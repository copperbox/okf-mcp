import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readPackageJson(): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("npm packaging", () => {
  it("exposes the okf-mcp bin pointing at the compiled CLI", async () => {
    const pkg = await readPackageJson();
    assert.deepEqual(pkg.bin, { "okf-mcp": "dist/cli.js" });
  });

  it("publishes only dist and README", async () => {
    const pkg = await readPackageJson();
    assert.deepEqual(pkg.files, ["dist", "README.md"]);
  });

  it("has a non-empty author for the npm listing", async () => {
    const pkg = await readPackageJson();
    assert.equal(typeof pkg.author, "string");
    assert.ok(pkg.author.length > 0, "author must be filled in before publishing");
  });

  it("declares the ISC license and ships a matching LICENSE file", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.license, "ISC");
    const license = await fs.readFile(path.join(repoRoot, "LICENSE"), "utf8");
    assert.match(license, /ISC License/);
    assert.match(license, /Copyright/);
  });

  it("rebuilds via prepack so a publish never ships a stale dist", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.scripts.prepack, "npm run build");
  });

  it("keeps the CLI shebang so dist/cli.js is directly executable", async () => {
    const source = await fs.readFile(path.join(repoRoot, "src", "cli.ts"), "utf8");
    assert.ok(source.startsWith("#!/usr/bin/env node\n"), "src/cli.ts must start with a node shebang");
    const pkg = await readPackageJson();
    assert.match(pkg.scripts.build, /chmod/);
  });

  it("documents the npx install path in the README", async () => {
    const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
    assert.match(readme, /npx/);
    assert.match(readme, /"@copperbox\/okf-mcp"/);
  });
});

describe("docs agent guidance", () => {
  async function docFile(name: string): Promise<string> {
    return fs.readFile(path.join(repoRoot, "docs", name), "utf8");
  }

  it("covers keeping a shared bundle fresh (git pull + reload_bundles)", async () => {
    const section = await docFile("agent-instructions.md");

    // The server does no git sync — the guidance must say so and put
    // pull/reload (and publish-back) into the standing instructions.
    assert.match(section, /git pull/);
    assert.match(section, /reload_bundles/);
    assert.match(section, /--remote-bundle/);
    assert.match(section, /push/);
  });

  it("covers the multi-bundle (org + project) workflow", async () => {
    const section = await docFile("multi-bundle.md");

    // Example config mounts two bundles, with a read-only remote alternative
    // for the org brain.
    assert.ok(
      (section.match(/"--bundle"/g) ?? []).length >= 2,
      "config example must mount at least two bundles",
    );
    assert.match(section, /--remote-bundle/);

    // Routing guidance: search everything (omit `bundle`), write by scope.
    assert.match(section, /omit/i);
    assert.match(section, /search_concepts/);
    assert.match(section, /org/i);
    assert.match(section, /project/i);

    // Cross-bundle references go through spec §8 citations (optionally a
    // references/ mirror stub), never §5 links.
    assert.match(section, /Citations/);
    assert.match(section, /references\//);
  });

  it("leads with declaring the server globally and mounting per directory", async () => {
    const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
    const section = await docFile("configuration.md");

    // The recommended shape: one argument-free server declaration in the
    // harness, bundles chosen per directory by okf.config.json.
    for (const doc of [readme, section]) {
      assert.match(doc, /okf\.config\.json/);
      assert.match(doc, /"args": \["-y", "@copperbox\/okf-mcp"\]/);
    }
    assert.match(section, /globally/i);
    // Why a global declaration is safe: the harness launches the server in the
    // directory you have open, and one user-level bundle keeps it from
    // erroring in directories that configure nothing.
    assert.match(section, /working directory/i);
    assert.match(section, /~\/\.config\/okf\/config\.json/);
  });

  it("covers okf.config.json layering, per-bundle writability, and the trust guard", async () => {
    const section = await docFile("configuration.md");

    // The reason the file layer exists: MCP client configs cannot merge, so
    // the layering order and the escape hatches have to be spelled out.
    assert.match(section, /okf\.config\.local\.json/);
    assert.match(section, /~\/\.config\/okf\/config\.json/);
    assert.match(section, /--no-config/);
    assert.match(section, /"root": true/);

    // Per-bundle writability and the guard against a cloned repo granting
    // itself writes outside its own directory.
    assert.match(section, /"writable"/);
    assert.match(section, /read-only with a warning/);

    // Every mount kind is declarable in the file, not just local bundles.
    for (const key of [
      "bundles",
      "colocatedRoots",
      "remoteBundles",
      "colocatedRemoteRoots",
      "searchLimit",
      "searchCutoff",
    ]) {
      assert.match(section, new RegExp(`"${key}"`), `configuration.md must document ${key}`);
    }
  });

  it("shows the multi-bundle setup in config-file form too", async () => {
    const section = await docFile("multi-bundle.md");
    assert.match(section, /okf\.config\.json/);
    assert.match(section, /"writable"/);
  });
});
