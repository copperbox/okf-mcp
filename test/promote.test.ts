import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writeConcept } from "../src/authoring.js";
import { loadBundle } from "../src/bundle.js";
import { deriveCrossBundleEdges } from "../src/graph.js";
import { canonicalConceptUrl, promoteConcept } from "../src/promote.js";
import type { LoadedBundle } from "../src/types.js";

describe("promoteConcept", () => {
  let projRoot: string;
  let orgRoot: string;
  beforeEach(async () => {
    projRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okf-promote-proj-"));
    orgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okf-promote-org-"));
    await writeConcept(
      projRoot,
      "notes/naming.md",
      { type: "Standard", title: "Naming", tags: ["style"] },
      "Use snake_case.",
    );
    await writeConcept(
      projRoot,
      "guides/setup.md",
      { type: "Guide", title: "Setup" },
      "Follow [Naming](/notes/naming.md).",
    );
    await writeConcept(
      orgRoot,
      "standards/reviews.md",
      { type: "Standard", title: "Reviews" },
      "Review rules.",
    );
  });
  afterEach(async () => {
    await fs.rm(projRoot, { recursive: true, force: true });
    await fs.rm(orgRoot, { recursive: true, force: true });
  });

  async function bundles(): Promise<{ proj: LoadedBundle; org: LoadedBundle }> {
    return {
      proj: await loadBundle({ id: "proj", root: projRoot }),
      org: await loadBundle({ id: "org", root: orgRoot }),
    };
  }

  it("moves the concept, leaves a citation stub, and reports inbound links", async () => {
    const { proj, org } = await bundles();
    const result = await promoteConcept(proj, org, "notes/naming", {
      toPath: "standards/naming.md",
    });
    assert.equal(result.id, "standards/naming");
    assert.equal(result.from, "notes/naming.md");
    assert.equal(result.to, "standards/naming.md");
    assert.equal(result.fromBundle, "proj");
    assert.equal(result.toBundle, "org");
    assert.equal(result.title, "Naming");
    assert.equal(result.citation, "okf://org/standards/naming.md");
    assert.equal(result.stubPath, "notes/naming.md");
    assert.deepEqual(result.inboundLinks, ["guides/setup"]);
    assert.deepEqual(result.removedDirs, []);

    // The promoted copy carries the original frontmatter and body.
    const orgAfter = await loadBundle({ id: "org", root: orgRoot });
    const promoted = orgAfter.concepts.get("standards/naming");
    assert.equal(promoted?.frontmatter.title, "Naming");
    assert.deepEqual(promoted?.frontmatter.tags, ["style"]);
    assert.match(promoted?.body ?? "", /snake_case/);

    // The stub redirects: resource + §8 citation on the canonical location,
    // and the inbound link still resolves (to the stub).
    const projAfter = await loadBundle({ id: "proj", root: projRoot });
    const stub = projAfter.concepts.get("notes/naming");
    assert.equal(stub?.frontmatter.type, "Standard");
    assert.equal(stub?.frontmatter.title, "Naming");
    assert.equal(stub?.frontmatter.resource, "okf://org/standards/naming.md");
    assert.match(stub?.body ?? "", /# Citations/);
    assert.match(stub?.body ?? "", /\[1\] \[Naming\]\(okf:\/\/org\/standards\/naming\.md\)/);
    const setup = projAfter.concepts.get("guides/setup");
    assert.equal(
      setup?.links.find((l) => l.kind === "concept")?.resolvedId,
      "notes/naming",
    );
  });

  it("defaults placement to the suggested directory, keeping the filename", async () => {
    const { proj, org } = await bundles();
    // org's only Standard lives in standards/, so that directory wins.
    const result = await promoteConcept(proj, org, "notes/naming");
    assert.equal(result.to, "standards/naming.md");
    await fs.access(path.join(orgRoot, "standards/naming.md"));
  });

  it("cites the target bundle's canonical URL (blob form for GitHub trees)", async () => {
    const proj = await loadBundle({ id: "proj", root: projRoot });
    const org = await loadBundle({
      id: "org",
      root: orgRoot,
      canonicalUrl: "https://github.com/acme/kb/tree/main/kb",
    });
    const result = await promoteConcept(proj, org, "notes/naming", {
      toPath: "standards/naming.md",
    });
    assert.equal(
      result.citation,
      "https://github.com/acme/kb/blob/main/kb/standards/naming.md",
    );

    // The stub's citation resolves back to the promoted concept as a
    // derived cross-bundle edge, keeping the source graph navigable.
    const projAfter = await loadBundle({ id: "proj", root: projRoot });
    const orgAfter = await loadBundle({
      id: "org",
      root: orgRoot,
      canonicalUrl: "https://github.com/acme/kb/tree/main/kb",
    });
    const edges = deriveCrossBundleEdges([projAfter, orgAfter]);
    assert.ok(
      edges.some(
        (e) => e.from === "proj:notes/naming" && e.to === "org:standards/naming",
      ),
    );
  });

  it("skips the stub with stub: false and reports the dangling inbound links", async () => {
    const { proj, org } = await bundles();
    const result = await promoteConcept(proj, org, "notes/naming", {
      toPath: "standards/naming.md",
      stub: false,
    });
    assert.equal(result.stubPath, undefined);
    assert.deepEqual(result.inboundLinks, ["guides/setup"]);
    assert.deepEqual(result.removedDirs, ["notes"]);
    await assert.rejects(fs.access(path.join(projRoot, "notes")));
    await fs.access(path.join(orgRoot, "standards/naming.md"));
  });

  it("rejects same-bundle promotion, collisions, reserved files, and unknown concepts", async () => {
    const { proj, org } = await bundles();
    await assert.rejects(
      promoteConcept(proj, proj, "notes/naming"),
      /source and target bundle are the same/,
    );
    await assert.rejects(
      promoteConcept(proj, org, "notes/naming", { toPath: "standards/reviews.md" }),
      /already exists in bundle "org"/,
    );
    await assert.rejects(promoteConcept(proj, org, "log.md"), /reserved/);
    await assert.rejects(promoteConcept(proj, org, "nope"), /unknown concept/);
    // Failed promotions leave the source untouched.
    await fs.access(path.join(projRoot, "notes/naming.md"));
  });
});

describe("canonicalConceptUrl", () => {
  it("prefers the blob prefix for GitHub canonicals and falls back to okf://", () => {
    const base = {
      root: "/x",
      concepts: new Map(),
      reserved: [],
      problems: [],
      readOnly: false,
    };
    const github: LoadedBundle = {
      ...base,
      id: "org",
      canonicalUrls: [
        "https://github.com/acme/kb/tree/main/kb",
        "https://github.com/acme/kb/blob/main/kb",
        "https://raw.githubusercontent.com/acme/kb/main/kb",
      ],
    };
    assert.equal(
      canonicalConceptUrl(github, "standards/naming.md"),
      "https://github.com/acme/kb/blob/main/kb/standards/naming.md",
    );
    const plain: LoadedBundle = {
      ...base,
      id: "org",
      canonicalUrls: ["https://kb.example.com/org"],
    };
    assert.equal(
      canonicalConceptUrl(plain, "standards/naming.md"),
      "https://kb.example.com/org/standards/naming.md",
    );
    const local: LoadedBundle = { ...base, id: "org" };
    assert.equal(
      canonicalConceptUrl(local, "standards/naming.md"),
      "okf://org/standards/naming.md",
    );
  });
});
