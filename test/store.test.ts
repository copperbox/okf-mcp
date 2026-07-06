import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { OkfStore } from "../src/store.js";

async function writeDoc(root: string, relPath: string, frontmatter: string, body: string): Promise<void> {
  const absolute = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("OkfStore.reloadBundles", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-test-"));
    await writeDoc(root, "tables/orders.md", 'type: Table\ntitle: Orders', "Order rows.");
    await writeDoc(root, "tables/customers.md", 'type: Table\ntitle: Customers', "Customer rows.");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("picks up external edits and reports added/removed/changed concept IDs", async () => {
    const store = new OkfStore([{ id: "t", root }]);
    await store.load();

    await writeDoc(root, "metrics/revenue.md", "type: Metric", "Sum of totals.");
    await fs.rm(path.join(root, "tables/customers.md"));
    await writeDoc(root, "tables/orders.md", 'type: Table\ntitle: Orders v2', "Order rows.");

    const stats = await store.reloadBundles();
    assert.deepEqual(stats, [
      {
        bundle: "t",
        concepts: 2,
        problems: 0,
        added: ["metrics/revenue"],
        removed: ["tables/customers"],
        changed: ["tables/orders"],
      },
    ]);
    // The in-memory index reflects the reload.
    assert.equal(store.getConcept("t", "metrics/revenue")?.frontmatter.type, "Metric");
    assert.equal(store.getConcept("t", "tables/customers"), undefined);
  });

  it("reports empty deltas when nothing changed on disk", async () => {
    const store = new OkfStore([{ id: "t", root }]);
    await store.load();
    const stats = await store.reloadBundles();
    assert.deepEqual(stats, [
      { bundle: "t", concepts: 2, problems: 0, added: [], removed: [], changed: [] },
    ]);
  });

  it("reloads only the named bundle and rejects unknown IDs", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-test-"));
    try {
      await writeDoc(other, "a.md", "type: Note", "A.");
      const store = new OkfStore([
        { id: "t", root },
        { id: "o", root: other },
      ]);
      await store.load();

      await writeDoc(other, "b.md", "type: Note", "B.");
      await writeDoc(root, "c.md", "type: Note", "C.");

      const stats = await store.reloadBundles("o");
      assert.deepEqual(stats.map((s) => s.bundle), ["o"]);
      assert.deepEqual(stats[0]?.added, ["b"]);
      // Bundle "t" was not reloaded, so c.md is still invisible.
      assert.equal(store.getConcept("t", "c"), undefined);

      await assert.rejects(store.reloadBundles("nope"), /unknown bundle/);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});
