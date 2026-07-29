/**
 * `okf-mcp repair`: a registry of named bundle auto-fixers, one per defect
 * class discovered in bundles on disk. Each fixer pairs detection with a
 * mechanical, provably-safe rewrite; a finding whose rewrite cannot be
 * proven safe is reported instead of guessed at. All edits splice the raw
 * source (never full-document regeneration), so human formatting and
 * unknown frontmatter survive byte-for-byte outside the touched spans.
 *
 * Write-time enforcement (writeConcept/updateConcept normalization) prevents
 * new damage; this module repairs the documents that already carry it. New
 * defect classes get a fixer here alongside their write-time prevention.
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  appendLogEntry,
  bodyStartOffset,
  generateIndexes,
  renderTarget,
} from "./authoring.js";
import { readBundleDocument } from "./bundle.js";
import { citationPrefix } from "./canonical.js";
import { patchFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { extractLinks, normalizeCitationEntries, sectionSpans } from "./parser.js";
import type { LoadedBundle } from "./types.js";

/** What a fixer sees beyond the raw source of the document under repair. */
export interface FixerContext {
  /** Bundle-relative path of the document. */
  path: string;
  bundle: LoadedBundle;
  /** Every mounted bundle, for cross-bundle lookups (okf:// targets). */
  allBundles: LoadedBundle[];
}

/** One defect found by one fixer in one document. */
export interface RepairFinding {
  /** Fixer id that produced the finding. */
  fixer: string;
  /** Bundle-relative path of the document. */
  path: string;
  message: string;
  /**
   * False when the fixer could not prove a safe rewrite for this finding —
   * reported for manual repair, never applied.
   */
  fixable: boolean;
}

/** A named auto-fixer: detection paired with a provably-safe rewrite. */
export interface Fixer {
  id: string;
  /** One line for the registry listing (`repair --list`). */
  description: string;
  /**
   * Detect this fixer's defect class in one document, returning the repaired
   * source (splice-based edits only) and one finding per defect. A finding
   * with `fixable: false` leaves its span of the source untouched.
   */
  repair(
    source: string,
    context: FixerContext,
  ): { source: string; findings: { message: string; fixable: boolean }[] };
}

