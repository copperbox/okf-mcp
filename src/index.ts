/** Public API of okf-mcp: load OKF bundles, query them, serve them over MCP. */

export {
  appendLogEntry,
  assertSafeConceptPath,
  generateIndexes,
  readDeclaredVersion,
  writeConcept,
} from "./authoring.js";
export type { WriteConceptOptions } from "./authoring.js";
export { buildBundle, loadBundle, readBundleDocument } from "./bundle.js";
export type { BuildBundleOptions, BundleDocument } from "./bundle.js";
export { serializeDocument, splitFrontmatter } from "./frontmatter.js";
export type { FrontmatterSplit } from "./frontmatter.js";
export {
  buildGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
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
} from "./graph.js";
export { conceptIdFromPath, extractLinks, parseConceptDocument } from "./parser.js";
export type { ParsedConceptDocument } from "./parser.js";
export {
  loadRemoteBundle,
  MAX_REMOTE_BYTES,
  MAX_REMOTE_FILES,
  parseGitHubTreeUrl,
} from "./remote.js";
export type { GitHubTreeRef } from "./remote.js";
export { searchConcepts } from "./search.js";
export type { SearchFilters, SearchHit, SearchResult } from "./search.js";
export { createOkfServer } from "./server.js";
export type { ServerOptions } from "./server.js";
export { OkfStore } from "./store.js";
export type { BundleReloadStats, OkfStoreOptions } from "./store.js";
export { okfUri, OKF_VERSION, RESERVED_FILENAMES } from "./types.js";
export type {
  BundleConfig,
  BundleProblem,
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
