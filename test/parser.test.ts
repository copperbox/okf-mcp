import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitFrontmatter, serializeDocument } from "../src/frontmatter.js";
import {
  conceptIdFromPath,
  extractLinks,
  parseConceptDocument,
} from "../src/parser.js";

describe("splitFrontmatter", () => {
  it("parses a well-formed frontmatter block and body", () => {
    const result = splitFrontmatter("---\ntype: Metric\ntags: [a, b]\n---\n\nBody here.\n");
    assert.equal(result.present, true);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.data, { type: "Metric", tags: ["a", "b"] });
    assert.equal(result.body, "Body here.\n");
  });

  it("reports a document without frontmatter as absent, not an error", () => {
    const result = splitFrontmatter("# Just markdown\n");
    assert.equal(result.present, false);
    assert.equal(result.data, null);
    assert.equal(result.body, "# Just markdown\n");
  });

  it("reports unterminated frontmatter as an error without throwing", () => {
    const result = splitFrontmatter("---\ntype: Metric\n\nNo closing fence.");
    assert.equal(result.present, true);
    assert.match(result.error ?? "", /unterminated/);
  });

  it("round-trips through serializeDocument preserving unknown keys", () => {
    const doc = serializeDocument({ type: "Metric", custom_key: 42 }, "Body.");
    const back = splitFrontmatter(doc);
    assert.deepEqual(back.data, { type: "Metric", custom_key: 42 });
    assert.equal(back.body.trim(), "Body.");
  });
});

describe("extractLinks", () => {
  it("resolves bundle-absolute links from any directory", () => {
    const body = "See [orders](/tables/orders.md).";
    const links = extractLinks(body, "playbooks/x.md");
    assert.deepEqual(links, [
      {
        text: "orders",
        target: "/tables/orders.md",
        kind: "concept",
        path: "tables/orders.md",
        targetStart: body.indexOf("/tables"),
        targetEnd: body.indexOf("/tables") + "/tables/orders.md".length,
      },
    ]);
  });

  it("records target offsets that slice back to the raw target", () => {
    const body = 'A [x](./a.md) then [y](<c.md> "t") and [z](b.md#frag).';
    for (const link of extractLinks(body, "dir/doc.md")) {
      assert.equal(body.slice(link.targetStart, link.targetEnd), link.target);
    }
  });

  it("resolves relative links against the document's directory", () => {
    const [link] = extractLinks("See [c](./customers.md).", "tables/orders.md");
    assert.equal(link?.kind, "concept");
    assert.equal(link?.path, "tables/customers.md");
  });

  it("classifies URLs as external and #fragments as anchors", () => {
    const links = extractLinks(
      "[dash](https://example.com/d) and [above](#steps) and [code](repo://src/a.ts)",
      "a.md",
    );
    assert.deepEqual(
      links.map((l) => l.kind),
      ["external", "anchor", "external"],
    );
  });

  it("marks links escaping the bundle root as outside", () => {
    const [link] = extractLinks("[up](../../elsewhere.md)", "tables/orders.md");
    assert.equal(link?.kind, "outside");
  });

  it("ignores images", () => {
    const links = extractLinks("![diagram](./diagram.png)", "a.md");
    assert.equal(links.length, 0);
  });
});

describe("parseConceptDocument", () => {
  it("flags a missing type as a conformance problem but keeps the document", () => {
    const parsed = parseConceptDocument("---\ntitle: X\n---\n\nBody.", "x.md");
    assert.equal(parsed.problems.length, 1);
    assert.match(parsed.problems[0]!, /type/);
    assert.notEqual(parsed.frontmatter, null);
  });

  it("normalizes a scalar tags value into an array", () => {
    const parsed = parseConceptDocument("---\ntype: T\ntags: solo\n---\n", "x.md");
    assert.deepEqual(parsed.frontmatter?.tags, ["solo"]);
  });
});

describe("conceptIdFromPath", () => {
  it("strips the .md suffix", () => {
    assert.equal(conceptIdFromPath("tables/orders.md"), "tables/orders");
  });
});
