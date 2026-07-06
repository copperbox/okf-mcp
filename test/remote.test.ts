import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_REMOTE_BYTES,
  MAX_REMOTE_FILES,
  loadRemoteBundle,
  parseGitHubTreeUrl,
} from "../src/remote.js";
import { fakeGitHub } from "./fake-github.js";

const DOC = "---\ntype: Table\n---\n\nRows and [orders](/tables/orders.md).\n";

describe("parseGitHubTreeUrl", () => {
  it("parses owner, repo, ref, and optional path", () => {
    assert.deepEqual(
      parseGitHubTreeUrl("https://github.com/acme/kb/tree/main/okf/bundle"),
      { owner: "acme", repo: "kb", ref: "main", path: "okf/bundle" },
    );
    assert.deepEqual(parseGitHubTreeUrl("https://github.com/acme/kb/tree/v1.0"), {
      owner: "acme",
      repo: "kb",
      ref: "v1.0",
      path: "",
    });
  });

  it("rejects anything that is not a GitHub tree URL", () => {
    for (const bad of [
      "https://gitlab.com/acme/kb/tree/main",
      "https://github.com/acme/kb",
      "https://github.com/acme/kb/blob/main/readme.md",
      "http://github.com/acme/kb/tree/main",
      "not a url",
    ]) {
      assert.throws(() => parseGitHubTreeUrl(bad), /GitHub tree URL/);
    }
  });
});

describe("loadRemoteBundle", () => {
  it("indexes only .md files from the tree as a read-only in-memory bundle", async () => {
    const fetchImpl = fakeGitHub({
      "kb/index.md": "# Bundle Index\n",
      "kb/tables/orders.md": DOC,
      "kb/tables/schema.sql": "select 1;",
      "kb/tables/customers.md":
        "---\ntype: Table\n---\n\nSee [orders](./orders.md).\n",
      "kb/.obsidian/app.json": "{}",
    });
    const bundle = await loadRemoteBundle(
      { id: "r", url: "https://github.com/acme/kb/tree/main/kb" },
      fetchImpl,
    );

    assert.equal(bundle.id, "r");
    assert.equal(bundle.readOnly, true);
    assert.equal(bundle.root, "https://github.com/acme/kb/tree/main/kb");
    assert.deepEqual([...bundle.concepts.keys()].sort(), [
      "tables/customers",
      "tables/orders",
    ]);
    assert.deepEqual(bundle.reserved, [{ path: "index.md", kind: "index" }]);
    assert.deepEqual(bundle.problems, []);
    // Links resolve through the ordinary pipeline.
    const customers = bundle.concepts.get("tables/customers")!;
    assert.equal(customers.links[0]?.resolvedId, "tables/orders");
    // Raw sources are kept in memory so resources can be served.
    assert.equal(bundle.sources?.get("tables/orders.md"), DOC);
  });

  it("applies include and exclude globs to bundle-relative paths", async () => {
    const fetchImpl = fakeGitHub({
      "kb/tables/orders.md": DOC,
      "kb/tables/archive/old.md": DOC,
      "kb/notes/scratch.md": DOC,
    });
    const bundle = await loadRemoteBundle(
      {
        id: "r",
        url: "https://github.com/acme/kb/tree/main/kb",
        include: ["tables/**"],
        exclude: ["tables/archive/*"],
      },
      fetchImpl,
    );
    assert.deepEqual([...bundle.concepts.keys()], ["tables/orders"]);
  });

  it("enforces the file-count limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_REMOTE_FILES; i++) files[`kb/c${i}.md`] = DOC;
    await assert.rejects(
      loadRemoteBundle(
        { id: "r", url: "https://github.com/acme/kb/tree/main/kb" },
        fakeGitHub(files),
      ),
      /too many files/,
    );
  });

  it("enforces the total-byte limit using listed sizes", async () => {
    const fetchImpl = fakeGitHub(
      { "kb/a.md": DOC, "kb/b.md": DOC },
      { "kb/a.md": MAX_REMOTE_BYTES },
    );
    await assert.rejects(
      loadRemoteBundle(
        { id: "r", url: "https://github.com/acme/kb/tree/main/kb" },
        fetchImpl,
      ),
      /too large/,
    );
  });

  it("surfaces GitHub API failures with the status code", async () => {
    await assert.rejects(
      loadRemoteBundle(
        { id: "r", url: "https://github.com/acme/kb/tree/main/missing" },
        fakeGitHub({ "kb/a.md": DOC }),
      ),
      /404/,
    );
  });
});
