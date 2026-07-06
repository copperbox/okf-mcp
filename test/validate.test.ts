import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { validateBundle } from "../src/validate.js";
import type { ValidationReport } from "../src/validate.js";

const ACME = path.join(import.meta.dirname, "fixtures", "acme");
const MALFORMED = path.join(import.meta.dirname, "fixtures", "malformed");

async function report(root: string): Promise<ValidationReport> {
  return validateBundle(await loadBundle({ id: "fixture", root }));
}

describe("validateBundle reserved-file structure (spec §9.3)", () => {
  it("flags non-date `##` headings in log.md as conformance errors (spec §7)", async () => {
    const result = await report(MALFORMED);
    const errors = result.errors.filter((p) => p.path === "log.md");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /ISO 8601/);
    assert.match(errors[0]!.message, /Release notes/);
    assert.equal(result.conformant, false);
  });

  it("warns when log.md date sections are not newest-first (spec §7)", async () => {
    const result = await report(MALFORMED);
    const outOfOrder = result.warnings.filter(
      (p) => p.path === "log.md" && p.message.includes("newest-first"),
    );
    assert.equal(outOfOrder.length, 1);
    assert.match(outOfOrder[0]!.message, /2026-03-01/);
    assert.match(outOfOrder[0]!.message, /2026-01-05/);
  });

  it("warns when a log.md entry is not a list item (spec §7)", async () => {
    const result = await report(MALFORMED);
    const prose = result.warnings.filter(
      (p) => p.path === "log.md" && p.message.includes("list item"),
    );
    assert.equal(prose.length, 1);
    assert.match(prose[0]!.message, /Plain prose entry/);
  });

  it("warns about index.md content that is neither a heading nor a link bullet (spec §6)", async () => {
    const result = await report(MALFORMED);
    const shape = result.warnings.filter(
      (p) => p.path === "index.md" && p.message.includes("link bullet"),
    );
    assert.equal(shape.length, 1);
    assert.match(shape[0]!.message, /Welcome to the malformed bundle/);
  });

  it("keeps warning about frontmatter in a non-root index.md (spec §11)", async () => {
    const result = await report(MALFORMED);
    const frontmatter = result.warnings.filter(
      (p) => p.path === "guides/index.md",
    );
    assert.equal(frontmatter.length, 1);
    assert.match(frontmatter[0]!.message, /bundle root/);
  });

  it("reports no reserved-file problems for a well-formed bundle", async () => {
    const result = await report(ACME);
    const reserved = [...result.errors, ...result.warnings].filter(
      (p) => p.path !== undefined && /(^|\/)(index|log)\.md$/.test(p.path),
    );
    assert.deepEqual(reserved, []);
  });
});
