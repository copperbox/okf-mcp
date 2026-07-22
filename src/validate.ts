import { isCuratedIndex } from "./authoring.js";
import {
  colocatedSiblings,
  outsideLinkDangles,
  readBundleDocument,
  resolveOutsideLink,
} from "./bundle.js";
import { splitFrontmatter } from "./frontmatter.js";
import { extractCitations, normalizeCitationBlock, splitSections } from "./parser.js";
import type { BundleProblem, LoadedBundle } from "./types.js";
import { OKF_VERSION } from "./types.js";

export interface ValidationReport {
  bundle: string;
  /** Conformance failures per spec §9 (documents that cannot be consumed). */
  errors: BundleProblem[];
  /** Soft issues consumers must tolerate: broken links etc. (spec §9). */
  warnings: BundleProblem[];
  conformant: boolean;
}

/** Major version this consumer implements; newer majors are best-effort (§11). */
const SUPPORTED_MAJOR = Number.parseInt(OKF_VERSION, 10);

/**
 * Soft §11 check: a bundle declaring a newer major okf_version is still
 * consumed best-effort, so a warning — never an error.
 */
function checkDeclaredVersion(bundle: LoadedBundle): BundleProblem[] {
  if (bundle.okfVersion === undefined) return [];
  const major = Number.parseInt(bundle.okfVersion, 10);
  if (!Number.isFinite(major) || major <= SUPPORTED_MAJOR) return [];
  return [
    {
      severity: "warning",
      path: "index.md",
      message: `bundle declares okf_version "${bundle.okfVersion}", a newer major version than the supported ${OKF_VERSION}; consuming best-effort (spec §11)`,
    },
  ];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 8601 date, optionally with a time part (offset or Z). */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** A `##` (exactly level-2) ATX heading, capturing its text. */
const H2 = /^##(?!#)\s+(.*?)\s*$/;
const HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^[*+-]\s/;
/** An index entry: `* [Title](url)`, optionally followed by ` - description`. */
const LINK_BULLET = /^[*+-]\s+\[[^\]]*\]\([^)]*\)/;

function excerpt(line: string): string {
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/**
 * Suffix pointing a warning at its `okf-mcp repair` auto-fixer, so every
 * validator warning with a safe mechanical fix names the fixer that applies
 * it (the repair registry stays in sync with these checks).
 */
function fixableBy(fixerId: string): string {
  return ` (auto-fixable: \`okf-mcp repair --only ${fixerId}\`)`;
}

/** Render a frontmatter value for a warning message. */
function describeValue(value: unknown): string {
  return excerpt(JSON.stringify(value) ?? String(value));
}

/**
 * Soft checks for the recommended §4.1 frontmatter fields, run against the
 * raw YAML mapping (the parser normalizes `tags` before a concept is
 * indexed, so the loaded frontmatter no longer shows what was written).
 * Recommended fields are guidance, so malformed values warn — never error
 * (spec §9) — giving enrichment agents the feedback to self-correct. A key
 * with a null value (`title:` with nothing after it) is treated as absent,
 * matching how the parser treats empty keys.
 */
function checkRecommendedFrontmatter(
  path: string,
  data: Record<string, unknown>,
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const warn = (message: string) =>
    problems.push({ severity: "warning", path, message });

  for (const field of ["title", "description", "resource"] as const) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      warn(
        `\`${field}\` should be a string (spec §4.1); found ${describeValue(value)}`,
      );
    }
  }

  const resource = data.resource;
  if (typeof resource === "string" && !URL.canParse(resource)) {
    warn(
      `\`resource\` should be a parseable URI (spec §4.1); found ${describeValue(resource)}`,
    );
  }

  const timestamp = data.timestamp;
  if (
    timestamp !== undefined &&
    timestamp !== null &&
    (typeof timestamp !== "string" ||
      !ISO_TIMESTAMP.test(timestamp) ||
      Number.isNaN(Date.parse(timestamp)))
  ) {
    warn(
      `\`timestamp\` should be an ISO 8601 datetime (spec §4.1); found ${describeValue(timestamp)}`,
    );
  }

  const tags = data.tags;
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) {
      warn(
        `\`tags\` should be a YAML list of strings (spec §4.1); the scalar ${describeValue(tags)} was normalized to a one-element list`,
      );
    } else if (tags.some((tag) => typeof tag !== "string")) {
      warn(
        `\`tags\` should be a YAML list of strings (spec §4.1); non-string items in ${describeValue(tags)} were coerced to strings`,
      );
    }
  }

  return problems;
}

