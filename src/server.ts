import fs from "node:fs/promises";
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
import {
  buildGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
} from "./graph.js";
import { searchConcepts } from "./search.js";
import type { OkfStore } from "./store.js";
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
      const bundle = store.bundle(String(variables.bundle));
      const relPath = path.posix.normalize(String(variables.path));
      if (relPath.startsWith("..") || path.posix.isAbsolute(relPath)) {
        throw new Error(`invalid document path: ${relPath}`);
      }
      const text = await fs.readFile(path.join(bundle.root, relPath), "utf8");
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
    async ({ bundle, pathPrefix, type }) => {
      const bundles = bundle !== undefined ? [store.bundle(bundle)] : store.bundles();
      return json(
        searchConcepts(bundles, {
          ...(pathPrefix !== undefined && { pathPrefix }),
          ...(type !== undefined && { types: [type] }),
          limit: 500,
        }).hits.map(({ score: _score, ...hit }) => hit),
      );
    },
  );

  server.registerTool(
    "get_concept",
    {
      title: "Get concept",
      description:
        "Read one concept document: frontmatter, markdown body, and its outgoing links",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
      },
    },
    async ({ bundle, id }) => {
      const concept = store.getConcept(bundle, id);
      if (!concept) throw new Error(`unknown concept: ${id}`);
      return json(concept);
    },
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
    async ({ bundle, ...filters }) => {
      const bundles = bundle !== undefined ? [store.bundle(bundle)] : store.bundles();
      return json(searchConcepts(bundles, filters));
    },
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

  server.registerTool(
    "validate_bundle",
    {
      title: "Validate bundle",
      description: "Report OKF v0.1 conformance errors and soft warnings",
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) => {
      const targets = bundle !== undefined ? [store.bundle(bundle)] : store.bundles();
      return json(await Promise.all(targets.map(validateBundle)));
    },
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
        const written = await generateIndexes(target);
        await store.reloadBundle(target.id);
        return json({ bundle: target.id, written });
      },
    );
  }

  return server;
}
