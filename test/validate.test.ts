import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { buildBundle, loadBundle } from "../src/bundle.js";
import { validateBundle } from "../src/validate.js";
import type { ValidationReport } from "../src/validate.js";

const ACME = path.join(import.meta.dirname, "fixtures", "acme");
const MALFORMED = path.join(import.meta.dirname, "fixtures", "malformed");

async function report(root: string): Promise<ValidationReport> {
  return validateBundle(await loadBundle({ id: "fixture", root }));
}

describe("validateBundle reserved-file structure (spec §9.3)", () => {
  it("flags non-date `##` headings in log.md as conformance errors (spec §7)", async () => {
    const result = await report(MALFORMED);
    const errors = result.errors.filter((p) => p.path === "log.md");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /ISO 8601/);
    assert.match(errors[0]!.message, /Release notes/);
    assert.equal(result.conformant, false);
  });

  it("warns when log.md date sections are not newest-first (spec §7)", async () => {
    const result = await report(MALFORMED);
    const outOfOrder = result.warnings.filter(
      (p) => p.path === "log.md" && p.message.includes("newest-first"),
    );
    assert.equal(outOfOrder.length, 1);
    assert.match(outOfOrder[0]!.message, /2026-03-01/);
    assert.match(outOfOrder[0]!.message, /2026-01-05/);
  });

  it("warns when a log.md entry is not a list item (spec §7)", async () => {
    const result = await report(MALFORMED);
    const prose = result.warnings.filter(
      (p) => p.path === "log.md" && p.message.includes("list item"),
    );
    assert.equal(prose.length, 1);
    assert.match(prose[0]!.message, /Plain prose entry/);
  });

  it("warns about index.md content that is neither a heading nor a link bullet (spec §6)", async () => {
    const result = await report(MALFORMED);
    const shape = result.warnings.filter(
      (p) => p.path === "index.md" && p.message.includes("link bullet"),
    );
    assert.equal(shape.length, 1);
    assert.match(shape[0]!.message, /Welcome to the malformed bundle/);
  });

  it("keeps warning about frontmatter in a non-root index.md (spec §11)", async () => {
    const result = await report(MALFORMED);
    const frontmatter = result.warnings.filter(
      (p) => p.path === "guides/index.md",
    );
    assert.equal(frontmatter.length, 1);
    assert.match(frontmatter[0]!.message, /bundle root/);
  });

  it("does not warn when non-root index frontmatter is only the generated: false marker", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "guides/index.md",
          source: "---\ngenerated: false\n---\n\n# Curated\n\n* [Note](../note.md)\n",
        },
        { path: "note.md", source: "---\ntype: Note\n---\n\nBody.\n" },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    assert.deepEqual(
      result.warnings.filter((p) => p.message.includes("bundle root")),
      [],
    );
  });

  it("still warns when curated non-root index frontmatter carries other keys", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "guides/index.md",
          source: "---\ngenerated: false\nowner: docs\n---\n\n# Curated\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    const frontmatter = result.warnings.filter((p) => p.message.includes("bundle root"));
    assert.equal(frontmatter.length, 1);
  });

  it("still warns when non-root index frontmatter declares generated: true", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "guides/index.md",
          source: "---\ngenerated: true\n---\n\n# Not Curated\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    const frontmatter = result.warnings.filter((p) => p.message.includes("bundle root"));
    assert.equal(frontmatter.length, 1);
  });

  it("accepts both directory-link forms in an index (bare `sub/` and `sub/index.md`)", async () => {
    // Older bundles link subdirectories as `sub/`; regeneration now emits
    // `sub/index.md` (resolvable in Obsidian). Both are valid §6 entries.
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "index.md",
          source:
            "# Bundle Index\n\n# Directories\n\n* [old](old/)\n* [new](new/index.md)\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    const indexProblems = [...result.errors, ...result.warnings].filter(
      (p) => p.path === "index.md",
    );
    assert.deepEqual(indexProblems, []);
  });

  it("reports no reserved-file problems for a well-formed bundle", async () => {
    const result = await report(ACME);
    const reserved = [...result.errors, ...result.warnings].filter(
      (p) => p.path !== undefined && /(^|\/)(index|log)\.md$/.test(p.path),
    );
    assert.deepEqual(reserved, []);
  });
});

