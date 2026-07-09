import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

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
