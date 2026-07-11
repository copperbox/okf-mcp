import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { canonicalUrlPrefixes } from "../src/canonical.js";
import { extractCitations } from "../src/parser.js";
import { FIXERS, repairBundle, selectFixers } from "../src/repair.js";
import type { LoadedBundle } from "../src/types.js";

describe("repair fixer registry", () => {
  it("registers the three initial fixers with descriptions", () => {
    assert.deepEqual(
      FIXERS.map((f) => f.id),
      ["citation-format", "duplicate-citation-headings", "okf-uri-to-canonical"],
    );
    for (const fixer of FIXERS) {
      assert.ok(fixer.description.length > 0, `${fixer.id} has a description`);
    }
  });

  it("selectFixers keeps registry order and rejects unknown ids", () => {
    assert.deepEqual(
      selectFixers(["okf-uri-to-canonical", "citation-format"]).map((f) => f.id),
      ["citation-format", "okf-uri-to-canonical"],
    );
    assert.throws(() => selectFixers(["bogus"]), /unknown fixer: bogus.*citation-format/);
  });
});

describe("repairBundle", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-repair-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, source: string): Promise<void> {
    await fs.mkdir(path.join(root, path.dirname(relPath)), { recursive: true });
    await fs.writeFile(path.join(root, relPath), source);
  }

  async function read(relPath: string): Promise<string> {
    return fs.readFile(path.join(root, relPath), "utf8");
  }

  async function bundle(): Promise<LoadedBundle> {
    return loadBundle({ id: "kb", root });
  }

  it("normalizes ordered-list citation entries (citation-format)", async () => {
    await write(
      "note.md",
      "---\ntype: Note\ntitle: Note # keep me\n---\n\nProse.\n\n" +
        "1. an ordered list outside Citations\n\n# Citations\n\n" +
        "1. [Alpha](https://example.com/a)\n2) [Beta](https://example.com/b)\n",
    );
    const report = await repairBundle(await bundle(), { write: true });
    assert.equal(report.fixed, 2);
    assert.equal(report.skipped, 0);
    assert.deepEqual(report.files, ["note.md"]);
    const repaired = await read("note.md");
    assert.match(repaired, /\[1\] \[Alpha\]\(https:\/\/example\.com\/a\)/);
    assert.match(repaired, /\[2\] \[Beta\]\(https:\/\/example\.com\/b\)/);
    // Everything outside the entries survives byte-for-byte.
    assert.match(repaired, /title: Note # keep me/);
    assert.match(repaired, /1\. an ordered list outside Citations/);
  });

  it("dry-run reports the same findings but writes nothing", async () => {
    const source =
      "---\ntype: Note\n---\n\n# Citations\n\n1. [Alpha](https://example.com/a)\n";
    await write("note.md", source);
    const report = await repairBundle(await bundle());
    assert.equal(report.applied, false);
    assert.equal(report.fixed, 1);
    assert.deepEqual(report.files, ["note.md"]);
    assert.equal(report.log, undefined);
    assert.equal(await read("note.md"), source);
    await assert.rejects(read("log.md")); // no bookkeeping on a dry run
  });

  it("drops empty duplicate Citations sections (duplicate-citation-headings)", async () => {
    await write(
      "damaged.md",
      "---\ntype: Note\n---\n\nIntro.\n\n# Citations\n\n# Citations\n\n" +
        "[1] [Docs](https://example.com/docs)\n",
    );
    const report = await repairBundle(await bundle(), { write: true });
    assert.equal(report.fixed, 1);
    const repaired = await read("damaged.md");
    assert.equal(repaired.match(/# Citations/g)?.length, 1);
    const { citations } = extractCitations(
      repaired.split("---\n")[2]!,
      "damaged.md",
      () => false,
    );
    assert.equal(citations.length, 1);
    assert.equal(citations[0]!.target, "https://example.com/docs");
  });

  it("keeps one heading when every duplicate Citations section is empty", async () => {
    await write(
      "empty.md",
      "---\ntype: Note\n---\n\n# Citations\n\n# Citations\n",
    );
    const report = await repairBundle(await bundle(), { write: true });
    assert.equal(report.fixed, 1);
    const repaired = await read("empty.md");
    assert.equal(repaired.match(/# Citations/g)?.length, 1);
  });

  it("reports duplicates that each have content instead of guessing", async () => {
    const source =
      "---\ntype: Note\n---\n\n# Citations\n\n[1] [A](https://example.com/a)\n\n" +
      "# Citations\n\n[1] [B](https://example.com/b)\n";
    await write("conflict.md", source);
    const report = await repairBundle(await bundle(), { write: true });
    assert.equal(report.fixed, 0);
    assert.equal(report.skipped, 1);
    assert.match(report.findings[0]!.message, /each have entries; merge them manually/);
    assert.deepEqual(report.files, []);
    assert.equal(await read("conflict.md"), source);
  });

  it("still drops the empty duplicate next to two content-bearing ones", async () => {
    await write(
      "mixed.md",
      "---\ntype: Note\n---\n\n# Citations\n\n" +
        "# Citations\n\n[1] [A](https://example.com/a)\n\n" +
        "# Citations\n\n[1] [B](https://example.com/b)\n",
    );
    const report = await repairBundle(await bundle(), { write: true });
    assert.equal(report.fixed, 1);
    assert.equal(report.skipped, 1);
    const repaired = await read("mixed.md");
    assert.equal(repaired.match(/# Citations/g)?.length, 2);
  });

  it("rewrites okf:// link targets and resource to the canonical URL", async () => {
    await write(
      "stub.md",
      "---\ntype: Note\ntitle: Stub\nresource: okf://org/standards/naming.md\n---\n\n" +
        "Promoted to [Naming](okf://org/standards/naming.md).\n\n# Citations\n\n" +
        "[1] [Naming](okf://org/standards/naming.md)\n",
    );
    const org: LoadedBundle = {
      id: "org",
      root: "/org",
      concepts: new Map(),
      reserved: [],
      problems: [],
      readOnly: false,
      canonicalUrls: canonicalUrlPrefixes("https://github.com/acme/org-kb/tree/main"),
    };
    const report = await repairBundle(await bundle(), {
      write: true,
      allBundles: [await bundle(), org],
    });
    assert.equal(report.fixed, 3); // two body links + resource
    const repaired = await read("stub.md");
    const blob = "https://github.com/acme/org-kb/blob/main/standards/naming.md";
    assert.match(repaired, new RegExp(`resource: ${blob}`));
    assert.equal(repaired.match(new RegExp(`\\]\\(${blob}\\)`, "g"))?.length, 2);
    assert.doesNotMatch(repaired, /okf:\/\//);
  });

  it("reports okf:// URIs whose bundle is unmounted or has no canonical URL", async () => {
    await write(
      "stub.md",
      "---\ntype: Note\nresource: okf://ghost/x.md\n---\n\n" +
        "See [x](okf://ghost/x.md) and [y](okf://bare/y.md).\n",
    );
    const bare: LoadedBundle = {
      id: "bare",
      root: "/bare",
      concepts: new Map(),
      reserved: [],
      problems: [],
      readOnly: false,
    };
    const loaded = await bundle();
    const report = await repairBundle(loaded, {
      write: true,
      allBundles: [loaded, bare],
    });
    assert.equal(report.fixed, 0);
    assert.equal(report.skipped, 3);
    assert.ok(
      report.findings.filter((f) => /"ghost" is not mounted/.test(f.message)).length === 2,
    );
    assert.match(
      report.findings.find((f) => /okf:\/\/bare/.test(f.message))!.message,
      /"bare" has no canonical URL configured/,
    );
    assert.deepEqual(report.files, []);
  });

  it("scopes the sweep to --only fixers", async () => {
    await write(
      "note.md",
      "---\ntype: Note\nresource: okf://ghost/x.md\n---\n\n# Citations\n\n" +
        "1. [Alpha](https://example.com/a)\n",
    );
    const report = await repairBundle(await bundle(), {
      write: true,
      only: ["citation-format"],
    });
    assert.deepEqual(report.fixers, ["citation-format"]);
    assert.equal(report.fixed, 1);
    assert.equal(report.skipped, 0); // okf-uri fixer did not run
    assert.match(await read("note.md"), /resource: okf:\/\/ghost\/x\.md/);
  });

  it("appends a log entry naming fixers and regenerates indexes on write", async () => {
    await write(
      "a.md",
      "---\ntype: Note\ntitle: A\n---\n\n# Citations\n\n1. [X](https://example.com/x)\n",
    );
    await write(
      "b.md",
      "---\ntype: Note\ntitle: B\n---\n\n# Citations\n\n# Citations\n\n[1] [Y](https://example.com/y)\n",
    );
    const report = await repairBundle(await bundle(), { write: true });
    assert.equal(report.log, "log.md");
    assert.equal(report.indexes, 1);
    const log = await read("log.md");
    assert.match(log, /Repair sweep \(okf-mcp repair\): citation-format \(1 file\), duplicate-citation-headings \(1 file\)/);
    assert.match(await read("index.md"), /\[A\]\(a\.md\)/);
  });

  it("skips bookkeeping when the sweep finds nothing to fix", async () => {
    await write(
      "clean.md",
      "---\ntype: Note\n---\n\n# Citations\n\n[1] [X](https://example.com/x)\n",
    );
    const report = await repairBundle(await bundle(), { write: true });
    assert.deepEqual(report.findings, []);
    assert.equal(report.log, undefined);
    await assert.rejects(read("log.md"));
    await assert.rejects(read("index.md"));
  });

  it("refuses read-only bundles", async () => {
    await write("note.md", "---\ntype: Note\n---\n\nBody.\n");
    const readOnly = { ...(await bundle()), readOnly: true };
    await assert.rejects(
      repairBundle(readOnly, { write: true }),
      /read-only; repair rewrites documents in place/,
    );
  });
});
