import { isCuratedIndex } from "./authoring.js";
import {
  colocatedSiblings,
  outsideLinkDangles,
  readBundleDocument,
  resolveOutsideLink,
} from "./bundle.js";
import { splitFrontmatter } from "./frontmatter.js";
import { extractCitations, normalizeCitationBlock, splitSections } from "./parser.js";
import { actorKind, footnoteLabels } from "./provenance.js";
import type { BundleProblem, LoadedBundle } from "./types.js";
import { ATTESTED_COMPUTATION, CONCEPT_STATUSES, OKF_VERSION } from "./types.js";

export interface ValidationReport {
  bundle: string;
  /** Conformance failures per spec §11 (documents that cannot be consumed). */
  errors: BundleProblem[];
  /** Soft issues consumers must tolerate: broken links etc. (spec §11). */
  warnings: BundleProblem[];
  conformant: boolean;
}

/** Major version this consumer implements; newer majors are best-effort (§12). */
const SUPPORTED_MAJOR = Number.parseInt(OKF_VERSION, 10);

/**
 * Soft §12 check: a bundle declaring a newer major okf_version is still
 * consumed best-effort, so a warning — never an error. A newer *minor* is
 * silent: §12 defines minor bumps as backward-compatible additions.
 */
function checkDeclaredVersion(bundle: LoadedBundle): BundleProblem[] {
  if (bundle.okfVersion === undefined) return [];
  const major = Number.parseInt(bundle.okfVersion, 10);
  if (!Number.isFinite(major) || major <= SUPPORTED_MAJOR) return [];
  return [
    {
      severity: "warning",
      path: "index.md",
      message: `bundle declares okf_version "${bundle.okfVersion}", a newer major version than the supported ${OKF_VERSION}; consuming best-effort (spec §12)`,
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
 * (spec §11) — giving enrichment agents the feedback to self-correct. A key
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
      `\`timestamp\` should be an ISO 8601 datetime (v0.1 §4.1); found ${describeValue(timestamp)}`,
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
 * Soft checks for the v0.2 provenance, trust, lifecycle, and computation
 * families (spec §5, §7, §10). Everything here warns and nothing errors: §11
 * forbids rejecting a concept over an optional family, and these documents are
 * mostly written by agents, which self-correct from feedback but stall on a
 * hard failure.
 *
 * The checks that matter most are the ones a reader cannot spot: a footnote
 * attributing a claim to a `sources` id that does not exist reads as cited
 * when it is not, and an actor missing its `human:` prefix silently demotes a
 * concept's trust tier (§5.3).
 */
function checkProvenanceFrontmatter(
  path: string,
  data: Record<string, unknown>,
  body: string,
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const warn = (message: string) =>
    problems.push({ severity: "warning", path, message });

  const checkActor = (value: unknown, field: string) => {
    if (value === undefined || value === null) return;
    if (actorKind(value) !== undefined) return;
    warn(
      `\`${field}\` should follow the actor convention — \`human:<id>\`, ` +
        `\`process:<id>\`, or \`<producer>/<version>\` (spec §7); found ` +
        `${describeValue(value)}. Trust tiers key off the \`human:\` prefix`,
    );
  };
  const checkStamp = (value: unknown, field: string) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
      warn(
        `\`${field}\` should be an ISO 8601 datetime (spec §5.2); found ${describeValue(value)}`,
      );
    }
  };
  const checkDate = (value: unknown, field: string, section: string) => {
    if (value === undefined || value === null) return;
    const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
    if (typeof text !== "string" || !ISO_DATE.test(text)) {
      warn(
        `\`${field}\` should be an absolute \`YYYY-MM-DD\` date (spec ${section}); found ${describeValue(value)}`,
      );
    }
  };

  // §5.2 generated: a mapping whose `by` is required within it.
  const generated = data.generated;
  if (generated !== undefined && generated !== null) {
    if (typeof generated !== "object" || Array.isArray(generated)) {
      warn(
        `\`generated\` should be a \`{ by, at }\` mapping (spec §5.2); found ${describeValue(generated)}`,
      );
    } else {
      const record = generated as Record<string, unknown>;
      if (record.by === undefined || record.by === null) {
        warn("`generated.by` is required within `generated` (spec §5.2)");
      }
      checkActor(record.by, "generated.by");
      checkStamp(record.at, "generated.at");
    }
  }

  // §5.2 verified: a list of events (the parser has already widened a bare
  // mapping, so anything not a list here is genuinely the wrong shape).
  const verified = data.verified;
  if (verified !== undefined && verified !== null) {
    const events = Array.isArray(verified) ? verified : [verified];
    if (!Array.isArray(verified) && typeof verified !== "object") {
      warn(
        `\`verified\` should be a \`{ by, at }\` mapping or a list of them (spec §5.2); found ${describeValue(verified)}`,
      );
    }
    events.forEach((event, index) => {
      if (event === null || typeof event !== "object") {
        warn(
          `\`verified[${index}]\` should be a \`{ by, at }\` mapping (spec §5.2); found ${describeValue(event)}`,
        );
        return;
      }
      const record = event as Record<string, unknown>;
      if (record.by === undefined || record.by === null) {
        warn(`\`verified[${index}].by\` is required (spec §5.2)`);
      }
      checkActor(record.by, `verified[${index}].by`);
      checkStamp(record.at, `verified[${index}].at`);
    });
  }

  // §5.4 status: a closed enum, unlike the open `type` vocabulary.
  const status = data.status;
  if (
    status !== undefined &&
    status !== null &&
    (typeof status !== "string" ||
      !(CONCEPT_STATUSES as readonly string[]).includes(status))
  ) {
    warn(
      `\`status\` should be one of ${CONCEPT_STATUSES.join(", ")} (spec §5.4); found ${describeValue(status)}`,
    );
  }

  checkDate(data.stale_after, "stale_after", "§5.5");

  const checkUsageWindow = (value: unknown, field: string) => {
    if (value === undefined || value === null) return;
    if (typeof value !== "object" || Array.isArray(value)) {
      warn(
        `\`${field}\` should be a \`{ from, to }\` date range (spec §5.1); found ${describeValue(value)}`,
      );
      return;
    }
    const record = value as Record<string, unknown>;
    checkDate(record.from, `${field}.from`, "§5.1");
    checkDate(record.to, `${field}.to`, "§5.1");
  };
  checkUsageWindow(data.usage_window, "usage_window");

  // §5.1 sources, and the footnote labels that attribute claims to them.
  const sources = data.sources;
  const sourceIds = new Set<string>();
  if (sources !== undefined && sources !== null) {
    if (!Array.isArray(sources)) {
      warn(
        `\`sources\` should be a list of entries (spec §5.1); found ${describeValue(sources)}`,
      );
    } else {
      sources.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          warn(
            `\`sources[${index}]\` should be a mapping (spec §5.1); found ${describeValue(entry)}`,
          );
          return;
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.resource !== "string" || record.resource.trim() === "") {
          warn(
            `\`sources[${index}].resource\` is required within an entry (spec §5.1) — ` +
              "a URL, a path, or a scope descriptor",
          );
        }
        if (typeof record.id === "string") sourceIds.add(record.id);
        else if (record.id !== undefined && record.id !== null) {
          warn(
            `\`sources[${index}].id\` should be a string (spec §5.1); found ${describeValue(record.id)}`,
          );
        }
        checkActor(record.author, `sources[${index}].author`);
        if (
          record.usage_count !== undefined &&
          record.usage_count !== null &&
          typeof record.usage_count !== "number"
        ) {
          warn(
            `\`sources[${index}].usage_count\` should be a number (spec §5.1); found ${describeValue(record.usage_count)}`,
          );
        }
        checkDate(record.last_modified, `sources[${index}].last_modified`, "§5.1");
        checkUsageWindow(record.usage_window, `sources[${index}].usage_window`);
      });
    }
  }

  // A footnote label is the join key into `sources` (§5.1), so one that
  // resolves to no entry is an attribution that silently points nowhere.
  // Only judged once the document declares `sources` — a plain markdown
  // footnote in a v0.1 document is just a footnote.
  if (sources !== undefined) {
    const { defined, referenced } = footnoteLabels(body);
    for (const label of [...referenced].sort()) {
      if (sourceIds.has(label)) continue;
      problems.push({
        severity: "warning",
        path,
        message:
          `footnote [^${label}] matches no \`sources[].id\`, so the claim it ` +
          `attributes resolves to no source (spec §5.1)` +
          (defined.has(label) ? "" : " — and the footnote is never defined"),
      });
    }
  }

  // §10.2: `runtime` is the one field required for this type, because it is
  // what tells the executor and attester how to read everything else.
  const type = data.type;
  if (
    typeof type === "string" &&
    type.trim().toLowerCase() === ATTESTED_COMPUTATION.toLowerCase() &&
    (typeof data.runtime !== "string" || data.runtime.trim() === "")
  ) {
    warn(
      `\`runtime\` is required for \`type: ${ATTESTED_COMPUTATION}\` (spec §10.2) — ` +
        "it defines what `parameters` mean and how the computation is run",
    );
  }

  return problems;
}

