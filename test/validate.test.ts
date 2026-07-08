import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildBundle, loadBundle } from "../src/bundle.js";
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

describe("validateBundle recommended frontmatter (spec §4.1)", () => {
  function bundleWithConcept(frontmatterYaml: string) {
    return buildBundle(
      "mem",
      "/mem",
      [
        { path: "index.md", source: "# Bundle Index\n" },
        { path: "note.md", source: `---\n${frontmatterYaml}\n---\n\nBody.\n` },
      ],
      { keepSources: true },
    );
  }

  async function fieldWarnings(frontmatterYaml: string) {
    const result = await validateBundle(bundleWithConcept(frontmatterYaml));
    // Recommended fields are soft guidance (§9): never errors.
    assert.deepEqual(result.errors, []);
    assert.equal(result.conformant, true);
    return result.warnings.filter((w) => w.message.includes("§4.1"));
  }

  it("warns when timestamp is not an ISO 8601 datetime", async () => {
    for (const yaml of [
      "type: Note\ntimestamp: last tuesday",
      "type: Note\ntimestamp: 2026-13-01",
      "type: Note\ntimestamp: 12345",
    ]) {
      const warnings = await fieldWarnings(yaml);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.path, "note.md");
      assert.match(warnings[0]!.message, /`timestamp`.*ISO 8601/);
    }
  });

  it("warns when title or description is not a string", async () => {
    const warnings = await fieldWarnings(
      "type: Note\ntitle: 42\ndescription: [not, a, string]",
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!.message, /`title` should be a string/);
    assert.match(warnings[1]!.message, /`description` should be a string/);
  });

  it("warns when resource is not a string or not a parseable URI", async () => {
    const nonString = await fieldWarnings("type: Note\nresource: 7");
    assert.equal(nonString.length, 1);
    assert.match(nonString[0]!.message, /`resource` should be a string/);

    const nonUri = await fieldWarnings("type: Note\nresource: not a uri");
    assert.equal(nonUri.length, 1);
    assert.match(nonUri[0]!.message, /`resource`.*URI/);
    assert.match(nonUri[0]!.message, /not a uri/);
  });

  it("warns when tags is a scalar, noting the applied normalization", async () => {
    const warnings = await fieldWarnings("type: Note\ntags: infra");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.path, "note.md");
    assert.match(warnings[0]!.message, /`tags`.*list of strings/);
    assert.match(warnings[0]!.message, /normalized/);
    assert.match(warnings[0]!.message, /infra/);
  });

  it("warns when tags is a list containing non-strings", async () => {
    const warnings = await fieldWarnings("type: Note\ntags:\n  - ok\n  - 42");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /`tags`.*list of strings/);
    assert.match(warnings[0]!.message, /coerced/);
  });

  it("accepts well-formed recommended fields and absent ones silently", async () => {
    for (const yaml of [
      "type: Note", // all recommended fields absent
      [
        "type: Note",
        "title: A note",
        "description: Something helpful.",
        "resource: https://example.com/x",
        "tags: [a, b]",
        "timestamp: 2026-01-05T10:00:00Z",
      ].join("\n"),
      "type: Note\ntimestamp: 2026-01-05", // ISO 8601 date-only is fine
      "type: Note\nresource: repo:acme/data", // any URI scheme parses
    ]) {
      assert.deepEqual(await fieldWarnings(yaml), []);
    }
  });

  it("reports no §4.1 warnings for the well-formed fixture bundle", async () => {
    const result = await report(ACME);
    assert.deepEqual(
      result.warnings.filter((w) => w.message.includes("§4.1")),
      [],
    );
  });
});

describe("validateBundle okf_version (spec §11)", () => {
  function bundleDeclaring(indexSource: string) {
    return buildBundle(
      "mem",
      "/mem",
      [
        { path: "index.md", source: indexSource },
        { path: "note.md", source: "---\ntype: Note\n---\n\nBody.\n" },
      ],
      { keepSources: true },
    );
  }

  it("warns, never errors, when the declared major version is newer than supported", async () => {
    const result = await validateBundle(
      bundleDeclaring('---\nokf_version: "1.0"\n---\n\n# Bundle Index\n'),
    );
    const version = result.warnings.filter((p) => p.message.includes("okf_version"));
    assert.equal(version.length, 1);
    assert.equal(version[0]!.path, "index.md");
    assert.match(version[0]!.message, /"1\.0"/);
    assert.match(version[0]!.message, /best-effort/);
    assert.equal(result.errors.length, 0);
    assert.equal(result.conformant, true);
  });

  it("does not warn about the supported version or an absent declaration", async () => {
    for (const source of [
      '---\nokf_version: "0.1"\n---\n\n# Bundle Index\n',
      "# Bundle Index\n",
    ]) {
      const result = await validateBundle(bundleDeclaring(source));
      assert.deepEqual(
        result.warnings.filter((p) => p.message.includes("okf_version")),
        [],
      );
    }
  });
});
