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
import {
  extractCitations,
  extractLinks,
  normalizeCitationEntries,
  sectionSpans,
} from "./parser.js";
import { uniqueSourceId } from "./provenance.js";
import type { LoadedBundle } from "./types.js";
import { OKF_VERSION } from "./types.js";

/** What a fixer sees beyond the raw source of the document under repair. */
export interface FixerContext {
  /** Bundle-relative path of the document. */
  path: string;
  bundle: LoadedBundle;
  /** Every mounted bundle, for cross-bundle lookups (okf:// targets). */
  allBundles: LoadedBundle[];
  /**
   * Actor to credit for provenance a fixer creates (spec §7). Undefined when
   * none is configured — a fixer that needs one reports instead of inventing.
   */
  actor?: string;
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

    const declared = splitFrontmatter(repaired).data;
    const resource = declared?.resource;
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

    // `sources[].resource` is a §6.2 path-valued field like the body links
    // above, and promote_concept's stub now writes provenance there — so an
    // okf:// URI can land in frontmatter too, and must be rewritten the same
    // way or the cross-bundle edge only resolves inside this server.
    const sources = declared?.sources;
    if (Array.isArray(sources)) {
      const rewritten = sources.map((entry) => {
        if (entry === null || typeof entry !== "object") return entry;
        const record = entry as Record<string, unknown>;
        const target = record.resource;
        if (typeof target !== "string" || !target.startsWith("okf://")) return entry;
        const resolved = canonicalForOkfUri(target, allBundles);
        if ("reason" in resolved) {
          findings.push({
            message: `sources entry ${target} left as-is: ${resolved.reason}`,
            fixable: false,
          });
          return entry;
        }
        findings.push({
          message: `sources entry ${target} → ${resolved.url}`,
          fixable: true,
        });
        return { ...record, resource: resolved.url };
      });
      if (rewritten.some((entry, i) => entry !== sources[i])) {
        repaired = patchFrontmatter(repaired, { sources: rewritten }).source;
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

/**
 * Move a v0.1 `timestamp` to the v0.2 `generated: { by, at }` record
 * (spec §13.1). The date carries over verbatim — it is the same fact — but
 * `by` is information the v0.1 document simply does not contain, so it comes
 * from the configured actor. Without one the finding is reported and the
 * document is left alone: a fabricated `by` is worse than an unmigrated
 * document, because §5.3 derives trust from exactly that field.
 *
 * A document carrying both keys is the half-migrated state the validator
 * warns about; there `generated` already wins for every consumer, so the fix
 * is to drop the shadowed `timestamp` rather than reconcile two values.
 */
const timestampToGenerated: Fixer = {
  id: "timestamp-to-generated",
  description:
    "move a v0.1 `timestamp` into the v0.2 `generated: {by, at}` record, " +
    "taking `by` from the configured actor (spec §5.2, §13.1)",
  repair(source, { actor }) {
    const declared = splitFrontmatter(source).data;
    const timestamp = declared?.timestamp;
    if (timestamp === undefined || timestamp === null) {
      return { source, findings: [] };
    }
    const at = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
    if (declared?.generated !== undefined) {
      return {
        source: patchFrontmatter(source, { timestamp: null }).source,
        findings: [
          {
            message: `removed \`timestamp: ${excerpt(String(at))}\` shadowed by an existing \`generated\``,
            fixable: true,
          },
        ],
      };
    }
    if (actor === undefined) {
      return {
        source,
        findings: [
          {
            message:
              "`timestamp` needs an actor to become `generated.by` (spec §5.2) — " +
              "set `actor` in okf.config.json or pass --actor; refusing to invent one",
            fixable: false,
          },
        ],
      };
    }
    // Delete then set, so `generated` lands in `timestamp`'s slot rather than
    // at the end of the mapping.
    const cleared = patchFrontmatter(source, { timestamp: null }).source;
    return {
      source: patchFrontmatter(cleared, { generated: { by: actor, at } }, {
        insertAfter: { generated: IDENTITY_KEYS },
      }).source,
      findings: [
        {
          message: `timestamp ${excerpt(String(at))} → generated: { by: ${actor}, at: ${excerpt(String(at))} }`,
          fixable: true,
        },
      ],
    };
  },
};

/**
 * Lift a v0.1 `# Citations` list into the v0.2 frontmatter `sources` list
 * (spec §13.1), then drop the section. Each entry keeps its target as
 * `resource` and its link text as `title`, and gains a slugged `id` — keyed
 * rather than positional because §5.1 is explicit that agents reorder these
 * lists and a positional index misattributes silently when they do.
 *
 * Nothing in the body needs rewriting: v0.1 has no per-claim footnotes, so
 * there is no attribution to re-point. The links themselves survive as graph
 * edges because `sources[].resource` is a §6.2 path-valued field the loader
 * resolves (see extractFrontmatterLinks) — moving them out of the body does
 * not disconnect the concept.
 *
 * A document that already declares `sources` is reported, never merged: two
 * provenance lists are a judgement call about which entries are duplicates,
 * and that is not a mechanical rewrite.
 */
const citationsToSources: Fixer = {
  id: "citations-to-sources",
  description:
    "lift a v0.1 `# Citations` list into the v0.2 frontmatter `sources` list " +
    "with slugged entry ids, and drop the section (spec §5.1, §13.1)",
  repair(source, { path: docPath }) {
    const bodyStart = bodyStartOffset(source);
    const body = source.slice(bodyStart);
    const spans = sectionSpans(body).filter(
      (s) => s.heading.toLowerCase() === "citations",
    );
    if (spans.length === 0) return { source, findings: [] };
    const { citations, malformed } = extractCitations(body, docPath, () => false);
    if (citations.length === 0 && malformed.length === 0) {
      // An empty section: dropping it loses nothing, but there is also nothing
      // to migrate, so leave it to duplicate-citation-headings.
      return { source, findings: [] };
    }
    if (malformed.length > 0) {
      return {
        source,
        findings: [
          {
            message:
              `${malformed.length} citation entr${malformed.length === 1 ? "y is" : "ies are"} ` +
              "malformed; run `repair --only citation-format` first so nothing is dropped",
            fixable: false,
          },
        ],
      };
    }
    if (splitFrontmatter(source).data?.sources !== undefined) {
      return {
        source,
        findings: [
          {
            message:
              "document has both a `# Citations` section and frontmatter `sources`; " +
              "merge them by hand — deciding which entries are duplicates is not mechanical",
            fixable: false,
          },
        ],
      };
    }

    const used = new Set<string>();
    const sources = citations.map((citation) => ({
      id: uniqueSourceId(citation.text || citation.target, used),
      resource: citation.target,
      ...(citation.text !== "" && { title: citation.text }),
    }));
    let repaired = patchFrontmatter(source, { sources }, {
      insertAfter: { sources: IDENTITY_KEYS },
    }).source;
    // Re-derive the spans against the patched document: the frontmatter grew,
    // so every body offset moved.
    const newBodyStart = bodyStartOffset(repaired);
    const newBody = repaired.slice(newBodyStart);
    for (const span of sectionSpans(newBody)
      .filter((s) => s.heading.toLowerCase() === "citations")
      .sort((a, b) => b.start - a.start)) {
      repaired =
        repaired.slice(0, newBodyStart + span.start).trimEnd() +
        "\n" +
        repaired.slice(newBodyStart + span.end);
    }
    return {
      source: repaired,
      findings: [
        {
          message: `${citations.length} citation${citations.length === 1 ? "" : "s"} → frontmatter \`sources\` (ids: ${sources.map((s) => s.id).join(", ")})`,
          fixable: true,
        },
      ],
    };
  },
};

/** The §4.1 identity keys a newly created §5 family slots in after. */
const IDENTITY_KEYS = ["type", "title", "description", "resource", "tags"] as const;

/** The fixer registry, in the order fixers run over each document. */
export const FIXERS: readonly Fixer[] = [
  citationFormat,
  duplicateCitationHeadings,
  okfUriToCanonical,
  absoluteLinksToRelative,
];

/**
 * Fixers that migrate a bundle from OKF v0.1 to v0.2. Deliberately outside
 * FIXERS: every fixer there normalizes *form* and is safe to run on any
 * bundle at any time, while these rewrite a document's vocabulary — a
 * one-way, whole-bundle decision that belongs to `okf-mcp migrate`, not to a
 * routine hygiene sweep. Reading v0.1 stays supported indefinitely (§13.1),
 * so nothing forces this on anyone.
 */
export const MIGRATION_FIXERS: readonly Fixer[] = [
  citationsToSources,
  timestampToGenerated,
];

/** Every fixer id `--only` can name, across both registries. */
const ALL_FIXERS: readonly Fixer[] = [...FIXERS, ...MIGRATION_FIXERS];

/**
 * Resolve `--only` fixer ids against a registry, in registry order.
 * `registry` defaults to the routine sweep; the migrate command passes the
 * migration set. An id from the other registry is named in the error rather
 * than reported as unknown — "that fixer exists, but not in this command".
 */
export function selectFixers(
  only?: string[],
  registry: readonly Fixer[] = FIXERS,
): Fixer[] {
  if (only === undefined) return [...registry];
  const wanted = new Set(only);
  for (const id of wanted) {
    if (registry.some((f) => f.id === id)) continue;
    const elsewhere = ALL_FIXERS.some((f) => f.id === id);
    throw new Error(
      elsewhere
        ? `fixer ${id} belongs to the other registry; ` +
          `\`repair\` runs ${FIXERS.map((f) => f.id).join(", ")} and ` +
          `\`migrate\` runs ${MIGRATION_FIXERS.map((f) => f.id).join(", ")}`
        : `unknown fixer: ${id} (available: ${registry.map((f) => f.id).join(", ")})`,
    );
  }
  return registry.filter((f) => wanted.has(f.id));
}

export interface RepairBundleOptions {
  /** Apply the fixes. Defaults to a dry run: report findings, write nothing. */
  write?: boolean;
  /** Run only the named fixers; an unknown id is an error. */
  only?: string[];
  /** Every mounted bundle, for cross-bundle fixers. Defaults to just `bundle`. */
  allBundles?: LoadedBundle[];
  /** Fixer registry to run. Defaults to FIXERS; migrateBundle passes its own. */
  registry?: readonly Fixer[];
  /** Actor for fixers that create provenance (spec §7). */
  actor?: string;
  /** Log line describing the sweep; defaults to the repair wording. */
  logLabel?: string;
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
  const fixers = selectFixers(options.only, options.registry ?? FIXERS);
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
    const context = {
      path: concept.path,
      bundle,
      allBundles,
      ...(options.actor !== undefined && { actor: options.actor }),
    };
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
    `${options.logLabel ?? "Repair sweep (okf-mcp repair)"}: ${summary}`,
  );
  report.log = logPath;
  const { written } = await generateIndexes(bundle);
  report.indexes = written.length;
  return report;
}

export interface MigrateBundleOptions {
  /** Apply the migration. Defaults to a dry run: report findings, write nothing. */
  write?: boolean;
  /** Run only the named migration fixers; an unknown id is an error. */
  only?: string[];
  /** Every mounted bundle, for cross-bundle fixers. Defaults to just `bundle`. */
  allBundles?: LoadedBundle[];
  /**
   * Actor to credit as `generated.by` for provenance the migration creates
   * (spec §7). Without one, timestamp-to-generated reports instead of guessing.
   */
  actor?: string;
}

export interface MigrateReport extends RepairReport {
  /** OKF version the bundle declared before the migration, if any. */
  from?: string;
  /** OKF version the bundle declares after it. */
  to: string;
  /** True when the root index.md's declared `okf_version` was (re)stamped. */
  versionStamped: boolean;
}

/**
 * Migrate a bundle from OKF v0.1 to v0.2: run the migration fixers over every
 * concept, then declare the new version on the bundle-root index.md.
 *
 * The version stamp goes **last** and only when nothing was left unfixed, so a
 * partially-migrated bundle never advertises conformance it does not have —
 * `okf_version: "0.2"` is what tells this server's own write path to start
 * writing v0.2 vocabulary, and flipping it over half-converted documents is
 * how a bundle ends up permanently mixed.
 *
 * Dry-run by default, like repair.
 */
export async function migrateBundle(
  bundle: LoadedBundle,
  options: MigrateBundleOptions = {},
): Promise<MigrateReport> {
  const report = (await repairBundle(bundle, {
    ...options,
    registry: MIGRATION_FIXERS,
    logLabel: `Migration to OKF ${OKF_VERSION} (okf-mcp migrate)`,
  })) as MigrateReport;
  report.to = OKF_VERSION;
  if (bundle.okfVersion !== undefined) report.from = bundle.okfVersion;
  report.versionStamped = false;

  if (report.skipped > 0 || bundle.okfVersion === OKF_VERSION) return report;
  if (options.write !== true) {
    report.versionStamped = true; // what a --write run would do
    return report;
  }

  const indexPath = path.join(bundle.root, "index.md");
  let existing: string | undefined;
  try {
    existing = await fs.readFile(indexPath, "utf8");
  } catch {
    existing = undefined;
  }
  // generateIndexes (run by repairBundle above) has already created a root
  // index when there was none, and stamps the vocabulary the bundle was
  // written in — which was still 0.1 at that point. Restamp it explicitly.
  const source = existing ?? `---\nokf_version: "${OKF_VERSION}"\n---\n\n# Bundle Index\n`;
  await fs.writeFile(
    indexPath,
    splitFrontmatter(source).present
      ? patchFrontmatter(source, { okf_version: OKF_VERSION }).source
      : `---\nokf_version: "${OKF_VERSION}"\n---\n\n${source.replace(/^\s+/, "")}`,
    "utf8",
  );
  report.versionStamped = true;
  return report;
}