describe("validateBundle recommended frontmatter (spec §4.1)", () => {
  function bundleWithConcept(frontmatterYaml: string) {
    return buildBundle(
      "mem",
      "/mem",
      [
        { path: "index.md", source: "# Bundle Index\n" },
        { path: "note.md", source: `---\n${frontmatterYaml}\n---\n\nBody.\n` },
      ],
      { keepSources: true },
    );
  }

  async function fieldWarnings(frontmatterYaml: string) {
    const result = await validateBundle(bundleWithConcept(frontmatterYaml));
    // Recommended fields are soft guidance (§9): never errors.
    assert.deepEqual(result.errors, []);
    assert.equal(result.conformant, true);
    return result.warnings.filter((w) => w.message.includes("§4.1"));
  }

  it("warns when timestamp is not an ISO 8601 datetime", async () => {
    for (const yaml of [
      "type: Note\ntimestamp: last tuesday",
      "type: Note\ntimestamp: 2026-13-01",
      "type: Note\ntimestamp: 12345",
    ]) {
      const warnings = await fieldWarnings(yaml);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.path, "note.md");
      assert.match(warnings[0]!.message, /`timestamp`.*ISO 8601/);
    }
  });

  it("warns when title or description is not a string", async () => {
    const warnings = await fieldWarnings(
      "type: Note\ntitle: 42\ndescription: [not, a, string]",
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!.message, /`title` should be a string/);
    assert.match(warnings[1]!.message, /`description` should be a string/);
  });

  it("warns when resource is not a string or not a parseable URI", async () => {
    const nonString = await fieldWarnings("type: Note\nresource: 7");
    assert.equal(nonString.length, 1);
    assert.match(nonString[0]!.message, /`resource` should be a string/);

    const nonUri = await fieldWarnings("type: Note\nresource: not a uri");
    assert.equal(nonUri.length, 1);
    assert.match(nonUri[0]!.message, /`resource`.*URI/);
    assert.match(nonUri[0]!.message, /not a uri/);
  });

  it("warns when tags is a scalar, noting the applied normalization", async () => {
    const warnings = await fieldWarnings("type: Note\ntags: infra");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.path, "note.md");
    assert.match(warnings[0]!.message, /`tags`.*list of strings/);
    assert.match(warnings[0]!.message, /normalized/);
    assert.match(warnings[0]!.message, /infra/);
  });

  it("warns when tags is a list containing non-strings", async () => {
    const warnings = await fieldWarnings("type: Note\ntags:\n  - ok\n  - 42");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /`tags`.*list of strings/);
    assert.match(warnings[0]!.message, /coerced/);
  });

  it("accepts well-formed recommended fields and absent ones silently", async () => {
    for (const yaml of [
      "type: Note", // all recommended fields absent
      [
        "type: Note",
        "title: A note",
        "description: Something helpful.",
        "resource: https://example.com/x",
        "tags: [a, b]",
        "timestamp: 2026-01-05T10:00:00Z",
      ].join("\n"),
      "type: Note\ntimestamp: 2026-01-05", // ISO 8601 date-only is fine
      "type: Note\nresource: repo:acme/data", // any URI scheme parses
    ]) {
      assert.deepEqual(await fieldWarnings(yaml), []);
    }
  });

  it("reports no §4.1 warnings for the well-formed fixture bundle", async () => {
    const result = await report(ACME);
    assert.deepEqual(
      result.warnings.filter((w) => w.message.includes("§4.1")),
      [],
    );
  });
});

describe("validateBundle okf_version (spec §11)", () => {
  function bundleDeclaring(indexSource: string) {
    return buildBundle(
      "mem",
      "/mem",
      [
        { path: "index.md", source: indexSource },
        { path: "note.md", source: "---\ntype: Note\n---\n\nBody.\n" },
      ],
      { keepSources: true },
    );
  }

  it("warns, never errors, when the declared major version is newer than supported", async () => {
    const result = await validateBundle(
      bundleDeclaring('---\nokf_version: "1.0"\n---\n\n# Bundle Index\n'),
    );
    const version = result.warnings.filter((p) => p.message.includes("okf_version"));
    assert.equal(version.length, 1);
    assert.equal(version[0]!.path, "index.md");
    assert.match(version[0]!.message, /"1\.0"/);
    assert.match(version[0]!.message, /best-effort/);
    assert.equal(result.errors.length, 0);
    assert.equal(result.conformant, true);
  });

  it("does not warn about the supported version or an absent declaration", async () => {
    for (const source of [
      '---\nokf_version: "0.1"\n---\n\n# Bundle Index\n',
      "# Bundle Index\n",
    ]) {
      const result = await validateBundle(bundleDeclaring(source));
      assert.deepEqual(
        result.warnings.filter((p) => p.message.includes("okf_version")),
        [],
      );
    }
  });
});

