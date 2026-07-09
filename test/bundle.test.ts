import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildBundle, discoverColocatedBundles, loadBundle } from "../src/bundle.js";
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
    // shipments.md (broken .md link) + retired-runbook (broken extensionless link)
    assert.equal(broken.length, 2);
    assert.ok(broken.every((p) => p.severity === "warning"));
  });

  it("warns on broken extensionless concept links (issue #49)", () => {
    const bundle = buildBundle("m", "/m", [
      { path: "note.md", source: "---\ntype: Note\n---\n\nSee [orders](/tables/orders).\n" },
    ]);
    const broken = bundle.problems.filter((p) => p.message.includes("missing concept"));
    assert.equal(broken.length, 1);
    assert.equal(broken[0]?.severity, "warning");
    assert.equal(broken[0]?.path, "note.md");
    assert.match(broken[0]!.message, /\/tables\/orders/);
    const link = bundle.concepts.get("note")!.links[0]!;
    assert.equal(link.broken, true);
  });

  it("exempts directories, assets, and reserved files from extensionless broken-link warnings", () => {
    const bundle = buildBundle("m", "/m", [
      { path: "index.md", source: "# Index\n" },
      { path: "guides/index.md", source: "# Guides\n" },
      { path: "guides/log.md", source: "# Update Log\n" },
      { path: "guides/setup.md", source: "---\ntype: Note\n---\n\nSetup.\n" },
      {
        path: "note.md",
        source: [
          "---",
          "type: Note",
          "---",
          "",
          "A [directory](/guides) and a [trailing slash](/guides/), an",
          "[asset](/assets/diagram.png), the [root index](/index), and the",
          "[scoped log](/guides/log) are not missing concepts; only",
          "[gone](/gone) is.",
        ].join("\n"),
      },
    ]);
    const broken = bundle.problems.filter((p) => p.message.includes("missing concept"));
    assert.deepEqual(broken.map((p) => p.message), ["link to missing concept: /gone"]);
    const flagged = bundle.concepts.get("note")!.links.filter((l) => l.broken);
    assert.deepEqual(flagged.map((l) => l.target), ["/gone"]);
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

  it("parses description from the bundle-root index.md frontmatter", () => {
    const bundle = buildBundle("m", "/m", [
      {
        path: "index.md",
        source: '---\nokf_version: "0.1"\ndescription: Acme data warehouse knowledge.\n---\n\n# Index\n',
      },
    ]);
    assert.equal(bundle.description, "Acme data warehouse knowledge.");
  });

  it("leaves description undefined when absent or declared only by a nested index", () => {
    const bundle = buildBundle("m", "/m", [
      { path: "index.md", source: "# Index\n" },
      { path: "guides/index.md", source: "---\ndescription: Nested.\n---\n\n# Guides\n" },
    ]);
    assert.equal(bundle.description, undefined);
  });

  it("ignores a non-string description declaration", () => {
    const bundle = buildBundle("m", "/m", [
      { path: "index.md", source: "---\ndescription: [not, a, string]\n---\n\n# Index\n" },
    ]);
    assert.equal(bundle.description, undefined);
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

  it("expands a configured canonicalUrl into canonical prefixes", async () => {
    const bundle = await loadBundle({
      id: "acme",
      root: FIXTURE,
      canonicalUrl: "https://github.com/acme/kb/tree/main/okf",
    });
    assert.deepEqual(bundle.canonicalUrls, [
      "https://github.com/acme/kb/tree/main/okf",
      "https://github.com/acme/kb/blob/main/okf",
      "https://raw.githubusercontent.com/acme/kb/main/okf",
    ]);
    const plain = await loadBundle({ id: "acme", root: FIXTURE });
    assert.equal(plain.canonicalUrls, undefined);
  });
});

describe("discoverColocatedBundles", () => {
  let root: string;

  async function write(relPath: string, content = ""): Promise<void> {
    const absolute = path.join(root, relPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-colocated-test-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("mounts each immediate subdirectory holding markdown as a bundle named after it", async () => {
    await write("acme/tables/orders.md", "---\ntype: Table\n---\n\nRows.\n");
    await write("ops/runbook.md", "---\ntype: Note\n---\n\nSteps.\n");
    const configs = await discoverColocatedBundles(root);
    assert.deepEqual(configs, [
      { id: "acme", root: path.join(root, "acme"), colocatedRoot: root },
      { id: "ops", root: path.join(root, "ops"), colocatedRoot: root },
    ]);
  });

  it("skips dot directories such as .obsidian and .git", async () => {
    await write(".obsidian/plugins/readme.md");
    await write(".git/COMMIT_EDITMSG.md");
    await write("acme/note.md");
    const configs = await discoverColocatedBundles(root);
    assert.deepEqual(configs.map((c) => c.id), ["acme"]);
  });

  it("ignores loose files at the root and subdirectories without markdown", async () => {
    await write("README.md", "# Vault\n");
    await write("AGENTS.md", "Instructions.\n");
    await write("assets/logo.png");
    await fs.mkdir(path.join(root, "empty"));
    await write("acme/note.md");
    const configs = await discoverColocatedBundles(root);
    assert.deepEqual(configs.map((c) => c.id), ["acme"]);
  });

  it("does not count markdown hidden inside a subdirectory's dot directories", async () => {
    await write("drafts/.obsidian/note.md");
    await write("acme/deep/nested/note.md");
    const configs = await discoverColocatedBundles(root);
    assert.deepEqual(configs.map((c) => c.id), ["acme"]);
  });

  it("loadBundle carries the discovered colocatedRoot onto the loaded bundle", async () => {
    await write("acme/note.md", "---\ntype: Note\n---\n\nBody.\n");
    await write("solo/note.md", "---\ntype: Note\n---\n\nBody.\n");
    const [config] = await discoverColocatedBundles(root);
    const colocated = await loadBundle(config!);
    assert.equal(colocated.colocatedRoot, path.resolve(root));
    const independent = await loadBundle({ id: "solo", root: path.join(root, "solo") });
    assert.equal(independent.colocatedRoot, undefined);
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
