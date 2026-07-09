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
  nearestLogDirectory,
  renameConcept,
  renderIndexes,
  updateConcept,
  writeConcept,
} from "./authoring.js";
import {
  colocatedSiblings,
  readBundleDocument,
  readColocatedAgentsGuide,
  resolveOutsideLink,
} from "./bundle.js";
import { fileDiff, fileHistory, isGitWorkTree } from "./git.js";
import {
  buildGraph,
  buildMultiGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
  listTags,
  listTypes,
  neighborsInGraph,
  pathInGraph,
  qualifyNodeId,
} from "./graph.js";
import { deriveTitle, extractCitations, extractSection, splitSections } from "./parser.js";
import { promoteConcept } from "./promote.js";
import { searchConcepts } from "./search.js";
import type { ColocatedRootMount, OkfStore } from "./store.js";
import { suggestConceptPath } from "./suggest.js";
import type { ConceptFrontmatter, LoadedBundle } from "./types.js";
import { okfUri } from "./types.js";
import { validateBundle } from "./validate.js";

/**
 * Agent-facing guide to the mounted bundles (a colocated root's AGENTS.md),
 * appended to the server instructions so every session knows which bundles
 * exist and which matter for what kind of work.
 */
export interface BundleGuide {
  /** Raw markdown content of the guide. */
  text: string;
  /** Path of the full file, named by the truncation pointer. */
  source: string;
}

export interface ServerOptions {
  /**
   * Allow the authoring tools (write_concept, update_concept, delete_concept,
   * rename_concept, append_log_entry, regenerate_indexes).
   * Default: read-only.
   */
  writable?: boolean;
  /**
   * Bundle guides appended to the server instructions; each is truncated past
   * BUNDLE_GUIDE_BUDGET characters with a pointer to its full file.
   */
  bundleGuides?: BundleGuide[];
}

/**
 * Instructions load into the agent's context every session, so a bundle
 * guide longer than this many characters is truncated rather than injected
 * whole (the full file stays readable where it lives).
 */
export const BUNDLE_GUIDE_BUDGET = 4000;

/**
 * A guide under the budget passes through whole; past it, cut at the last
 * line break before the budget and point at the full file.
 */
function renderBundleGuide(guide: BundleGuide): string {
  const heading = "Bundle guide (from AGENTS.md):";
  const text = guide.text.trim();
  if (text.length <= BUNDLE_GUIDE_BUDGET) return `${heading}\n\n${text}`;
  const lastBreak = text.lastIndexOf("\n", BUNDLE_GUIDE_BUDGET);
  const kept = text.slice(0, lastBreak > 0 ? lastBreak : BUNDLE_GUIDE_BUDGET).trimEnd();
  return (
    `${heading}\n\n${kept}\n\n[Guide truncated — call get_bundle_guide for the ` +
    `full guide (source: ${guide.source}).]`
  );
}

/**
 * Server-level instructions clients inject into the agent's context every
 * session (so kept deliberately short): the OKF conventions the tools assume
 * but cannot express individually.
 */
