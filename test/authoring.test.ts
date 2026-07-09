import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  appendLogEntry,
  assertSafeConceptPath,
  deleteConcept,
  generateIndexes,
  nearestLogDirectory,
  renameConcept,
  renderIndexes,
  updateConcept,
  writeConcept,
} from "../src/authoring.js";
import { loadBundle } from "../src/bundle.js";

describe("assertSafeConceptPath", () => {
  it("accepts and normalizes safe relative markdown paths", () => {
    assert.equal(assertSafeConceptPath("tables/./orders.md"), "tables/orders.md");
  });

  it("rejects escapes, absolute paths, reserved names, and non-markdown", () => {
    assert.throws(() => assertSafeConceptPath("../outside.md"), /inside the bundle/);
    assert.throws(() => assertSafeConceptPath("/etc/x.md"), /inside the bundle/);
    assert.throws(() => assertSafeConceptPath("docs/index.md"), /reserved/);
    assert.throws(() => assertSafeConceptPath("log.md"), /reserved/);
    assert.throws(() => assertSafeConceptPath("notes/todo.txt"), /end in .md/);
    assert.throws(() => assertSafeConceptPath(".obsidian/x.md"), /start with/);
  });
});

describe("authoring", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-test-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes a concept that round-trips through the bundle loader", async () => {
    const result = await writeConcept(
      root,
      "metrics/revenue.md",
      { type: "Metric", title: "Revenue", description: "Total revenue.", tags: ["finance"] },
      "# Definition\n\nSum of order totals.",
    );
    assert.equal(result.created, true);

    const bundle = await loadBundle({ id: "t", root });
    const concept = bundle.concepts.get("metrics/revenue");
    assert.equal(concept?.frontmatter.title, "Revenue");
    assert.match(concept?.body ?? "", /Sum of order totals/);
  });

  it("requires a non-empty type", async () => {
    await assert.rejects(
      writeConcept(root, "x.md", { type: " " }, "Body"),
      /non-empty `type`/,
    );
  });

  it("defaults timestamp to now, between tags and extension keys", async () => {
    const before = Date.now();
    await writeConcept(
      root,
      "metrics/revenue.md",
      { type: "Metric", owner: "data-team", tags: ["finance"] },
      "Body",
    );
    const after = Date.now();

    const bundle = await loadBundle({ id: "t", root });
    const timestamp = bundle.concepts.get("metrics/revenue")?.frontmatter.timestamp;
    assert.equal(typeof timestamp, "string");
    assert.match(timestamp as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const written = Date.parse(timestamp as string);
    assert.ok(written >= before && written <= after);

    const source = await fs.readFile(path.join(root, "metrics/revenue.md"), "utf8");
    const keys = [...source.matchAll(/^(\w+):/gm)].map((match) => match[1]);
    assert.deepEqual(keys, ["type", "tags", "timestamp", "owner"]);
  });

  it("preserves a caller-provided timestamp verbatim", async () => {
    await writeConcept(
      root,
      "x.md",
      { type: "Note", timestamp: "2020-05-04T00:00:00Z" },
      "Body",
    );
    const bundle = await loadBundle({ id: "t", root });
    assert.equal(bundle.concepts.get("x")?.frontmatter.timestamp, "2020-05-04T00:00:00Z");
  });

  it("refreshes the timestamp when an update omits it", async () => {
    await writeConcept(
      root,
      "x.md",
      { type: "Note", timestamp: "2020-01-01T00:00:00Z" },
      "Old body",
    );
    const before = Date.now();
    await writeConcept(root, "x.md", { type: "Note" }, "New body");

    const bundle = await loadBundle({ id: "t", root });
    const timestamp = bundle.concepts.get("x")?.frontmatter.timestamp;
    assert.equal(typeof timestamp, "string");
    assert.ok(Date.parse(timestamp as string) >= before);
  });

  it("patches frontmatter keys, preserving untouched keys, comments, and the body byte-for-byte", async () => {
    const original =
      "---\n# reviewed 2026-06\ntype: Table\nowner: data-team\ntitle: Orders\n---\n\n# Schema\n\nColumns.\n";
    await fs.mkdir(path.join(root, "tables"), { recursive: true });
    await fs.writeFile(path.join(root, "tables/orders.md"), original);
    const bundle = await loadBundle({ id: "t", root });

    const result = await updateConcept(bundle, "tables/orders", {
      frontmatter: { title: "Order Facts", status: "active", owner: null },
    });
    assert.equal(result.id, "tables/orders");
    assert.equal(result.path, "tables/orders.md");
    assert.equal(result.title, "Order Facts");
    assert.deepEqual(result.updatedKeys, ["title", "status", "timestamp"]);
    assert.deepEqual(result.deletedKeys, ["owner"]);

    const source = await fs.readFile(path.join(root, "tables/orders.md"), "utf8");
    assert.match(source, /# reviewed 2026-06\ntype: Table\n/);
    assert.doesNotMatch(source, /owner: data-team/);
    assert.match(source, /title: Order Facts/);
    assert.ok(source.endsWith("---\n\n# Schema\n\nColumns.\n"));
  });

  it("refreshes the timestamp by default on a frontmatter patch", async () => {
    await writeConcept(
      root,
      "x.md",
      { type: "Note", timestamp: "2020-01-01T00:00:00Z" },
      "Body",
    );
    const bundle = await loadBundle({ id: "t", root });

    const before = Date.now();
    const result = await updateConcept(bundle, "x", { frontmatter: { owner: "data-team" } });
    assert.deepEqual(result.updatedKeys, ["owner", "timestamp"]);

    const reloaded = await loadBundle({ id: "t", root });
    const timestamp = reloaded.concepts.get("x")?.frontmatter.timestamp;
    assert.equal(typeof timestamp, "string");
    assert.ok(Date.parse(timestamp as string) >= before);
  });

  it("refreshes the timestamp on a section-only update", async () => {
    await writeConcept(
      root,
      "x.md",
      { type: "Note", timestamp: "2020-01-01T00:00:00Z" },
      "# A\n\nOld.",
    );
    const bundle = await loadBundle({ id: "t", root });

    const before = Date.now();
    const result = await updateConcept(bundle, "x", {
      section: { heading: "A", content: "New." },
    });
    assert.deepEqual(result.updatedKeys, ["timestamp"]);

    const reloaded = await loadBundle({ id: "t", root });
    const timestamp = reloaded.concepts.get("x")?.frontmatter.timestamp;
    assert.ok(Date.parse(timestamp as string) >= before);
  });

  it("gives a concept without a timestamp one in its spec-order slot", async () => {
    const original =
      "---\n# provenance note\ntype: Table\ntags:\n  - sales\nowner: data-team\n---\n\nBody.\n";
    await fs.writeFile(path.join(root, "orders.md"), original);
    const bundle = await loadBundle({ id: "t", root });

    await updateConcept(bundle, "orders", { frontmatter: { owner: "core" } });

    const source = await fs.readFile(path.join(root, "orders.md"), "utf8");
    assert.match(source, /# provenance note\ntype: Table\n/);
    const keys = [...source.matchAll(/^(\w+):/gm)].map((match) => match[1]);
    assert.deepEqual(keys, ["type", "tags", "timestamp", "owner"]);
  });

  it("lets an explicit timestamp in the patch win over the refresh", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    await updateConcept(bundle, "x", {
      frontmatter: { timestamp: "1999-12-31T23:59:59Z" },
    });
    const reloaded = await loadBundle({ id: "t", root });
    assert.equal(reloaded.concepts.get("x")?.frontmatter.timestamp, "1999-12-31T23:59:59Z");
  });

  it("deletes the timestamp on explicit null instead of refreshing it", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    const result = await updateConcept(bundle, "x", { frontmatter: { timestamp: null } });
    assert.deepEqual(result.deletedKeys, ["timestamp"]);
    const source = await fs.readFile(path.join(root, "x.md"), "utf8");
    assert.doesNotMatch(source, /timestamp/);
  });

  it("keepTimestamp preserves the existing timestamp byte-for-byte", async () => {
    const original =
      "---\ntype: Note\ntimestamp: 2020-01-01 # hand-stamped\n---\n\n# A\n\nOld.\n";
    await fs.writeFile(path.join(root, "x.md"), original);
    const bundle = await loadBundle({ id: "t", root });

    const result = await updateConcept(bundle, "x", {
      frontmatter: { owner: "core" },
      section: { heading: "A", content: "New." },
      keepTimestamp: true,
    });
    assert.deepEqual(result.updatedKeys, ["owner"]);
    const source = await fs.readFile(path.join(root, "x.md"), "utf8");
    assert.match(source, /timestamp: 2020-01-01 # hand-stamped\n/);
    assert.match(source, /owner: core/);
  });

  it("still applies a section-only update when there is no frontmatter block to stamp", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "# A\n\nOld.");
    const bundle = await loadBundle({ id: "t", root });
    // A concurrent edit strips the frontmatter block after the bundle loads.
    await fs.writeFile(path.join(root, "x.md"), "# A\n\nOld.\n");

    const result = await updateConcept(bundle, "x", {
      section: { heading: "A", content: "New." },
    });
    assert.equal(result.replacedSection, "A");
    assert.deepEqual(result.updatedKeys, []);
    assert.equal(await fs.readFile(path.join(root, "x.md"), "utf8"), "# A\n\nNew.\n");
  });

  it("replaces one body section, leaving the rest of the document byte-for-byte intact", async () => {
    const original =
      "---\ntype: Table\n---\n\nIntro.\n\n# Schema\n\nOld columns.\n\n## Keys\n\nOld key.\n\n# Examples\n\nQuery.\n";
    await fs.writeFile(path.join(root, "orders.md"), original);
    const bundle = await loadBundle({ id: "t", root });

    const result = await updateConcept(bundle, "orders", {
      section: { heading: "schema", content: "New columns.\n\n## Keys\n\nNew key." },
      keepTimestamp: true,
    });
    assert.equal(result.replacedSection, "Schema");
    assert.deepEqual(result.updatedKeys, []);

    const source = await fs.readFile(path.join(root, "orders.md"), "utf8");
    assert.equal(
      source,
      "---\ntype: Table\n---\n\nIntro.\n\n# Schema\n\nNew columns.\n\n## Keys\n\nNew key.\n\n# Examples\n\nQuery.\n",
    );
  });

  it("replaces the last section without disturbing the trailing newline", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "# A\n\nOne.\n\n# B\n\nTwo.");
    const bundle = await loadBundle({ id: "t", root });

    await updateConcept(bundle, "x", { section: { heading: "B", content: "New two." } });
    const source = await fs.readFile(path.join(root, "x.md"), "utf8");
    assert.match(source, /# A\n\nOne\.\n\n# B\n\nNew two\.\n$/);
  });

  it("applies a frontmatter patch and a section replacement together", async () => {
    await writeConcept(
      root,
      "x.md",
      { type: "Note", title: "X" },
      "# A\n\nOne.\n\n# B\n\nTwo.",
    );
    const bundle = await loadBundle({ id: "t", root });

    const result = await updateConcept(bundle, "x", {
      frontmatter: { title: "X2" },
      section: { heading: "A", content: "New one." },
    });
    assert.deepEqual(result.updatedKeys, ["title", "timestamp"]);
    assert.equal(result.replacedSection, "A");
    const source = await fs.readFile(path.join(root, "x.md"), "utf8");
    assert.match(source, /title: X2/);
    assert.match(source, /# A\n\nNew one\.\n\n# B\n\nTwo\.\n$/);
  });

  it("rejects an unknown section, listing what is available", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "# A\n\nOne.\n\n# B\n\nTwo.");
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(
      updateConcept(bundle, "x", { section: { heading: "C", content: "?" } }),
      /no section "C".*available sections: A, B/,
    );
    // Nothing was written.
    assert.match(await fs.readFile(path.join(root, "x.md"), "utf8"), /# A\n\nOne\./);
  });

  it("requires at least one of a frontmatter patch or a section replacement", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(updateConcept(bundle, "x", {}), /frontmatter patch|section/);
    await assert.rejects(updateConcept(bundle, "x", { frontmatter: {} }), /frontmatter patch|section/);
  });

  it("refuses to delete or blank the required type key", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(
      updateConcept(bundle, "x", { frontmatter: { type: null } }),
      /non-empty `type`/,
    );
    await assert.rejects(
      updateConcept(bundle, "x", { frontmatter: { type: " " } }),
      /non-empty `type`/,
    );
  });

  it("rejects reserved files and unknown concepts", async () => {
    await writeConcept(root, "x.md", { type: "Note" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(
      updateConcept(bundle, "log.md", { frontmatter: { a: 1 } }),
      /reserved/,
    );
    await assert.rejects(
      updateConcept(bundle, "nope", { frontmatter: { a: 1 } }),
      /unknown concept/,
    );
  });

  it("patches the document as it is on disk, not the loaded snapshot", async () => {
    await writeConcept(root, "bare.md", { type: "Note" }, "# A\n\nOld.");
    const bundle = await loadBundle({ id: "t", root });
    // A concurrent editor stripped the frontmatter after the bundle loaded.
    await fs.writeFile(path.join(root, "bare.md"), "# A\n\nNo frontmatter here.\n");

    await assert.rejects(
      updateConcept(bundle, "bare", { frontmatter: { owner: "x" } }),
      /no frontmatter/,
    );
    // A section-only update still works against the on-disk state.
    await updateConcept(bundle, "bare", { section: { heading: "A", content: "Patched." } });
    assert.equal(
      await fs.readFile(path.join(root, "bare.md"), "utf8"),
      "# A\n\nPatched.\n",
    );
  });

  it("prepends log entries newest-first grouped by day", async () => {
    await appendLogEntry(root, "**Creation**: first", { date: new Date("2026-07-01T10:00:00Z") });
    await appendLogEntry(root, "**Update**: second", { date: new Date("2026-07-06T10:00:00Z") });
    const result = await appendLogEntry(root, "**Update**: third", {
      date: new Date("2026-07-06T11:00:00Z"),
    });
    assert.equal(result.path, "log.md");
    const log = await fs.readFile(path.join(root, "log.md"), "utf8");
    assert.ok(log.startsWith("# Update Log\n"));
    assert.ok(log.indexOf("## 2026-07-06") < log.indexOf("## 2026-07-01"));
    assert.ok(log.indexOf("third") < log.indexOf("second"));
  });

  it("writes scoped entries to the directory's log.md, creating it on first use", async () => {
    const result = await appendLogEntry(root, "**Update**: scoped", {
      directory: "tables",
      date: new Date("2026-07-06T10:00:00Z"),
    });
    assert.equal(result.path, "tables/log.md");
    const log = await fs.readFile(path.join(root, "tables/log.md"), "utf8");
    assert.ok(log.startsWith("# Directory Update Log\n"));
    assert.ok(log.indexOf("## 2026-07-06") < log.indexOf("scoped"));
    // The root log is untouched by a scoped entry.
    await assert.rejects(fs.access(path.join(root, "log.md")));
  });

  it("groups scoped entries newest-first like the root log", async () => {
    await appendLogEntry(root, "**Creation**: first", {
      directory: "tables/facts",
      date: new Date("2026-07-01T10:00:00Z"),
    });
    await appendLogEntry(root, "**Update**: second", {
      directory: "tables/facts",
      date: new Date("2026-07-06T10:00:00Z"),
    });
    const log = await fs.readFile(path.join(root, "tables/facts/log.md"), "utf8");
    assert.ok(log.indexOf("## 2026-07-06") < log.indexOf("## 2026-07-01"));
  });

  it("treats '', '.', and trailing slashes as normalized directories", async () => {
    const rootLog = await appendLogEntry(root, "**Update**: at root", { directory: "." });
    assert.equal(rootLog.path, "log.md");
    const scoped = await appendLogEntry(root, "**Update**: scoped", { directory: "tables/" });
    assert.equal(scoped.path, "tables/log.md");
  });

  it("resolves the nearest existing directory log for a concept path", async () => {
    await writeConcept(root, "tables/facts/orders.md", { type: "Table" }, "Body");
    // No directory log anywhere: fall back to the bundle root.
    assert.equal(await nearestLogDirectory(root, "tables/facts/orders.md"), "");
    // An ancestor log is found across intermediate levels without one.
    await appendLogEntry(root, "**Creation**: tables scope", { directory: "tables" });
    assert.equal(await nearestLogDirectory(root, "tables/facts/orders.md"), "tables");
    // The concept's own directory wins over an ancestor's.
    await appendLogEntry(root, "**Creation**: facts scope", { directory: "tables/facts" });
    assert.equal(await nearestLogDirectory(root, "tables/facts/orders.md"), "tables/facts");
    // A root-level concept always resolves to the root.
    assert.equal(await nearestLogDirectory(root, "readme-ish.md"), "");
  });

  it("rejects log directories that escape the bundle or hide in dot-directories", async () => {
    await assert.rejects(
      appendLogEntry(root, "x", { directory: "../outside" }),
      /inside the bundle/,
    );
    await assert.rejects(appendLogEntry(root, "x", { directory: "/etc" }), /inside the bundle/);
    await assert.rejects(
      appendLogEntry(root, "x", { directory: "tables/../../up" }),
      /inside the bundle/,
    );
    await assert.rejects(appendLogEntry(root, "x", { directory: ".obsidian" }), /start with/);
  });

  it("deletes a concept and reports concepts still linking to it", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
    await writeConcept(
      root,
      "metrics/revenue.md",
      { type: "Metric", title: "Revenue" },
      "Derived from [Orders](/tables/orders.md).",
    );
    const bundle = await loadBundle({ id: "t", root });

    const result = await deleteConcept(bundle, "tables/orders");
    assert.equal(result.path, "tables/orders.md");
    assert.deepEqual(result.inboundLinks, ["metrics/revenue"]);
    await assert.rejects(fs.access(path.join(root, "tables/orders.md")));
  });

  it("resolves a trailing .md and rejects reserved or unknown targets", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(deleteConcept(bundle, "log.md"), /reserved/);
    await assert.rejects(deleteConcept(bundle, "tables/index"), /reserved/);
    await assert.rejects(deleteConcept(bundle, "nope"), /unknown concept/);

    const result = await deleteConcept(bundle, "tables/orders.md");
    assert.equal(result.path, "tables/orders.md");
  });

  it("refuses to delete a linked concept when failIfLinked is set", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    await writeConcept(
      root,
      "metrics/revenue.md",
      { type: "Metric" },
      "See [Orders](/tables/orders.md).",
    );
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(
      deleteConcept(bundle, "tables/orders", { failIfLinked: true }),
      /still linked/,
    );
    await fs.access(path.join(root, "tables/orders.md"));
  });

  it("removes now-empty directories and their generated index.md", async () => {
    await writeConcept(root, "tables/sales/orders.md", { type: "Table" }, "Body");
    await writeConcept(root, "metrics/revenue.md", { type: "Metric" }, "Body");
    let bundle = await loadBundle({ id: "t", root });
    await generateIndexes(bundle);

    bundle = await loadBundle({ id: "t", root });
    const result = await deleteConcept(bundle, "tables/sales/orders");
    assert.deepEqual(result.removedDirs, ["tables/sales", "tables"]);
    await assert.rejects(fs.access(path.join(root, "tables")));
    // Unrelated directories stay put.
    await fs.access(path.join(root, "metrics/revenue.md"));
  });

  it("keeps a directory whose index.md is hand-curated when the last concept leaves", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    await writeConcept(root, "metrics/revenue.md", { type: "Metric" }, "Body");
    const curated = "---\ngenerated: false\n---\n\n# Tables, by hand\n";
    await fs.writeFile(path.join(root, "tables/index.md"), curated);
    const bundle = await loadBundle({ id: "t", root });

    const result = await deleteConcept(bundle, "tables/orders");
    assert.deepEqual(result.removedDirs, []);
    assert.equal(await fs.readFile(path.join(root, "tables/index.md"), "utf8"), curated);
  });

  it("keeps a directory that still contains other concepts", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    await writeConcept(root, "tables/customers.md", { type: "Table" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    const result = await deleteConcept(bundle, "tables/orders");
    assert.deepEqual(result.removedDirs, []);
    await fs.access(path.join(root, "tables/customers.md"));
  });

  it("renames a concept and rewrites absolute inbound links in place", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
    await writeConcept(
      root,
      "metrics/revenue.md",
      { type: "Metric", title: "Revenue" },
      "Derived   from [Orders](/tables/orders.md#totals) and [same](/tables/orders).",
    );
    const bundle = await loadBundle({ id: "t", root });

    const result = await renameConcept(bundle, "tables/orders", "archive/orders.md");
    assert.equal(result.from, "tables/orders.md");
    assert.equal(result.to, "archive/orders.md");
    assert.deepEqual(result.rewrittenFiles, ["metrics/revenue.md"]);

    await assert.rejects(fs.access(path.join(root, "tables/orders.md")));
    await fs.access(path.join(root, "archive/orders.md"));
    const revenue = await fs.readFile(path.join(root, "metrics/revenue.md"), "utf8");
    // Absolute links stay absolute; fragments and extensionless style survive;
    // surrounding formatting is untouched byte-for-byte.
    assert.match(revenue, /Derived {3}from \[Orders\]\(\/archive\/orders\.md#totals\) and \[same\]\(\/archive\/orders\)\./);
  });

  it("rewrites relative inbound links recomputed from the linking file's directory", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    await writeConcept(
      root,
      "tables/customers.md",
      { type: "Table" },
      "See [orders](./orders.md) and [bare](orders.md).",
    );
    const bundle = await loadBundle({ id: "t", root });

    await renameConcept(bundle, "tables/orders", "archive/deep/orders.md");
    const customers = await fs.readFile(path.join(root, "tables/customers.md"), "utf8");
    assert.match(customers, /\[orders\]\(\.\.\/archive\/deep\/orders\.md\)/);
    assert.match(customers, /\[bare\]\(\.\.\/archive\/deep\/orders\.md\)/);
  });

  it("rewrites the moved concept's own relative links, leaving absolute and external ones", async () => {
    await writeConcept(root, "tables/customers.md", { type: "Table" }, "Body");
    await writeConcept(root, "tables/regions.md", { type: "Table" }, "Body");
    await writeConcept(
      root,
      "tables/orders.md",
      { type: "Table" },
      "Joins [customers](./customers.md), [regions](/tables/regions.md), [self](./orders.md), and [docs](https://example.com/x).",
    );
    const bundle = await loadBundle({ id: "t", root });

    const result = await renameConcept(bundle, "tables/orders", "archive/orders.md");
    assert.ok(result.rewrittenFiles.includes("archive/orders.md"));
    const moved = await fs.readFile(path.join(root, "archive/orders.md"), "utf8");
    assert.match(moved, /\[customers\]\(\.\.\/tables\/customers\.md\)/);
    assert.match(moved, /\[regions\]\(\/tables\/regions\.md\)/);
    assert.match(moved, /\[self\]\(\.\/orders\.md\)/);
    assert.match(moved, /\[docs\]\(https:\/\/example\.com\/x\)/);
  });

  it("refuses to overwrite an existing concept and validates the target path", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    await writeConcept(root, "tables/customers.md", { type: "Table" }, "Body");
    const bundle = await loadBundle({ id: "t", root });

    await assert.rejects(
      renameConcept(bundle, "tables/orders", "tables/customers.md"),
      /already exists/,
    );
    await assert.rejects(renameConcept(bundle, "tables/orders", "../out.md"), /inside the bundle/);
    await assert.rejects(renameConcept(bundle, "tables/orders", "docs/index.md"), /reserved/);
    await assert.rejects(renameConcept(bundle, "log.md", "x.md"), /reserved/);
    await assert.rejects(renameConcept(bundle, "nope", "x.md"), /unknown concept/);
    await fs.access(path.join(root, "tables/orders.md"));
  });

  it("removes directories emptied by the rename", async () => {
    await writeConcept(root, "tables/sales/orders.md", { type: "Table" }, "Body");
    await writeConcept(root, "metrics/revenue.md", { type: "Metric" }, "Body");
    let bundle = await loadBundle({ id: "t", root });
    await generateIndexes(bundle);

    bundle = await loadBundle({ id: "t", root });
    const result = await renameConcept(bundle, "tables/sales/orders", "orders.md");
    assert.deepEqual(result.removedDirs, ["tables/sales", "tables"]);
    await assert.rejects(fs.access(path.join(root, "tables")));
    await fs.access(path.join(root, "orders.md"));
  });

  it("generates index.md files with titles and descriptions per directory", async () => {
    await writeConcept(
      root,
      "tables/orders.md",
      { type: "Table", title: "Orders", description: "Order rows." },
      "Body",
    );
    const bundle = await loadBundle({ id: "t", root });
    const { written, skipped } = await generateIndexes(bundle);
    assert.deepEqual(written, ["index.md", "tables/index.md"]);
    assert.deepEqual(skipped, []);

    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf8");
    assert.match(rootIndex, /okf_version: "0.1"/);
    // Directory entries link to the subdirectory's index file, not the bare
    // directory — trailing-slash links do not resolve in Obsidian.
    assert.match(rootIndex, /\[tables\]\(tables\/index\.md\)/);

    const tablesIndex = await fs.readFile(path.join(root, "tables/index.md"), "utf8");
    assert.match(tablesIndex, /\[Orders\]\(orders\.md\) - Order rows\./);
  });

  it("preserves root-index frontmatter and a declared okf_version on regeneration", async () => {
    await fs.writeFile(
      path.join(root, "index.md"),
      '---\nokf_version: "0.2"\nowner: data-team\n---\n\n# Old Index\n',
    );
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
    const bundle = await loadBundle({ id: "t", root });
    await generateIndexes(bundle);

    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf8");
    assert.match(rootIndex, /okf_version: "0\.2"/);
    assert.match(rootIndex, /owner: data-team/);
    // The body is still regenerated; only the frontmatter is carried over.
    assert.match(rootIndex, /\[tables\]\(tables\/index\.md\)/);
    assert.doesNotMatch(rootIndex, /Old Index/);
    const reloaded = await loadBundle({ id: "t", root });
    assert.equal(reloaded.okfVersion, "0.2");
  });

  it("preserves a root-index description across regeneration", async () => {
    await fs.writeFile(
      path.join(root, "index.md"),
      '---\nokf_version: "0.1"\ndescription: Data warehouse knowledge.\n---\n\n# Old Index\n',
    );
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
    const bundle = await loadBundle({ id: "t", root });
    await generateIndexes(bundle);

    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf8");
    assert.match(rootIndex, /description: Data warehouse knowledge\./);
    const reloaded = await loadBundle({ id: "t", root });
    assert.equal(reloaded.description, "Data warehouse knowledge.");
  });

  it("stamps okf_version only when the existing root frontmatter lacks it", async () => {
    await fs.writeFile(
      path.join(root, "index.md"),
      "---\nowner: data-team\n---\n\n# Old Index\n",
    );
    await writeConcept(root, "x.md", { type: "Note" }, "Body");
    const bundle = await loadBundle({ id: "t", root });
    await generateIndexes(bundle);

    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf8");
    assert.match(rootIndex, /okf_version: "0.1"/);
    assert.match(rootIndex, /owner: data-team/);
  });

  it("skips hand-curated indexes marked generated: false and reports why", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
    const curated =
      "---\ngenerated: false\n---\n\n# Getting Started\n\n* [Orders](orders.md) - start here\n";
    await fs.mkdir(path.join(root, "tables"), { recursive: true });
    await fs.writeFile(path.join(root, "tables/index.md"), curated);

    const bundle = await loadBundle({ id: "t", root });
    const { written, skipped } = await generateIndexes(bundle);
    assert.deepEqual(written, ["index.md"]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.path, "tables/index.md");
    assert.match(skipped[0]!.reason, /generated: false/);

    const tablesIndex = await fs.readFile(path.join(root, "tables/index.md"), "utf8");
    assert.equal(tablesIndex, curated);
  });

  it("skips a hand-curated bundle-root index entirely", async () => {
    await writeConcept(root, "tables/orders.md", { type: "Table" }, "Body");
    const curated =
      '---\nokf_version: "0.1"\ngenerated: false\n---\n\n# Curated Home\n\n* [Tables](tables/) - by hand\n';
    await fs.writeFile(path.join(root, "index.md"), curated);

    const bundle = await loadBundle({ id: "t", root });
    const { written, skipped } = await generateIndexes(bundle);
    assert.deepEqual(written, ["tables/index.md"]);
    assert.deepEqual(skipped.map((s) => s.path), ["index.md"]);
    assert.equal(await fs.readFile(path.join(root, "index.md"), "utf8"), curated);
  });

  it("derives index entry titles from the filename when frontmatter has none", async () => {
    await writeConcept(root, "tables/customer-order-history.md", { type: "Table" }, "Body");
    const bundle = await loadBundle({ id: "t", root });
    const rendered = renderIndexes(bundle);
    assert.match(
      rendered.get("tables/index.md")!,
      /\[Customer Order History\]\(customer-order-history\.md\)/,
    );
  });

  it("renders index content in memory without writing files", async () => {
    await writeConcept(
      root,
      "tables/orders.md",
      { type: "Table", title: "Orders", description: "Order rows." },
      "Body",
    );
    const bundle = await loadBundle({ id: "t", root });
    const rendered = renderIndexes(bundle);

    assert.deepEqual([...rendered.keys()].sort(), ["index.md", "tables/index.md"]);
    assert.match(rendered.get("index.md")!, /okf_version: "0.1"/);
    assert.match(rendered.get("index.md")!, /\[tables\]\(tables\/index\.md\)/);
    assert.match(
      rendered.get("tables/index.md")!,
      /\[Orders\]\(orders\.md\) - Order rows\./,
    );
    // Pure rendering: nothing hit the disk.
    await assert.rejects(fs.access(path.join(root, "index.md")));
    await assert.rejects(fs.access(path.join(root, "tables/index.md")));
  });
});
