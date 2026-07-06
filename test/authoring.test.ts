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
  renameConcept,
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

  it("prepends log entries newest-first grouped by day", async () => {
    await appendLogEntry(root, "**Creation**: first", new Date("2026-07-01T10:00:00Z"));
    await appendLogEntry(root, "**Update**: second", new Date("2026-07-06T10:00:00Z"));
    await appendLogEntry(root, "**Update**: third", new Date("2026-07-06T11:00:00Z"));
    const log = await fs.readFile(path.join(root, "log.md"), "utf8");
    assert.ok(log.indexOf("## 2026-07-06") < log.indexOf("## 2026-07-01"));
    assert.ok(log.indexOf("third") < log.indexOf("second"));
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
    const written = await generateIndexes(bundle);
    assert.deepEqual(written, ["index.md", "tables/index.md"]);

    const rootIndex = await fs.readFile(path.join(root, "index.md"), "utf8");
    assert.match(rootIndex, /okf_version: "0.1"/);
    assert.match(rootIndex, /\[tables\]\(tables\/\)/);

    const tablesIndex = await fs.readFile(path.join(root, "tables/index.md"), "utf8");
    assert.match(tablesIndex, /\[Orders\]\(orders\.md\) - Order rows\./);
  });
});
