import fs from "node:fs/promises";
import path from "node:path";

import { splitFrontmatter } from "./frontmatter.js";
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
 * (index.md frontmatter is only permitted at the bundle root, spec §11).
 */
export async function validateBundle(
  bundle: LoadedBundle,
): Promise<ValidationReport> {
  const problems: BundleProblem[] = [...bundle.problems];

  for (const file of bundle.reserved) {
    if (file.kind !== "index" || file.path === "index.md") continue;
    const source = await fs.readFile(path.join(bundle.root, file.path), "utf8");
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
