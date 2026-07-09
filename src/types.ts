/**
 * Core types for the Open Knowledge Format (OKF) v0.1.
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */

export const OKF_VERSION = "0.1";

/** Filenames with reserved meaning at any level of a bundle (spec §3.1). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;

/**
 * Frontmatter of a concept document (spec §4.1). Only `type` is required;
 * unknown keys are preserved for round-tripping.
 */
export interface ConceptFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
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
   * link — a warning, never an error (spec §5.3).
   */
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
}

/** A reserved (non-concept) file found in the bundle: index.md or log.md. */
export interface ReservedFile {
  path: string;
  kind: "index" | "log";
}

/** A problem found while loading a bundle. Errors break OKF conformance (§9). */
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

export interface LoadedBundle {
  id: string;
  /** Absolute path to the bundle root, or the source URL for remote bundles. */
  root: string;
  concepts: Map<string, Concept>;
  reserved: ReservedFile[];
  problems: BundleProblem[];
  /** Read-only bundles are rejected by all authoring paths (remote bundles). */
  readOnly: boolean;
  /** OKF version declared by the bundle-root index.md frontmatter (spec §11). */
  okfVersion?: string;
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
