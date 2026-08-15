/**
 * Core types for the Open Knowledge Format (OKF) v0.2.
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * v0.1 bundles stay first-class: the two fields v0.2 superseded (`timestamp`
 * and the body `# Citations` list) are read through the fallbacks the spec
 * blesses in §13.1, and a bundle declaring `okf_version: "0.1"` keeps being
 * written in v0.1 vocabulary.
 */

export const OKF_VERSION = "0.2";

/** The OKF versions this server writes; reading tolerates any (spec §12). */
export const SUPPORTED_OKF_VERSIONS = ["0.1", "0.2"] as const;
export type OkfVersion = (typeof SUPPORTED_OKF_VERSIONS)[number];

/** Filenames with reserved meaning at any level of a bundle (spec §3.1). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/**
 * An identity in the spec §7 actor convention: `<producer>/<version>` for an
 * agent or tool, `human:<id>` for a person, `process:<id>` for an automated
 * process. Trust tiers (§5.3) key off the `human:` prefix.
 */
export type Actor = string;

/**
 * One `sources` entry (spec §5.1): the material a concept derives from.
 * `resource` is required within an entry and names either something a consumer
 * can follow (URL or path) or a scope descriptor it cannot ("all queries in
 * BigQuery project X"). `id` is the stable key body footnotes attribute to.
 */
export interface SourceEntry {
  resource: string;
  id?: string;
  title?: string;
  /** Who or what produced the source, in the actor convention (§7). */
  author?: Actor;
  /** Times `resource` was exercised over the applicable usage window. */
  usage_count?: number;
  /** When the source itself last changed, `YYYY-MM-DD`. */
  last_modified?: string;
  /** Per-entry override of the frontmatter-level `usage_window`. */
  usage_window?: UsageWindow;
  [key: string]: unknown;
}

/** The `{ from, to }` date range framing every `usage_count` (spec §5.1). */
export interface UsageWindow {
  from?: string;
  to?: string;
}

/** How the current content was produced (spec §5.2). `by` is required. */
export interface GeneratedRecord {
  by: Actor;
  /** ISO 8601 datetime of the content's last meaningful change. */
  at?: string;
  [key: string]: unknown;
}

/** One verification event (spec §5.2). A bare mapping is a one-element list. */
export interface VerifiedRecord {
  by: Actor;
  at?: string;
  [key: string]: unknown;
}

/** Lifecycle status (spec §5.4). Absent means `stable`. */
export type ConceptStatus = "draft" | "stable" | "deprecated";

export const CONCEPT_STATUSES: readonly ConceptStatus[] = [
  "draft",
  "stable",
  "deprecated",
];

/**
 * Trust tier derived from `verified` (spec §5.3) — never stored, always
 * computed, and advisory rather than access control.
 */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/** The concept type whose computation contract §10 specifies. */
export const ATTESTED_COMPUTATION = "Attested Computation";

/** One typed hole an agent may fill in an attested computation (spec §10.2). */
export interface ComputationParameter {
  name: string;
  type?: string;
  required?: boolean;
  [key: string]: unknown;
}

/** How an attested computation is run, and what evidence a run returns (§10.2). */
export interface ExecutorRecord {
  resource?: string;
  /** Fields a run must return for the attester to inspect. */
  receipt?: string[];
  [key: string]: unknown;
}

/** The deterministic consumer-side check over a run's receipt (spec §10.2). */
export interface AttesterRecord {
  resource?: string;
  [key: string]: unknown;
}

/**
 * Frontmatter of a concept document (spec §4.1). Only `type` is required;
 * unknown keys are preserved for round-tripping. The optional provenance,
 * trust, and lifecycle families (§5) and the computation fields (§10) are
 * declared here for the fields this server understands — every consumer still
 * guards at read time, because frontmatter is user data and may hold anything.
 */