function serverInstructions(options: ServerOptions): string {
  const shared = `This server exposes OKF (Open Knowledge Format) bundles: directories of markdown
concept documents with YAML frontmatter (type, title, tags), indexed into a link graph.
A concept's ID is its bundle-relative path without the .md extension (e.g. tables/orders).
Relationships are ordinary markdown links in the body; prefer the bundle-absolute form,
e.g. [Orders](/tables/orders.md). index.md and log.md are reserved, generated files.

Reading: orient with graph_summary and list_types / list_tags, narrow with
search_concepts (text plus type/tag/path/link filters), then read specific concepts
with get_concept and explore with get_neighbors / find_path — rather than dumping
every document. When a get_bundle_guide tool is listed, call it before exploring:
it says what each mounted bundle is for and which to use for what work.

Colocated bundles may be discovered but not loaded yet (lazy mounting):
list_bundles marks them loaded: false, any tool naming one loads it, and no-arg
sweeps cover loaded bundles only, noting what they excluded.

If bundle files may have changed outside this server (e.g. a human editing in
Obsidian), call reload_bundles before relying on current state.`;
  const writing = `Writing: call suggest_concept_path before creating a concept so placement matches
where similar concepts live, and reuse existing types/tags. Prefer update_concept
for partial edits — it patches frontmatter keys and/or one body section, preserving
the rest of the document — over full write_concept rewrites. write_concept,
update_concept, rename_concept, and delete_concept keep index.md navigation and the
log.md history current — never edit those reserved files directly. Their auto entries
go to the nearest existing directory log.md above the concept, falling back to the
bundle root's. Use append_log_entry for change narrative not tied to a single concept
write. When knowledge outgrows its bundle (e.g. project → org), promote_concept moves
it and leaves a citation stub behind. Remote bundles are always read-only.`;
  const authoring = options.writable
    ? writing
    : "This server is read-only; authoring tools are not available.";
  const guides = (options.bundleGuides ?? []).map(renderBundleGuide);
  return [shared, authoring, ...guides].join("\n\n");
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
 * Synthesized index for a directory the bundle has but no index.md covers —
 * spec §6 lets consumers synthesize one on the fly (the only entry point for
 * read-only remote bundles published without index files). Never written to
 * disk. Returns undefined for non-index paths and unknown directories.
 */
function synthesizeIndex(bundle: LoadedBundle, safePath: string): string | undefined {
  if (path.posix.basename(safePath).toLowerCase() !== "index.md") return undefined;
  const dir = path.posix.dirname(safePath);
  return renderIndexes(bundle).get(dir === "." ? "index.md" : `${dir}/index.md`);
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
  const server = new McpServer(
    { name: "okf-mcp", version: "0.1.0" },
    { instructions: serverInstructions(options) },
  );

  const selectBundles = async (bundle: string | undefined) =>
    bundle !== undefined ? [await store.bundle(bundle)] : store.bundles();

  /**
   * A no-arg sweep covers only loaded bundles; when lazy colocated bundles
   * are discovered but not loaded, say so in the result rather than letting
   * the truncated sweep read as complete (issue #64).
   */
  const sweepJson = (data: unknown, sweep: boolean): CallToolResult => {
    const result = json(data);
    const excluded = store.discoveredBundles();
    if (!sweep || excluded.length === 0) return result;
    result.content.push({
      type: "text",
      text:
        `Note: ${excluded.length} discovered bundle(s) are not loaded and were ` +
        `excluded from this sweep: ${excluded.map((d) => d.id).join(", ")}. ` +
        "Pass one as the `bundle` argument to load and include it (first access " +
        "loads a bundle); list_bundles shows every bundle's loaded state.",
    });
    return result;
  };

  /**
   * Read any bundle document (concept or reserved file) after path
   * validation, falling back to a synthesized view for a missing index.md.
   */
  const readDocument = async (bundleId: string | undefined, relPath: string) => {
    const bundle = await store.bundle(bundleId);
    const safePath = assertSafeDocumentPath(relPath);
    try {
      return { text: await readBundleDocument(bundle, safePath), synthesized: false };
    } catch (err) {
      const text = synthesizeIndex(bundle, safePath);
      if (text === undefined) throw err;
      return { text, synthesized: true };
    }
  };

  server.registerResource(
    "okf-document",
    new ResourceTemplate("okf://{bundle}/{+path}", {
      list: async () => ({
        resources: [
          ...store.bundles().flatMap((bundle) => [
            ...[...bundle.concepts.values()].map((concept) => ({
              uri: okfUri(bundle.id, concept.path),
              name: deriveTitle(concept),
              ...(concept.frontmatter.description !== undefined && {
                description: concept.frontmatter.description,
              }),
              mimeType: "text/markdown",
            })),
            ...bundle.reserved.map((file) => ({
              uri: okfUri(bundle.id, file.path),
              name: `${bundle.id}/${file.path}`,
              // The root index.md carries the bundle's declared purpose so
              // agents can judge relevance from the resource list alone.
              ...(file.path === "index.md" &&
                bundle.description !== undefined && {
                  description: bundle.description,
                }),
              mimeType: "text/markdown",
            })),
          ]),
          // A discovered-but-unloaded bundle is represented by its root
          // index.md alone (not silently absent); reading it loads the
          // bundle, after which its documents list individually.
          ...store.discoveredBundles().map((discovered) => ({
            uri: okfUri(discovered.id, "index.md"),
            name: `${discovered.id}/index.md (bundle not loaded yet)`,
            ...(discovered.description !== undefined && {
              description: discovered.description,
            }),
            mimeType: "text/markdown",
          })),
        ],
      }),
    }),
    {
      title: "OKF documents",
      description:
        "Markdown documents (concepts, index.md, log.md) from the configured OKF bundles",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const { text, synthesized } = await readDocument(
        String(variables.bundle),
        String(variables.path),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text,
            ...(synthesized && { _meta: { synthesized: true } }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_bundles",
    {
      title: "List bundles",
      description:
        "List configured OKF bundles with concept counts and each bundle's declared description (its one-line purpose). Bundles with `loaded: false` were discovered under a colocated root but not yet parsed — any tool naming one loads it on the spot.",
      inputSchema: {},
    },
    async () =>
      json([
        ...store.bundles().map((bundle) => ({
          id: bundle.id,
          root: bundle.root,
          okfVersion: bundle.okfVersion,
          description: bundle.description,
          concepts: bundle.concepts.size,
          reservedFiles: bundle.reserved.map((f) => f.path),
          problems: bundle.problems.length,
          readOnly: bundle.readOnly,
          loaded: true,
        })),
        ...store.discoveredBundles().map((discovered) => ({
          id: discovered.id,
          root: discovered.root,
          ...(discovered.description !== undefined && {
            description: discovered.description,
          }),
          loaded: false,
        })),
      ]),
  );

  /**
   * One get_bundle_guide entry: the root's AGENTS.md full text (local roots
   * read it from disk on demand, so external edits show up; remote roots
   * return the guide fetched with the mount) plus each bundle's one-line
   * description. Unlike the instructions injection, never truncated.
   */
  const bundleGuideEntry = async (mount: ColocatedRootMount) => {
    const guide = mount.remote
      ? mount.agentsGuide
      : await readColocatedAgentsGuide(mount.root);
    return {
      root: mount.root,
      ...(guide !== undefined
        ? {
            guide,
            source: mount.remote
              ? `${mount.root}/AGENTS.md`
              : path.join(mount.root, "AGENTS.md"),
          }
        : {
            note:
              "this root has no AGENTS.md; the bundle descriptions below are the guide",
          }),
      bundles: mount.bundles,
    };
  };

  const bundleGuideTool = server.registerTool(
    "get_bundle_guide",
    {
      title: "Get bundle guide",
      description:
        "Describes what each mounted bundle is for and which to use for what work: each colocated root's AGENTS.md guide in full (read on demand, never truncated) plus every bundle's one-line description. Call before choosing which bundles to search or explore.",
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe(
            "Colocated root — a local root path or a remote root URL, as reported by a previous call; omitted covers every mounted root",
          ),
      },
    },
    async ({ root }) => {
      const mounts = store.mountedColocatedRoots();
      const selected =
        root === undefined
          ? mounts
          : mounts.filter(
              (m) => m.root === root || (!m.remote && m.root === path.resolve(root)),
            );
      if (selected.length === 0) {
        throw new Error(
          `unknown colocated root: ${root} ` +
            `(mounted: ${mounts.map((m) => m.root).join(", ")})`,
        );
      }
      return json(await Promise.all(selected.map(bundleGuideEntry)));
    },
  );

  /**
   * get_bundle_guide exists only while a colocated root is mounted: hidden
   * from tools/list otherwise, flipped on when a runtime mount introduces
   * the first root (enable() notifies connected clients via
   * tools/list_changed), and off again should none remain.
   */
  const syncBundleGuideTool = () => {
    const mounted = store.mountedColocatedRoots().length > 0;
    if (mounted === bundleGuideTool.enabled) return;
    if (mounted) bundleGuideTool.enable();
    else bundleGuideTool.disable();
  };
  syncBundleGuideTool();

  server.registerTool(
    "reload_bundles",
    {
      title: "Reload bundles",
      description:
        "Re-read bundles from disk to pick up external edits (e.g. a human editing in Obsidian). Reports per-bundle counts and which concept IDs were added, removed, or changed. Without a bundle id, only loaded bundles reload (an unloaded discovered bundle has no stale index); naming an unloaded bundle loads it.",
      inputSchema: {
        bundle: z
          .string()
          .optional()
          .describe("Bundle ID to reload; omitted reloads all configured bundles"),
      },
    },
    async ({ bundle }) => json(await store.reloadBundles(bundle)),
  );

  const remoteBundleSummary = async (id: string, url: string) => {
    const bundle = await store.bundle(id);
    return {
      id,
      url,
      description: bundle.description,
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
        "Fetch a read-only OKF bundle from a public GitHub tree URL or a .tar.gz/.tgz/.zip archive (URL or local path) and add it to the in-memory index. Only .md files are indexed (bounded in count and size), nothing is written to disk, and remote content is never executed. Authoring tools reject the bundle.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Bundle ID to register; must not collide with an existing bundle"),
        url: z
          .string()
          .describe(
            "Public GitHub tree URL (https://github.com/<owner>/<repo>/tree/<ref>[/<path>]) or a .tar.gz/.tgz/.zip archive URL or local path",
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
        canonicalUrl: z
          .string()
          .optional()
          .describe(
            "Extra canonical URL of the bundle root; citations/external links under it resolve to this bundle's concepts as derived cross-bundle edges (GitHub tree mounts derive one from the tree URL automatically)",
          ),
      },
    },
    async ({ id, url, include, exclude, canonicalUrl }) => {
      await store.addRemoteBundle({
        id,
        url,
        ...(include !== undefined && { include }),
        ...(exclude !== undefined && { exclude }),
        ...(canonicalUrl !== undefined && { canonicalUrl }),
      });
      return json(await remoteBundleSummary(id, url));
    },
  );

  server.registerTool(
    "load_colocated_remote_bundles",
    {
      title: "Load colocated remote bundles",
      description:
        "Mount a published colocated root by URL: each immediate subdirectory of the GitHub tree (or .tar.gz/.tgz/.zip archive) containing markdown becomes its own read-only bundle, id = folder name, and relative ../sibling links between them derive cross-bundle edges. File-count and size limits apply across the whole root. The root's AGENTS.md (bundle guide) is returned in `agentsGuide` — server instructions are fixed at initialization, so read the guide from this result; get_bundle_guide (registered with the mount) serves it again any time later.",
      inputSchema: {
        url: z
          .string()
          .describe(
            "Public GitHub tree URL of the root (https://github.com/<owner>/<repo>/tree/<ref>[/<path>]) or a .tar.gz/.tgz/.zip archive URL or local path",
          ),
        only: z
          .array(z.string())
          .optional()
          .describe(
            "Mount only these immediate subfolders; a name that is not a bundle subdirectory of the root is an error",
          ),
        include: z
          .array(z.string())
          .optional()
          .describe(
            "Glob patterns over bundle-relative paths, applied within every bundle; when present, only matching files load",
          ),
        exclude: z
          .array(z.string())
          .optional()
          .describe(
            "Glob patterns over bundle-relative paths to skip, applied within every bundle",
          ),
        canonicalUrl: z
          .string()
          .optional()
          .describe(
            "Published canonical URL of the root; every bundle derives <url>/<folder> (tree mounts derive canonical URLs from the tree URL automatically; archives have none without this)",
          ),
      },
    },
    async ({ url, only, include, exclude, canonicalUrl }) => {
      const mount = await store.addColocatedRemoteBundles({
        url,
        ...(only !== undefined && { only }),
        ...(include !== undefined && { include }),
        ...(exclude !== undefined && { exclude }),
        ...(canonicalUrl !== undefined && { canonicalUrl }),
      });
      // The first colocated root makes get_bundle_guide appear mid-session.
      syncBundleGuideTool();
      return json({
        url,
        bundles: mount.bundles.map((bundle) => ({
          id: bundle.id,
          description: bundle.description,
          concepts: bundle.concepts.size,
          problems: bundle.problems.length,
          readOnly: true,
        })),
        ...(mount.agentsGuide !== undefined && { agentsGuide: mount.agentsGuide }),
      });
    },
  );

  server.registerTool(
    "list_remote_bundles",
    {
      title: "List remote bundles",
      description:
        "List read-only remote bundles (GitHub trees or archives) with their source URLs, concept counts, and each bundle's declared description",
      inputSchema: {},
    },
    async () =>
      json(
        await Promise.all(
          store.remoteBundleConfigs().map(async (config) => ({
            ...(await remoteBundleSummary(config.id, config.url)),
            ...(config.include !== undefined && { include: config.include }),
            ...(config.exclude !== undefined && { exclude: config.exclude }),
            ...(config.canonicalUrl !== undefined && {
              canonicalUrl: config.canonicalUrl,
            }),
          })),
        ),
      ),
  );

  server.registerTool(
    "list_concepts",
    {
      title: "List concepts",
      description:
        "List concepts (ID, type, title, description, resource, tags) with optional filtering. Use get_concept for full documents.",
      inputSchema: {
        bundle: bundleParam,
        pathPrefix: z.string().optional().describe("Concept ID prefix, e.g. tables/"),
        type: z.string().optional().describe("Only this frontmatter type"),
      },
    },
    async ({ bundle, pathPrefix, type }) =>
      sweepJson(
        searchConcepts(await selectBundles(bundle), {
          ...(pathPrefix !== undefined && { pathPrefix }),
          ...(type !== undefined && { types: [type] }),
          limit: 500,
        }).hits.map(({ score: _score, ...hit }) => hit),
        bundle === undefined,
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
      const concept = await store.getConcept(bundle, id);
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
        "Numbered citation entries under a concept's `# Citations` heading (spec §8), each classified as an external URL, a concept (in the bundle, or reached by a relative `../` link into a mounted colocated sibling bundle), or missing (a relative target that does not resolve)",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
      },
    },
    async ({ bundle, id }) => {
      const loadedBundle = await store.bundle(bundle);
      const concept = await store.getConcept(bundle, id);
      if (!concept) throw new Error(`unknown concept: ${id}`);
      const siblings = colocatedSiblings(loadedBundle, store.bundles());
      const { citations } = extractCitations(
        concept.body,
        concept.path,
        (cid) => loadedBundle.concepts.has(cid),
        (linkPath) => resolveOutsideLink(linkPath, siblings) !== undefined,
      );
      return json(citations);
    },
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read the raw markdown of any bundle document by path — reserved files (index.md, log.md) as well as concepts. A missing index.md is synthesized from frontmatter (spec §6) and marked with `synthesized: true` in the result",
      inputSchema: {
        bundle: bundleParam,
        path: z
          .string()
          .describe("Bundle-relative path, e.g. log.md or tables/orders.md"),
      },
    },
    async ({ bundle, path: relPath }) => {
      const { text, synthesized } = await readDocument(bundle, relPath);
      return { ...markdown(text), ...(synthesized && { synthesized: true }) };
    },
  );

  server.registerTool(
    "search_concepts",
    {
      title: "Search concepts",
      description:
        "Structured search over concepts: text query plus type/tag/path/link/resource filters",
      inputSchema: {
        query: z.string().optional(),
        bundle: bundleParam,
        types: z.array(z.string()).optional(),
        resource: z
          .string()
          .optional()
          .describe(
            "Exact frontmatter `resource` URI — find the concept describing this asset",
          ),
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
    async ({ bundle, ...filters }) =>
      sweepJson(
        searchConcepts(await selectBundles(bundle), filters),
        bundle === undefined,
      ),
  );

  server.registerTool(
    "list_types",
    {
      title: "List types",
      description:
        "Distinct concept `type` values with usage counts, sorted by count. Reuse an existing type when authoring or filtering instead of inventing a variant.",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      sweepJson(listTypes(await selectBundles(bundle)), bundle === undefined),
  );

  server.registerTool(
    "list_tags",
    {
      title: "List tags",
      description:
        "Distinct tag values with usage counts, sorted by count. Reuse an existing tag when authoring or filtering instead of inventing a variant.",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      sweepJson(listTags(await selectBundles(bundle)), bundle === undefined),
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
        suggestConceptPath(await store.bundle(bundle), {
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
        "Compact overview of a bundle's link graph: counts, types, tags, orphans, derived cross-bundle edge count. Call this before broader graph exploration.",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      sweepJson(
        bundle !== undefined
          ? graphSummary(await store.bundle(bundle), store.bundles())
          : store.bundles().map((b) => graphSummary(b, store.bundles())),
        bundle === undefined,
      ),
  );

  /**
   * Node ID for cross-bundle traversal: `bundle:concept` IDs pass through
   * when the prefix names a mounted bundle; plain concept IDs are qualified
   * with the tool's `bundle` argument (or the only configured bundle).
   */
  const qualifyForCrossBundle = async (
    bundleId: string | undefined,
    id: string,
  ): Promise<string> => {
    const colon = id.indexOf(":");
    if (colon > 0 && store.bundles().some((b) => b.id === id.slice(0, colon))) {
      return id;
    }
    return qualifyNodeId((await store.bundle(bundleId)).id, id);
  };

  const crossBundleParam = z
    .boolean()
    .optional()
    .describe(
      "Traverse the multi-bundle graph: node IDs become bundle:concept and derived cross-bundle edges (citation/resource URLs matching another mounted bundle's canonical location) are followed",
    );

  server.registerTool(
    "get_neighbors",
    {
      title: "Get neighbors",
      description:
        "Concepts linked to/from a concept, expanded to a bounded depth. With crossBundle, derived edges into other mounted bundles are traversed too and each node carries its bundle ID.",
      inputSchema: {
        bundle: bundleParam,
        id: z.string(),
        direction: z.enum(["in", "out", "both"]).optional(),
        depth: z.number().int().positive().max(5).optional(),
        crossBundle: crossBundleParam,
      },
    },
    async ({ bundle, id, direction, depth, crossBundle }) =>
      json(
        crossBundle
          ? neighborsInGraph(
              buildMultiGraph(store.bundles()),
              await qualifyForCrossBundle(bundle, id),
              direction ?? "both",
              depth ?? 1,
            )
          : getNeighbors(await store.bundle(bundle), id, direction ?? "both", depth ?? 1),
      ),
  );

  server.registerTool(
    "find_path",
    {
      title: "Find path",
      description:
        "Shortest directed link path between two concepts, if any. With crossBundle, `from`/`to` may be bundle:concept IDs and the path may traverse derived cross-bundle edges.",
      inputSchema: {
        bundle: bundleParam,
        from: z.string(),
        to: z.string(),
        crossBundle: crossBundleParam,
      },
    },
    async ({ bundle, from, to, crossBundle }) =>
      json({
        path: crossBundle
          ? pathInGraph(
              buildMultiGraph(store.bundles()),
              await qualifyForCrossBundle(bundle, from),
              await qualifyForCrossBundle(bundle, to),
            )
          : findPath(await store.bundle(bundle), from, to),
      }),
  );

  server.registerTool(
    "export_graph",
    {
      title: "Export graph",
      description:
        "Export a bundle's link graph as json, dot, or mermaid. With crossBundle, all mounted bundles export as one graph with bundle:concept node IDs and visually distinct derived edges.",
      inputSchema: {
        bundle: bundleParam,
        format: z.enum(["json", "dot", "mermaid"]).optional(),
        includeExternal: z
          .boolean()
          .optional()
          .describe("Include external link targets as opaque nodes"),
        crossBundle: crossBundleParam,
      },
    },
    async ({ bundle, format, includeExternal, crossBundle }) => {
      const options = { includeExternal: includeExternal ?? false };
      return markdown(
        exportGraph(
          crossBundle
            ? buildMultiGraph(store.bundles(), options)
            : buildGraph(await store.bundle(bundle), options),
          format ?? "json",
        ),
      );
    },
  );

  /**
   * Resolve a concept for the git tools, returning its bundle plus either the
   * concept or a graceful "not a git repository" result for non-git bundles.
   */
  const resolveGitConcept = async (bundleId: string | undefined, id: string) => {
    const bundle = await store.bundle(bundleId);
    const concept = await store.getConcept(bundleId, id);
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
      sweepJson(
        await Promise.all(
          (await selectBundles(bundle)).map((b) => validateBundle(b, store.bundles())),
        ),
        bundle === undefined,
      ),
  );

  if (options.writable) {
    /**
     * After a concept write/delete/rename: log the change, then regenerate
     * indexes from a reloaded bundle so they reflect the change, then reload
     * again so the store sees the freshly written index files.
     *
     * Each entry goes to the nearest existing directory log.md above the
     * touched path, falling back to the bundle root (spec §7 scoped logs) —
     * the auto path uses scoped logs but never creates them. A rename spanning
     * two scopes logs to both so neither history has a gap.
     */
    async function logAndReindex(
      target: LoadedBundle,
      message: string,
      touchedPaths: string[],
    ): Promise<void> {
      const scopes = new Set<string>();
      for (const touched of touchedPaths) {
        scopes.add(await nearestLogDirectory(target.root, touched));
      }
      for (const directory of scopes) {
        await appendLogEntry(target.root, message, { directory });
      }
      const reloaded = await store.reloadBundle(target.id);
      await generateIndexes(reloaded);
      await store.reloadBundle(target.id);
    }

    server.registerTool(
      "write_concept",
      {
        title: "Write concept",
        description:
          "Create or update a concept markdown document, append a log.md entry (to the nearest existing directory log, falling back to the bundle root's), and regenerate index.md files",
        inputSchema: {
          bundle: bundleParam,
          path: z.string().describe("Bundle-relative path ending in .md"),
          frontmatter: z
            .object({ type: z.string().min(1) })
            .passthrough()
            .describe(
              "YAML frontmatter; `type` is required, extra keys are preserved. `timestamp` defaults to the current UTC time when omitted (supply one to backdate)",
            ),
          body: z.string().describe("Markdown body"),
          logMessage: z
            .string()
            .optional()
            .describe("Entry for log.md; a default is generated when omitted"),
        },
      },
      async ({ bundle, path: relPath, frontmatter, body, logMessage }) => {
        const target = await store.bundle(bundle);
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
          [result.path],
        );
        return json({ ...result, bundle: target.id, uri: okfUri(target.id, result.path) });
      },
    );

    server.registerTool(
      "update_concept",
      {
        title: "Update concept",
        description:
          "Partially update a concept without rewriting the whole document: shallow-merge a frontmatter patch and/or replace one body section by heading. Everything not named in the update — other frontmatter keys, YAML comments and formatting, the rest of the body — is preserved byte-for-byte, except `timestamp`, which refreshes to the current UTC time (spec §4.1: last meaningful change) unless pinned via the patch or `keepTimestamp`. Appends a log.md entry and regenerates index.md files.",
        inputSchema: {
          bundle: bundleParam,
          id: z.string().describe("Concept ID or bundle-relative path, e.g. tables/orders"),
          frontmatter: z
            .record(z.unknown())
            .optional()
            .describe(
              "Frontmatter keys to set/overwrite; an explicit null deletes a key. Including `timestamp` (a value, or null to delete) overrides the default refresh",
            ),
          section: z
            .object({
              heading: z
                .string()
                .min(1)
                .describe(
                  "Body section heading to replace (case-insensitive, first match, including its subsections)",
                ),
              content: z
                .string()
                .describe("New markdown content for the section; the heading line is kept"),
            })
            .optional()
            .describe("Replace one body section, leaving the rest of the body untouched"),
          keepTimestamp: z
            .boolean()
            .optional()
            .describe(
              "Preserve the existing `timestamp` byte-for-byte instead of refreshing it to now",
            ),
          logMessage: z
            .string()
            .optional()
            .describe("Entry for log.md; a default is generated when omitted"),
        },
      },
      async ({ bundle, id, frontmatter, section, keepTimestamp, logMessage }) => {
        const target = await store.bundle(bundle);
        assertWritableBundle(target);
        const result = await updateConcept(target, id, {
          ...(frontmatter !== undefined && { frontmatter }),
          ...(section !== undefined && { section }),
          ...(keepTimestamp !== undefined && { keepTimestamp }),
        });
        await logAndReindex(
          target,
          logMessage ?? `**Update**: Updated [${result.title ?? result.id}](/${result.path}).`,
          [result.path],
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
        const target = await store.bundle(bundle);
        assertWritableBundle(target);
        const result = await deleteConcept(target, id, {
          ...(failIfLinked !== undefined && { failIfLinked }),
        });
        await logAndReindex(
          target,
          logMessage ??
            `**Deletion**: Deleted [${result.title ?? result.id}](/${result.path}).`,
          [result.path],
        );
        return json({ ...result, bundle: target.id });
      },
    );

    server.registerTool(
      "rename_concept",
      {
        title: "Rename concept",
        description:
          "Move a concept to a new path, rewriting links that pointed at it across the bundle (and the moved file's own relative links), then log the change (in both the old and new paths' nearest log.md scopes when they differ) and regenerate index.md files",
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
        const target = await store.bundle(bundle);
        assertWritableBundle(target);
        const result = await renameConcept(target, from, to);
        await logAndReindex(
          target,
          logMessage ??
            `**Update**: Renamed [${result.title ?? result.id}](/${result.to}) (was /${result.from}).`,
          [result.from, result.to],
        );
        return json({ ...result, bundle: target.id, uri: okfUri(target.id, result.to) });
      },
    );

    server.registerTool(
      "promote_concept",
      {
        title: "Promote concept",
        description:
          "Move a concept into another writable bundle (e.g. project → org): write it there (explicit toPath, or suggest_concept_path-style placement keeping the filename), replace the original with a citation stub pointing at the promoted copy (a relative ../<bundle>/<path> link between colocated siblings, the canonical location otherwise) so the source graph stays navigable, then log the change and regenerate indexes in both bundles",
        inputSchema: {
          id: z
            .string()
            .describe("Concept ID or source-bundle-relative path, e.g. standards/naming"),
          fromBundle: z.string().describe("Source bundle ID; must be writable"),
          toBundle: z
            .string()
            .describe("Target bundle ID; must be writable and differ from fromBundle"),
          toPath: z
            .string()
            .optional()
            .describe(
              "Target-bundle-relative path ending in .md; defaults to suggest_concept_path-style placement with the original filename",
            ),
          stub: z
            .boolean()
            .optional()
            .describe(
              "Leave a citation stub at the old path (default true); false deletes the source copy and just reports the inbound links left dangling",
            ),
        },
      },
      async ({ id, fromBundle, toBundle, toPath, stub }) => {
        const source = await store.bundle(fromBundle);
        const target = await store.bundle(toBundle);
        assertWritableBundle(source);
        assertWritableBundle(target);
        const result = await promoteConcept(source, target, id, {
          ...(toPath !== undefined && { toPath }),
          ...(stub !== undefined && { stub }),
        });
        const label = result.title ?? result.id;
        await logAndReindex(
          source,
          `**Update**: Promoted [${label}](/${result.from}) to bundle "${target.id}" (${result.citation}).`,
          [result.from],
        );
        await logAndReindex(
          target,
          `**Creation**: Promoted [${label}](/${result.to}) from bundle "${source.id}".`,
          [result.to],
        );
        return json({ ...result, uri: okfUri(target.id, result.to) });
      },
    );

    server.registerTool(
      "append_log_entry",
      {
        title: "Append log entry",
        description:
          "Record a change-narrative entry in a log.md (spec §7) — the bundle root's by default, or a per-directory scope — without touching any concept",
        inputSchema: {
          bundle: bundleParam,
          message: z
            .string()
            .min(1)
            .describe(
              "One-line markdown entry; conventionally starts with a bold verb like **Update**: or **Deprecation**:",
            ),
          directory: z
            .string()
            .optional()
            .describe(
              "Bundle-relative directory whose log.md receives the entry (created when absent), e.g. tables; defaults to the bundle root",
            ),
        },
      },
      async ({ bundle, message, directory }) => {
        const target = await store.bundle(bundle);
        assertWritableBundle(target);
        const { path: logPath } = await appendLogEntry(target.root, message, {
          ...(directory !== undefined && { directory }),
        });
        await store.reloadBundle(target.id);
        return json({ bundle: target.id, path: logPath, uri: okfUri(target.id, logPath) });
      },
    );

    server.registerTool(
      "regenerate_indexes",
      {
        title: "Regenerate indexes",
        description:
          "Rewrite index.md files in every bundle directory from concept frontmatter (spec §6); hand-curated indexes (frontmatter `generated: false`) are skipped and reported",
        inputSchema: { bundle: bundleParam },
      },
      async ({ bundle }) => {
        const target = await store.bundle(bundle);
        assertWritableBundle(target);
        const { written, skipped } = await generateIndexes(target);
        await store.reloadBundle(target.id);
        return json({ bundle: target.id, written, skipped });
      },
    );
  }

  return server;
}
