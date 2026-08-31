import path from "node:path";

import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  appendLogEntry,
  bundleVocabulary,
  deleteConcept,
  generateIndexes,
  nearestLogDirectory,
  renameConcept,
  renderIndexes,
  updateConcept,
  writeConcept,
} from "./authoring.js";
import { readBundleDocument, readColocatedAgentsGuide } from "./bundle.js";
import { fileDiff, fileHistory, isGitWorkTree } from "./git.js";
import type { GraphNode, GraphSummary, NeighborsResult } from "./graph.js";
import {
  buildGraph,
  buildMultiGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphShape,
  graphSummary,
  listTags,
  listTypes,
  neighborsInGraph,
  pathInGraph,
  qualifyNodeId,
} from "./graph.js";
import { deriveTitle, extractSection, splitSections } from "./parser.js";
import { promoteConcept } from "./promote.js";
import {
  conceptSources,
  defaultActor,
  footnoteLabels,
  generatedAt,
  isStale,
  trustTier,
  usageWindowFor,
} from "./provenance.js";
import { DEFAULT_CUTOFF_RATIO, DEFAULT_SEARCH_LIMIT, searchConcepts } from "./search.js";
import type { ColocatedRootMount, OkfStore } from "./store.js";
import { suggestConceptPath } from "./suggest.js";
import type { ConceptFrontmatter, ConceptStatus, LoadedBundle } from "./types.js";
import { CONCEPT_STATUSES, okfUri } from "./types.js";
import type { ValidationReport } from "./validate.js";
import { validateBundle } from "./validate.js";
import { PACKAGE_VERSION } from "./version.js";

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
  /**
   * Default hits per search_concepts page when a call passes no `limit`
   * (`--search-limit`). Default DEFAULT_SEARCH_LIMIT.
   */
  searchLimit?: number;
  /**
   * Relevance cutoff ratio for search_concepts text queries: hits under this
   * fraction of the top hit's score are dropped and counted in `omitted`
   * (`--search-cutoff`); 0 disables. Default DEFAULT_CUTOFF_RATIO.
   */
  searchCutoff?: number;
  /**
   * Actor recorded as `generated.by` on every write (spec §5.2, §7). Defaults
   * to SERVER_ACTOR — `okf-mcp/<version>`, the §7 `<producer>/<version>` form.
   * Deployments that want writes attributed to the agent driving the server,
   * or to a named process, set this in okf.config.json (`actor`) or with
   * `--actor`. It is never `human:` by default: the server is not a person,
   * and §5.3 derives the human-reviewed trust tier from that prefix.
   */
  actor?: string;
}