export interface ConceptFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];

  // Provenance, trust, and lifecycle (spec §5).
  /** Normalized to a list by the parser, so a bare mapping reads as one entry. */
  verified?: VerifiedRecord[];
  generated?: GeneratedRecord;
  status?: ConceptStatus;
  /** Absolute `YYYY-MM-DD`; the concept is stale when `today >= stale_after`. */
  stale_after?: string;
  sources?: SourceEntry[];
  usage_window?: UsageWindow;

  // Computation contract, for `type: Attested Computation` (spec §10.2).
  runtime?: string;
  parameters?: ComputationParameter[];
  computation?: string;
  executor?: ExecutorRecord;
  attester?: AttesterRecord;

  /**
   * Superseded by `generated.at` in v0.2 (spec §13.1). Still read as a
   * fallback, and still written into bundles that declare `okf_version: "0.1"`.
   */
  timestamp?: string;

  [key: string]: unknown;
}

/** How a markdown link in a concept body was classified during parsing. */
export type LinkKind =
  | "concept" // resolves inside the bundle to a markdown document
  | "external" // has a URI scheme (https:, repo:, mailto:, ...)
  | "anchor" // same-document #fragment link
  | "outside"; // escapes the bundle root, e.g. via ../

export interface ConceptLink {
  /** Link text as written. */
  text: string;
  /** Raw link target as written. */
  target: string;
  kind: LinkKind;
  /** Offset of the raw target within the document body (for in-place rewrites). */
  targetStart: number;
  /** Offset just past the raw target within the document body. */
  targetEnd: number;
  /** Bundle-relative path the link points at (concept/outside kinds). */
  path?: string;
  /** Concept ID the link resolves to, when the target exists in the bundle. */
  resolvedId?: string;
  /**
   * Set when the link plausibly targets a concept the bundle does not have:
   * an unresolved `.md` target, or an unresolved extensionless target that
   * names neither a directory nor a reserved file. Reported as a broken
   * link — a warning, never an error (spec §6.1).
   */
  broken?: boolean;
}

/**
 * A path-valued frontmatter field pointing at another document (spec §6.2).
 * Kept apart from body `links` because it has no body offsets to splice and
 * because callers usually want to know which field it came from — but it is
 * resolved by the same pass, so it becomes a real graph edge.
 */
export interface FrontmatterLink {
  /** The field it came from, e.g. `sources[0].resource` or `attester.resource`. */
  field: string;
  /** Raw path as written. */
  target: string;
  kind: LinkKind;
  /** Bundle-relative path the link points at (concept/outside kinds). */
  path?: string;
  /** Concept ID the link resolves to, when the target exists in the bundle. */
  resolvedId?: string;
  /** Set when the target plausibly names a concept the bundle does not have. */
  broken?: boolean;
}

/** A single unit of knowledge: one markdown document in a bundle (spec §2). */
export interface Concept {
  /** Concept ID: bundle-relative path with the `.md` suffix removed. */
  id: string;
  bundleId: string;
  /** Bundle-relative file path, POSIX separators, including `.md`. */
  path: string;
  frontmatter: ConceptFrontmatter;
  body: string;
  links: ConceptLink[];
  /**
   * Links carried by the §6.2 path-valued frontmatter fields — `sources[]`,
   * `computation`, `executor`, `attester`. Empty for a v0.1 concept.
   * Top-level `resource` is deliberately excluded: it names the asset the
   * concept *describes*, not knowledge it derives from, so it stays a
   * cross-bundle-only signal (see canonical.ts).
   */
  frontmatterLinks: FrontmatterLink[];
}

/** A reserved (non-concept) file found in the bundle: index.md or log.md. */
export interface ReservedFile {
  path: string;
  kind: "index" | "log";
}

/** A problem found while loading a bundle. Errors break OKF conformance (§11). */
export interface BundleProblem {
  severity: "error" | "warning";
  path?: string;
  message: string;
}

