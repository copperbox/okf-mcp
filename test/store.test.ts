import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { OkfStore } from "../src/store.js";
import { fakeGitHub } from "./fake-github.js";

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
    assert.equal((await store.getConcept("t", "metrics/revenue"))?.frontmatter.type, "Metric");
    assert.equal(await store.getConcept("t", "tables/customers"), undefined);
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
      assert.equal(await store.getConcept("t", "c"), undefined);

      await assert.rejects(store.reloadBundles("nope"), /unknown bundle/);
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe("OkfStore lazy bundles", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-lazy-"));
    await fs.mkdir(path.join(root, "acme"));
    await fs.writeFile(
      path.join(root, "acme", "index.md"),
      '---\ndescription: "Acme knowledge."\n---\n\n# Index\n',
    );
    await writeDoc(root, "acme/note.md", "type: Note\ntitle: Note", "Body.");
    await writeDoc(root, "ops/runbook.md", "type: Runbook\ntitle: Runbook", "Steps.");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function lazyStore(): OkfStore {
    return new OkfStore([
      { id: "acme", root: path.join(root, "acme"), colocatedRoot: root, lazy: true },
      { id: "ops", root: path.join(root, "ops"), colocatedRoot: root, lazy: true },
    ]);
  }

  it("discovers lazy bundles without loading and hydrates on first access", async () => {
    const store = lazyStore();
    await store.load();

    assert.deepEqual(store.bundles(), []);
    assert.deepEqual(store.discoveredBundles(), [
      {
        id: "acme",
        root: path.join(root, "acme"),
        description: "Acme knowledge.",
        colocatedRoot: root,
      },
      { id: "ops", root: path.join(root, "ops"), colocatedRoot: root },
    ]);

    const bundle = await store.bundle("acme");
    assert.deepEqual([...bundle.concepts.keys()], ["note"]);
    assert.equal(bundle.colocatedRoot, root);
    assert.deepEqual(store.bundles().map((b) => b.id), ["acme"]);
    assert.deepEqual(store.discoveredBundles().map((d) => d.id), ["ops"]);
  });

  it("getConcept hydrates, and an unknown id names the discovered bundles", async () => {
    const store = lazyStore();
    await store.load();
    const concept = await store.getConcept("ops", "runbook");
    assert.equal(concept?.frontmatter.type, "Runbook");
    await assert.rejects(store.bundle("nope"), /available: ops, acme/);
  });

  it("bundle() with no id hydrates the only configured bundle", async () => {
    const store = new OkfStore([
      { id: "acme", root: path.join(root, "acme"), colocatedRoot: root, lazy: true },
    ]);
    await store.load();
    const bundle = await store.bundle();
    assert.equal(bundle.id, "acme");
  });

  it("concurrent first accesses share one load and notify onHydrate once", async () => {
    const store = lazyStore();
    await store.load();
    const hydrated: string[] = [];
    store.onHydrate((bundle) => hydrated.push(bundle.id));
    const [a, b] = await Promise.all([store.bundle("acme"), store.bundle("acme")]);
    assert.equal(a, b);
    assert.deepEqual(hydrated, ["acme"]);
  });

  it("no-arg reloadBundles skips unloaded bundles; naming one hydrates it", async () => {
    const store = lazyStore();
    await store.load();
    await store.bundle("acme");

    assert.deepEqual((await store.reloadBundles()).map((s) => s.bundle), ["acme"]);
    assert.deepEqual(store.discoveredBundles().map((d) => d.id), ["ops"]);

    const stats = await store.reloadBundles("ops");
    assert.deepEqual(stats, [
      { bundle: "ops", concepts: 1, problems: 0, added: ["runbook"], removed: [], changed: [] },
    ]);
    assert.deepEqual(store.discoveredBundles(), []);
  });
});

