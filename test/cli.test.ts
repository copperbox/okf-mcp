import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { makeTarGz } from "./archives.js";
import { embeddedGraphData } from "./helpers.js";

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

describe("cli graph html", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-graph-html-"));
    await fs.mkdir(path.join(root, "acme"));
    await fs.writeFile(
      path.join(root, "acme", "note.md"),
      "---\ntype: Note\ntitle: Note\ntags: [alpha]\n---\n\n" +
        "See [runbook](../ops/runbook.md).\n",
    );
    await fs.mkdir(path.join(root, "ops"));
    await fs.mkdir(path.join(root, "ops", "playbooks"));
    await fs.writeFile(
      path.join(root, "ops", "runbook.md"),
      "---\ntype: Note\ntitle: Runbook\n---\n\n" +
        "See [deploy](/playbooks/deploy.md).\n",
    );
    await fs.writeFile(
      path.join(root, "ops", "playbooks", "deploy.md"),
      "---\ntype: Runbook\ntitle: Deploy\n---\n\nSteps.\n",
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exports a merged multi-bundle graph grouped by bundle", async () => {
    const { code, stdout } = await runCli(["--colocated-bundles", root, "graph", "html"]);
    assert.equal(code, 0);
    assert.match(stdout, /^<!doctype html>/);
    const data = embeddedGraphData(stdout);
    assert.deepEqual(
      data.nodes.map((n) => [n.id, n.community]).sort(),
      [
        ["acme:note", "acme"],
        ["ops:playbooks/deploy", "ops"],
        ["ops:runbook", "ops"],
      ],
    );
    assert.ok(
      data.edges.some(
        (e) => e.from === "acme:note" && e.to === "ops:runbook" && e.kind === "cross-bundle",
      ),
      `no cross-bundle edge in: ${JSON.stringify(data.edges)}`,
    );
    assert.ok(
      data.edges.some((e) => e.from === "ops:runbook" && e.to === "ops:playbooks/deploy"),
      `no in-bundle edge in: ${JSON.stringify(data.edges)}`,
    );
  });

  it("groups a single bundle by concept type unless --community overrides", async () => {
    const bundle = ["--bundle", path.join(root, "ops")];
    const byType = await runCli([...bundle, "graph", "html"]);
    assert.equal(byType.code, 0);
    assert.deepEqual(
      embeddedGraphData(byType.stdout).nodes.map((n) => [n.id, n.community]).sort(),
      [
        ["playbooks/deploy", "Runbook"],
        ["runbook", "Note"],
      ],
    );

    const byFolder = await runCli([...bundle, "graph", "html", "--community", "folder"]);
    assert.equal(byFolder.code, 0);
    assert.deepEqual(
      embeddedGraphData(byFolder.stdout).nodes.map((n) => [n.id, n.community]).sort(),
      [
        ["playbooks/deploy", "playbooks"],
        ["runbook", "(root)"],
      ],
    );

    const byTag = await runCli([
      "--bundle",
      path.join(root, "acme"),
      "graph",
      "html",
      "--community",
      "tag",
    ]);
    assert.equal(byTag.code, 0);
    assert.deepEqual(
      embeddedGraphData(byTag.stdout).nodes.map((n) => [n.id, n.community]),
      [["note", "alpha"]],
    );
  });

  it("rejects --community for a merged multi-bundle graph (bundle grouping wins)", async () => {
    const { code, stderr } = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "html",
      "--community",
      "type",
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /groups by bundle/);
    // Scoping to one bundle makes --community valid again.
    const scoped = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "html",
      "ops",
      "--community",
      "folder",
    ]);
    assert.equal(scoped.code, 0);
  });

  it("rejects --community with a non-html format and an unknown mode", async () => {
    const wrongFormat = await runCli([
      "--bundle",
      path.join(root, "ops"),
      "graph",
      "dot",
      "--community",
      "type",
    ]);
    assert.equal(wrongFormat.code, 2);
    assert.match(wrongFormat.stderr, /--community requires the html graph format/);

    const unknownMode = await runCli([
      "--bundle",
      path.join(root, "ops"),
      "graph",
      "html",
      "--community",
      "detect",
    ]);
    assert.equal(unknownMode.code, 2);
    assert.match(unknownMode.stderr, /unknown --community mode: detect/);
  });

  it("escapes a </script> in a title so it cannot break out of the document", async () => {
    await fs.writeFile(
      path.join(root, "ops", "sneaky.md"),
      '---\ntype: Note\ntitle: "</script><script>alert(1)</script>"\n---\n\nBody.\n',
    );
    const { code, stdout } = await runCli([
      "--bundle",
      path.join(root, "ops"),
      "graph",
      "html",
    ]);
    assert.equal(code, 0);
    assert.doesNotMatch(stdout, /<\/script><script>alert/);
    const sneaky = embeddedGraphData(stdout).nodes.find((n) => n.id === "sneaky");
    assert.equal(sneaky?.title, "</script><script>alert(1)</script>");
  });

  it("writes the document to --out instead of stdout", async () => {
    const out = path.join(root, "graph.html");
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "html",
      "--out",
      out,
    ]);
    assert.equal(code, 0);
    assert.equal(stdout, "");
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /"acme:note"/);
  });

  it("honors --out for the other graph formats too", async () => {
    const out = path.join(root, "graph.dot");
    const { code, stdout } = await runCli([
      "--colocated-bundles",
      root,
      "graph",
      "dot",
      "--out",
      out,
    ]);
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.match(await fs.readFile(out, "utf8"), /digraph okf/);
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

describe("cli repair", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cli-repair-"));
    await fs.writeFile(
      path.join(root, "note.md"),
      "---\ntype: Note\ntitle: Note\n---\n\n# Citations\n\n" +
        "1. [Alpha](https://example.com/a)\n",
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("--list prints the fixer registry without needing a bundle", async () => {
    const { code, stdout } = await runCli(["repair", "--list"]);
    assert.equal(code, 0);
    assert.match(stdout, /^citation-format: /m);
    assert.match(stdout, /^duplicate-citation-headings: /m);
    assert.match(stdout, /^okf-uri-to-canonical: /m);
  });

  it("dry-runs by default: reports findings, writes nothing", async () => {
    const before = await fs.readFile(path.join(root, "note.md"), "utf8");
    const { code, stdout } = await runCli(["--bundle", root, "repair"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.applied, false);
    assert.equal(report.fixed, 1);
    assert.deepEqual(report.files, ["note.md"]);
    assert.equal(await fs.readFile(path.join(root, "note.md"), "utf8"), before);
  });

  it("--write applies fixes and does the log/index bookkeeping", async () => {
    const { code, stdout } = await runCli(["--bundle", root, "repair", "--write"]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.applied, true);
    assert.equal(report.log, "log.md");
    const repaired = await fs.readFile(path.join(root, "note.md"), "utf8");
    assert.match(repaired, /\[1\] \[Alpha\]\(https:\/\/example\.com\/a\)/);
    assert.match(
      await fs.readFile(path.join(root, "log.md"), "utf8"),
      /Repair sweep .*citation-format \(1 file\)/,
    );
  });

  it("--only scopes to the named fixers and rejects unknown ids", async () => {
    const { code, stdout } = await runCli([
      "--bundle",
      root,
      "repair",
      "--only",
      "duplicate-citation-headings",
    ]);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    assert.deepEqual(report.fixers, ["duplicate-citation-headings"]);
    assert.deepEqual(report.findings, []);

    const bad = await runCli(["--bundle", root, "repair", "--only", "bogus"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown fixer: bogus/);
  });

  it("skips read-only remote bundles with a note and repairs the rest", async () => {
    const archive = path.join(root, "remote.tar.gz");
    await fs.writeFile(
      archive,
      makeTarGz({
        "kb/doc.md":
          "---\ntype: Note\n---\n\n# Citations\n\n1. [X](https://example.com/x)\n",
      }),
    );
    const { code, stdout, stderr } = await runCli([
      "--bundle",
      root,
      "--remote-bundle",
      `remote=${archive}`,
      "repair",
    ]);
    assert.equal(code, 0);
    assert.match(stderr, /remote: skipped \(read-only remote bundle\)/);
    const report = JSON.parse(stdout);
    assert.equal(report.bundle, path.basename(root));
    assert.equal(report.fixed, 1);
  });
});
