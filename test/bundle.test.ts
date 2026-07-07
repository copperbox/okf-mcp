import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildBundle, loadBundle } from "../src/bundle.js";
import { validateBundle } from "../src/validate.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

describe("loadBundle", () => {
  it("indexes concepts by path-derived ID and separates reserved files", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    assert.deepEqual(
      [...bundle.concepts.keys()].sort(),
      ["datasets/sales", "notes/no-type", "playbooks/freshness", "tables/customers", "tables/orders"],
    );
    assert.deepEqual(
      bundle.reserved.map((f) => f.path).sort(),
      ["index.md", "log.md"],
    );
  });

  it("skips dot directories such as .obsidian", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    for (const id of bundle.concepts.keys()) {
      assert.ok(!id.includes(".obsidian"));
    }
  });

  it("resolves internal links and records broken links as warnings", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    const playbook = bundle.concepts.get("playbooks/freshness")!;
    const resolved = playbook.links.filter((l) => l.resolvedId !== undefined);
    assert.deepEqual(resolved.map((l) => l.resolvedId), ["tables/orders"]);
    const broken = bundle.problems.filter((p) => p.message.includes("missing concept"));
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.severity, "warning");
  });

  it("parses okf_version from the bundle-root index.md (spec §11)", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    assert.equal(bundle.okfVersion, "0.1");
  });

  it("leaves okfVersion undefined when only a nested index declares one", () => {
    const bundle = buildBundle("m", "/m", [
      { path: "index.md", source: "# Index\n" },
      { path: "guides/index.md", source: '---\nokf_version: "9.9"\n---\n\n# Guides\n' },
      { path: "note.md", source: "---\ntype: Note\n---\n\nBody.\n" },
    ]);
    assert.equal(bundle.okfVersion, undefined);
  });

  it("ignores a non-string okf_version declaration", () => {
    const bundle = buildBundle("m", "/m", [
      { path: "index.md", source: "---\nokf_version: 0.1\n---\n\n# Index\n" },
    ]);
    assert.equal(bundle.okfVersion, undefined);
  });

  it("resolves relative and absolute link forms to the same concept space", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    const orders = bundle.concepts.get("tables/orders")!;
    const targets = orders.links.map((l) => l.resolvedId).filter(Boolean);
    assert.deepEqual(targets.sort(), [
      "datasets/sales",
      "tables/customers",
      "tables/customers", // the schema link and citation [2] both point here
    ]);
  });
});

describe("validateBundle", () => {
  it("reports the missing-type document as a conformance error", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    const report = await validateBundle(bundle);
    assert.equal(report.conformant, false);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.path, "notes/no-type.md");
    assert.ok(report.warnings.length >= 1);
  });

  it("warns on malformed citation entries and unresolved citation targets", async () => {
    const bundle = await loadBundle({ id: "acme", root: FIXTURE });
    const report = await validateBundle(bundle);
    const citationWarnings = report.warnings.filter((w) => w.path === "tables/orders.md");
    assert.ok(
      citationWarnings.some((w) => /malformed citation entry/.test(w.message)),
      "expected a malformed-citation warning",
    );
    assert.ok(
      citationWarnings.some((w) =>
        /citation \[3\] target does not resolve.*\/playbooks\/retired-runbook/.test(w.message),
      ),
      "expected an unresolved-citation warning",
    );
    // Citation problems stay soft (spec §9): still exactly one hard error.
    assert.equal(report.errors.length, 1);
  });
});