function excerpt(line: string): string {
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/**
 * Normalize ordered-list citation entries to the spec §8 form (issue #78).
 * The rewrite is normalizeCitationEntries — the same transformation the
 * write paths apply — so repair and write-time prevention cannot drift.
 * Line counts are preserved, so findings come from a per-line diff.
 */
const citationFormat: Fixer = {
  id: "citation-format",
  description:
    "normalize ordered-list citation entries (`1. [text](target)`, `1) ...`) " +
    "under a Citations heading to the spec §8 `[n] [text](target)` form",
  repair(source) {
    const bodyStart = bodyStartOffset(source);
    const body = source.slice(bodyStart);
    const normalized = normalizeCitationEntries(body);
    if (normalized === body) return { source, findings: [] };
    const before = body.split("\n");
    const after = normalized.split("\n");
    const findings: { message: string; fixable: boolean }[] = [];
    for (const [i, line] of before.entries()) {
      if (line === after[i]) continue;
      findings.push({
        message: `citation entry "${excerpt(line)}" → "${excerpt(after[i]!)}"`,
        fixable: true,
      });
    }
    return { source: source.slice(0, bodyStart) + normalized, findings };
  },
};

/**
 * Merge duplicate Citations headings by dropping empty duplicate sections
 * (issue #78: a botched section repair left an empty first `# Citations`
 * that masked the populated second one from first-match readers). An empty
 * section's subtree holds nothing but whitespace, so removing it provably
 * loses no content; duplicates that each have content need a human to merge
 * their numbered entries, so they are reported instead.
 */
const duplicateCitationHeadings: Fixer = {
  id: "duplicate-citation-headings",
  description:
    "merge duplicate Citations headings by dropping empty duplicate sections; " +
    "duplicates that each have content are reported for manual merging",
  repair(source) {
    const bodyStart = bodyStartOffset(source);
    const body = source.slice(bodyStart);
    const spans = sectionSpans(body).filter(
      (s) => s.heading.toLowerCase() === "citations",
    );
    if (spans.length < 2) return { source, findings: [] };
    const empty = spans.filter(
      (s) => body.slice(s.contentStart, s.end).trim() === "",
    );
    // Drop every empty duplicate; when all are empty, keep the first so the
    // document does not silently lose its Citations heading.
    const dropped = empty.length === spans.length ? empty.slice(1) : empty;
    const withEntries = spans.length - empty.length;
    let repaired = source;
    for (const span of [...dropped].sort((a, b) => b.start - a.start)) {
      repaired =
        repaired.slice(0, bodyStart + span.start) +
        repaired.slice(bodyStart + span.end);
    }
    const findings = dropped.map((span) => ({
      message: `removed empty duplicate "${"#".repeat(span.level)} ${span.heading}" section`,
      fixable: true,
    }));
    if (withEntries > 1) {
      findings.push({
        message: `${withEntries} "# Citations" sections each have entries; merge them manually`,
        fixable: false,
      });
    }
    return { source: repaired, findings };
  },
};

const OKF_URI = /^okf:\/\/([^/]+)\/(.+)$/;

/**
 * Canonical URL for an `okf://<bundle>/<path>` URI, or the reason it cannot
 * be rewritten. Fragments and query strings carry over, like renderTarget.
 */
function canonicalForOkfUri(
  uri: string,
  allBundles: LoadedBundle[],
): { url: string } | { reason: string } {
  const pathPart = uri.split("#")[0]!.split("?")[0]!;
  const suffix = uri.slice(pathPart.length);
  const match = OKF_URI.exec(pathPart);
  if (match === null) {
    return { reason: "not an okf://<bundle>/<path> URI" };
  }
  const target = allBundles.find((b) => b.id === match[1]);
  if (target === undefined) {
    return { reason: `bundle "${match[1]}" is not mounted` };
  }
  if (target.canonicalUrls === undefined || target.canonicalUrls.length === 0) {
    return { reason: `bundle "${match[1]}" has no canonical URL configured` };
  }
  return { url: `${citationPrefix(target.canonicalUrls)}/${match[2]}${suffix}` };
}

/**
 * Rewrite okf:// body-link targets and the frontmatter `resource` to the
 * target bundle's canonical URL. promote_concept writes okf:// URIs as a
 * fallback when the target bundle has no canonical URL; once one is
 * configured, the okf:// form only resolves inside this server, while the
 * canonical URL resolves anywhere (and derives cross-bundle graph edges).
 * URIs whose bundle is unmounted or still has no canonical URL are reported
 * and left alone.
 */
const okfUriToCanonical: Fixer = {
  id: "okf-uri-to-canonical",
  description:
    "rewrite okf:// citation targets and frontmatter resource URIs to the " +
    "target bundle's canonical URL, once one is configured",
  repair(source, { path: docPath, allBundles }) {
    const findings: { message: string; fixable: boolean }[] = [];
    const bodyStart = bodyStartOffset(source);
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    for (const link of extractLinks(source.slice(bodyStart), docPath)) {
      if (!link.target.startsWith("okf://")) continue;
      const resolved = canonicalForOkfUri(link.target, allBundles);
      if ("reason" in resolved) {
        findings.push({
          message: `link target ${link.target} left as-is: ${resolved.reason}`,
          fixable: false,
        });
        continue;
      }
      edits.push({
        start: bodyStart + link.targetStart,
        end: bodyStart + link.targetEnd,
        replacement: resolved.url,
      });
      findings.push({
        message: `link target ${link.target} → ${resolved.url}`,
        fixable: true,
      });
    }
    let repaired = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      repaired =
        repaired.slice(0, edit.start) + edit.replacement + repaired.slice(edit.end);
    }

    const resource = splitFrontmatter(repaired).data?.resource;
    if (typeof resource === "string" && resource.startsWith("okf://")) {
      const resolved = canonicalForOkfUri(resource, allBundles);
      if ("reason" in resolved) {
        findings.push({
          message: `resource ${resource} left as-is: ${resolved.reason}`,
          fixable: false,
        });
      } else {
        // patchFrontmatter edits the YAML block in place, preserving every
        // other key, comments, and formatting — the sanctioned splice path
        // for frontmatter (same as update_concept).
        repaired = patchFrontmatter(repaired, { resource: resolved.url }).source;
        findings.push({
          message: `resource ${resource} → ${resolved.url}`,
          fixable: true,
        });
      }
    }
    return { source: repaired, findings };
  },
};

/**
 * Rewrite bundle-absolute (leading-`/`) link targets to the document-relative
 * form (issue #85, the repair half of #84's guidance change): GitHub resolves
 * a leading-`/` link from the repository root, so intra-bundle links break
 * whenever the bundle is published as a repo subfolder. The parser normalizes
 * both forms to the same bundle-relative path, so the rewrite is provably
 * safe without checking that the target resolves — a broken link stays
 * equally broken (spec §5.3) — and rename_concept keeps relative targets
 * relative afterward, so repaired links stay repaired.
 */
const absoluteLinksToRelative: Fixer = {
  id: "absolute-links-to-relative",
  description:
    "rewrite bundle-absolute (leading-/) link targets to the document-relative " +
    "form, which resolves on GitHub wherever the bundle is published",
  repair(source, { path: docPath }) {
    const bodyStart = bodyStartOffset(source);
    const fromDir = path.posix.dirname(docPath);
    const findings: { message: string; fixable: boolean }[] = [];
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    for (const link of extractLinks(source.slice(bodyStart), docPath)) {
      if (
        link.kind !== "concept" ||
        link.path === undefined ||
        !link.target.startsWith("/")
      ) {
        continue;
      }
      const rendered = renderTarget(
        link.target.slice(1),
        link.path,
        fromDir === "." ? "" : fromDir,
      );
      // A link to the document's own directory renders as an empty path;
      // write `.` so the target survives as a link.
      const replacement =
        rendered === "" || rendered.startsWith("#") || rendered.startsWith("?")
          ? `.${rendered}`
          : rendered;
      edits.push({
        start: bodyStart + link.targetStart,
        end: bodyStart + link.targetEnd,
        replacement,
      });
      findings.push({
        message: `link target ${link.target} → ${replacement}`,
        fixable: true,
      });
    }
    let repaired = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      repaired =
        repaired.slice(0, edit.start) + edit.replacement + repaired.slice(edit.end);
    }
    return { source: repaired, findings };
  },
};

