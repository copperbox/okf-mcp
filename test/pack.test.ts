import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { packBundle } from "../src/pack.js";
import { loadRemoteBundle } from "../src/remote.js";

const ORDERS = "---\ntype: Table\ntitle: Orders\n---\n\nSee [customers](./customers.md).\n";
const CUSTOMERS = "---\ntype: Table\ndescription: Customer master data\n---\n\nRows.\n";
const LOG = "# Update Log\n\n## 2026-01-01\n* Initial import\n";

/** Write a throwaway bundle directory from a path → content map. */
async function writeBundleDir(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-pack-"));
  for (const [rel, content] of Object.entries(files)) {
    const absolute = path.join(root, rel);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf8");
  }
  return root;
}

/** Pack a bundle, write the archive next to its root, and load it back. */
async function roundTrip(
  bundle: Awaited<ReturnType<typeof loadBundle>>,
  options: Parameters<typeof packBundle>[1] = {},
) {
  const packed = await packBundle(bundle, options);
  const suffix = packed.format === "zip" ? "zip" : "tar.gz";
  const out = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "okf-pack-out-")),
    `bundle.${suffix}`,
  );
  await fs.writeFile(out, packed.bytes);
  return { packed, loaded: await loadRemoteBundle({ id: "rt", url: out }) };
}

describe("packBundle", () => {
  it("emits a tar.gz that loads back via loadRemoteBundle with identical concepts", async () => {
    const root = await writeBundleDir({
      "tables/orders.md": ORDERS,
      "tables/customers.md": CUSTOMERS,
      "log.md": LOG,
    });
    const bundle = await loadBundle({ id: "brain", root });
    const { packed, loaded } = await roundTrip(bundle);

    assert.equal(packed.format, "tar.gz");
    assert.deepEqual(packed.files, [
      "index.md",
      "log.md",
      "tables/customers.md",
      "tables/index.md",
      "tables/orders.md",
    ]);
    assert.deepEqual(
      [...loaded.concepts.keys()].sort(),
      [...bundle.concepts.keys()].sort(),
    );
    for (const [id, concept] of bundle.concepts) {
      const rt = loaded.concepts.get(id)!;
      assert.deepEqual(rt.frontmatter, concept.frontmatter);
      assert.equal(rt.body, concept.body);
    }
    // Links resolve through the ordinary pipeline after the round trip.
    assert.equal(
      loaded.concepts.get("tables/orders")!.links[0]?.resolvedId,
      "tables/customers",
    );
    // The log travels verbatim.
    assert.equal(loaded.sources?.get("log.md"), LOG);
  });

  it("regenerates indexes in-memory, stamping okf_version, without touching the source", async () => {
    const root = await writeBundleDir({ "tables/orders.md": ORDERS });
    const bundle = await loadBundle({ id: "brain", root });
    const { loaded } = await roundTrip(bundle);

    // The packed bundle is self-describing (§6, §11)...
    assert.equal(loaded.okfVersion, "0.1");
    assert.match(loaded.sources!.get("tables/index.md")!, /\[Orders\]\(orders\.md\)/);
    // ...but pack never wrote an index into the source directory.
    await assert.rejects(fs.access(path.join(root, "index.md")));
  });

  it("preserves declared root-index frontmatter, refreshing the rendered body", async () => {
    const root = await writeBundleDir({
      "index.md": '---\nokf_version: "0.2"\nowner: data-team\n---\n\n# Stale Index\n',
      "tables/orders.md": ORDERS,
    });
    const bundle = await loadBundle({ id: "brain", root });
    const { loaded } = await roundTrip(bundle);

    assert.equal(loaded.okfVersion, "0.2");
    const rootIndex = loaded.sources!.get("index.md")!;
    assert.match(rootIndex, /owner: data-team/);
    assert.match(rootIndex, /\[tables\]\(tables\/index\.md\)/);
  });

  it("keeps hand-curated indexes (generated: false) verbatim", async () => {
    const curated =
      "---\ngenerated: false\n---\n\n# Guides\n\n## Getting started\n\n* [Setup](setup.md)\n";
    const root = await writeBundleDir({
      "guides/index.md": curated,
      "guides/setup.md": "---\ntype: Guide\n---\n\nSteps.\n",
    });
    const bundle = await loadBundle({ id: "brain", root });
    const { loaded } = await roundTrip(bundle);

    assert.equal(loaded.sources?.get("guides/index.md"), curated);
  });

  it("applies include/exclude globs like load_remote_bundle, reindexing the packed subset", async () => {
    const root = await writeBundleDir({
      "tables/orders.md": ORDERS,
      "tables/archive/old.md": "---\ntype: Table\n---\n\nOld.\n",
      "notes/scratch.md": "---\ntype: Note\n---\n\nScratch.\n",
      "log.md": LOG,
    });
    const bundle = await loadBundle({ id: "brain", root });
    const { packed, loaded } = await roundTrip(bundle, {
      include: ["tables/**"],
      exclude: ["tables/archive/*"],
    });

    assert.deepEqual([...loaded.concepts.keys()], ["tables/orders"]);
    // The log falls outside the include globs, so it is not packed.
    assert.equal(loaded.sources?.get("log.md"), undefined);
    // Indexes describe only the packed subset (and are always emitted).
    assert.deepEqual(packed.files, ["index.md", "tables/index.md", "tables/orders.md"]);
    assert.doesNotMatch(loaded.sources!.get("tables/index.md")!, /archive/);
  });

  it("emits a zip when asked", async () => {
    const root = await writeBundleDir({ "tables/orders.md": ORDERS });
    const bundle = await loadBundle({ id: "brain", root });
    const { packed, loaded } = await roundTrip(bundle, { format: "zip" });

    assert.equal(packed.format, "zip");
    assert.deepEqual([...loaded.concepts.keys()], ["tables/orders"]);
    assert.equal(loaded.sources?.get("tables/orders.md"), ORDERS);
  });

  it("round-trips entry paths longer than the 100-byte tar name field", async () => {
    const dir = "a".repeat(60);
    const name = `${"b".repeat(60)}.md`;
    const root = await writeBundleDir({
      [`${dir}/${name}`]: "---\ntype: Note\n---\n\nDeep.\n",
    });
    const bundle = await loadBundle({ id: "brain", root });
    const { loaded } = await roundTrip(bundle);

    assert.ok(loaded.concepts.has(`${dir}/${"b".repeat(60)}`));
  });

  it("re-exports a read-only archive bundle", async () => {
    const root = await writeBundleDir({
      "tables/orders.md": ORDERS,
      "tables/customers.md": CUSTOMERS,
    });
    const sourceArchive = await packBundle(await loadBundle({ id: "brain", root }));
    const archivePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "okf-pack-src-")),
      "brain.tar.gz",
    );
    await fs.writeFile(archivePath, sourceArchive.bytes);

    const remote = await loadRemoteBundle({ id: "remote", url: archivePath });
    assert.equal(remote.readOnly, true);
    const { loaded } = await roundTrip(remote, { exclude: ["tables/customers.md"] });
    assert.deepEqual([...loaded.concepts.keys()], ["tables/orders"]);
  });
});
