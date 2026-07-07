import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { splitFrontmatter, serializeDocument } from "../src/frontmatter.js";
import {
  conceptIdFromPath,
  extractCitations,
  extractLinks,
  extractSection,
  parseConceptDocument,
  sectionAt,
  splitSections,
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

describe("splitSections", () => {
  it("splits on ATX headings, recording heading, level, and content", () => {
    const body = "# Schema\n\nColumns here.\n\n## Keys\n\nPrimary key.\n\n# Examples\n\nQuery one.\n";
    assert.deepEqual(splitSections(body), [
      { heading: "Schema", level: 1, content: "Columns here." },
      { heading: "Keys", level: 2, content: "Primary key." },
      { heading: "Examples", level: 1, content: "Query one." },
    ]);
  });

  it("excludes preamble text before the first heading", () => {
    const sections = splitSections("Intro line.\n\n# Schema\n\nBody.\n");
    assert.deepEqual(sections.map((s) => s.heading), ["Schema"]);
  });

  it("ignores heading-like lines inside fenced code blocks", () => {
    const body = "# Real\n\n```md\n# not a heading\n```\n\n~~~\n## also not\n~~~\n\n# Also Real\n";
    assert.deepEqual(splitSections(body).map((s) => s.heading), ["Real", "Also Real"]);
    assert.ok(splitSections(body)[0]?.content.includes("# not a heading"));
  });

  it("strips ATX closing sequences and requires a space after the #s", () => {
    const sections = splitSections("# Title ##\n\n#hashtag is body text\n");
    assert.deepEqual(sections, [
      { heading: "Title", level: 1, content: "#hashtag is body text" },
    ]);
  });

  it("returns an empty list for a body with no headings", () => {
    assert.deepEqual(splitSections("Just prose.\n"), []);
  });
});

describe("extractSection", () => {
  const body =
    "Intro.\n\n# Schema\n\nColumns.\n\n## Keys\n\nPrimary key.\n\n# Examples\n\nQuery.\n";

  it("matches the heading case-insensitively", () => {
    const section = extractSection(body, "schema");
    assert.equal(section?.heading, "Schema");
    assert.equal(section?.level, 1);
  });

  it("includes subsections up to the next same-or-shallower heading", () => {
    const section = extractSection(body, "Schema");
    assert.equal(section?.content, "Columns.\n\n## Keys\n\nPrimary key.");
  });

  it("ends a subsection at the next heading regardless of depth", () => {
    const section = extractSection(body, "Keys");
    assert.equal(section?.content, "Primary key.");
  });

  it("returns undefined for an unknown heading", () => {
    assert.equal(extractSection(body, "Citations"), undefined);
  });
});

describe("sectionAt", () => {
  const body = "Intro.\n\n# Schema\n\nColumns.\n\n## Keys\n\nPrimary key.\n\n# Examples\n\nQuery.\n";

  it("returns the deepest enclosing section heading for an offset", () => {
    assert.equal(sectionAt(body, body.indexOf("Columns")), "Schema");
    assert.equal(sectionAt(body, body.indexOf("Primary")), "Keys");
    assert.equal(sectionAt(body, body.indexOf("Query")), "Examples");
  });

  it("returns undefined for offsets before the first heading", () => {
    assert.equal(sectionAt(body, body.indexOf("Intro")), undefined);
  });
});

describe("extractCitations", () => {
  const exists = (id: string) => id === "tables/customers" || id === "references/runbook";

  it("parses numbered entries and classifies external, concept, and missing targets", () => {
    const body = [
      "# Schema",
      "",
      "Columns.",
      "",
      "# Citations",
      "",
      "[1] [BigQuery docs](https://cloud.google.com/bigquery/docs)",
      "[2] [Customer table](/tables/customers.md)",
      "[3] [Gone](/playbooks/retired)",
      "",
    ].join("\n");
    const { citations, malformed } = extractCitations(body, "tables/orders.md", exists);
    assert.deepEqual(citations, [
      {
        index: 1,
        text: "BigQuery docs",
        target: "https://cloud.google.com/bigquery/docs",
        kind: "external",
      },
      {
        index: 2,
        text: "Customer table",
        target: "/tables/customers.md",
        kind: "concept",
      },
      { index: 3, text: "Gone", target: "/playbooks/retired", kind: "missing" },
    ]);
    assert.deepEqual(malformed, []);
  });

  it("resolves relative and extensionless targets against the document directory", () => {
    const body = "# Citations\n\n[1] [Runbook mirror](../references/runbook)\n";
    const { citations } = extractCitations(body, "tables/orders.md", exists);
    assert.equal(citations[0]?.kind, "concept");
  });

  it("returns nothing for a body without a Citations section", () => {
    const body = "# Schema\n\n[1] [not a citation](https://example.com)\n";
    assert.deepEqual(extractCitations(body, "a.md", exists), {
      citations: [],
      malformed: [],
    });
  });

  it("matches the Citations heading case-insensitively", () => {
    const body = "# citations\n\n[1] [Docs](https://example.com)\n";
    const { citations } = extractCitations(body, "a.md", exists);
    assert.equal(citations.length, 1);
  });

  it("reports non-blank lines that are not numbered link entries as malformed", () => {
    const body = [
      "# Citations",
      "",
      "[1] [Docs](https://example.com)",
      "Ask the warehouse team for details.",
      "[2] an unlinked source",
      "[not numbered](https://example.com)",
      "",
    ].join("\n");
    const { citations, malformed } = extractCitations(body, "a.md", exists);
    assert.equal(citations.length, 1);
    assert.deepEqual(malformed, [
      "Ask the warehouse team for details.",
      "[2] an unlinked source",
      "[not numbered](https://example.com)",
    ]);
  });

  it("allows trailing prose after the citation link", () => {
    const body = "# Citations\n\n[1] [Docs](https://example.com), accessed 2026-05-28\n";
    const { citations, malformed } = extractCitations(body, "a.md", exists);
    assert.deepEqual(malformed, []);
    assert.equal(citations[0]?.target, "https://example.com");
  });

  it("ignores citation-shaped lines outside the Citations section", () => {
    const body = "# Notes\n\n[1] [Docs](https://example.com)\n\n# Citations\n\n[1] [Real](https://real.example)\n";
    const { citations } = extractCitations(body, "a.md", exists);
    assert.deepEqual(citations.map((c) => c.target), ["https://real.example"]);
  });
});

describe("conceptIdFromPath", () => {
  it("strips the .md suffix", () => {
    assert.equal(conceptIdFromPath("tables/orders.md"), "tables/orders");
  });
});
