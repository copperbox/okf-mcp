import path from "node:path";

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  appendLogEntry,
  deleteConcept,
  generateIndexes,
  renameConcept,
  writeConcept,
} from "./authoring.js";
import { readBundleDocument } from "./bundle.js";
import { fileDiff, fileHistory, isGitWorkTree } from "./git.js";
import {
  buildGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
  listTags,
  listTypes,
} from "./graph.js";
import { extractCitations, extractSection, splitSections } from "./parser.js";
import { searchConcepts } from "./search.js";
import type { OkfStore } from "./store.js";
import { suggestConceptPath } from "./suggest.js";
import type { ConceptFrontmatter, LoadedBundle } from "./types.js";
import { okfUri } from "./types.js";
import { validateBundle } from "./validate.js";

export interface ServerOptions {
  /**
   * Allow the authoring tools (write_concept, delete_concept,
   * rename_concept, append_log_entry, regenerate_indexes).
   * Default: read-only.
   */
  writable?: boolean;
}

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function markdown(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const bundleParam = z
  .string()
  .optional()
  .describe("Bundle ID; may be omitted when exactly one bundle is configured");

function assertWritableBundle(bundle: { id: string; readOnly: boolean }): void {
  if (bundle.readOnly) {
    throw new Error(
      `bundle "${bundle.id}" is read-only (remote bundles cannot be modified)`,
    );
  }
}

/**
 * Reject document paths that are absolute, escape the bundle root, or enter
 * dot-directories. Unlike assertSafeConceptPath this allows reserved files
 * (index.md, log.md) and non-.md extensions. Returns the normalized path.
 */
function assertSafeDocumentPath(relPath: string): string {
  const normalized = path.posix.normalize(relPath.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error(`document path must stay inside the bundle: ${relPath}`);
  }
  if (normalized.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error(`document path segments must not start with ".": ${relPath}`);
  }
  return normalized;
}

/**
 * Build the OKF MCP server: one markdown resource per document in each
 * bundle, plus tools for search, graph navigation, validation, and
 * (optionally) authoring.
 */
export function createOkfServer(
  store: OkfStore,
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "okf-mcp", version: "0.1.0" });

  const selectBundles = (bundle: string | undefined) =>
    bundle !== undefined ? [store.bundle(bundle)] : store.bundles();

  /** Read any bundle document (concept or reserved file) after path validation. */
  const readDocument = (bundleId: string | undefined, relPath: string) => {
    const bundle = store.bundle(bundleId);
    const safePath = assertSafeDocumentPath(relPath);
    return readBundleDocument(bundle, safePath);
  };

  server.registerResource(
    "okf-document",
    new ResourceTemplate("okf://{bundle}/{+path}", {
      list: async () => ({
        resources: store.bundles().flatMap((bundle) => [
          ...[...bundle.concepts.values()].map((concept) => ({
            uri: okfUri(bundle.id, concept.path),
            name: concept.frontmatter.title ?? concept.id,
            ...(concept.frontmatter.description !== undefined && {
              description: concept.frontmatter.description,
            }),
            mimeType: "text/markdown",
          })),
          ...bundle.reserved.map((file) => ({
            uri: okfUri(bundle.id, file.path),
            name: `${bundle.id}/${file.path}`,
            mimeType: "text/markdown",
          })),
        ]),
      }),
    }),
    {
      title: "OKF documents",
      description:
        "Markdown documents (concepts, index.md, log.md) from the configured OKF bundles",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const text = await readDocument(String(variables.bundle), String(variables.path));
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
      };
    },
  );

  server.registerTool(
    "list_bundles",
    {
      title: "List bundles",
      description: "List configured OKF bundles with concept counts",
      inputSchema: {},
    },
    async () =>
      json(
        store.bundles().map((bundle) => ({
          id: bundle.id,
          root: bundle.root,
          concepts: bundle.concepts.size,
          reservedFiles: bundle.reserved.map((f) => f.path),
          problems: bundle.problems.length,
          readOnly: bundle.readOnly,
        })),
      ),
  );

  server.registerTool(
    "reload_bundles",
    {
      title: "Reload bundles",
      description:
        "Re-read bundles from disk to pick up external edits (e.g. a human editing in Obsidian). Reports per-bundle counts and which concept IDs were added, removed, or changed.",
      inputSchema: {
        bundle: z
          .string()
          .optional()
          .describe("Bundle ID to reload; omitted reloads all configured bundles"),
      },
    },
    async ({ bundle }) => json(await store.reloadBundles(bundle)),
  );

  const remoteBundleSummary = (id: string, url: string) => {
    const bundle = store.bundle(id);
    return {
      id,
      url,
      concepts: bundle.concepts.size,
      problems: bundle.problems.length,
      readOnly: true,
    };
  };

  server.registerTool(
    "load_remote_bundle",
    {
      title: "Load remote bundle",
      description:
        "Fetch a read-only OKF bundle from a public GitHub tree URL and add it to the in-memory index. Only .md files are downloaded (bounded in count and size), nothing is written to disk, and remote content is never executed. Authoring tools reject the bundle.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Bundle ID to register; must not collide with an existing bundle"),
        url: z
          .string()
          .describe(
            "Public GitHub tree URL: https://github.com/<owner>/<repo>/tree/<ref>[/<path>]",
          ),
        include: z
          .array(z.string())
          .optional()
          .describe(
            "Glob patterns over bundle-relative paths; when present, only matching files load",
          ),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Glob patterns over bundle-relative paths to skip"),
      },
    },
    async ({ id, url, include, exclude }) => {
      await store.addRemoteBundle({
        id,
        url,
        ...(include !== undefined && { include }),
        ...(exclude !== undefined && { exclude }),
      });
      return json(remoteBundleSummary(id, url));
    },
  );

  server.registerTool(
    "list_remote_bundles",
    {
      title: "List remote bundles",
      description:
        "List read-only remote bundles loaded from public GitHub trees, with concept counts",
      inputSchema: {},
    },
    async () =>
      json(
        store
          .remoteBundleConfigs()
          .map((config) => ({
            ...remoteBundleSummary(config.id, config.url),
            ...(config.include !== undefined && { include: config.include }),
            ...(config.exclude !== undefined && { exclude: config.exclude }),
          })),
      ),
  );

  server.registerTool(
    "list_concepts",
    {
      title: "List concepts",
      description:
        "List concepts (ID, type, title, description, tags) with optional filtering. Use get_concept for full documents.",
      inputSchema: {
        bundle: bundleParam,
        pathPrefix: z.string().optional().describe("Concept ID prefix, e.g. tables/"),
        type: z.string().optional().describe("Only this frontmatter type"),
      },
    },
    async ({ bundle, pathPrefix, type }) =>
      json(
        searchConcepts(selectBundles(bundle), {
          ...(pathPrefix !== undefined && { pathPrefix }),
          ...(type !== undefined && { types: [type] }),
          limit: 500,
        }).hits.map(({ score: _score, ...hit }) => hit),
      ),
  );

  server.registerTool(
    "get_concept",
    {
      title: "Get concept",
      description:
        "Read one concept document: frontmatter, markdown body, outgoing links, and its body section headings. Pass `section` to fetch one section instead of the whole body.",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
        section: z
          .string()
          .optional()
          .describe(
            "Body section heading (case-insensitive), e.g. Schema; returns just that section (including its subsections) instead of the full body",
          ),
      },
    },
    async ({ bundle, id, section }) => {
      const concept = store.getConcept(bundle, id);
      if (!concept) throw new Error(`unknown concept: ${id}`);
      const sections = splitSections(concept.body).map((s) => s.heading);
      if (section === undefined) return json({ ...concept, sections });
      const match = extractSection(concept.body, section);
      if (!match) {
        throw new Error(
          `concept "${concept.id}" has no section "${section}"; available sections: ${
            sections.join(", ") || "(none)"
          }`,
        );
      }
      const { body: _body, links: _links, ...rest } = concept;
      return json({ ...rest, section: match, sections });
    },
  );

  server.registerTool(
    "get_citations",
    {
      title: "Get citations",
      description:
        "Numbered citation entries under a concept's `# Citations` heading (spec §8), each classified as an external URL, a concept in the bundle, or missing (a bundle-relative target that does not resolve)",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
      },
    },
    async ({ bundle, id }) => {
      const loadedBundle = store.bundle(bundle);
      const concept = store.getConcept(bundle, id);
      if (!concept) throw new Error(`unknown concept: ${id}`);
      const { citations } = extractCitations(concept.body, concept.path, (cid) =>
        loadedBundle.concepts.has(cid),
      );
      return json(citations);
    },
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read the raw markdown of any bundle document by path — reserved files (index.md, log.md) as well as concepts",
      inputSchema: {
        bundle: bundleParam,
        path: z
          .string()
          .describe("Bundle-relative path, e.g. log.md or tables/orders.md"),
      },
    },
    async ({ bundle, path: relPath }) => markdown(await readDocument(bundle, relPath)),
  );

  server.registerTool(
    "search_concepts",
    {
      title: "Search concepts",
      description:
        "Structured search over concepts: text query plus type/tag/path/link filters",
      inputSchema: {
        query: z.string().optional(),
        bundle: bundleParam,
        types: z.array(z.string()).optional(),
        tagsAny: z.array(z.string()).optional(),
        tagsAll: z.array(z.string()).optional(),
        pathPrefix: z.string().optional(),
        linkedTo: z.string().optional().describe("Only concepts linking to this ID"),
        linkedFrom: z.string().optional().describe("Only concepts linked from this ID"),
        orphanOnly: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async ({ bundle, ...filters }) => json(searchConcepts(selectBundles(bundle), filters)),
  );

  server.registerTool(
    "list_types",
    {
      title: "List types",
      description:
        "Distinct concept `type` values with usage counts, sorted by count. Reuse an existing type when authoring or filtering instead of inventing a variant.",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) => json(listTypes(selectBundles(bundle))),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "Distinct tag values with usage counts, sorted by count. Reuse an existing tag when authoring or filtering instead of inventing a variant.",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) => json(listTags(selectBundles(bundle))),
  );

  server.registerTool(
    "suggest_concept_path",
    {
      title: "Suggest concept path",
      description:
        "Suggest where a new concept file should live, ranked by where existing concepts of the same type (and overlapping tags) already live. Call before write_concept to keep placement consistent.",
      inputSchema: {
        bundle: bundleParam,
        type: z.string().min(1).describe("Frontmatter `type` the new concept will carry"),
        title: z
          .string()
          .optional()
          .describe("Planned title; slugged into the suggested filename"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Planned tags; used as a secondary placement signal"),
      },
    },
    async ({ bundle, type, title, tags }) =>
      json(
        suggestConceptPath(store.bundle(bundle), {
          type,
          ...(title !== undefined && { title }),
          ...(tags !== undefined && { tags }),
        }),
      ),
  );

  server.registerTool(
    "graph_summary",
    {
      title: "Graph summary",
      description:
        "Compact overview of a bundle's link graph: counts, types, tags, orphans. Call this before broader graph exploration.",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      json(
        bundle !== undefined
          ? graphSummary(store.bundle(bundle))
          : store.bundles().map(graphSummary),
      ),
  );

  server.registerTool(
    "get_neighbors",
    {
      title: "Get neighbors",
      description: "Concepts linked to/from a concept, expanded to a bounded depth",
      inputSchema: {
        bundle: bundleParam,
        id: z.string(),
        direction: z.enum(["in", "out", "both"]).optional(),
        depth: z.number().int().positive().max(5).optional(),
      },
    },
    async ({ bundle, id, direction, depth }) =>
      json(getNeighbors(store.bundle(bundle), id, direction ?? "both", depth ?? 1)),
  );

  server.registerTool(
    "find_path",
    {
      title: "Find path",
      description: "Shortest directed link path between two concepts, if any",
      inputSchema: {
        bundle: bundleParam,
        from: z.string(),
        to: z.string(),
      },
    },
    async ({ bundle, from, to }) =>
      json({ path: findPath(store.bundle(bundle), from, to) }),
  );

  server.registerTool(
    "export_graph",
    {
      title: "Export graph",
      description: "Export a bundle's link graph as json, dot, or mermaid",
      inputSchema: {
        bundle: bundleParam,
        format: z.enum(["json", "dot", "mermaid"]).optional(),
        includeExternal: z
          .boolean()
          .optional()
          .describe("Include external link targets as opaque nodes"),
      },
    },
    async ({ bundle, format, includeExternal }) =>
      markdown(
        exportGraph(
          buildGraph(store.bundle(bundle), { includeExternal: includeExternal ?? false }),
          format ?? "json",
        ),
      ),
  );

  /**
   * Resolve a concept for the git tools, returning its bundle plus either the
   * concept or a graceful "not a git repository" result for non-git bundles.
   */
  const resolveGitConcept = async (bundleId: string | undefined, id: string) => {
    const bundle = store.bundle(bundleId);
    const concept = store.getConcept(bundleId, id);
    if (!concept) throw new Error(`unknown concept: ${id}`);
    const notGit = (await isGitWorkTree(bundle.root))
      ? undefined
      : json({
          error: "not a git repository",
          message: `bundle "${bundle.id}" is not inside a git work tree`,
        });
    return { bundle, concept, notGit };
  };

  server.registerTool(
    "concept_history",
    {
      title: "Concept history",
      description:
        "Git commit history (hash, date, author, subject) for a concept file, newest first, following renames. Requires the bundle to live in a git work tree.",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ bundle, id, limit }) => {
      const { bundle: target, concept, notGit } = await resolveGitConcept(bundle, id);
      if (notGit) return notGit;
      return json(await fileHistory(target.root, concept.path, limit));
    },
  );

  server.registerTool(
    "concept_diff",
    {
      title: "Concept diff",
      description:
        "Unified git diff of a concept file against a ref (default: the commit before the last one touching the file, i.e. its most recent change). Requires the bundle to live in a git work tree.",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
        ref: z
          .string()
          .optional()
          .describe("Git ref to diff against, e.g. a commit hash or HEAD~3"),
      },
    },
    async ({ bundle, id, ref }) => {
      const { bundle: target, concept, notGit } = await resolveGitConcept(bundle, id);
      if (notGit) return notGit;
      return markdown(await fileDiff(target.root, concept.path, ref));
    },
  );

  server.registerTool(
    "validate_bundle",
    {
      title: "Validate bundle",
      description: "Report OKF v0.1 conformance errors and soft warnings",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      json(await Promise.all(selectBundles(bundle).map(validateBundle))),
  );

  if (options.writable) {
    /**
     * After a concept write/delete: log the change, then regenerate indexes
     * from a reloaded bundle so they reflect the change, then reload again so
     * the store sees the freshly written index files.
     */
    async function logAndReindex(target: LoadedBundle, message: string): Promise<void> {
      await appendLogEntry(target.root, message);
      const reloaded = await store.reloadBundle(target.id);
      await generateIndexes(reloaded);
      await store.reloadBundle(target.id);
    }

    server.registerTool(
      "write_concept",
      {
        title: "Write concept",
        description:
          "Create or update a concept markdown document, append a log.md entry, and regenerate index.md files",
        inputSchema: {
          bundle: bundleParam,
          path: z.string().describe("Bundle-relative path ending in .md"),
          frontmatter: z
            .object({ type: z.string().min(1) })
            .passthrough()
            .describe("YAML frontmatter; `type` is required, extra keys are preserved"),
          body: z.string().describe("Markdown body"),
          logMessage: z
            .string()
            .optional()
            .describe("Entry for log.md; a default is generated when omitted"),
        },
      },
      async ({ bundle, path: relPath, frontmatter, body, logMessage }) => {
        const target = store.bundle(bundle);
        assertWritableBundle(target);
        const result = await writeConcept(
          target.root,
          relPath,
          frontmatter as ConceptFrontmatter,
          body,
        );
        const verb = result.created ? "Creation" : "Update";
        const title =
          (frontmatter as ConceptFrontmatter).title ?? result.path.replace(/\.md$/i, "");
        await logAndReindex(
          target,
          logMessage ?? `**${verb}**: ${verb === "Creation" ? "Created" : "Updated"} [${title}](/${result.path}).`,
        );
        return json({ ...result, bundle: target.id, uri: okfUri(target.id, result.path) });
      },
    );

    server.registerTool(
      "delete_concept",
      {
        title: "Delete concept",
        description:
          "Delete a concept document, append a log.md entry, regenerate index.md files, and report concepts that still link to it",
        inputSchema: {
          bundle: bundleParam,
          id: z.string().describe("Concept ID or bundle-relative path, e.g. tables/orders"),
          logMessage: z
            .string()
            .optional()
            .describe("Entry for log.md; a default is generated when omitted"),
          failIfLinked: z
            .boolean()
            .optional()
            .describe(
              "Refuse to delete while other concepts still link to the target (broken links are otherwise spec-legal)",
            ),
        },
      },
      async ({ bundle, id, logMessage, failIfLinked }) => {
        const target = store.bundle(bundle);
        assertWritableBundle(target);
        const result = await deleteConcept(target, id, {
          ...(failIfLinked !== undefined && { failIfLinked }),
        });
        await logAndReindex(
          target,
          logMessage ??
            `**Deletion**: Deleted [${result.title ?? result.id}](/${result.path}).`,
        );
        return json({ ...result, bundle: target.id });
      },
    );

    server.registerTool(
      "rename_concept",
      {
        title: "Rename concept",
        description:
          "Move a concept to a new path, rewriting links that pointed at it across the bundle (and the moved file's own relative links), then log the change and regenerate index.md files",
        inputSchema: {
          bundle: bundleParam,
          from: z.string().describe("Concept ID or bundle-relative path, e.g. tables/orders"),
          to: z.string().describe("New bundle-relative path ending in .md"),
          logMessage: z
            .string()
            .optional()
            .describe("Entry for log.md; a default is generated when omitted"),
        },
      },
      async ({ bundle, from, to, logMessage }) => {
        const target = store.bundle(bundle);
        assertWritableBundle(target);
        const result = await renameConcept(target, from, to);
        await logAndReindex(
          target,
          logMessage ??
            `**Update**: Renamed [${result.title ?? result.id}](/${result.to}) (was /${result.from}).`,
        );
        return json({ ...result, bundle: target.id, uri: okfUri(target.id, result.to) });
      },
    );

    server.registerTool(
      "append_log_entry",
      {
        title: "Append log entry",
        description:
          "Record a change-narrative entry in the bundle-root log.md (spec §7) without touching any concept",
        inputSchema: {
          bundle: bundleParam,
          message: z
            .string()
            .min(1)
            .describe(
              "One-line markdown entry; conventionally starts with a bold verb like **Update**: or **Deprecation**:",
            ),
        },
      },
      async ({ bundle, message }) => {
        const target = store.bundle(bundle);
        assertWritableBundle(target);
        await appendLogEntry(target.root, message);
        await store.reloadBundle(target.id);
        return json({ bundle: target.id, path: "log.md", uri: okfUri(target.id, "log.md") });
      },
    );

    server.registerTool(
      "regenerate_indexes",
      {
        title: "Regenerate indexes",
        description:
          "Rewrite index.md files in every bundle directory from concept frontmatter (spec §6)",
        inputSchema: { bundle: bundleParam },
      },
      async ({ bundle }) => {
        const target = store.bundle(bundle);
        assertWritableBundle(target);
        const written = await generateIndexes(target);
        await store.reloadBundle(target.id);
        return json({ bundle: target.id, written });
      },
    );
  }

  return server;
}