describe("validateBundle duplicate headings", () => {
  it("warns on duplicate top-level headings in a concept body", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "note.md",
          source:
            "---\ntype: Note\n---\n\n# Citations\n\n# Citations\n\n[1] [Docs](https://example.com)\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    const duplicates = result.warnings.filter((p) =>
      p.message.includes("duplicate top-level heading"),
    );
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]!.path, "note.md");
    assert.match(duplicates[0]!.message, /# Citations.*2 times/);
    assert.equal(result.conformant, true); // a warning, never an error
  });

  it("names the repair fixer only for duplicate Citations headings", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "note.md",
          source:
            "---\ntype: Note\n---\n\n# Notes\n\ntext\n\n# Notes\n\nmore\n\n" +
            "# Citations\n\n# Citations\n\n[1] [Docs](https://example.com)\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    const duplicates = result.warnings.filter((p) =>
      p.message.includes("duplicate top-level heading"),
    );
    assert.equal(duplicates.length, 2);
    const citations = duplicates.find((p) => p.message.includes("# Citations"))!;
    assert.match(
      citations.message,
      /auto-fixable: `okf-mcp repair --only duplicate-citation-headings`/,
    );
    const notes = duplicates.find((p) => p.message.includes("# Notes"))!;
    assert.doesNotMatch(notes.message, /auto-fixable/);
  });

  it("stays silent for distinct or repeated-at-depth headings", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "note.md",
          source:
            "---\ntype: Note\n---\n\n# Schema\n\n## Keys\n\n# Examples\n\n## Keys\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    assert.deepEqual(
      result.warnings.filter((p) => p.message.includes("duplicate top-level")),
      [],
    );
  });
});

describe("validateBundle malformed-citation fixer pointers", () => {
  it("names citation-format only for the auto-fixable ordered-list form", async () => {
    const bundle = buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "note.md",
          source:
            "---\ntype: Note\n---\n\n# Citations\n\n" +
            "1. [Alpha](https://example.com/a)\nplain prose line\n",
        },
      ],
      { keepSources: true },
    );
    const result = await validateBundle(bundle);
    const malformed = result.warnings.filter((p) =>
      p.message.includes("malformed citation entry"),
    );
    assert.equal(malformed.length, 2);
    const ordered = malformed.find((p) => p.message.includes("[Alpha]"))!;
    assert.match(
      ordered.message,
      /auto-fixable: `okf-mcp repair --only citation-format`/,
    );
    const prose = malformed.find((p) => p.message.includes("plain prose"))!;
    assert.doesNotMatch(prose.message, /auto-fixable/);
  });
});

describe("validateBundle colocated `../` links", () => {
  const sibling = () =>
    buildBundle(
      "acme",
      "/vault/acme",
      [
        { path: "tables/orders.md", source: "---\ntype: Table\n---\n\nRows.\n" },
        { path: "tables/index.md", source: "# Tables\n" },
      ],
      { keepSources: true, colocatedRoot: "/vault" },
    );

  const opsWith = (body: string, colocatedRoot: string | null = "/vault") =>
    buildBundle(
      "ops",
      "/vault/ops",
      [{ path: "runbook.md", source: `---\ntype: Runbook\n---\n\n${body}\n` }],
      { keepSources: true, ...(colocatedRoot !== null && { colocatedRoot }) },
    );

  const danglingWarnings = (result: ValidationReport) =>
    result.warnings.filter((p) => p.message.includes("colocated"));

  it("warns for a dangling ../ link into a mounted colocated sibling", async () => {
    const result = await validateBundle(
      opsWith("See [gone](../acme/tables/shipments.md)."),
      [sibling()],
    );
    const dangling = danglingWarnings(result);
    assert.equal(dangling.length, 1);
    assert.equal(dangling[0]!.path, "runbook.md");
    assert.match(dangling[0]!.message, /\.\.\/acme\/tables\/shipments\.md/);
    assert.equal(result.conformant, true); // a warning, never an error (spec §5.3)
  });

  it("stays silent for a ../ link that resolves into a mounted sibling", async () => {
    const result = await validateBundle(
      opsWith("See [orders](../acme/tables/orders.md) and [bare](../acme/tables/orders)."),
      [sibling()],
    );
    assert.deepEqual(danglingWarnings(result), []);
  });

  it("applies the in-bundle exemptions inside the sibling (assets, directories, reserved files)", async () => {
    const result = await validateBundle(
      opsWith(
        [
          "An [asset](../acme/assets/logo.png), a [directory](../acme/tables),",
          "and a [reserved file](../acme/tables/index).",
        ].join("\n"),
      ),
      [sibling()],
    );
    assert.deepEqual(danglingWarnings(result), []);
  });

  it("stays silent for ../ links outside any mounted sibling or without colocation", async () => {
    // Unmounted first segment and escape from the colocated root: unjudgeable.
    const unjudgeable = await validateBundle(
      opsWith("See [loose](../README.md) and [escape](../../elsewhere/x.md)."),
      [sibling()],
    );
    assert.deepEqual(danglingWarnings(unjudgeable), []);
    // No declared colocation: today's silence is preserved.
    const uncolocated = await validateBundle(
      opsWith("See [gone](../acme/tables/shipments.md).", null),
      [sibling()],
    );
    assert.deepEqual(danglingWarnings(uncolocated), []);
  });

  it("stops reporting citations with resolving ../ targets as missing", async () => {
    const body = [
      "# Citations",
      "",
      "[1] [Orders](../acme/tables/orders.md)",
      "[2] [Gone](../acme/tables/shipments.md)",
    ].join("\n");
    const result = await validateBundle(opsWith(body), [sibling()]);
    const citations = result.warnings.filter((p) => p.message.includes("citation"));
    assert.equal(citations.length, 1);
    assert.match(citations[0]!.message, /\[2\]/);
  });
});

