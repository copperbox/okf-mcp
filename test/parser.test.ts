import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  patchFrontmatter,
  splitFrontmatter,
  serializeDocument,
} from "../src/frontmatter.js";
import {
  conceptIdFromPath,
  deriveTitle,
  extractCitations,
  extractLinks,
  extractSection,
  normalizeCitationEntries,
  parseConceptDocument,
  sectionAt,
  sectionSpan,
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

describe("patchFrontmatter", () => {
  const DOC =
    "---\ntype: Table\n# owner comes from CODEOWNERS\nowner: data-team\ntitle: Old Title\n---\n\n# Schema\n\nBody.\n";

  it("sets and overwrites only the patched keys, preserving comments and body bytes", () => {
    const result = patchFrontmatter(DOC, { title: "New Title", status: "active" });
    assert.deepEqual(result.set, ["title", "status"]);
    assert.deepEqual(result.deleted, []);
    assert.match(result.source, /# owner comes from CODEOWNERS\nowner: data-team\n/);
    assert.match(result.source, /title: New Title/);
    assert.match(result.source, /status: active/);
    assert.ok(result.source.endsWith("---\n\n# Schema\n\nBody.\n"));
    assert.deepEqual(splitFrontmatter(result.source).data, {
      type: "Table",
      owner: "data-team",
      title: "New Title",
      status: "active",
    });
  });

  it("deletes a key on explicit null, reporting only keys that existed", () => {
    const result = patchFrontmatter(DOC, { owner: null, nope: null });
    assert.deepEqual(result.set, []);
    assert.deepEqual(result.deleted, ["owner"]);
    assert.deepEqual(splitFrontmatter(result.source).data, {
      type: "Table",
      title: "Old Title",
    });
  });

  it("returns the source untouched for an empty patch", () => {
    assert.equal(patchFrontmatter(DOC, {}).source, DOC);
  });

  it("patches an empty frontmatter block", () => {
    const result = patchFrontmatter("---\n---\n\nBody.\n", { type: "Note" });
    assert.deepEqual(result.set, ["type"]);
    assert.deepEqual(splitFrontmatter(result.source).data, { type: "Note" });
    assert.ok(result.source.endsWith("---\n\nBody.\n"));
  });

  it("slots a newly created key after its insertAfter anchors", () => {
    const result = patchFrontmatter(
      DOC,
      { timestamp: "2026-07-08T00:00:00Z" },
      { insertAfter: { timestamp: ["type"] } },
    );
    assert.deepEqual(result.set, ["timestamp"]);
    assert.match(
      result.source,
      /type: Table\ntimestamp: 2026-07-08T00:00:00Z\n# owner comes from CODEOWNERS\nowner: data-team\n/,
    );
  });

  it("slots a new key at the top when none of its anchors are present", () => {
    const result = patchFrontmatter(
      DOC,
      { timestamp: "2026-07-08T00:00:00Z" },
      { insertAfter: { timestamp: ["description", "tags"] } },
    );
    assert.match(result.source, /^---\ntimestamp: 2026-07-08T00:00:00Z\ntype: Table\n/);
  });

  it("overwrites an existing key in place even when insertAfter names it", () => {
    const result = patchFrontmatter(
      DOC,
      { title: "New Title" },
      { insertAfter: { title: ["type"] } },
    );
    assert.match(result.source, /owner: data-team\ntitle: New Title\n---/);
  });

  it("rejects documents without a parseable frontmatter mapping", () => {
    assert.throws(() => patchFrontmatter("# No frontmatter\n", { a: 1 }), /no frontmatter/);
    assert.throws(() => patchFrontmatter("---\ntype: Note\n\nBody.", { a: 1 }), /unterminated/);
    assert.throws(
      () => patchFrontmatter("---\n- just\n- a list\n---\n\nBody.\n", { a: 1 }),
      /not a YAML mapping/,
    );
    assert.throws(
      () => patchFrontmatter("---\ntype: [broken\n---\n\nBody.\n", { a: 1 }),
      /invalid YAML/,
    );
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

  it("skips links inside fenced code blocks", () => {
    const body =
      "See [real](/tables/orders.md).\n\n```md\n[example](/tables/orders.md)\n```\n\n" +
      "~~~\n[also code](./code.md)\n~~~\n\nAnd [after](./after.md).";
    const links = extractLinks(body, "playbooks/x.md");
    assert.deepEqual(
      links.map((l) => l.target),
      ["/tables/orders.md", "./after.md"],
    );
    // Offsets still slice back to the raw targets around the skipped fences.
    for (const link of links) {
      assert.equal(body.slice(link.targetStart, link.targetEnd), link.target);
    }
  });

  it("treats links inside an unclosed fence as code to the end of the body", () => {
    const links = extractLinks("```\n[code](/a.md)\n", "x.md");
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

describe("sectionSpan", () => {
  const body =
    "Intro.\n\n# Schema\n\nColumns.\n\n## Keys\n\nPrimary key.\n\n# Examples\n\nQuery.\n";

  it("records offsets that slice back to the heading line and subtree", () => {
    const span = sectionSpan(body, "schema");
    assert.equal(span?.heading, "Schema");
    assert.equal(span?.level, 1);
    assert.equal(body.slice(span!.start, span!.contentStart), "# Schema\n");
    assert.equal(
      body.slice(span!.contentStart, span!.end),
      "\nColumns.\n\n## Keys\n\nPrimary key.\n\n",
    );
  });

  it("runs to the end of the body for the last section", () => {
    const span = sectionSpan(body, "Examples");
    assert.equal(span?.end, body.length);
    assert.equal(body.slice(span!.contentStart, span!.end), "\nQuery.\n");
  });

  it("returns undefined for an unknown heading", () => {
    assert.equal(sectionSpan(body, "Citations"), undefined);
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

  it("classifies a resolving outside target as concept via the outsideResolves hook", () => {
    const body =
      "# Citations\n\n[1] [Orders](../acme/tables/orders.md)\n[2] [Gone](../acme/tables/gone.md)\n";
    const outsideResolves = (p: string) => p === "../acme/tables/orders.md";
    const { citations } = extractCitations(body, "runbook.md", exists, outsideResolves);
    assert.equal(citations[0]?.kind, "concept");
    assert.equal(citations[1]?.kind, "missing");
  });

  it("keeps reporting outside targets as missing without an outsideResolves hook", () => {
    const body = "# Citations\n\n[1] [Orders](../acme/tables/orders.md)\n";
    const { citations } = extractCitations(body, "runbook.md", exists);
    assert.equal(citations[0]?.kind, "missing");
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

  it("merges duplicate Citations sections so an empty first one cannot mask entries", () => {
    const body =
      "# Citations\n\n# Citations\n\n[1] [Example](https://example.com)\n";
    const { citations, malformed } = extractCitations(body, "a.md", exists);
    assert.deepEqual(citations.map((c) => c.target), ["https://example.com"]);
    assert.deepEqual(malformed, []);
  });

  it("reads entries from every duplicate Citations section", () => {
    const body = [
      "# Citations",
      "",
      "[1] [A](https://a.example)",
      "",
      "# Notes",
      "",
      "Prose.",
      "",
      "# Citations",
      "",
      "[2] [B](https://b.example)",
      "",
    ].join("\n");
    const { citations } = extractCitations(body, "a.md", exists);
    assert.deepEqual(citations.map((c) => c.index), [1, 2]);
  });
});

describe("normalizeCitationEntries", () => {
  it("rewrites ordered-list entries under # Citations to the [n] form", () => {
    const body =
      "# Citations\n\n1. [Docs](https://example.com)\n2) [Guide](/guides/x.md), accessed 2026-07-01\n";
    assert.equal(
      normalizeCitationEntries(body),
      "# Citations\n\n[1] [Docs](https://example.com)\n[2] [Guide](/guides/x.md), accessed 2026-07-01\n",
    );
  });

  it("leaves correct entries, prose, and non-link list items alone", () => {
    const body =
      "# Citations\n\n[1] [Docs](https://example.com)\n1. no link here\nProse line.\n";
    assert.equal(normalizeCitationEntries(body), body);
  });

  it("only touches Citations sections", () => {
    const body =
      "# Steps\n\n1. [Open the runbook](/playbooks/x.md)\n\n# Citations\n\n1. [Docs](https://example.com)\n";
    assert.equal(
      normalizeCitationEntries(body),
      "# Steps\n\n1. [Open the runbook](/playbooks/x.md)\n\n# Citations\n\n[1] [Docs](https://example.com)\n",
    );
  });

  it("normalizes every duplicate Citations section", () => {
    const body =
      "# Citations\n\n1. [A](https://a.example)\n\n# Notes\n\nProse.\n\n# Citations\n\n2. [B](https://b.example)\n";
    assert.equal(
      normalizeCitationEntries(body),
      "# Citations\n\n[1] [A](https://a.example)\n\n# Notes\n\nProse.\n\n# Citations\n\n[2] [B](https://b.example)\n",
    );
  });

  it("leaves fenced code inside the Citations section alone", () => {
    const body =
      "# Citations\n\n```\n1. [not real](https://example.com)\n```\n\n1. [Docs](https://example.com)\n";
    assert.equal(
      normalizeCitationEntries(body),
      "# Citations\n\n```\n1. [not real](https://example.com)\n```\n\n[1] [Docs](https://example.com)\n",
    );
  });
});

describe("conceptIdFromPath", () => {
  it("strips the .md suffix", () => {
    assert.equal(conceptIdFromPath("tables/orders.md"), "tables/orders");
  });
});

describe("deriveTitle", () => {
  const concept = (path: string, frontmatter: { type: string; title?: string }) => ({
    id: conceptIdFromPath(path),
    path,
    frontmatter,
  });

  it("uses the frontmatter title when present", () => {
    assert.equal(
      deriveTitle(concept("tables/orders.md", { type: "Table", title: "Orders" })),
      "Orders",
    );
  });

  it("derives a title-cased name from the filename, not the full path", () => {
    assert.equal(
      deriveTitle(concept("tables/customer-order-history.md", { type: "Table" })),
      "Customer Order History",
    );
  });

  it("treats underscores and repeated separators as single spaces", () => {
    assert.equal(
      deriveTitle(concept("notes/q3_planning--notes.md", { type: "Note" })),
      "Q3 Planning Notes",
    );
  });

  it("falls back to the concept ID when the filename has no words", () => {
    assert.equal(deriveTitle(concept("notes/_.md", { type: "Note" })), "notes/_");
  });
});
