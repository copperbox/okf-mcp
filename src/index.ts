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
  bundleVocabulary,
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
  WriteVocabulary,
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
// The v0.2 derived reads (spec §5, §7): trust tiers, staleness, and the
// `sources` accessor that falls back to a v0.1 `# Citations` list.
export {
  actorKind,
  conceptSources,
  conceptStatus,
  defaultActor,
  footnoteLabels,
  generatedAt,
  generatedBy,
  isAttestedComputation,
  isStale,
  lastVerifiedAt,
  trustTier,
  usageWindowFor,
  verifications,
} from "./provenance.js";
export type { ActorKind, ResolvedSources } from "./provenance.js";
export { migrateBundle } from "./repair.js";
export type { MigrateBundleOptions, MigrateReport } from "./repair.js";
export { searchConcepts } from "./search.js";
export type { SearchFilters, SearchHit, SearchResult } from "./search.js";
export { createOkfServer, SERVER_ACTOR } from "./server.js";
export type { BundleGuide, ServerOptions } from "./server.js";
export { OkfStore } from "./store.js";
export type {
  BundleReloadStats,
  DiscoveredBundle,
  OkfStoreOptions,
} from "./store.js";
export { suggestConceptPath } from "./suggest.js";
export type { PathSuggestion, SuggestPathInput } from "./suggest.js";
export {
  ATTESTED_COMPUTATION,
  CONCEPT_STATUSES,
  okfUri,
  OKF_VERSION,
  RESERVED_FILENAMES,
  SUPPORTED_OKF_VERSIONS,
} from "./types.js";
export type {
  Actor,
  AttesterRecord,
  BundleConfig,
  BundleProblem,
  ColocatedRemoteRootConfig,
  ComputationParameter,
  Concept,
  ConceptFrontmatter,
  ConceptLink,
  ConceptStatus,
  ExecutorRecord,
  FrontmatterLink,
  GeneratedRecord,
  LinkKind,
  LoadedBundle,
  OkfVersion,
  RemoteBundleConfig,
  ReservedFile,
  SourceEntry,
  TrustTier,
  UsageWindow,
  VerifiedRecord,
} from "./types.js";
export { validateBundle } from "./validate.js";
export type { ValidationReport } from "./validate.js";