/**
 * Structure checks for a log file (spec §7): `##` headings must be ISO
 * 8601 dates (MUST → error), date sections should be newest-first and
 * entries should be list items (conventions → warnings).
 */
function checkLogStructure(path: string, source: string): BundleProblem[] {
  const problems: BundleProblem[] = [];
  let previousDate: string | undefined;
  source.split(/\r?\n/).forEach((line, index) => {
    const heading = line.match(H2);
    if (heading !== null) {
      const text = heading[1]!;
      if (!ISO_DATE.test(text)) {
        problems.push({
          severity: "error",
          path,
          message: `log.md date headings must be ISO 8601 dates (YYYY-MM-DD); line ${index + 1} is "${excerpt(line)}" (spec §7)`,
        });
        return;
      }
      if (previousDate !== undefined && text > previousDate) {
        problems.push({
          severity: "warning",
          path,
          message: `log.md date sections should be newest-first; ${text} (line ${index + 1}) appears below the older ${previousDate} (spec §7)`,
        });
      }
      previousDate = text;
      return;
    }
    if (line.trim() === "" || HEADING.test(line)) return;
    // Indented lines are continuations of a preceding list item.
    if (LIST_ITEM.test(line) || /^\s/.test(line)) return;
    problems.push({
      severity: "warning",
      path,
      message: `log.md entries should be markdown list items; line ${index + 1} is "${excerpt(line)}" (spec §7)`,
    });
  });
  return problems;
}

/**
 * Structure checks for an index file (spec §6): sections of link
 * bullets under headings (SHOULD → warnings), with frontmatter only
 * permitted at the bundle root (spec §11) — except the bare
 * `generated: false` opt-out marker for hand-curated indexes.
 */
function checkIndexStructure(path: string, source: string): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const frontmatter = splitFrontmatter(source);
  const onlyCuratedMarker =
    isCuratedIndex(source) && Object.keys(frontmatter.data ?? {}).length === 1;
  if (frontmatter.present && path !== "index.md" && !onlyCuratedMarker) {
    problems.push({
      severity: "warning",
      path,
      message:
        "index.md frontmatter is only permitted at the bundle root (spec §11; the `generated: false` opt-out marker is the exception)",
    });
  }
  // Report line numbers relative to the full file, not the
  // frontmatter-stripped body.
  const bodyLines = frontmatter.body.split(/\r?\n/);
  const offset = source.split(/\r?\n/).length - bodyLines.length;
  bodyLines.forEach((line, index) => {
    if (line.trim() === "" || HEADING.test(line) || LINK_BULLET.test(line)) {
      return;
    }
    problems.push({
      severity: "warning",
      path,
      message: `index.md should contain only section headings and link bullets ("* [Title](url) - description"); line ${offset + index + 1} is "${excerpt(line)}" (spec §6)`,
    });
  });
  return problems;
}

/**
 * Warn when a concept body repeats a top-level heading (issue #78: a botched
 * section repair left two `# Citations` headings, and section readers that
 * take the first match saw only the empty first copy). Duplicates surface as
 * warnings so existing damaged documents get repaired instead of silently
 * losing content.
 */
