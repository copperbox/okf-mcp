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

describe("README agent guidance", () => {
  // Slice a README section: from its `## ` heading to the next `## ` heading
  // outside fenced code (embedded CLAUDE.md snippets contain `##` headings).
  async function readmeSection(heading: string): Promise<string> {
    const readme = await fs.readFile(path.join(repoRoot, "README.md"), "utf8");
    const start = readme.indexOf(heading);
    assert.ok(start >= 0, `README section "${heading}" must exist`);
    const lines = readme.slice(start + heading.length).split("\n");
    let inFence = false;
    const sectionLines: string[] = [heading];
    for (const line of lines) {
      if (line.startsWith("```")) inFence = !inFence;
      else if (!inFence && line.startsWith("## ")) break;
      sectionLines.push(line);
    }
    return sectionLines.join("\n");
  }

  it("covers keeping a shared bundle fresh (git pull + reload_bundles)", async () => {
    const section = await readmeSection("## Teaching your agent to maintain the brain");

    // The server does no git sync — the guidance must say so and put
    // pull/reload (and publish-back) into the standing instructions.
    assert.match(section, /git pull/);
    assert.match(section, /reload_bundles/);
    assert.match(section, /--remote-bundle/);
    assert.match(section, /push/);
  });

  it("covers the multi-bundle (org + project) workflow", async () => {
    const section = await readmeSection("## Multi-bundle setups");

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
});
