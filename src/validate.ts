import { readBundleDocument } from "./bundle.js";
import { splitFrontmatter } from "./frontmatter.js";
import { extractCitations } from "./parser.js";
import type { BundleProblem, LoadedBundle } from "./types.js";

export interface ValidationReport {
  bundle: string;
  /** Conformance failures per spec §9 (documents that cannot be consumed). */
  errors: BundleProblem[];
  /** Soft issues consumers must tolerate: broken links etc. (spec §9). */
  warnings: BundleProblem[];
  conformant: boolean;
}

/**
 * Report OKF v0.1 conformance for a loaded bundle. Loading already
 * collects most problems; this adds reserved-file structure checks
 * (index.md frontmatter is only permitted at the bundle root, spec §11)
 * and citation hygiene warnings (spec §8).
 */
export async function validateBundle(
  bundle: LoadedBundle,
): Promise<ValidationReport> {
  const problems: BundleProblem[] = [...bundle.problems];

  // Citation problems are soft, consistent with §9's broken-link tolerance.
  for (const concept of bundle.concepts.values()) {
    const { citations, malformed } = extractCitations(
      concept.body,
      concept.path,
      (id) => bundle.concepts.has(id),
    );
    for (const line of malformed) {
      problems.push({
        severity: "warning",
        path: concept.path,
        message: `malformed citation entry (expected \`[n] [text](target)\`): ${line}`,
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
  }

  for (const file of bundle.reserved) {
    if (file.kind !== "index" || file.path === "index.md") continue;
    const source = await readBundleDocument(bundle, file.path);
    if (splitFrontmatter(source).present) {
      problems.push({
        severity: "warning",
        path: file.path,
        message:
          "index.md frontmatter is only permitted at the bundle root (spec §11)",
      });
    }
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
