import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeTarGz } from "./archives.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const CLI = path.join(repoRoot, "src", "cli.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI as a subprocess (cli.ts invokes main() at import time). */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      { cwd: repoRoot },
      (error, stdout, stderr) => {
        let code = 1;
        if (error === null) {
          code = 0;
        } else if (typeof error.code === "number") {
          code = error.code;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
}

describe("cli --canonical-url for colocated roots", () => {
  let root: string;

  /** crossBundleEdges reported for one bundle in `inspect` output. */
  function crossBundleEdges(stdout: string, bundle: string): number {
    const match = new RegExp(
      `"bundle": "${bundle}"[\\s\\S]*?"crossBundleEdges": (\\d+)`,
    ).exec(stdout);
    assert.ok(match, `no summary for bundle ${bundle} in: ${stdout}`);
    return Number(match[1]);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-canonical-"));
    await fs.mkdir(path.join(root, "ops"));
    await fs.writeFile(
      path.join(root, "ops", "runbook.md"),
      "---\ntype: Note\ntitle: Runbook\n---\n\nSteps.\n",
    );
    await fs.mkdir(path.join(root, "acme"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("derives per-bundle canonical URLs from a bare GitHub root URL", async () => {
    // acme cites ops via the blob form of <rootUrl>/ops — proving the derived
    // URL flowed through canonicalUrlPrefixes' tree/blob/raw expansion.
    await fs.writeFile(
      path.join(root, "acme", "note.md"),
      "---\ntype: Note\ntitle: Note\n---\n\n" +
        "See [runbook](https://github.com/acme/kb/blob/main/vault/ops/runbook.md).\n",
    );
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "--canonical-url",
      "https://github.com/acme/kb/tree/main/vault",
      "inspect",
    ]);
    assert.equal(code, 0);
    assert.equal(crossBundleEdges(stdout, "acme"), 1);
  });

  it("accepts the root's path as the flag id and path-appends non-GitHub URLs", async () => {
    await fs.writeFile(
      path.join(root, "acme", "note.md"),
      "---\ntype: Note\ntitle: Note\n---\n\n" +
        "See [runbook](https://kb.example.com/vault/ops/runbook.md).\n",
    );
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "--canonical-url",
      `${root}=https://kb.example.com/vault`,
      "inspect",
    ]);
    assert.equal(code, 0);
    assert.equal(crossBundleEdges(stdout, "acme"), 1);
  });

  it("lets an explicit per-bundle --canonical-url override the derived URL", async () => {
    // Two source concepts: only the override URL should resolve, so exactly
    // one edge — two would mean the derived URL survived the override.
    await fs.writeFile(
      path.join(root, "acme", "derived.md"),
      "---\ntype: Note\ntitle: Derived\n---\n\n" +
        "See [runbook](https://kb.example.com/vault/ops/runbook.md).\n",
    );
    await fs.writeFile(
      path.join(root, "acme", "override.md"),
      "---\ntype: Note\ntitle: Override\n---\n\n" +
        "See [runbook](https://kb.example.com/other/runbook.md).\n",
    );
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "--canonical-url",
      `${root}=https://kb.example.com/vault`,
      "--canonical-url",
      "ops=https://kb.example.com/other",
      "inspect",
    ]);
    assert.equal(code, 0);
    assert.equal(crossBundleEdges(stdout, "acme"), 1);
  });

  it("rejects a bare URL when no colocated root is configured", async () => {
    const { code, stderr } = await runCli([
      "--bundle",
      path.join(root, "ops"),
      "--canonical-url",
      "https://kb.example.com/vault",
      "inspect",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /exactly one --colocated-bundles root/);
  });

  it("rejects a bare URL when several colocated roots are configured", async () => {
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-canonical-b-"));
    await fs.mkdir(path.join(second, "docs"));
    await fs.writeFile(
      path.join(second, "docs", "guide.md"),
      "---\ntype: Note\ntitle: Guide\n---\n\nText.\n",
    );
    try {
      const { code, stderr } = await runCli([
        "--colocated-bundles",
        root,
        "--colocated-bundles",
        second,
        "--canonical-url",
        "https://kb.example.com/vault",
        "inspect",
      ]);
      assert.equal(code, 2);
      assert.match(stderr, /exactly one --colocated-bundles root/);
    } finally {
      await fs.rm(second, { recursive: true, force: true });
    }
  });
});