/** The fixer registry, in the order fixers run over each document. */
export const FIXERS: readonly Fixer[] = [
  citationFormat,
  duplicateCitationHeadings,
  okfUriToCanonical,
  absoluteLinksToRelative,
];

/** Resolve `--only` fixer ids against the registry, in registry order. */
export function selectFixers(only?: string[]): Fixer[] {
  if (only === undefined) return [...FIXERS];
  const wanted = new Set(only);
  for (const id of wanted) {
    if (!FIXERS.some((f) => f.id === id)) {
      throw new Error(
        `unknown fixer: ${id} (available: ${FIXERS.map((f) => f.id).join(", ")})`,
      );
    }
  }
  return FIXERS.filter((f) => wanted.has(f.id));
}

export interface RepairBundleOptions {
  /** Apply the fixes. Defaults to a dry run: report findings, write nothing. */
  write?: boolean;
  /** Run only the named fixers; an unknown id is an error. */
  only?: string[];
  /** Every mounted bundle, for cross-bundle fixers. Defaults to just `bundle`. */
  allBundles?: LoadedBundle[];
}

export interface RepairReport {
  bundle: string;
  /** True when fixes were written to disk; false for a dry run. */
  applied: boolean;
  /** Fixer ids that ran, in registry order. */
  fixers: string[];
  findings: RepairFinding[];
  /** Findings with a safe rewrite — applied when `applied`, else would apply. */
  fixed: number;
  /** Findings without a provably-safe rewrite; reported, never applied. */
  skipped: number;
  /** Files with safe rewrites (rewritten on disk when `applied`), sorted. */
  files: string[];
  /** Bundle-relative log.md that recorded the sweep (write mode with fixes). */
  log?: string;
  /** Count of index.md files regenerated (write mode with fixes). */
  indexes?: number;
}

/**
 * Run the fixer registry over every concept document of a local bundle.
 * Dry-run by default: findings are reported and nothing is written; with
 * `write`, repaired documents are rewritten in place, a log.md entry
 * summarizes the sweep (fixer ids + file counts), and indexes are
 * regenerated — the same bookkeeping the authoring tools do. Read-only
 * (remote) bundles are refused: repair rewrites documents on disk.
 */
export async function repairBundle(
  bundle: LoadedBundle,
  options: RepairBundleOptions = {},
): Promise<RepairReport> {
  if (bundle.readOnly) {
    throw new Error(
      `bundle "${bundle.id}" is read-only; repair rewrites documents in place`,
    );
  }
  const write = options.write ?? false;
  const fixers = selectFixers(options.only);
  const allBundles = options.allBundles ?? [bundle];
  const findings: RepairFinding[] = [];
  const files: string[] = [];

  const concepts = [...bundle.concepts.values()].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  for (const concept of concepts) {
    // Fresh from disk, not the loaded snapshot, so edits splice what is
    // actually there even if the file changed since the bundle loaded.
    const original = await readBundleDocument(bundle, concept.path);
    const context = { path: concept.path, bundle, allBundles };
    let source = original;
    for (const fixer of fixers) {
      const result = fixer.repair(source, context);
      source = result.source;
      findings.push(
        ...result.findings.map((f) => ({ fixer: fixer.id, path: concept.path, ...f })),
      );
    }
    if (source === original) continue;
    files.push(concept.path);
    if (write) {
      await fs.writeFile(path.join(bundle.root, concept.path), source, "utf8");
    }
  }

  const report: RepairReport = {
    bundle: bundle.id,
    applied: write,
    fixers: fixers.map((f) => f.id),
    findings,
    fixed: findings.filter((f) => f.fixable).length,
    skipped: findings.filter((f) => !f.fixable).length,
    files,
  };
  if (!write || files.length === 0) return report;

  // Authoring-tool bookkeeping: one root log entry summarizing the sweep,
  // then regenerated indexes. Repairs never touch the fields indexes render
  // (paths, titles, descriptions), so the loaded snapshot is still accurate.
  const summary = report.fixers
    .map((id) => {
      const count = new Set(
        findings.filter((f) => f.fixer === id && f.fixable).map((f) => f.path),
      ).size;
      return count > 0 ? `${id} (${count} file${count === 1 ? "" : "s"})` : undefined;
    })
    .filter((part) => part !== undefined)
    .join(", ");
  const { path: logPath } = await appendLogEntry(
    bundle.root,
    `Repair sweep (okf-mcp repair): ${summary}`,
  );
  report.log = logPath;
  const { written } = await generateIndexes(bundle);
  report.indexes = written.length;
  return report;
}