/**
 * Warn about a document caught between the two vocabularies v0.2 renamed
 * (spec §13.1). Reading either is fine and permanently supported; carrying
 * *both* is not a v0.1 document and not a v0.2 one, and whichever a consumer
 * happens to prefer, the other is silently ignored. This is exactly the state
 * a half-finished migration leaves behind, so the warning names the fixer.
 */
function checkMixedVocabulary(
  path: string,
  data: Record<string, unknown>,
  body: string,
): BundleProblem[] {
  const problems: BundleProblem[] = [];
  if (data.timestamp !== undefined && data.generated !== undefined) {
    problems.push({
      severity: "warning",
      path,
      message:
        "document carries both `timestamp` and `generated`; v0.2 superseded " +
        "`timestamp` (spec §13.1), so consumers reading one ignore the other" +
        fixableBy("timestamp-to-generated"),
    });
  }
  const hasCitations = splitSections(body).some(
    (section) => section.heading.toLowerCase() === "citations",
  );
  if (hasCitations && data.sources !== undefined) {
    problems.push({
      severity: "warning",
      path,
      message:
        "document carries both a `# Citations` section and frontmatter `sources`; " +
        "v0.2 superseded the body list (spec §13.1), and provenance read from " +
        "frontmatter will not see the section" + fixableBy("citations-to-sources"),
    });
  }
  return problems;
}