describe("validateBundle bundle-absolute links", () => {
  const withBody = (body: string) =>
    buildBundle(
      "mem",
      "/mem",
      [
        {
          path: "playbooks/x.md",
          source: `---\ntype: Runbook\n---\n\n${body}\n`,
        },
        { path: "tables/orders.md", source: "---\ntype: Table\n---\n\nRows.\n" },
      ],
      { keepSources: true },
    );

  const absoluteWarnings = (result: ValidationReport) =>
    result.warnings.filter((p) => p.message.includes("bundle-absolute"));

  it("warns on leading-slash link targets, naming the repair fixer", async () => {
    const result = await validateBundle(
      withBody("See [orders](/tables/orders.md)."),
    );
    const warnings = absoluteWarnings(result);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.path, "playbooks/x.md");
    assert.match(warnings[0]!.message, /"\/tables\/orders\.md"/);
    assert.match(warnings[0]!.message, /repository root/);
    assert.match(
      warnings[0]!.message,
      /okf-mcp repair --only absolute-links-to-relative/,
    );
    assert.equal(result.conformant, true); // a warning, never an error (spec §5.3)
  });

  it("warns even when the target does not resolve — the form is the problem", async () => {
    const result = await validateBundle(withBody("See [gone](/tables/gone.md)."));
    assert.equal(absoluteWarnings(result).length, 1);
  });

  it("stays quiet for document-relative, external, and anchor links", async () => {
    const result = await validateBundle(
      withBody(
        "See [orders](../tables/orders.md), [ext](https://example.com/), and [top](#top).",
      ),
    );
    assert.deepEqual(absoluteWarnings(result), []);
  });
});

