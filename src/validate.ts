import { readBundleDocument } from "./bundle.js";
import { splitFrontmatter } from "./frontmatter.js";
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
 * permitted at the bundle root (spec §11).
 */
function checkIndexStructure(path: string, source: string): BundleProblem[] {
  const problems: BundleProblem[] = [];
  const frontmatter = splitFrontmatter(source);
  if (frontmatter.present && path !== "index.md") {
    problems.push({
      severity: "warning",
      path,
      message:
        "index.md frontmatter is only permitted at the bundle root (spec §11)",
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
 * Report OKF v0.1 conformance for a loaded bundle. Loading already
 * collects most problems; this adds the reserved-file structure checks
 * of spec §9.3: every index.md follows §6 and every log.md follows §7.
 */
export async function validateBundle(
  bundle: LoadedBundle,
): Promise<ValidationReport> {
  const problems: BundleProblem[] = [
    ...bundle.problems,
    ...checkDeclaredVersion(bundle),
  ];

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