/** This server's own actor id, used when nothing else is configured (spec §7). */
export const SERVER_ACTOR = defaultActor(PACKAGE_VERSION);

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
function serverInstructions(options: ServerOptions, mounted: boolean): string {
  const shared = `This server exposes OKF (Open Knowledge Format) bundles: directories of markdown
concept documents with YAML frontmatter (type, title, tags), indexed into a link graph.
A concept's ID is its bundle-relative path without the .md extension (e.g. tables/orders).
Relationships are ordinary markdown links in the body; prefer document-relative
links, e.g. [Orders](../tables/orders.md) — they render correctly everywhere the
bundle is published (GitHub resolves a leading-/ link from the repository root, so
bundle-absolute links break when the bundle is a repo subfolder).
index.md and log.md are reserved, generated files.

Reading: search_concepts is the entry point (its own description covers the
filters, paging, and \`omitted\`); reserve list_concepts for when the whole
catalog is genuinely needed. Read sections, not whole documents: get_concept's
\`section\` argument returns one heading's subtree, \`outline: true\` lists
sections without the body, and a search hit's \`section\` / \`matchedSections\`
feed \`section\` directly. Explore with get_neighbors / find_path.

Orient once per session, not once per task: graph_summary, list_types /
list_tags, list_bundles, and get_bundle_guide (when listed, call it before
exploring — it says what each mounted bundle is for) rarely change mid-session;
don't repeat them, and don't re-fire them in subagents that already inherit
their answers. Colocated bundles may be discovered but not loaded yet (lazy
mounting): list_bundles marks them loaded: false, any tool naming one loads it,
and no-arg sweeps cover loaded bundles only, noting what they excluded. If
bundle files may have changed outside this server (e.g. a human editing in
Obsidian), call reload_bundles before relying on current state.`;
  const writing = `Writing: call suggest_concept_path before creating a concept so placement matches
where similar concepts live, and reuse existing types/tags. Prefer update_concept
for partial edits — it patches frontmatter keys and/or one body section, preserving
the rest of the document — over full write_concept rewrites. The write tools keep
index.md navigation and log.md history current; never edit those reserved files
directly. Use append_log_entry for narrative not tied to one write, promote_concept
when knowledge outgrows its bundle (project → org).
Record provenance in the frontmatter \`sources\` list (spec §5.1): each entry needs a
\`resource\`, plus an \`id\` when the body cites it via a footnote keyed to that id
(\`...sharded daily.[^ga4-schema]\`). Set \`status\` (draft/stable/deprecated) and
\`stale_after\` when a concept has a shelf life; record sign-off as
\`verified: {by: human:<id>, at: <ISO>}\` — the \`human:\` prefix is what makes it
human-reviewed (§5.3). The server stamps \`generated\` itself; pass \`actor\` to credit
someone else. Bundles declaring okf_version 0.1 keep the legacy \`timestamp\` and
\`# Citations\` form; \`okf-mcp migrate\` converts one. Remote bundles are always
read-only, and a local bundle may be read-only too — check list_bundles' readOnly
before planning a write.`;
  const authoring = options.writable
    ? writing
    : "This server is read-only; authoring tools are not available.";
  // Only the first root's guide is injected (renderBundleGuide caps it at
  // BUNDLE_GUIDE_BUDGET); every further root costs one pointer line, so the
  // instructions stay bounded no matter how many roots are mounted.
  const [firstGuide, ...restGuides] = options.bundleGuides ?? [];
  const guides = firstGuide === undefined ? [] : [renderBundleGuide(firstGuide)];
  for (const guide of restGuides) {
    guides.push(
      `Bundle root ${path.dirname(guide.source)} has a guide — call get_bundle_guide before exploring it.`,
    );
  }
  // Say it up front rather than letting the agent infer it from empty sweeps.
  const empty =
    mounted === false
      ? [
          `No bundles are mounted for this working directory, so every read returns
nothing. This is configuration, not an error or an empty knowledge base: bundles
are declared in an okf.config.json beside the project, or in the user config
(~/.config/okf/config.json) to mount them in every directory. Tell the user that
rather than reporting the knowledge base as empty.`,
        ]
      : [];
  return [shared, ...empty, authoring, ...guides].join("\n\n");
}

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function markdown(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Most orphan ids graph_summary returns inline; the full list stays queryable. */
const ORPHAN_CAP = 25;

/** Most problems validate_bundle returns per list; totals still count them all. */
const PROBLEM_CAP = 50;

/** Most diff lines concept_diff returns (concept_history caps commits at 200 too). */
const DIFF_LINE_CAP = 200;

/** Concepts list_concepts returns per page unless the caller asks for more. */
const DEFAULT_LIST_LIMIT = 50;

/**
 * The one truncation contract every cap site speaks: slice `items` at `cap`,
 * always report the true `total`, and flag the cut with `truncated`. A caller
 * that wants a steering note passes a builder, which runs only when the slice
 * dropped something. Call sites spread the pieces under their own field names,
 * but the shape is the same everywhere: `truncated` means the list was cut,
 * and the true total is always present alongside it.
 */
function capList<T>(items: T[], cap: number, note?: (total: number) => string) {
  const truncated = items.length > cap;
  return {
    items: truncated ? items.slice(0, cap) : items,
    total: items.length,
    truncated,
    ...(truncated && note !== undefined && { note: note(items.length) }),
  };
}

/**
 * Cap a graph summary's orphan list: `orphanCount` is always the true count,
 * `orphans` holds at most ORPHAN_CAP ids, and a truncated list points at the
 * query that returns the rest.
 */
function capOrphans({ orphans, ...rest }: GraphSummary) {
  const capped = capList(
    orphans,
    ORPHAN_CAP,
    () => "truncated; list all via search_concepts {orphanOnly: true}",
  );
  return {
    ...rest,
    orphanCount: capped.total,
    orphans: capped.items,
    ...(capped.truncated && { note: capped.note }),
  };
}

/**
 * Cap a validation report's problem lists at PROBLEM_CAP each. The true
 * totals are always present; a capped report adds a note so the truncation
 * is visible.
 */
function capProblems(report: ValidationReport) {
  const errors = capList(report.errors, PROBLEM_CAP);
  const warnings = capList(report.warnings, PROBLEM_CAP);
  return {
    ...report,
    errors: errors.items,
    warnings: warnings.items,
    errorsTotal: errors.total,
    warningsTotal: warnings.total,
    ...((errors.truncated || warnings.truncated) && {
      note: `showing first ${PROBLEM_CAP} per list; fix these first`,
    }),
  };
}

/** Most nodes get_neighbors returns; a deep expansion around a hub truncates. */
const NEIGHBOR_NODE_CAP = 50;

/** Most nodes / edges export_graph returns in ids and full JSON modes. */
const GRAPH_NODE_CAP = 300;
const GRAPH_EDGE_CAP = 600;

/**
 * Shape a neighbors result for the wire: cap the node list at
 * NEIGHBOR_NODE_CAP (dropping edges into the cut, with a one-clause steering
 * note), and slim each node to id + title + type unless detail is "full".
 */
function capNeighbors(result: NeighborsResult, detail: "concise" | "full") {
  // The center is always nodes[0] (BFS starts there), so it survives the cap.
  const capped = capList(
    result.nodes,
    NEIGHBOR_NODE_CAP,
    (total) =>
      `showing ${NEIGHBOR_NODE_CAP} of ${total} nodes; lower depth or narrow direction`,
  );
  const nodes = capped.items;
  const kept = new Set(nodes.map((n) => n.id));
  const slim = ({ id, title, type }: GraphNode) => ({
    id,
    ...(title !== undefined && { title }),
    type,
  });
  return {
    center: result.center,
    depth: result.depth,
    nodesTotal: capped.total,
    nodes: detail === "full" ? nodes : nodes.map(slim),
    edges: capped.truncated
      ? result.edges.filter((e) => kept.has(e.from) && kept.has(e.to))
      : result.edges,
    ...(capped.truncated && { note: capped.note }),
  };
}

const bundleParam = z
  .string()
  .optional()
  .describe("Bundle ID; may be omitted when exactly one bundle is configured");

/**
 * The shared read-verbosity ladder ("detail"): responses are concise by
 * default and "full" restores every field a leaner default drops.
 */
const detailParam = (description: string) =>
  z.enum(["concise", "full"]).optional().describe(description);

// Marks an entry-point tool: clients with deferred tool loading keep its
// schema visible while the rest of the toolset loads on demand.
const entryPointMeta = { "anthropic/alwaysLoad": true };

function assertWritableBundle(bundle: { id: string; readOnly: boolean }): void {
  if (bundle.readOnly) {
    throw new Error(
      `bundle "${bundle.id}" is read-only (remote, or config "writable": false) — pick a writable bundle`,
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
    { name: "okf-mcp", version: PACKAGE_VERSION },
    {
      instructions: serverInstructions(
        options,
        store.bundles().length > 0 || store.discoveredBundles().length > 0,
      ),
    },
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
        `excluded ${excluded.length} unloaded bundle(s): ` +
        `${excluded.map((d) => d.id).join(", ")} — name one as \`bundle\` to load it`,
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
        "List configured OKF bundles with concept counts and each bundle's declared description (its one-line purpose). Bundles with `loaded: false` were discovered under a colocated root but not yet parsed — any tool naming one loads it on the spot. The answer rarely changes mid-session: call once and reuse it rather than re-listing.",
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
          reservedFileCount: bundle.reserved.length,
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
        "Describes what each mounted bundle is for and which to use for what work: each colocated root's AGENTS.md guide in full (read on demand, never truncated) plus every bundle's one-line description. Call once before choosing which bundles to search or explore — not again once its answer is in context.",
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
        "Re-read bundles from disk to pick up external edits (e.g. a human editing in Obsidian). With no bundle id it also re-runs config discovery, so an okf.config.json added or edited after the server started takes effect: newly declared bundles mount (reported under `mounted` and as an all-added delta), removed ones unmount (`unmounted`), and the rest reload their content. Returns `{ mounted, unmounted, bundles }` (and `notes` when relevant). Naming a bundle id skips discovery and reloads just that bundle, returning its delta directly.",
      inputSchema: {
        bundle: z
          .string()
          .optional()
          .describe(
            "Bundle ID to reload; omitted reloads all loaded bundles and re-runs config discovery",
          ),
      },
    },
    async ({ bundle }) => {
      if (bundle !== undefined) return json(await store.reloadBundles(bundle));
      const result = await store.reloadWithRediscovery();
      // A rediscovered config may have added or removed a colocated root, which
      // flips get_bundle_guide's visibility.
      syncBundleGuideTool();
      const notes = [...result.problems];
      // hasWritableBundle can only turn true after startup here: a config
      // declaring a writable bundle at launch already flips the server-wide
      // gate on. So this fires exactly when re-discovery mounted a writable
      // bundle the read-only server cannot author until it restarts.
      if (options.writable !== true && store.hasWritableBundle()) {
        notes.push(
          'a mounted bundle declares "writable": true, but this server started read-only; restart it to enable authoring tools for that bundle',
        );
      }
      return json({
        mounted: result.mounted,
        unmounted: result.unmounted,
        ...(notes.length > 0 && { notes }),
        bundles: result.stats,
      });
    },
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
        "Enumerate concepts (ID, type, title, description, resource, tags) with optional filtering. Prefer search_concepts to find concepts relevant to a task; reach for this only when the whole catalog (or a whole subtree/type) is genuinely needed.",
      inputSchema: {
        bundle: bundleParam,
        pathPrefix: z.string().optional().describe("Concept ID prefix, e.g. tables/"),
        type: z.string().optional().describe("Only this frontmatter type"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(`Concepts per page (default ${DEFAULT_LIST_LIMIT})`),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Skip this many concepts; page until `total` is reached"),
      },
    },
    async ({ bundle, pathPrefix, type, limit, offset }) => {
      const { hits, total } = searchConcepts(await selectBundles(bundle), {
        ...(pathPrefix !== undefined && { pathPrefix }),
        ...(type !== undefined && { types: [type] }),
        limit: limit ?? DEFAULT_LIST_LIMIT,
        ...(offset !== undefined && { offset }),
      });
      return sweepJson(
        { total, hits: hits.map(({ score: _score, ...hit }) => hit) },
        bundle === undefined,
      );
    },
  );

  server.registerTool(
    "get_concept",
    {
      title: "Get concept",
      description:
        "Read one concept document: frontmatter, markdown body, and its body section headings. Prefer partial reads over the full document: `section` fetches one heading's subtree, `outline: true` fetches the document's shape (section headings with sizes) without the body. Outgoing link arrays (with char offsets) return only with detail: \"full\".",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
        section: z
          .string()
          .optional()
          .describe(
            "Body section heading (case-insensitive), e.g. Schema; returns just that section (including its subsections) instead of the full body",
          ),
        outline: z
          .boolean()
          .optional()
          .describe(
            "Return the document's shape instead of its body: frontmatter plus each section's heading, level, and content size in characters — cheap section discovery before fetching one with `section`",
          ),
        detail: detailParam(
          'concise (default) omits the outgoing-link offset arrays; "full" includes them',
        ),
      },
      _meta: entryPointMeta,
    },
    async ({ bundle, id, section, outline, detail }) => {
      const concept = await store.getConcept(bundle, id);
      if (!concept) throw new Error(`unknown concept: ${id}`);
      const split = splitSections(concept.body);
      const sections = split.map((s) => s.heading);
      const full = detail === "full";
      // Concise (the default) drops the link arrays with their char offsets;
      // "full" restores the pre-2.0 shapes (body mode carried both arrays,
      // outline/section modes carried frontmatterLinks).
      const { body, links, frontmatterLinks, ...meta } = concept;
      const rest = full ? { ...meta, frontmatterLinks } : meta;
      if (outline === true && section === undefined) {
        return json({
          ...rest,
          sections: split.map((s) => ({
            heading: s.heading,
            level: s.level,
            chars: s.content.length,
          })),
        });
      }
      if (section === undefined) {
        return json({ ...rest, ...(full && { links }), body, sections });
      }
      const match = extractSection(concept.body, section);
      if (!match) {
        throw new Error(
          `no section "${section}" in "${concept.id}" — sections: ${sections.join(", ") || "(none)"}`,
        );
      }
      return json({ ...rest, section: match, sections });
    },
  );

  server.registerTool(
    "get_sources",
    {
      title: "Get sources",
      description:
        "A concept's provenance: its frontmatter `sources` entries (spec §5.1) with their credibility signals (`author`, `usage_count` over the applicable `usage_window`, `last_modified`), which body footnotes cite each entry, and the concept's derived trust tier and staleness. For a v0.1 document with no `sources`, entries are synthesized from its legacy `# Citations` list and marked `origin: \"citations\"`",
      inputSchema: {
        bundle: bundleParam,
        id: z.string().describe("Concept ID, e.g. tables/orders"),
      },
    },
    async ({ bundle, id }) => {
      const concept = await store.getConcept(bundle, id);
      if (!concept) throw new Error(`unknown concept: ${id}`);
      const { sources, origin } = conceptSources(concept);
      const { referenced } = footnoteLabels(concept.body);
      return json({
        origin,
        trust: trustTier(concept.frontmatter),
        stale: isStale(concept.frontmatter),
        ...(generatedAt(concept.frontmatter) !== undefined && {
          generatedAt: generatedAt(concept.frontmatter),
        }),
        sources: sources.map((entry) => ({
          ...entry,
          ...(usageWindowFor(concept.frontmatter, entry) !== undefined && {
            usage_window: usageWindowFor(concept.frontmatter, entry),
          }),
          // Whether the body actually attributes a claim to this entry, which
          // is the difference between a cited source and a listed one.
          cited: entry.id !== undefined && referenced.has(entry.id),
        })),
      });
    },
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read the raw file text of any bundle document by path — reserved files (index.md, log.md) as well as concepts; for concepts prefer get_concept outline/section reads. `startLine`/`endLine` return just that slice with a `totalLines` count. A missing index.md is synthesized from frontmatter (spec §6) and marked with `synthesized: true` in the result",
      inputSchema: {
        bundle: bundleParam,
        path: z
          .string()
          .describe("Bundle-relative path, e.g. log.md or tables/orders.md"),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("First line to return (1-based, inclusive)"),
        endLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Last line to return (1-based, inclusive)"),
      },
    },
    async ({ bundle, path: relPath, startLine, endLine }) => {
      const { text, synthesized } = await readDocument(bundle, relPath);
      if (startLine === undefined && endLine === undefined) {
        return { ...markdown(text), ...(synthesized && { synthesized: true }) };
      }
      const lines = text.split("\n");
      const slice = lines.slice((startLine ?? 1) - 1, endLine ?? lines.length);
      return {
        ...markdown(slice.join("\n")),
        totalLines: lines.length,
        ...(synthesized && { synthesized: true }),
      };
    },
  );

  server.registerTool(
    "search_concepts",
    {
      title: "Search concepts",
      description:
        `The entry point for finding concepts: text query plus type/tag/path/link/resource filters and the v0.2 lifecycle/trust filters (status, minTrust, stale). Query keywords match independently across id, title, description, resource, tags, and body; concepts matching every keyword rank first (termMatching: "any" flags a fallback to partial matches). A body-matched hit names the matching \`section\` (and \`matchedSections\` when several matched). Hits are concise by default (detail: "full" adds score/matchedIn and status/trust/stale), relevance-sorted, and paginated: \`total\` counts all matches, so page on with \`offset\` if the first page did not answer — later pages are strictly less relevant. \`omitted\` counts low-relevance matches suppressed by the relevance cutoff — refine the query or filters to reach them. When nothing matches, tagHints lists existing tags related to the keywords — retry with tagsAny.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Whitespace-separated keywords, matched case-insensitively; prefer a few short keywords over full sentences",
          ),
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
        status: z
          .array(z.enum(CONCEPT_STATUSES as unknown as [ConceptStatus, ...ConceptStatus[]]))
          .optional()
          .describe(
            "Lifecycle statuses to keep (spec §5.4). A concept with no `status` counts as stable, so [\"stable\"] includes every undeclared concept",
          ),
        minTrust: z
          .enum(["unverified", "machine-confirmed", "human-reviewed"])
          .optional()
          .describe(
            "Minimum trust tier derived from `verified` (spec §5.3) — use human-reviewed when only signed-off knowledge will do",
          ),
        stale: z
          .boolean()
          .optional()
          .describe(
            "true keeps only concepts past their `stale_after`, false drops them (spec §5.5)",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe(
            `Hits per page (default ${options.searchLimit ?? DEFAULT_SEARCH_LIMIT}); page with offset when total exceeds the returned count`,
          ),
        offset: z.number().int().nonnegative().optional(),
        detail: detailParam(
          'concise (default) omits score, matchedIn, status, trust, stale per hit; "full" keeps them',
        ),
      },
      _meta: entryPointMeta,
    },
    async ({ bundle, detail, ...filters }) => {
      const result = searchConcepts(await selectBundles(bundle), {
        ...filters,
        limit: filters.limit ?? options.searchLimit ?? DEFAULT_SEARCH_LIMIT,
        cutoffRatio: options.searchCutoff ?? DEFAULT_CUTOFF_RATIO,
      });
      const shaped =
        detail === "full"
          ? result
          : {
              ...result,
              hits: result.hits.map(
                ({
                  score: _score,
                  matchedIn: _matchedIn,
                  status: _status,
                  trust: _trust,
                  stale: _stale,
                  ...hit
                }) => hit,
              ),
            };
      return sweepJson(shaped, bundle === undefined);
    },
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
        `Compact overview of a bundle's link graph: counts, types, tags, orphans (first ${ORPHAN_CAP} plus an \`orphanCount\`; list all via search_concepts with orphanOnly), derived cross-bundle edge count. Call this before broader graph exploration.`,
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      sweepJson(
        bundle !== undefined
          ? capOrphans(graphSummary(await store.bundle(bundle), store.bundles()))
          : store.bundles().map((b) => capOrphans(graphSummary(b, store.bundles()))),
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
        `Concepts linked to/from a concept, expanded to a bounded depth (capped at ${NEIGHBOR_NODE_CAP} nodes; depth 3+ around a hub concept mostly returns truncation — prefer depth 1-2). With crossBundle, derived edges into other mounted bundles are traversed too, with bundle:concept node IDs.`,
      inputSchema: {
        bundle: bundleParam,
        id: z.string(),
        direction: z.enum(["in", "out", "both"]).optional(),
        depth: z.number().int().positive().max(5).optional(),
        crossBundle: crossBundleParam,
        detail: detailParam(
          'concise (default): nodes as id + title + type; "full" adds bundle, path, description, tags',
        ),
      },
    },
    async ({ bundle, id, direction, depth, crossBundle, detail }) =>
      json(
        capNeighbors(
          crossBundle
            ? neighborsInGraph(
                buildMultiGraph(store.bundles()),
                await qualifyForCrossBundle(bundle, id),
                direction ?? "both",
                depth ?? 1,
              )
            : getNeighbors(await store.bundle(bundle), id, direction ?? "both", depth ?? 1),
          detail ?? "concise",
        ),
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
        `Export a bundle's link graph — can be large, so json climbs a detail ladder: summary (default: counts + hub nodes), ids (bare node ids, [from, to] edge pairs), full (complete nodes/edges, capped at ${GRAPH_NODE_CAP}/${GRAPH_EDGE_CAP}). dot and mermaid render the whole graph as text, uncapped and potentially large. With crossBundle, all mounted bundles export as one graph with bundle:concept node IDs and visually distinct derived edges.`,
      inputSchema: {
        bundle: bundleParam,
        format: z.enum(["json", "dot", "mermaid"]).optional(),
        detail: z
          .enum(["summary", "concise", "ids", "full"])
          .optional()
          .describe(
            'json format only — summary (default; "concise" is an alias, matching the read tools\' ladder): counts + hubs; ids: bare ids and [from, to] pairs; full: complete nodes/edges',
          ),
        includeExternal: z
          .boolean()
          .optional()
          .describe("Include external link targets as opaque nodes"),
        crossBundle: crossBundleParam,
      },
    },
    async ({ bundle, format, detail, includeExternal, crossBundle }) => {
      const options = { includeExternal: includeExternal ?? false };
      const graph = crossBundle
        ? buildMultiGraph(store.bundles(), options)
        : buildGraph(await store.bundle(bundle), options);
      const chosenFormat = format ?? "json";
      if (chosenFormat !== "json") return markdown(exportGraph(graph, chosenFormat));
      const level = detail === "concise" ? "summary" : (detail ?? "summary");
      if (level === "summary") return json(graphShape(graph));
      // Slice nodes first, then keep only edges whose endpoints survived: a
      // capped export must still be a self-contained graph, so edges into the
      // truncated remainder are dropped and counted as truncated in the note.
      const nodes = graph.nodes.slice(0, GRAPH_NODE_CAP);
      const kept = new Set(nodes.map((n) => n.id));
      const reachable =
        nodes.length < graph.nodes.length
          ? graph.edges.filter((e) => kept.has(e.from) && kept.has(e.to))
          : graph.edges;
      const edges = reachable.slice(0, GRAPH_EDGE_CAP);
      const truncated = nodes.length < graph.nodes.length || edges.length < graph.edges.length;
      const totals = {
        nodesTotal: graph.nodes.length,
        edgesTotal: graph.edges.length,
        ...(truncated && {
          note:
            `showing ${nodes.length} of ${graph.nodes.length} nodes and ` +
            `${edges.length} of ${graph.edges.length} edges; filter (bundle, ` +
            `includeExternal: false) or use detail: "summary"`,
        }),
      };
      if (level === "ids") {
        return json({
          nodes: nodes.map((n) => n.id),
          edges: edges.map((e) =>
            e.kind !== undefined ? [e.from, e.to, e.kind] : [e.from, e.to],
          ),
          ...totals,
        });
      }
      return json({ nodes, edges, warnings: graph.warnings, ...totals });
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
      const diff = await fileDiff(target.root, concept.path, ref);
      const lines = diff.split("\n");
      if (lines.length <= DIFF_LINE_CAP) return markdown(diff);
      return markdown(
        `${lines.slice(0, DIFF_LINE_CAP).join("\n")}\n` +
          `[diff truncated: first ${DIFF_LINE_CAP} of ${lines.length} lines]`,
      );
    },
  );

  server.registerTool(
    "validate_bundle",
    {
      title: "Validate bundle",
      description:
        `Report OKF v0.2 conformance errors and soft warnings; each list is capped at ${PROBLEM_CAP} per bundle, with errorsTotal/warningsTotal carrying the true counts`,
      inputSchema: { bundle: bundleParam },
    },
    async ({ bundle }) =>
      sweepJson(
        (
          await Promise.all(
            (await selectBundles(bundle)).map((b) => validateBundle(b, store.bundles())),
          )
        ).map(capProblems),
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
              'YAML frontmatter; `type` is required, extra keys are preserved, e.g. {type: "table", title: "Orders", description: "Daily order facts.", tags: ["sales"], sources: [{resource: "https://x.co/doc", id: "doc"}]}. `generated: {by, at}` defaults to this server\'s actor and the current UTC time (supply one to backdate or to credit a different actor); lifecycle goes in `status`/`stale_after` (§5.4-5.5), sign-off in `verified` (§5.2). In a bundle declaring okf_version 0.1 the legacy `timestamp` is stamped instead',
            ),
          body: z
            .string()
            .describe(
              "Markdown body. Attribute a claim to a `sources` entry with a markdown footnote whose label is that entry's `id` (spec §5.1), e.g. `...sharded daily.[^ga4-schema]`. In a v0.1 bundle, cite under a `# Citations` heading as `[n] [text](target)` entries instead; ordered-list entries like `1. [text](target)` are normalized to that form",
            ),
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
          { vocabulary: bundleVocabulary(target), actor: options.actor ?? SERVER_ACTOR },
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
          "Partially update a concept without rewriting the whole document: shallow-merge a frontmatter patch and/or replace one body section by heading. Everything not named in the update — other frontmatter keys, YAML comments and formatting, the rest of the body — is preserved byte-for-byte, except `generated`, which refreshes to this server's actor and the current UTC time (spec §5.2: last meaningful change) unless pinned via the patch or `keepGenerated`. A bundle declaring okf_version 0.1 gets its legacy `timestamp` refreshed instead. Appends a log.md entry and regenerates index.md files.",
        inputSchema: {
          bundle: bundleParam,
          id: z.string().describe("Concept ID or bundle-relative path, e.g. tables/orders"),
          frontmatter: z
            .record(z.unknown())
            .optional()
            .describe(
              'Frontmatter keys to set/overwrite; an explicit null deletes a key, e.g. {description: "Daily order facts.", tags: ["sales"], sources: [{resource: "https://x.co/doc", id: "doc"}], stale_after: null}. Including `generated` or `timestamp` (a value, or null to delete) overrides the default refresh',
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
                .describe(
                  "New markdown content for the section; the existing heading line is kept (a leading heading repeating it is stripped, never duplicated) and legacy Citations entries are normalized to the `[n] [text](target)` form (v0.1 §8)",
                ),
            })
            .optional()
            .describe("Replace one body section, leaving the rest of the body untouched"),
          keepGenerated: z
            .boolean()
            .optional()
            .describe(
              "Preserve the existing `generated` record (or a v0.1 `timestamp`) byte-for-byte instead of refreshing it to now",
            ),
          keepTimestamp: z
            .boolean()
            .optional()
            .describe("Deprecated alias for `keepGenerated`"),
          actor: z
            .string()
            .optional()
            .describe(
              "Actor to record as `generated.by` for this write (spec §7: `human:<id>`, `process:<id>`, or `<producer>/<version>`). Defaults to the server's configured actor",
            ),
          logMessage: z
            .string()
            .optional()
            .describe("Entry for log.md; a default is generated when omitted"),
        },
      },
      async ({
        bundle,
        id,
        frontmatter,
        section,
        keepGenerated,
        keepTimestamp,
        actor,
        logMessage,
      }) => {
        const target = await store.bundle(bundle);
        assertWritableBundle(target);
        const result = await updateConcept(target, id, {
          ...(frontmatter !== undefined && { frontmatter }),
          ...(section !== undefined && { section }),
          ...(keepGenerated !== undefined && { keepGenerated }),
          ...(keepTimestamp !== undefined && { keepTimestamp }),
          actor: actor ?? options.actor ?? SERVER_ACTOR,
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
          actor: options.actor ?? SERVER_ACTOR,
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