function checkDuplicateTopHeadings(path: string, body: string): BundleProblem[] {
  const counts = new Map<string, { heading: string; count: number }>();
  for (const section of splitSections(body)) {
    if (section.level !== 1) continue;
    const key = section.heading.toLowerCase();
    const entry = counts.get(key) ?? { heading: section.heading, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .map(({ heading, count }) => ({
      severity: "warning" as const,
      path,
      message:
        `duplicate top-level heading "# ${heading}" appears ${count} times; merge the sections — readers taking the first match miss the rest` +
        (heading.toLowerCase() === "citations"
          ? fixableBy("duplicate-citation-headings")
          : ""),
    }));
}

/**
 * Report OKF v0.1 conformance for a loaded bundle. Loading already
 * collects most problems; this adds reserved-file structure checks
 * of spec §9.3 (every index.md follows §6, every log.md follows §7,
 * and index.md frontmatter is only permitted at the bundle root per
 * §11), recommended-frontmatter warnings (spec §4.1), citation hygiene
 * warnings (spec §8), duplicate top-level heading warnings, and warnings
 * for bundle-absolute (leading-`/`) body links, which GitHub resolves
 * from the repository root. Given
 * the other mounted bundles, `../` links from a colocated bundle are
 * judged against its mounted siblings: resolving ones are fine (and
 * count as resolving citation targets), dangling ones warn. Warnings
 * with a safe mechanical fix name their `okf-mcp repair` fixer id.
 */
export async function validateBundle(
  bundle: LoadedBundle,
  allBundles: LoadedBundle[] = [],
): Promise<ValidationReport> {
  const problems: BundleProblem[] = [
    ...bundle.problems,
    ...checkDeclaredVersion(bundle),
  ];
  const siblings = colocatedSiblings(bundle, allBundles);

  // Recommended-field and citation problems are soft, consistent with
  // §9's tolerance of imperfect documents.
  for (const concept of bundle.concepts.values()) {
    const raw = splitFrontmatter(
      await readBundleDocument(bundle, concept.path),
    ).data;
    if (raw !== null) {
      problems.push(...checkRecommendedFrontmatter(concept.path, raw));
    }
    for (const link of concept.links) {
      // Unconditional (even for bundles without a canonical URL or colocated
      // root): the form is portability-hostile regardless, and the check
      // stays identical to the repair fixer's detection so they cannot drift.
      if (link.kind === "concept" && link.target.startsWith("/")) {
        problems.push({
          severity: "warning",
          path: concept.path,
          message:
            `bundle-absolute link "${link.target}" resolves from the repository root on GitHub and will break when the bundle is published as a subdirectory; prefer a document-relative link` +
            fixableBy("absolute-links-to-relative"),
        });
      }
      if (link.kind !== "outside" || link.path === undefined) continue;
      if (!outsideLinkDangles(link.path, siblings)) continue;
      problems.push({
        severity: "warning",
        path: concept.path,
        message: `link does not resolve in the colocated sibling bundle: ${link.target}`,
      });
    }
    const { citations, malformed } = extractCitations(
      concept.body,
      concept.path,
      (id) => bundle.concepts.has(id),
      (linkPath) => resolveOutsideLink(linkPath, siblings) !== undefined,
    );
    for (const line of malformed) {
      // The ordered-list form is exactly what the citation-format fixer
      // rewrites; other malformed lines have no mechanical fix.
      const autoFixable = normalizeCitationBlock(line) !== line;
      problems.push({
        severity: "warning",
        path: concept.path,
        message:
          `malformed citation entry (expected \`[n] [text](target)\`): ${line}` +
          (autoFixable ? fixableBy("citation-format") : ""),
      });
    }
    for (const citation of citations) {
      if (citation.kind !== "missing") continue;
      problems.push({
        severity: "warning",
        path: concept.path,
        message: `citation [${citation.index}] target does not resolve in the bundle: ${citation.target}`,
      });
    }
    problems.push(...checkDuplicateTopHeadings(concept.path, concept.body));
  }

  for (const file of bundle.reserved) {
    const check =
      file.kind === "index" ? checkIndexStructure : checkLogStructure;
    const source = await readBundleDocument(bundle, file.path);
    problems.push(...check(file.path, source));
  }

  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");
  return {
    bundle: bundle.id,
    errors,
    warnings,
    conformant: errors.length === 0,
  };
}
