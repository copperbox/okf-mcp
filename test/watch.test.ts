import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { BundleReloadStats } from "../src/store.js";
import { OkfStore } from "../src/store.js";
import { watchBundles } from "../src/watch.js";
import type { BundleWatcher } from "../src/watch.js";

async function writeDoc(root: string, relPath: string, frontmatter: string, body: string): Promise<void> {
  const absolute = path.join(root, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, `---\n${frontmatter}\n---\n\n${body}\n`);
}

/** Poll until `condition` returns true, failing after `timeoutMs`. */
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("watchBundles", () => {
  let root: string;
  let store: OkfStore;
  let watcher: BundleWatcher | undefined;
  let reloads: BundleReloadStats[][];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-watch-test-"));
    await writeDoc(root, "tables/orders.md", "type: Table\ntitle: Orders", "Order rows.");
    store = new OkfStore([{ id: "t", root }]);
    await store.load();
    reloads = [];
  });

  afterEach(async () => {
    watcher?.close();
    watcher = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reloads the store when a .md file is written externally", async () => {
    watcher = watchBundles(store, [{ id: "t", root }], {
      debounceMs: 25,
      onReload: (stats) => reloads.push(stats),
    });
    assert.deepEqual(watcher.watching, ["t"]);

    await writeDoc(root, "metrics/revenue.md", "type: Metric", "Sum of totals.");
    await until(
      async () => (await store.getConcept("t", "metrics/revenue")) !== undefined,
      "the new concept to appear in the store",
    );
    const added = reloads.flat().flatMap((s) => s.added);
    assert.ok(added.includes("metrics/revenue"), `added ${JSON.stringify(added)}`);
  });

  it("coalesces a burst of writes into one reload", async () => {
    watcher = watchBundles(store, [{ id: "t", root }], {
      debounceMs: 250,
      onReload: (stats) => reloads.push(stats),
    });

    await writeDoc(root, "a.md", "type: Note", "A.");
    await writeDoc(root, "b.md", "type: Note", "B.");
    await writeDoc(root, "c.md", "type: Note", "C.");
    await until(() => reloads.length >= 1, "the debounced reload");
    // All three writes landed within one debounce window.
    assert.equal(reloads.length, 1);
    assert.deepEqual(reloads[0]?.flatMap((s) => s.added).sort(), ["a", "b", "c"]);
  });

  it("ignores non-.md files and dot directories", async () => {
    watcher = watchBundles(store, [{ id: "t", root }], {
      debounceMs: 25,
      onReload: (stats) => reloads.push(stats),
    });

    await fs.writeFile(path.join(root, "notes.txt"), "not markdown");
    await fs.mkdir(path.join(root, ".obsidian"), { recursive: true });
    await fs.writeFile(path.join(root, ".obsidian", "workspace.json"), "{}");
    await sleep(200);
    assert.equal(reloads.length, 0);

    // Control: the watcher is still alive and reacts to a real concept edit.
    await writeDoc(root, "d.md", "type: Note", "D.");
    await until(() => reloads.length >= 1, "the .md reload");
    assert.deepEqual(reloads.flat().flatMap((s) => s.added), ["d"]);
  });

  it("stops reloading after close()", async () => {
    watcher = watchBundles(store, [{ id: "t", root }], {
      debounceMs: 25,
      onReload: (stats) => reloads.push(stats),
    });
    watcher.close();

    await writeDoc(root, "late.md", "type: Note", "Late.");
    await sleep(200);
    assert.equal(reloads.length, 0);
    assert.equal(await store.getConcept("t", "late"), undefined);
  });

  it("watches a lazy bundle only after it hydrates", async () => {
    const lazyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okf-watch-lazy-"));
    try {
      await writeDoc(lazyRoot, "acme/note.md", "type: Note\ntitle: Note", "Body.");
      const config = {
        id: "acme",
        root: path.join(lazyRoot, "acme"),
        colocatedRoot: lazyRoot,
        lazy: true,
      };
      const lazyStore = new OkfStore([config]);
      await lazyStore.load();
      watcher = watchBundles(lazyStore, [config], {
        debounceMs: 25,
        onReload: (stats) => reloads.push(stats),
      });
      assert.deepEqual(watcher.watching, []);

      // Unloaded: edits are invisible and trigger no reload.
      await writeDoc(lazyRoot, "acme/early.md", "type: Note", "Early.");
      await sleep(200);
      assert.equal(reloads.length, 0);

      // First access hydrates (picking up the earlier edit) and starts watching.
      const bundle = await lazyStore.bundle("acme");
      assert.deepEqual([...bundle.concepts.keys()], ["early", "note"]);
      assert.deepEqual(watcher.watching, ["acme"]);

      await writeDoc(lazyRoot, "acme/late.md", "type: Note", "Late.");
      await until(
        async () => (await lazyStore.getConcept("acme", "late")) !== undefined,
        "the post-hydration edit to reload",
      );
      assert.ok(reloads.flat().some((s) => s.added.includes("late")));
    } finally {
      await fs.rm(lazyRoot, { recursive: true, force: true });
    }
  });

  it("reports bundles it cannot watch instead of throwing", async () => {
    const errors: { bundleId: string; error: Error }[] = [];
    watcher = watchBundles(
      store,
      [
        { id: "t", root },
        { id: "missing", root: path.join(root, "does-not-exist") },
      ],
      {
        debounceMs: 25,
        onError: (bundleId, error) => errors.push({ bundleId, error }),
      },
    );
    assert.deepEqual(watcher.watching, ["t"]);
    assert.deepEqual(errors.map((e) => e.bundleId), ["missing"]);
  });
});