describe("OkfStore remote bundles", () => {
  const DOC = "---\ntype: Table\n---\n\nRows.\n";
  const URL = "https://github.com/acme/kb/tree/main/kb";

  it("loads configured remote bundles at startup, read-only", async () => {
    const store = new OkfStore([], {
      remotes: [{ id: "shared", url: URL }],
      fetchImpl: fakeGitHub({ "kb/tables/orders.md": DOC }),
    });
    await store.load();
    const bundle = await store.bundle("shared");
    assert.equal(bundle.readOnly, true);
    assert.equal(
      (await store.getConcept("shared", "tables/orders"))?.frontmatter.type,
      "Table",
    );
  });

  it("addRemoteBundle mutates only the in-memory index and rejects duplicate ids", async () => {
    let root: string | undefined;
    try {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-test-"));
      await writeDoc(root, "a.md", "type: Note", "A.");
      const store = new OkfStore([{ id: "local", root }], {
        fetchImpl: fakeGitHub({ "kb/b.md": DOC }),
      });
      await store.load();

      const bundle = await store.addRemoteBundle({ id: "shared", url: URL });
      assert.equal(bundle.readOnly, true);
      assert.deepEqual([...bundle.concepts.keys()], ["b"]);
      assert.deepEqual(store.remoteBundleConfigs(), [{ id: "shared", url: URL }]);

      await assert.rejects(
        store.addRemoteBundle({ id: "local", url: URL }),
        /duplicate bundle id/,
      );
      await assert.rejects(
        store.addRemoteBundle({ id: "shared", url: URL }),
        /duplicate bundle id/,
      );
    } finally {
      if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reloadBundles refetches remote bundles and reports the delta", async () => {
    const before = { "kb/a.md": DOC };
    const after = { "kb/a.md": DOC, "kb/b.md": DOC };
    let files = before;
    const store = new OkfStore([], {
      remotes: [{ id: "shared", url: URL }],
      fetchImpl: ((...params: Parameters<typeof fetch>) =>
        fakeGitHub(files)(...params)) as typeof fetch,
    });
    await store.load();

    files = after;
    const stats = await store.reloadBundles();
    assert.deepEqual(stats, [
      { bundle: "shared", concepts: 2, problems: 0, added: ["b"], removed: [], changed: [] },
    ]);
  });

  it("names the colocated root when a colocated bundle id collides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-test-"));
    try {
      assert.throws(
        () =>
          new OkfStore([
            { id: "acme", root },
            { id: "acme", root: "/vault/acme", colocatedRoot: "/vault" },
          ]),
        /duplicate bundle id: acme.*--colocated-bundles \/vault/,
      );
      assert.throws(
        () =>
          new OkfStore(
            [{ id: "acme", root: "/vault/acme", colocatedRoot: "/vault" }],
            { remotes: [{ id: "acme", url: URL }] },
          ),
        /duplicate bundle id: acme.*--colocated-bundles \/vault/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a remote id colliding with a local bundle id at construction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-test-"));
    try {
      assert.throws(
        () =>
          new OkfStore([{ id: "x", root }], {
            remotes: [{ id: "x", url: URL }],
          }),
        /duplicate bundle id/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("OkfStore colocated remote roots", () => {
  const DOC = "---\ntype: Table\n---\n\nRows.\n";
  const ROOT_URL = "https://github.com/acme/kb/tree/main/kb";
  const FILES = {
    "kb/AGENTS.md": "# Guide\n",
    "kb/acme/note.md": DOC,
    "kb/ops/runbook.md": DOC,
  };

  it("mounts each subdirectory at startup and reports the mount", async () => {
    const store = new OkfStore([], {
      colocatedRemoteRoots: [{ url: ROOT_URL }],
      fetchImpl: fakeGitHub(FILES),
    });
    await store.load();
    assert.deepEqual(
      store.bundles().map((b) => [b.id, b.readOnly]),
      [
        ["acme", true],
        ["ops", true],
      ],
    );
    assert.deepEqual(store.colocatedRemoteRootMounts(), [
      { url: ROOT_URL, bundleIds: ["acme", "ops"], agentsGuide: "# Guide\n" },
    ]);
  });

  it("rejects a discovered id colliding with another mount, naming the root", async () => {
    const store = new OkfStore([], {
      remotes: [{ id: "acme", url: "https://github.com/acme/kb/tree/main/kb/acme" }],
      colocatedRemoteRoots: [{ url: ROOT_URL }],
      fetchImpl: fakeGitHub(FILES),
    });
    await assert.rejects(
      store.load(),
      /duplicate bundle id: acme.*--colocated-remote-bundles https:\/\/github\.com\/acme\/kb\/tree\/main\/kb/,
    );
  });

  it("mountedColocatedRoots unifies local roots and remote mounts", async () => {
    const local = await fs.mkdtemp(path.join(os.tmpdir(), "okf-store-test-"));
    try {
      await fs.mkdir(path.join(local, "proj"));
      await fs.writeFile(
        path.join(local, "proj", "index.md"),
        '---\ndescription: "Project notes."\n---\n\n# Index\n',
      );
      const store = new OkfStore(
        [
          { id: "proj", root: path.join(local, "proj"), colocatedRoot: local, lazy: true },
        ],
        {
          colocatedRemoteRoots: [{ url: ROOT_URL }],
          fetchImpl: fakeGitHub(FILES),
        },
      );
      assert.deepEqual(store.mountedColocatedRoots().map((m) => m.root), [local]);
      await store.load();
      assert.deepEqual(store.mountedColocatedRoots(), [
        {
          root: local,
          remote: false,
          bundles: [{ id: "proj", description: "Project notes.", loaded: false }],
        },
        {
          root: ROOT_URL,
          remote: true,
          bundles: [
            { id: "acme", loaded: true },
            { id: "ops", loaded: true },
          ],
          agentsGuide: "# Guide\n",
        },
      ]);
      // Hydration flips the loaded flag without changing the mount shape.
      await store.bundle("proj");
      assert.equal(store.mountedColocatedRoots()[0]?.bundles[0]?.loaded, true);
    } finally {
      await fs.rm(local, { recursive: true, force: true });
    }
  });

  it("addColocatedRemoteBundles mounts at runtime and rejects a repeated root", async () => {
    const store = new OkfStore([], { fetchImpl: fakeGitHub(FILES) });
    await store.load();
    const mount = await store.addColocatedRemoteBundles({ url: ROOT_URL });
    assert.deepEqual(mount.bundles.map((b) => b.id), ["acme", "ops"]);
    assert.equal(mount.agentsGuide, "# Guide\n");
    assert.equal((await store.bundle("ops")).readOnly, true);
    await assert.rejects(
      store.addColocatedRemoteBundles({ url: ROOT_URL }),
      /already mounted/,
    );
    // A later per-bundle remote mount cannot shadow a colocated bundle.
    await assert.rejects(
      store.addRemoteBundle({ id: "ops", url: `${ROOT_URL}/ops` }),
      /duplicate bundle id: ops.*--colocated-remote-bundles/,
    );
  });

  it("a failed runtime mount leaves the store unchanged", async () => {
    const store = new OkfStore([], { fetchImpl: fakeGitHub(FILES) });
    await store.load();
    await assert.rejects(
      store.addColocatedRemoteBundles({ url: ROOT_URL, only: ["nope"] }),
      /no bundle subdirectory named "nope"/,
    );
    assert.deepEqual(store.bundles(), []);
    assert.deepEqual(store.colocatedRemoteRootMounts(), []);
    // The root is free to mount again with a valid selection.
    const mount = await store.addColocatedRemoteBundles({ url: ROOT_URL, only: ["ops"] });
    assert.deepEqual(mount.bundles.map((b) => b.id), ["ops"]);
  });

  it("reloadBundles refetches the root once and tracks appeared/vanished folders", async () => {
    let files: Record<string, string> = FILES;
    const store = new OkfStore([], {
      colocatedRemoteRoots: [{ url: ROOT_URL }],
      fetchImpl: ((...params: Parameters<typeof fetch>) =>
        fakeGitHub(files)(...params)) as typeof fetch,
    });
    await store.load();

    files = {
      "kb/acme/note.md": DOC,
      "kb/acme/extra.md": DOC,
      "kb/docs/guide.md": DOC,
    };
    const stats = await store.reloadBundles();
    assert.deepEqual(stats, [
      { bundle: "acme", concepts: 2, problems: 0, added: ["extra"], removed: [], changed: [] },
      { bundle: "ops", concepts: 0, problems: 0, added: [], removed: ["runbook"], changed: [] },
      { bundle: "docs", concepts: 1, problems: 0, added: ["guide"], removed: [], changed: [] },
    ]);
    assert.deepEqual(
      store.bundles().map((b) => b.id).sort(),
      ["acme", "docs"],
    );
  });

  it("reloading one colocated bundle by id refetches the whole root", async () => {
    let files: Record<string, string> = FILES;
    const store = new OkfStore([], {
      colocatedRemoteRoots: [{ url: ROOT_URL }],
      fetchImpl: ((...params: Parameters<typeof fetch>) =>
        fakeGitHub(files)(...params)) as typeof fetch,
    });
    await store.load();

    files = { ...FILES, "kb/ops/extra.md": DOC };
    const bundle = await store.reloadBundle("acme");
    assert.equal(bundle.id, "acme");
    // The sibling picked up the upstream change too.
    assert.equal((await store.bundle("ops")).concepts.size, 2);
  });
});
