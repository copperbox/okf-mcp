import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { fileDiff, fileHistory, isGitWorkTree } from "../src/git.js";
import { commitAll, initRepo } from "./helpers.js";

describe("git helpers", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-git-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("isGitWorkTree distinguishes repos from plain directories", async () => {
    assert.equal(await isGitWorkTree(root), false);
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await initRepo(repo);
    assert.equal(await isGitWorkTree(repo), true);
  });

  it("fileHistory returns commits newest-first with hash, date, author, subject", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "add a");
    await fs.appendFile(path.join(root, "a.md"), "two\n");
    await commitAll(root, "edit a");

    const commits = await fileHistory(root, "a.md");
    assert.equal(commits.length, 2);
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["edit a", "add a"],
    );
    for (const commit of commits) {
      assert.match(commit.hash, /^[0-9a-f]{40}$/);
      assert.match(commit.date, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(commit.author, "Test Author");
    }
  });

  it("fileHistory honors limit", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "first");
    await fs.appendFile(path.join(root, "a.md"), "two\n");
    await commitAll(root, "second");

    const commits = await fileHistory(root, "a.md", 1);
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["second"],
    );
  });

  it("fileHistory follows renames", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "old.md"), "same content\n");
    await commitAll(root, "add old");
    await fs.rename(path.join(root, "old.md"), path.join(root, "new.md"));
    await commitAll(root, "rename to new");

    const commits = await fileHistory(root, "new.md");
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["rename to new", "add old"],
    );
  });

  it("fileHistory returns [] for untracked paths and empty repos", async () => {
    await initRepo(root);
    assert.deepEqual(await fileHistory(root, "a.md"), []);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "add a");
    assert.deepEqual(await fileHistory(root, "never-existed.md"), []);
  });

  it("fileDiff defaults to the previous commit touching the file", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "add a");
    await fs.writeFile(path.join(root, "unrelated.md"), "noise\n");
    await commitAll(root, "unrelated change");
    await fs.appendFile(path.join(root, "a.md"), "two\n");
    await commitAll(root, "edit a");

    const diff = await fileDiff(root, "a.md");
    assert.match(diff, /^diff --git a\/a\.md b\/a\.md/);
    assert.match(diff, /\+two/);
    assert.doesNotMatch(diff, /\+one/);
  });

  it("fileDiff on a file with one commit shows its creation", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "add a");

    const diff = await fileDiff(root, "a.md");
    assert.match(diff, /new file mode/);
    assert.match(diff, /\+one/);
  });

  it("fileDiff accepts an explicit ref", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "add a");
    await fs.appendFile(path.join(root, "a.md"), "two\n");
    await commitAll(root, "edit a");
    await fs.appendFile(path.join(root, "a.md"), "three\n");
    await commitAll(root, "edit again");

    const diff = await fileDiff(root, "a.md", "HEAD~2");
    assert.match(diff, /\+two/);
    assert.match(diff, /\+three/);
  });

  it("fileDiff returns empty for files with no history", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    assert.equal(await fileDiff(root, "a.md"), "");
  });

  it("fileDiff rejects refs that look like options", async () => {
    await initRepo(root);
    await fs.writeFile(path.join(root, "a.md"), "one\n");
    await commitAll(root, "add a");
    await assert.rejects(fileDiff(root, "a.md", "--no-index"), /invalid git ref/);
  });
});