/**
 * Warn when a document still speaks v0.1 inside a bundle that declares v0.2.
 * Not a conformance failure — §13.1 keeps both readable — but it is the
 * migration this server can finish mechanically, so it says so.
 */
function checkLegacyVocabulary(
  path: string,
  data: Record<string, unknown>,
  body: string,
  bundle: LoadedBundle,
): BundleProblem[] {
  if (bundle.okfVersion !== OKF_VERSION) return [];
  const problems: BundleProblem[] = [];
  if (data.timestamp !== undefined && data.generated === undefined) {
    problems.push({
      severity: "warning",
      path,
      message:
        `bundle declares okf_version "${OKF_VERSION}" but this document records its ` +
        "last change as a v0.1 `timestamp` rather than `generated` (spec §5.2)" +
        fixableBy("timestamp-to-generated"),
    });
  }
  const hasCitations = splitSections(body).some(
    (section) => section.heading.toLowerCase() === "citations",
  );
  if (hasCitations && data.sources === undefined) {
    problems.push({
      severity: "warning",
      path,
      message:
        `bundle declares okf_version "${OKF_VERSION}" but this document records ` +
        "provenance as a v0.1 `# Citations` list rather than frontmatter `sources` (spec §5.1)" +
        fixableBy("citations-to-sources"),
    });
  }
  return problems;
}

/**
 * Structure checks for a log file (spec §9): `##` headings must be ISO
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
          message: `log.md date headings must be ISO 8601 dates (YYYY-MM-DD); line ${index + 1} is "${excerpt(line)}" (spec §9)`,
        });
        return;
      }
      if (previousDate !== undefined && text > previousDate) {
        problems.push({
          severity: "warning",
          path,
          message: `log.md date sections should be newest-first; ${text} (line ${index + 1}) appears below the older ${previousDate} (spec §9)`,
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
      message: `log.md entries should be markdown list items; line ${index + 1} is "${excerpt(line)}" (spec §9)`,
    });
  });
  return problems;
}

/**
 * Structure checks for an index file (spec §8): sections of link
 * bullets under headings (SHOULD → warnings), with frontmatter only
 * permitted at the bundle root (spec §8, §12) — except the bare
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
        "index.md frontmatter is only permitted at the bundle root (spec §8; the `generated: false` opt-out marker is the exception)",
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
      message: `index.md should contain only section headings and link bullets ("* [Title](url) - description"); line ${offset + index + 1} is "${excerpt(line)}" (spec §8)`,
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
 * Report OKF v0.2 conformance for a loaded bundle. Loading already
 * collects most problems; this adds reserved-file structure checks
 * of spec §11.3 (every index.md follows §8, every log.md follows §9,
 * and index.md frontmatter is only permitted at the bundle root),
 * recommended-frontmatter warnings (spec §4.1), provenance/trust/lifecycle
 * and computation warnings (§5, §7, §10), mixed- and legacy-vocabulary
 * warnings (§13.1), legacy citation hygiene warnings (v0.1 §8),
 * duplicate top-level heading warnings, and warnings
 * for bundle-absolute (leading-`/`) body links, which GitHub resolves
 * from the repository root. Given the other mounted bundles, `../`
 * links from a colocated bundle are judged against its mounted
 * siblings: resolving ones are fine (and
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
      problems.push(...checkProvenanceFrontmatter(concept.path, raw, concept.body));
      problems.push(...checkMixedVocabulary(concept.path, raw, concept.body));
      problems.push(
        ...checkLegacyVocabulary(concept.path, raw, concept.body, bundle),
      );
    }
    for (const link of concept.frontmatterLinks) {
      if (link.kind !== "outside" || link.path === undefined) continue;
      if (!outsideLinkDangles(link.path, siblings)) continue;
      problems.push({
        severity: "warning",
        path: concept.path,
        message: `frontmatter \`${link.field}\` does not resolve in the colocated sibling bundle: ${link.target}`,
      });
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
