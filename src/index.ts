/**
 * Public API of okf-mcp: load OKF bundles, query them, serve them over MCP.
 *
 * This barrel is the package's semver-covered library surface, curated
 * deliberately for 1.0: embedding the server, loading bundles, querying
 * (search/graph/validate), and the high-level authoring write path.
 * Deeper internals (parser sections, frontmatter splicing, remote/pack/
 * repair/visualize/watch machinery) are intentionally not exported —
 * reach them through the MCP server or the CLI, which are the stable
 * surfaces for that functionality.
 */

export {
  appendLogEntry,
  generateIndexes,
  updateConcept,
  writeConcept,
} from "./authoring.js";
export type {
  AppendLogEntryOptions,
  GenerateIndexesResult,
  SkippedIndex,
  UpdateConceptInput,
  UpdateConceptResult,
  WriteConceptOptions,
} from "./authoring.js";
export { buildBundle, loadBundle } from "./bundle.js";
export type { BuildBundleOptions, BundleDocument } from "./bundle.js";
export { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, loadOkfConfig, userConfigDir } from "./config.js";
export type {
  DiscoverConfigOptions,
  OkfConfigFile,
  ResolvedColocatedRoot,
  ResolvedConfig,
} from "./config.js";
export {
  buildGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
  listTags,
  listTypes,
} from "./graph.js";
export type {
  ConceptGraph,
  Direction,
  GraphEdge,
  GraphFormat,
  GraphNode,
  GraphOptions,
  GraphSummary,
  NeighborsResult,
  TagCount,
  TypeCount,
} from "./graph.js";
export { parseConceptDocument } from "./parser.js";
export type { ParsedConceptDocument } from "./parser.js";
export { searchConcepts } from "./search.js";
export type { SearchFilters, SearchHit, SearchResult } from "./search.js";
export { createOkfServer } from "./server.js";
export type { BundleGuide, ServerOptions } from "./server.js";
export { OkfStore } from "./store.js";
export type {
  BundleReloadStats,
  DiscoveredBundle,
  OkfStoreOptions,
} from "./store.js";
export { suggestConceptPath } from "./suggest.js";
export type { PathSuggestion, SuggestPathInput } from "./suggest.js";
export { okfUri, OKF_VERSION, RESERVED_FILENAMES } from "./types.js";
export type {
  BundleConfig,
  BundleProblem,
  ColocatedRemoteRootConfig,
  Concept,
  ConceptFrontmatter,
  ConceptLink,
  LinkKind,
  LoadedBundle,
  RemoteBundleConfig,
  ReservedFile,
} from "./types.js";
export { validateBundle } from "./validate.js";
export type { ValidationReport } from "./validate.js";