describe("cli --only", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-test-"));
    await fs.mkdir(path.join(root, "acme"));
    await fs.writeFile(
      path.join(root, "acme", "note.md"),
      "---\ntype: Note\ntitle: Note\n---\n\nBody.\n",
    );
    await fs.mkdir(path.join(root, "ops"));
    await fs.writeFile(
      path.join(root, "ops", "runbook.md"),
      "---\ntype: Note\ntitle: Runbook\n---\n\nSteps.\n",
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("mounts only the named subfolders of the colocated root", async () => {
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "--only",
      "acme",
      "inspect",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /"bundle": "acme"/);
    assert.doesNotMatch(stdout, /"bundle": "ops"/);
  });

  it("exits with a usage error when --only is passed without --colocated-bundles", async () => {
    const { code, stderr } = await runCli(["--bundle", path.join(root, "acme"), "--only", "acme", "inspect"]);
    assert.equal(code, 2);
    assert.match(stderr, /--only requires --colocated-bundles/);
  });

  it("exits with a usage error when --only names an unknown subfolder", async () => {
    const { code, stderr } = await runCli([
      "--colocated-bundles",
      root,
      "--only",
      "acme,nope",
      "inspect",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /no bundle subdirectory named "nope"/);
  });
});

describe("cli graph", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-graph-"));
    await fs.mkdir(path.join(root, "acme"));
    await fs.writeFile(
      path.join(root, "acme", "note.md"),
      "---\ntype: Note\ntitle: Note\n---\n\n" +
        "See [runbook](../ops/runbook.md) and [docs](https://example.com/docs).\n",
    );
    await fs.mkdir(path.join(root, "ops"));
    await fs.writeFile(
      path.join(root, "ops", "runbook.md"),
      "---\ntype: Note\ntitle: Runbook\n---\n\nSteps.\n",
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exports all loaded bundles as one merged graph with cross-bundle edges (json)", async () => {
    const { code, stdout } = await runCli(["--colocated-bundles", root, "graph"]);
    assert.equal(code, 0);
    const graph = JSON.parse(stdout);
    const ids = graph.nodes.map((n: { id: string }) => n.id).sort();
    assert.deepEqual(ids, ["acme:note", "ops:runbook"]);
    assert.deepEqual(graph.edges, [
      { from: "acme:note", to: "ops:runbook", kind: "cross-bundle" },
    ]);
  });

  it("renders cross-bundle edges dashed in dot and mermaid", async () => {
    const dot = await runCli(["--colocated-bundles", root, "graph", "dot"]);
    assert.equal(dot.code, 0);
    assert.match(dot.stdout, /"acme:note" -> "ops:runbook" \[style=dashed\];/);

    const mermaid = await runCli(["--colocated-bundles", root, "graph", "mermaid"]);
    assert.equal(mermaid.code, 0);
    assert.match(mermaid.stdout, /n\d+ -\.-> n\d+/);
  });

  it("keeps single-bundle output unqualified when exactly one bundle is mounted", async () => {
    const { code, stdout } = await runCli([
      "--bundle",
      path.join(root, "ops"),
      "graph",
    ]);
    assert.equal(code, 0);
    const graph = JSON.parse(stdout);
    assert.deepEqual(
      graph.nodes.map((n: { id: string }) => n.id),
      ["runbook"],
    );
    assert.deepEqual(graph.edges, []);
  });

  it("scopes the export to a named bundle with unqualified IDs", async () => {
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "json",
      "ops",
    ]);
    assert.equal(code, 0);
    const graph = JSON.parse(stdout);
    assert.deepEqual(
      graph.nodes.map((n: { id: string }) => n.id),
      ["runbook"],
    );
  });

  it("errors on an unknown bundle, listing the available ones", async () => {
    const { code, stderr } = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "json",
      "nope",
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /unknown bundle "nope" \(available: acme, ops\)/);
  });

  it("includes external nodes only with --include-external", async () => {
    const bare = await runCli(["--colocated-bundles", root, "graph"]);
    assert.equal(bare.code, 0);
    assert.doesNotMatch(bare.stdout, /example\.com/);

    const withExternal = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "json",
      "--include-external",
    ]);
    assert.equal(withExternal.code, 0);
    const graph = JSON.parse(withExternal.stdout);
    const external = graph.nodes.find(
      (n: { id: string }) => n.id === "https://example.com/docs",
    );
    assert.ok(external, `no external node in: ${withExternal.stdout}`);
    assert.equal(external.external, true);

    const single = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "json",
      "acme",
      "--include-external",
    ]);
    assert.equal(single.code, 0);
    assert.match(single.stdout, /https:\/\/example\.com\/docs/);
  });

  it("does not duplicate a URL matched to a cross-bundle edge as an external node", async () => {
    // The link targets ops's canonical URL, so it derives a cross-bundle edge;
    // even with --include-external it must not also appear as an external node.
    await fs.writeFile(
      path.join(root, "acme", "cite.md"),
      "---\ntype: Note\ntitle: Cite\n---\n\n" +
        "See [runbook](https://kb.example.com/vault/ops/runbook.md).\n",
    );
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "--canonical-url",
      `${root}=https://kb.example.com/vault`,
      "graph",
      "json",
      "--include-external",
    ]);
    assert.equal(code, 0);
    const graph = JSON.parse(stdout);
    assert.ok(
      graph.edges.some(
        (e: { from: string; to: string; kind?: string }) =>
          e.from === "acme:cite" && e.to === "ops:runbook" && e.kind === "cross-bundle",
      ),
      `no derived edge in: ${stdout}`,
    );
    assert.equal(
      graph.nodes.some(
        (n: { id: string }) => n.id === "https://kb.example.com/vault/ops/runbook.md",
      ),
      false,
    );
  });

  it("rejects an unknown format", async () => {
    const { code, stderr } = await runCli([
      "--bundle",
      path.join(root, "ops"),
      "graph",
      "png",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /unknown graph format: png/);
  });
});