export interface BundleConfig {
  id: string;
  /** Absolute or cwd-relative path to the bundle root directory. */
  root: string;
  /**
   * Published canonical URL of the bundle root (e.g. its GitHub tree URL).
   * Citations and external links whose URL points under it resolve to this
   * bundle's concepts as derived cross-bundle edges.
   */
  canonicalUrl?: string;
  /**
   * Set when the bundle was discovered as a subdirectory of a shared
   * `--colocated-bundles` root: the absolute/cwd-relative path of that root.
   * Marks the bundle as a sibling of every other bundle sharing the value,
   * so downstream features can rely on the layout.
   */
  colocatedRoot?: string;
  /**
   * Discover at startup, parse on first access: load() records only the id
   * and the root index.md's frontmatter `description`; the full index is
   * built the first time any caller names the bundle (OkfStore.bundle).
   */
  lazy?: boolean;
  /**
   * Per-bundle authoring permission, declared in an `okf.config.json`
   * (see config.ts). `false` mounts the bundle read-only even on a writable
   * server; `undefined` means undeclared — the bundle follows the server-wide
   * `--writable` gate, which is how CLI `--bundle` flags have always behaved.
   */
  writable?: boolean;
}

/** A read-only bundle fetched from a remote source (issue: exchange goal). */
export interface RemoteBundleConfig {
  id: string;
  /**
   * Public GitHub tree URL (https://github.com/<owner>/<repo>/tree/<ref>[/<path>]),
   * or a `.tar.gz`/`.tgz`/`.zip` archive — any http(s) URL or local path,
   * detected by extension.
   */
  url: string;
  /** Glob patterns over bundle-relative paths; when present, only matches load. */
  include?: string[];
  /** Glob patterns over bundle-relative paths to skip. */
  exclude?: string[];
  /**
   * Extra canonical URL for the bundle root, matched in addition to the
   * location derived from `url` (GitHub tree mounts derive one automatically;
   * archives have no per-file URLs, so this is their only canonical location).
   */
  canonicalUrl?: string;
}

/**
 * A published colocated root mounted from a remote source: each immediate
 * subdirectory of the tree (or archive) containing markdown becomes its own
 * read-only bundle, `id` = folder basename — the remote counterpart of
 * `--colocated-bundles`.
 */
export interface ColocatedRemoteRootConfig {
  /**
   * Public GitHub tree URL of the root
   * (https://github.com/<owner>/<repo>/tree/<ref>[/<path>]), or a
   * `.tar.gz`/`.tgz`/`.zip` archive — any http(s) URL or local path.
   */
  url: string;
  /** Mount only these immediate subfolders; an unknown name is an error. */
  only?: string[];
  /** Glob patterns over bundle-relative paths; when present, only matches load. */
  include?: string[];
  /** Glob patterns over bundle-relative paths to skip. */
  exclude?: string[];
  /**
   * Published canonical URL of the root: every bundle derives
   * `<url>/<folder>`. Tree mounts also derive canonicals from the tree URL
   * itself; archives have no per-file URLs, so this is their only source.
   */
  canonicalUrl?: string;
}

export interface LoadedBundle {
  id: string;
  /** Absolute path to the bundle root, or the source URL for remote bundles. */
  root: string;
  concepts: Map<string, Concept>;
  reserved: ReservedFile[];
  problems: BundleProblem[];
  /** Read-only bundles are rejected by all authoring paths (remote bundles). */
  readOnly: boolean;
  /**
   * Absolute path of the shared `--colocated-bundles` root the bundle was
   * discovered under, when it was. Bundles sharing the value are declared
   * siblings: relative `../<sibling>/...` links between them resolve as
   * derived cross-bundle edges. Declared, never inferred from disk paths.
   */
  colocatedRoot?: string;
  /** OKF version declared by the bundle-root index.md frontmatter (spec §12). */
  okfVersion?: string;
  /** One-line bundle purpose declared by the bundle-root index.md frontmatter. */
  description?: string;
  /** Raw document sources, present only for bundles with no local files. */
  sources?: Map<string, string>;
  /**
   * URL prefixes of the bundle's canonical location(s), expanded at load
   * time (see canonicalUrlPrefixes). Citations/external links under one of
   * these prefixes resolve to this bundle's concepts across bundles.
   */
  canonicalUrls?: string[];
}

/** Canonical URI for a concept or reserved file, used for MCP resources. */
export function okfUri(bundleId: string, path: string): string {
  return `okf://${bundleId}/${path}`;
}