describe("v0.2 provenance, trust, and lifecycle warnings (spec §5, §7, §10)", () => {
  /** Validate a one-document bundle, returning just its warning messages. */
  async function warnings(source: string, extra: Record<string, string> = {}) {
    const documents = [
      { path: "x.md", source },
      ...Object.entries(extra).map(([p, s]) => ({ path: p, source: s })),
    ];
    const bundle = buildBundle("t", "/t", documents);
    // Sources are served from memory, so validate can re-read the raw YAML.
    bundle.sources = new Map(documents.map((d) => [d.path, d.source]));
    const result = await validateBundle(bundle);
    assert.deepEqual(result.errors, [], "none of these may be a conformance error");
    return result.warnings.map((w) => w.message);
  }

  it("requires generated.by within generated", async () => {
    const found = await warnings("---\ntype: Note\ngenerated: { at: 2026-06-20T22:53:05Z }\n---\n\nB.\n");
    assert.ok(found.some((m) => /`generated.by` is required/.test(m)));
  });

  it("flags an actor written without its convention prefix", async () => {
    // The one that matters: `ahormati` is a person, but without `human:` the
    // §5.3 tier silently reads machine-confirmed.
    const found = await warnings(
      "---\ntype: Note\nverified: { by: ahormati, at: 2026-06-25T09:00:00Z }\n---\n\nB.\n",
    );
    assert.ok(found.some((m) => /verified\[0\]\.by.*actor convention.*human:/s.test(m)));
  });

  it("accepts all three actor forms without comment", async () => {
    const found = await warnings(
      "---\ntype: Note\ngenerated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }\n" +
        "verified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n---\n\nB.\n",
    );
    assert.deepEqual(found.filter((m) => /actor convention/.test(m)), []);
  });

  it("flags a status outside the closed enum, unlike the open type vocabulary", async () => {
    const found = await warnings("---\ntype: Anything At All\nstatus: retired\n---\n\nB.\n");
    assert.ok(found.some((m) => /`status` should be one of draft, stable, deprecated/.test(m)));
    assert.deepEqual(found.filter((m) => /`type`/.test(m)), []);
  });

  it("flags a stale_after that is not a bare date", async () => {
    const found = await warnings("---\ntype: Note\nstale_after: 2026-09-23T00:00:00Z\n---\n\nB.\n");
    assert.ok(found.some((m) => /`stale_after` should be an absolute `YYYY-MM-DD` date/.test(m)));
  });

  it("requires resource within a sources entry", async () => {
    const found = await warnings(
      "---\ntype: Note\nsources:\n  - { id: a, title: No resource }\n---\n\nB.\n",
    );
    assert.ok(found.some((m) => /`sources\[0\]\.resource` is required/.test(m)));
  });

  it("accepts a scope descriptor as a sources resource", async () => {
    const found = await warnings(
      "---\ntype: Note\nsources:\n  - { id: a, resource: all queries in BigQuery project X }\n---\n\nB.\n",
    );
    assert.deepEqual(found, []);
  });

  it("flags a footnote attributing a claim to no sources entry", async () => {
    const found = await warnings(
      "---\ntype: Note\nsources:\n  - { id: ga4-schema, resource: https://example.com/a }\n---\n\n" +
        "Sharded daily.[^ga4-schema] Also true.[^runbook]\n\n[^ga4-schema]: GA4\n",
    );
    assert.ok(found.some((m) => /footnote \[\^runbook\] matches no `sources\[\]\.id`/.test(m)));
    assert.deepEqual(found.filter((m) => /\[\^ga4-schema\]/.test(m)), []);
  });

  it("leaves plain footnotes alone in a document that declares no sources", async () => {
    const found = await warnings("---\ntype: Note\n---\n\nA claim.[^n]\n\n[^n]: An aside.\n");
    assert.deepEqual(found, []);
  });

  it("requires runtime on an Attested Computation", async () => {
    const found = await warnings("---\ntype: Attested Computation\n---\n\n# Computation\n\n    SELECT 1\n");
    assert.ok(found.some((m) => /`runtime` is required for `type: Attested Computation`/.test(m)));
    const complete = await warnings(
      "---\ntype: Attested Computation\nruntime: bigquery\n---\n\n# Computation\n\n    SELECT 1\n",
    );
    assert.deepEqual(complete, []);
  });

  it("flags a document carrying both superseded and current provenance", async () => {
    const both = await warnings(
      "---\ntype: Note\ntimestamp: '2020-01-01T00:00:00Z'\ngenerated: { by: human:a, at: 2026-06-20T22:53:05Z }\n---\n\nB.\n",
    );
    assert.ok(both.some((m) => /both `timestamp` and `generated`/.test(m)));
    assert.ok(both.some((m) => /repair --only timestamp-to-generated/.test(m)));

    const lists = await warnings(
      "---\ntype: Note\nsources:\n  - { id: a, resource: https://example.com/a }\n---\n\nB.\n\n" +
        "# Citations\n\n[1] [Other](https://example.com/b)\n",
    );
    assert.ok(lists.some((m) => /both a `# Citations` section and frontmatter `sources`/.test(m)));
  });

  it("stays silent about a clean v0.1 document, which is still conformant", async () => {
    const found = await warnings(
      "---\ntype: Note\ntimestamp: '2026-05-28T22:53:05Z'\n---\n\nB.\n\n" +
        "# Citations\n\n[1] [Policy](https://example.com/a)\n",
    );
    assert.deepEqual(found, []);
  });

  it("names the migration when a bundle declaring v0.2 still holds v0.1 documents", async () => {
    const found = await warnings(
      "---\ntype: Note\ntimestamp: '2026-05-28T22:53:05Z'\n---\n\nB.\n\n" +
        "# Citations\n\n[1] [Policy](https://example.com/a)\n",
      { "index.md": '---\nokf_version: "0.2"\n---\n\n# Bundle Index\n' },
    );
    assert.ok(found.some((m) => /v0\.1 `timestamp` rather than `generated`/.test(m)));
    assert.ok(found.some((m) => /v0\.1 `# Citations` list rather than frontmatter `sources`/.test(m)));
    for (const message of found) {
      assert.match(message, /repair --only (timestamp-to-generated|citations-to-sources)/);
    }
  });
});
