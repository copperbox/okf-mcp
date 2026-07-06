import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  appendLogEntry,
  assertSafeConceptPath,
  generateIndexes,
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
