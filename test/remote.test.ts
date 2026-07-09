import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";

import { colocatedSiblings, resolveOutsideLink } from "../src/bundle.js";
import {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  MAX_REMOTE_BYTES,
  MAX_REMOTE_FILES,
  loadColocatedRemoteBundles,
  loadRemoteBundle,
  parseGitHubTreeUrl,
} from "../src/remote.js";
import { fakeArchiveServer, makeTarGz, makeZip } from "./archives.js";
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
    // The tree URL becomes the bundle's canonical location (tree/blob/raw).
    assert.deepEqual(bundle.canonicalUrls, [
      "https://github.com/acme/kb/tree/main/kb",
      "https://github.com/acme/kb/blob/main/kb",
      "https://raw.githubusercontent.com/acme/kb/main/kb",
    ]);
  });

  it("appends a configured canonicalUrl to the derived prefixes", async () => {
    const bundle = await loadRemoteBundle(
      {
        id: "r",
        url: "https://github.com/acme/kb/tree/main/kb",
        canonicalUrl: "https://kb.example.com/brain",
      },
      fakeGitHub({ "kb/tables/orders.md": DOC }),
    );
    assert.ok(bundle.canonicalUrls?.includes("https://kb.example.com/brain"));
    assert.ok(
      bundle.canonicalUrls?.includes("https://github.com/acme/kb/blob/main/kb"),
    );
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

describe("loadRemoteBundle from archives", () => {
  const URL = "https://example.com/dist/kb.tar.gz";

  it("indexes only .md entries of a tar.gz URL as a read-only bundle", async () => {
    const fetchImpl = fakeArchiveServer({
      [URL]: makeTarGz({
        "index.md": "# Bundle Index\n",
        "tables/orders.md": DOC,
        "tables/schema.sql": "select 1;",
        "tables/customers.md": "---\ntype: Table\n---\n\nSee [orders](./orders.md).\n",
        ".obsidian/app.json": "{}",
      }),
    });
    const bundle = await loadRemoteBundle({ id: "r", url: URL }, fetchImpl);

    assert.equal(bundle.id, "r");
    assert.equal(bundle.readOnly, true);
    // Archives have no per-file URLs, so no canonical location is derived.
    assert.equal(bundle.canonicalUrls, undefined);
    assert.equal(bundle.root, URL);
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

  it("strips the single top-level directory GitHub-style archives add", async () => {
    const fetchImpl = fakeArchiveServer({
      [URL]: makeTarGz({
        "kb-main/index.md": "# Bundle Index\n",
        "kb-main/tables/orders.md": DOC,
      }),
    });
    const bundle = await loadRemoteBundle({ id: "r", url: URL }, fetchImpl);
    assert.deepEqual([...bundle.concepts.keys()], ["tables/orders"]);
    assert.deepEqual(bundle.reserved, [{ path: "index.md", kind: "index" }]);
  });

  it("indexes a .zip archive the same way", async () => {
    const zipUrl = "https://example.com/kb.zip";
    const fetchImpl = fakeArchiveServer({
      [zipUrl]: makeZip({
        "kb/index.md": "# Bundle Index\n",
        "kb/tables/orders.md": DOC,
        "kb/tables/notes.txt": "not markdown",
      }),
    });
    const bundle = await loadRemoteBundle({ id: "z", url: zipUrl }, fetchImpl);
    assert.equal(bundle.readOnly, true);
    assert.equal(bundle.root, zipUrl);
    assert.deepEqual([...bundle.concepts.keys()], ["tables/orders"]);
    assert.equal(bundle.sources?.get("tables/orders.md"), DOC);
  });

  it("loads a local archive path without touching the network", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-archive-"));
    try {
      const file = path.join(dir, "kb.tgz");
      await fs.writeFile(
        file,
        makeTarGz({ "index.md": "# Index\n", "tables/orders.md": DOC }),
      );
      const neverFetch = (async () => {
        throw new Error("unexpected network call");
      }) as unknown as typeof fetch;
      const bundle = await loadRemoteBundle({ id: "r", url: file }, neverFetch);
      assert.deepEqual([...bundle.concepts.keys()], ["tables/orders"]);
      assert.equal(bundle.readOnly, true);
      assert.equal(bundle.root, file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects entries with path traversal or absolute paths", async () => {
    for (const evil of ["../evil.md", "/abs.md", "a/../../evil.md"]) {
      const fetchImpl = fakeArchiveServer({
        [URL]: makeTarGz({ "ok.md": DOC, [evil]: DOC }),
      });
      await assert.rejects(
        loadRemoteBundle({ id: "r", url: URL }, fetchImpl),
        /escapes the bundle root/,
      );
    }
  });

  it("applies include and exclude globs to bundle-relative paths", async () => {
    const fetchImpl = fakeArchiveServer({
      [URL]: makeTarGz({
        "kb/tables/orders.md": DOC,
        "kb/tables/archive/old.md": DOC,
        "kb/notes/scratch.md": DOC,
      }),
    });
    const bundle = await loadRemoteBundle(
      { id: "r", url: URL, include: ["tables/**"], exclude: ["tables/archive/*"] },
      fetchImpl,
    );
    assert.deepEqual([...bundle.concepts.keys()], ["tables/orders"]);
  });

  it("enforces the file-count limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_REMOTE_FILES; i++) files[`c${i}.md`] = DOC;
    await assert.rejects(
      loadRemoteBundle(
        { id: "r", url: URL },
        fakeArchiveServer({ [URL]: makeTarGz(files) }),
      ),
      /too many files/,
    );
  });

  it("enforces the total .md byte limit", async () => {
    const half = "a".repeat(MAX_REMOTE_BYTES / 2 + 1);
    const fetchImpl = fakeArchiveServer({
      [URL]: makeTarGz({ "a.md": half, "b.md": half }),
    });
    await assert.rejects(
      loadRemoteBundle({ id: "r", url: URL }, fetchImpl),
      /too large/,
    );
  });

  it("enforces the compressed download size cap before unpacking", async () => {
    const fetchImpl = fakeArchiveServer({
      [URL]: Buffer.alloc(MAX_ARCHIVE_DOWNLOAD_BYTES + 1),
    });
    await assert.rejects(
      loadRemoteBundle({ id: "r", url: URL }, fetchImpl),
      /download size/,
    );
  });

  it("surfaces download failures with the status code", async () => {
    await assert.rejects(
      loadRemoteBundle({ id: "r", url: URL }, fakeArchiveServer({})),
      /404/,
    );
  });

  it("rejects archives that are not valid gzip", async () => {
    const fetchImpl = fakeArchiveServer({ [URL]: Buffer.from("not gzip") });
    await assert.rejects(loadRemoteBundle({ id: "r", url: URL }, fetchImpl));
  });

  it("rejects zip files without a central directory", async () => {
    const zipUrl = "https://example.com/kb.zip";
    const fetchImpl = fakeArchiveServer({ [zipUrl]: Buffer.from("not a zip") });
    await assert.rejects(
      loadRemoteBundle({ id: "z", url: zipUrl }, fetchImpl),
      /zip/,
    );
  });

  it("ignores query strings when detecting the archive extension", async () => {
    const signed = "https://example.com/kb.tar.gz?token=abc";
    const fetchImpl = fakeArchiveServer({
      [signed]: makeTarGz({ "index.md": "# Index\n", "tables/orders.md": DOC }),
    });
    const bundle = await loadRemoteBundle({ id: "r", url: signed }, fetchImpl);
    assert.deepEqual([...bundle.concepts.keys()], ["tables/orders"]);
  });

  it("guards against gzip decompression bombs", async () => {
    // A tiny download that decompresses far past the unpacked cap.
    const fetchImpl = fakeArchiveServer({
      [URL]: zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024)),
    });
    await assert.rejects(
      loadRemoteBundle({ id: "r", url: URL }, fetchImpl),
      /decompress/,
    );
  });
});

describe("loadColocatedRemoteBundles", () => {
  const ROOT_URL = "https://github.com/acme/kb/tree/main/kb";
  const NOTE = (target: string) =>
    `---\ntype: Note\n---\n\nSee [it](${target}).\n`;

  it("mounts each subdirectory of a tree as its own read-only colocated bundle", async () => {
    const fetchImpl = fakeGitHub({
      "kb/AGENTS.md": "# Guide\n\n- acme: schema tables.\n",
      "kb/README.md": "loose root file, no bundle\n",
      "kb/acme/note.md": NOTE("../ops/runbook.md"),
      "kb/ops/runbook.md": DOC,
      "kb/.obsidian/workspace.md": "dot dir, skipped",
    });
    const mount = await loadColocatedRemoteBundles({ url: ROOT_URL }, fetchImpl);

    assert.deepEqual(mount.bundles.map((b) => b.id), ["acme", "ops"]);
    assert.equal(mount.agentsGuide, "# Guide\n\n- acme: schema tables.\n");
    for (const bundle of mount.bundles) {
      assert.equal(bundle.readOnly, true);
      assert.equal(bundle.colocatedRoot, ROOT_URL);
    }
    const acme = mount.bundles[0]!;
    assert.deepEqual([...acme.concepts.keys()], ["note"]);
    assert.equal(acme.root, `${ROOT_URL}/acme`);
    // Loose root files belong to no bundle.
    const all = mount.bundles.flatMap((b) => [...b.concepts.keys()]);
    assert.ok(!all.includes("README"));
    // Sources are kept so resources can be served.
    assert.equal(mount.bundles[1]!.sources?.get("runbook.md"), DOC);
  });

  it("derives per-bundle canonical URLs as <treeUrl>/<folder>", async () => {
    const mount = await loadColocatedRemoteBundles(
      { url: ROOT_URL },
      fakeGitHub({ "kb/acme/note.md": DOC, "kb/ops/runbook.md": DOC }),
    );
    assert.deepEqual(mount.bundles[0]!.canonicalUrls, [
      "https://github.com/acme/kb/tree/main/kb/acme",
      "https://github.com/acme/kb/blob/main/kb/acme",
      "https://raw.githubusercontent.com/acme/kb/main/kb/acme",
    ]);
  });

  it("resolves relative ../sibling links between the mounted remote bundles", async () => {
    const mount = await loadColocatedRemoteBundles(
      { url: ROOT_URL },
      fakeGitHub({
        "kb/acme/note.md": NOTE("../ops/runbook.md"),
        "kb/ops/runbook.md": DOC,
      }),
    );
    const [acme] = mount.bundles;
    const siblings = colocatedSiblings(acme!, mount.bundles);
    assert.deepEqual(siblings.map((b) => b.id), ["ops"]);
    const link = acme!.concepts.get("note")!.links[0]!;
    assert.equal(link.kind, "outside");
    const target = resolveOutsideLink(link.path!, siblings);
    assert.equal(target?.bundle.id, "ops");
    assert.equal(target?.conceptId, "runbook");
  });

  it("partitions a wrapped archive by first path segment and reads the guide", async () => {
    const url = "https://example.com/kb.tar.gz";
    const fetchImpl = fakeArchiveServer({
      [url]: makeTarGz({
        "kb-main/AGENTS.md": "# Guide\n",
        "kb-main/acme/note.md": DOC,
        "kb-main/ops/runbook.md": DOC,
        "kb-main/ops/deep/plan.md": DOC,
      }),
    });
    const mount = await loadColocatedRemoteBundles({ url }, fetchImpl);
    assert.deepEqual(mount.bundles.map((b) => b.id), ["acme", "ops"]);
    assert.equal(mount.agentsGuide, "# Guide\n");
    assert.deepEqual(
      [...mount.bundles[1]!.concepts.keys()].sort(),
      ["deep/plan", "runbook"],
    );
    // Archives have no per-file URLs, so no canonical location is derived.
    assert.equal(mount.bundles[0]!.canonicalUrls, undefined);
    assert.equal(mount.bundles[0]!.colocatedRoot, url);
    assert.equal(mount.bundles[0]!.readOnly, true);
  });

  it("derives archive canonical URLs from an explicit root canonicalUrl", async () => {
    const url = "https://example.com/kb.zip";
    const fetchImpl = fakeArchiveServer({
      [url]: makeZip({ "kb/acme/note.md": DOC }),
    });
    const mount = await loadColocatedRemoteBundles(
      { url, canonicalUrl: "https://github.com/acme/kb/tree/main/kb/" },
      fetchImpl,
    );
    assert.deepEqual(mount.bundles[0]!.canonicalUrls, [
      "https://github.com/acme/kb/tree/main/kb/acme",
      "https://github.com/acme/kb/blob/main/kb/acme",
      "https://raw.githubusercontent.com/acme/kb/main/kb/acme",
    ]);
  });

  it("only mounts the named subfolders and rejects unknown names", async () => {
    const files = {
      "kb/acme/note.md": DOC,
      "kb/ops/runbook.md": DOC,
      "kb/scratch/junk.md": DOC,
    };
    const mount = await loadColocatedRemoteBundles(
      { url: ROOT_URL, only: ["ops", "acme"] },
      fakeGitHub(files),
    );
    assert.deepEqual(mount.bundles.map((b) => b.id), ["acme", "ops"]);

    await assert.rejects(
      loadColocatedRemoteBundles({ url: ROOT_URL, only: ["nope"] }, fakeGitHub(files)),
      /no bundle subdirectory named "nope"/,
    );
  });

  it("applies include/exclude globs per bundle and drops emptied folders", async () => {
    const mount = await loadColocatedRemoteBundles(
      {
        url: ROOT_URL,
        include: ["tables/**"],
        exclude: ["tables/archive/*"],
      },
      fakeGitHub({
        "kb/acme/tables/orders.md": DOC,
        "kb/acme/tables/archive/old.md": DOC,
        "kb/acme/notes/scratch.md": DOC,
        "kb/ops/runbook.md": DOC,
      }),
    );
    assert.deepEqual(mount.bundles.map((b) => b.id), ["acme"]);
    assert.deepEqual([...mount.bundles[0]!.concepts.keys()], ["tables/orders"]);
  });

  it("enforces the byte limit across the whole root, not per bundle", async () => {
    const half = MAX_REMOTE_BYTES / 2 + 1;
    await assert.rejects(
      loadColocatedRemoteBundles(
        { url: ROOT_URL },
        fakeGitHub(
          { "kb/acme/a.md": DOC, "kb/ops/b.md": DOC },
          { "kb/acme/a.md": half, "kb/ops/b.md": half },
        ),
      ),
      /too large/,
    );
  });

  it("enforces the file-count limit across the whole root", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_REMOTE_FILES; i++) {
      files[`kb/${i % 2 === 0 ? "acme" : "ops"}/c${i}.md`] = DOC;
    }
    await assert.rejects(
      loadColocatedRemoteBundles({ url: ROOT_URL }, fakeGitHub(files)),
      /too many files/,
    );
  });

  it("rejects a root with no bundle subdirectories holding markdown", async () => {
    await assert.rejects(
      loadColocatedRemoteBundles(
        { url: ROOT_URL },
        fakeGitHub({ "kb/README.md": "loose only\n" }),
      ),
      /no bundle subdirectories with markdown/,
    );
  });
});