describe("cli --colocated-remote-bundles", () => {
  let dir: string;
  let archive: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-remote-root-"));
    archive = path.join(dir, "kb.tar.gz");
    await fs.writeFile(
      archive,
      makeTarGz({
        "kb-main/AGENTS.md": "# Guide\n",
        "kb-main/acme/note.md":
          "---\ntype: Note\ntitle: Note\n---\n\n" +
          "See [runbook](../ops/runbook.md).\n",
        "kb-main/ops/runbook.md": "---\ntype: Note\ntitle: Runbook\n---\n\nSteps.\n",
      }),
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("mounts every subdirectory of a local archive root as read-only sibling bundles", async () => {
    const { code, stdout } = await runCli([
      "--colocated-remote-bundles",
      archive,
      "inspect",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /"bundle": "acme"/);
    assert.match(stdout, /"bundle": "ops"/);
    // The ../ops link derives a cross-bundle edge between the remote siblings.
    const match = /"bundle": "acme"[\s\S]*?"crossBundleEdges": (\d+)/.exec(stdout);
    assert.ok(match, `no summary for acme in: ${stdout}`);
    assert.equal(Number(match[1]), 1);
  });

  it("applies --only to the remote root", async () => {
    const { code, stdout } = await runCli([
      "--colocated-remote-bundles",
      archive,
      "--only",
      "ops",
      "inspect",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /"bundle": "ops"/);
    assert.doesNotMatch(stdout, /"bundle": "acme"/);

    const bad = await runCli([
      "--colocated-remote-bundles",
      archive,
      "--only",
      "nope",
      "inspect",
    ]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /no bundle subdirectory named "nope"/);
  });

  it("satisfies the --only guard without --colocated-bundles", async () => {
    const { code, stderr } = await runCli([
      "--bundle",
      dir,
      "--only",
      "acme",
      "inspect",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /--only requires --colocated-bundles or --colocated-remote-bundles/);
  });
});
