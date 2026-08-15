import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { canonicalUrlPrefixes } from "../src/canonical.js";
import { extractCitations, extractLinks } from "../src/parser.js";
import { buildGraph } from "../src/graph.js";
import {
  FIXERS,
  MIGRATION_FIXERS,
  migrateBundle,
  repairBundle,
  selectFixers,
} from "../src/repair.js";
import type { LoadedBundle } from "../src/types.js";
import { validateBundle } from "../src/validate.js";

describe("repair fixer registry", () => {
  it("registers the four initial fixers with descriptions", () => {
    assert.deepEqual(
      FIXERS.map((f) => f.id),
      [
        "citation-format",
        "duplicate-citation-headings",
        "okf-uri-to-canonical",
        "absolute-links-to-relative",
      ],
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

  it("rewrites bundle-absolute links to document-relative (absolute-links-to-relative)", async () => {
    await write(
      "playbooks/freshness.md",
      "---\ntype: Runbook\ntitle: Freshness # keep me\n---\n\n" +
        "Check [orders](/tables/orders.md) and [totals](/tables/orders#totals),\n" +
        "then [self](/playbooks/freshness.md) and [peer](./peer.md).\n",
    );
    await write("tables/orders.md", "---\ntype: Table\n---\n\nRows.\n");
    const report = await repairBundle(await bundle(), {
      write: true,
      only: ["absolute-links-to-relative"],
    });
    assert.equal(report.fixed, 3);
    assert.equal(report.skipped, 0);
    assert.match(
      report.findings[0]!.message,
      /\/tables\/orders\.md → \.\.\/tables\/orders\.md/,
    );
    const repaired = await read("playbooks/freshness.md");
    assert.match(repaired, /\[orders\]\(\.\.\/tables\/orders\.md\)/);
    // Extensionless stays extensionless; the fragment carries over.
    assert.match(repaired, /\[totals\]\(\.\.\/tables\/orders#totals\)/);
    assert.match(repaired, /\[self\]\(freshness\.md\)/);
    // Already-relative links and bytes outside the targets are untouched.
    assert.match(repaired, /\[peer\]\(\.\/peer\.md\)/);
    assert.match(repaired, /title: Freshness # keep me/);
  });

  it("rewrites broken bundle-absolute links too — equally broken relative (spec §5.3)", async () => {
    await write(
      "note.md",
      "---\ntype: Note\n---\n\nSee [gone](/gone/missing.md).\n",
    );
    const report = await repairBundle(await bundle(), {
      write: true,
      only: ["absolute-links-to-relative"],
    });
    assert.equal(report.fixed, 1);
    assert.equal(report.skipped, 0);
    assert.match(await read("note.md"), /\[gone\]\(gone\/missing\.md\)/);
  });

  it("preserves the normalized link path set across the rewrite (round trip)", async () => {
    const body =
      "See [a](/x/a.md), [b](/x/b#s), [dir](/docs), and [ext](https://example.com/).\n";
    await write("docs/note.md", `---\ntype: Note\n---\n\n${body}`);
    const before = extractLinks(body, "docs/note.md");
    const report = await repairBundle(await bundle(), {
      write: true,
      only: ["absolute-links-to-relative"],
    });
    assert.equal(report.fixed, 3);
    const repaired = await read("docs/note.md");
    const after = extractLinks(repaired.split("---\n")[2]!, "docs/note.md");
    assert.deepEqual(
      after.map((l) => [l.kind, l.path]),
      before.map((l) => [l.kind, l.path]),
    );
    // The whole document, byte for byte: only the three targets changed.
    assert.equal(
      repaired,
      "---\ntype: Note\n---\n\n" +
        "See [a](../x/a.md), [b](../x/b#s), [dir](.), and [ext](https://example.com/).\n",
    );
    // Repaired links stay repaired: a second sweep finds nothing.
    const again = await repairBundle(await bundle(), {
      write: true,
      only: ["absolute-links-to-relative"],
    });
    assert.deepEqual(again.findings, []);
  });

  it("leaves bundle-absolute links inside fenced code blocks alone", async () => {
    await write(
      "guide.md",
      "---\ntype: Note\n---\n\n[real](/a/b.md)\n\n" +
        "```md\n[example](/a/b.md)\n```\n",
    );
    const report = await repairBundle(await bundle(), {
      write: true,
      only: ["absolute-links-to-relative"],
    });
    assert.equal(report.fixed, 1);
    const repaired = await read("guide.md");
    assert.match(repaired, /\[real\]\(a\/b\.md\)/);
    assert.match(repaired, /```md\n\[example\]\(\/a\/b\.md\)\n```/);
  });

  it("validate flags bundle-absolute links before repair and is quiet after", async () => {
    await write("a.md", "---\ntype: Note\n---\n\nSee [b](/b.md).\n");
    await write("b.md", "---\ntype: Note\n---\n\nBody.\n");
    const before = await validateBundle(await bundle());
    assert.ok(
      before.warnings.some((w) =>
        w.message.includes("okf-mcp repair --only absolute-links-to-relative"),
      ),
    );
    await repairBundle(await bundle(), { write: true });
    const after = await validateBundle(await bundle());
    assert.deepEqual(
      after.warnings.filter((w) => w.message.includes("bundle-absolute")),
      [],
    );
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

describe("migration fixer registry (OKF v0.1 → v0.2)", () => {
  it("keeps the vocabulary-changing fixers out of the routine repair sweep", () => {
    assert.deepEqual(MIGRATION_FIXERS.map((f) => f.id), [
      "citations-to-sources",
      "timestamp-to-generated",
    ]);
    for (const fixer of MIGRATION_FIXERS) {
      assert.ok(
        !FIXERS.some((f) => f.id === fixer.id),
        `${fixer.id} must not run in the default repair sweep`,
      );
    }
  });

  it("points at the other command when --only names a fixer from it", () => {
    assert.throws(
      () => selectFixers(["timestamp-to-generated"]),
      /belongs to the other registry/,
    );
    assert.throws(
      () => selectFixers(["citation-format"], MIGRATION_FIXERS),
      /belongs to the other registry/,
    );
  });
});

describe("migrateBundle", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-migrate-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A v0.1 bundle: declared version, timestamps, and a Citations list. */
  async function v01Bundle(): Promise<LoadedBundle> {
    await fs.writeFile(
      path.join(root, "index.md"),
      '---\nokf_version: "0.1"\ndescription: Warehouse knowledge.\n---\n\n# Bundle Index\n',
    );
    await fs.mkdir(path.join(root, "tables"), { recursive: true });
    await fs.writeFile(
      path.join(root, "tables/orders.md"),
      "---\n# hand-written note\ntype: Table\ntitle: Orders\ntimestamp: '2026-05-28T22:53:05Z'\nowner: data-team\n---\n\n" +
        "# Schema\n\nOne row per order.\n\n# Citations\n\n[1] [Revenue policy](https://wiki.acme/revenue)\n",
    );
    return loadBundle({ id: "kb", root });
  }

  it("dry-runs by default: reports the conversion, writes nothing", async () => {
    const bundle = await v01Bundle();
    const before = await fs.readFile(path.join(root, "tables/orders.md"), "utf8");

    const report = await migrateBundle(bundle, { actor: "human:ahormati" });
    assert.equal(report.applied, false);
    assert.equal(report.from, "0.1");
    assert.equal(report.to, "0.2");
    assert.deepEqual(report.files, ["tables/orders.md"]);
    assert.equal(report.skipped, 0);
    // A dry run has stamped nothing; the report says what a --write would do
    // rather than claiming it happened.
    assert.equal(report.versionStamp, "would-stamp");
    assert.equal(await fs.readFile(path.join(root, "tables/orders.md"), "utf8"), before);
    assert.match(
      await fs.readFile(path.join(root, "index.md"), "utf8"),
      /okf_version: "0\.1"/,
    );
  });

  it("moves timestamp into generated and Citations into sources, then bumps the version", async () => {
    const bundle = await v01Bundle();
    const report = await migrateBundle(bundle, {
      write: true,
      actor: "human:ahormati",
    });
    assert.equal(report.applied, true);
    assert.equal(report.versionStamp, "stamped");
    assert.equal(report.skipped, 0);

    const migrated = await loadBundle({ id: "kb", root });
    assert.equal(migrated.okfVersion, "0.2");
    const orders = migrated.concepts.get("tables/orders")!;
    // The date carries over verbatim — it is the same fact — and `by` comes
    // from the configured actor, which v0.1 could not record.
    assert.deepEqual(orders.frontmatter.generated, {
      by: "human:ahormati",
      at: "2026-05-28T22:53:05Z",
    });
    assert.equal(orders.frontmatter.timestamp, undefined);
    assert.deepEqual(orders.frontmatter.sources, [
      {
        id: "revenue-policy",
        resource: "https://wiki.acme/revenue",
        title: "Revenue policy",
      },
    ]);
    assert.doesNotMatch(orders.body, /# Citations/);
    // Untouched content survives the splice: the schema section, the unknown
    // `owner` key, and the human's YAML comment.
    assert.match(orders.body, /# Schema\n\nOne row per order\./);
    assert.equal(orders.frontmatter.owner, "data-team");
    const source = await fs.readFile(path.join(root, "tables/orders.md"), "utf8");
    assert.match(source, /# hand-written note/);
    // The root index keeps its declared description alongside the new version.
    assert.equal(migrated.description, "Warehouse knowledge.");
  });

  it("leaves the migrated bundle clean under validate, and idempotent", async () => {
    await migrateBundle(await v01Bundle(), { write: true, actor: "human:ahormati" });
    const migrated = await loadBundle({ id: "kb", root });
    const report = await validateBundle(migrated);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(
      report.warnings.filter((w) => /vocabulary|timestamp|Citations|footnote/.test(w.message)),
      [],
    );
    // A second run finds nothing left to do.
    const again = await migrateBundle(migrated, { write: true, actor: "human:ahormati" });
    assert.deepEqual(again.files, []);
    assert.equal(again.versionStamp, "current");
  });

  it("refuses to invent an actor, leaving the document and version alone", async () => {
    const bundle = await v01Bundle();
    const report = await migrateBundle(bundle, { write: true });
    assert.equal(report.skipped, 1);
    assert.match(
      report.findings.find((f) => !f.fixable)!.message,
      /refusing to invent one/,
    );
    // Citations still migrate (they need no actor), but the version stamp is
    // withheld: a partly-migrated bundle must not advertise conformance.
    assert.equal(report.versionStamp, "withheld");
    const migrated = await loadBundle({ id: "kb", root });
    assert.equal(migrated.okfVersion, "0.1");
    assert.equal(
      migrated.concepts.get("tables/orders")?.frontmatter.timestamp,
      "2026-05-28T22:53:05Z",
    );
  });

  it("drops a timestamp shadowed by an existing generated record", async () => {
    await fs.writeFile(
      path.join(root, "x.md"),
      "---\ntype: Note\ntimestamp: '2020-01-01T00:00:00Z'\ngenerated: { by: human:a, at: 2026-06-20T22:53:05Z }\n---\n\nB.\n",
    );
    const report = await migrateBundle(await loadBundle({ id: "kb", root }), {
      write: true,
    });
    assert.equal(report.skipped, 0);
    const migrated = await loadBundle({ id: "kb", root });
    const fm = migrated.concepts.get("x")!.frontmatter;
    assert.equal(fm.timestamp, undefined);
    assert.equal(fm.generated?.at, "2026-06-20T22:53:05Z");
  });

  it("reports rather than guesses when citations are malformed", async () => {
    await fs.writeFile(
      path.join(root, "x.md"),
      "---\ntype: Note\n---\n\nB.\n\n# Citations\n\nsee the runbook somewhere\n",
    );
    const report = await migrateBundle(await loadBundle({ id: "kb", root }), {
      write: true,
      actor: "human:a",
    });
    assert.equal(report.skipped, 1);
    assert.match(report.findings[0]!.message, /repair --only citation-format/);
    assert.match(await fs.readFile(path.join(root, "x.md"), "utf8"), /# Citations/);
  });

  it("reports rather than merges when both vocabularies carry provenance", async () => {
    await fs.writeFile(
      path.join(root, "x.md"),
      "---\ntype: Note\nsources:\n  - { id: a, resource: https://example.com/a }\n---\n\n" +
        "B.\n\n# Citations\n\n[1] [Other](https://example.com/b)\n",
    );
    const report = await migrateBundle(await loadBundle({ id: "kb", root }), {
      write: true,
      actor: "human:a",
    });
    assert.equal(report.skipped, 1);
    assert.match(report.findings[0]!.message, /merge them by hand/);
  });

  it("preserves the graph: a migrated citation to a sibling concept stays an edge", async () => {
    await fs.mkdir(path.join(root, "tables"), { recursive: true });
    await fs.writeFile(path.join(root, "tables/customers.md"), "---\ntype: Table\n---\n\nB.\n");
    await fs.writeFile(
      path.join(root, "tables/orders.md"),
      "---\ntype: Table\n---\n\nB.\n\n# Citations\n\n[1] [Customers](customers.md)\n",
    );
    const edgesBefore = buildGraph(await loadBundle({ id: "kb", root })).edges.length;

    await migrateBundle(await loadBundle({ id: "kb", root }), {
      write: true,
      actor: "human:a",
    });
    const migrated = await loadBundle({ id: "kb", root });
    // The link moved out of the body, but `sources[].resource` is a §6.2
    // path-valued field, so the derivation edge survives the migration.
    assert.equal(buildGraph(migrated).edges.length, edgesBefore);
    assert.equal(
      migrated.concepts.get("tables/orders")?.frontmatterLinks[0]?.resolvedId,
      "tables/customers",
    );
  });

  it("logs the sweep and refuses read-only bundles", async () => {
    await migrateBundle(await v01Bundle(), { write: true, actor: "human:a" });
    assert.match(
      await fs.readFile(path.join(root, "log.md"), "utf8"),
      /Migration to OKF 0\.2 \(okf-mcp migrate\)/,
    );
    const readOnly = { ...(await loadBundle({ id: "kb", root })), readOnly: true };
    await assert.rejects(migrateBundle(readOnly, { write: true }), /read-only/);
  });
});
