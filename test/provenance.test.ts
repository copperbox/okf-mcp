import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBundle } from "../src/bundle.js";
import { extractFrontmatterLinks, parseConceptDocument } from "../src/parser.js";
import {
  actorKind,
  conceptSources,
  conceptStatus,
  defaultActor,
  footnoteLabels,
  generatedAt,
  generatedBy,
  isAttestedComputation,
  isStale,
  lastVerifiedAt,
  slugifySourceId,
  trustTier,
  usageWindowFor,
  verifications,
} from "../src/provenance.js";
import type { Concept, ConceptFrontmatter } from "../src/types.js";

/** A concept built through the parser, so normalization matches production. */
function concept(source: string, path = "notes/x.md"): Concept {
  const bundle = buildBundle("t", "/t", [{ path, source }]);
  const found = bundle.concepts.get(path.replace(/\.md$/, ""));
  assert.ok(found, `document did not parse into a concept: ${path}`);
  return found;
}

function frontmatter(source: string): ConceptFrontmatter {
  return concept(source).frontmatter;
}

describe("actor convention (spec §7)", () => {
  it("classifies the three sanctioned forms", () => {
    assert.equal(actorKind("human:ahormati"), "human");
    assert.equal(actorKind("process:finance-nightly"), "process");
    assert.equal(actorKind("reference_agent/gemini-2.5-pro"), "agent");
    assert.equal(actorKind("okf-mcp/1.3.0"), "agent");
  });

  it("rejects forms that would misclassify a trust tier", () => {
    // A bare name is the dangerous case: it is not `human:`, so a consumer
    // deriving tiers (§5.3) silently reads a person as machine-confirmed.
    assert.equal(actorKind("ahormati"), undefined);
    assert.equal(actorKind("human:"), undefined);
    assert.equal(actorKind("process:"), undefined);
    assert.equal(actorKind("a/b/c"), undefined);
    assert.equal(actorKind(""), undefined);
    assert.equal(actorKind(42), undefined);
  });

  it("builds this server's actor in the <producer>/<version> form", () => {
    assert.equal(defaultActor("1.3.0"), "okf-mcp/1.3.0");
    assert.equal(actorKind(defaultActor("1.3.0")), "agent");
  });
});

describe("verified normalization (spec §5.2, a §11 consumer MUST)", () => {
  it("reads a bare mapping as a one-element list", () => {
    const fm = frontmatter(
      "---\ntype: Note\nverified: { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n---\n\nBody.\n",
    );
    assert.equal(Array.isArray(fm.verified), true);
    assert.equal(fm.verified?.length, 1);
    assert.equal(fm.verified?.[0]?.by, "human:ahormati");
  });

  it("leaves a written list alone", () => {
    const fm = frontmatter(
      "---\ntype: Note\nverified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n---\n\nBody.\n",
    );
    assert.equal(fm.verified?.length, 2);
    assert.deepEqual(verifications(fm).map((v) => v.by), [
      "human:a",
      "process:nightly",
    ]);
  });

  it("reports the latest verification time across entries", () => {
    const fm = frontmatter(
      "---\ntype: Note\nverified:\n  - { by: human:a, at: 2026-06-25T09:00:00Z }\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n---\n\nBody.\n",
    );
    assert.equal(lastVerifiedAt(fm), "2026-06-26T02:00:00Z");
  });
});

describe("trust tiers (spec §5.3)", () => {
  const tier = (verified: string) =>
    trustTier(frontmatter(`---\ntype: Note\n${verified}---\n\nBody.\n`));

  it("is unverified with no verified key", () => {
    assert.equal(tier(""), "unverified");
  });

  it("is machine-confirmed for non-human verifiers only", () => {
    assert.equal(
      tier("verified: { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }\n"),
      "machine-confirmed",
    );
    assert.equal(
      tier("verified: { by: reference_agent/gemini-2.5-pro, at: 2026-06-26T02:00:00Z }\n"),
      "machine-confirmed",
    );
  });

  it("is human-reviewed when any verifier carries the human: prefix", () => {
    assert.equal(
      tier(
        "verified:\n  - { by: process:nightly, at: 2026-06-26T02:00:00Z }\n  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }\n",
      ),
      "human-reviewed",
    );
  });
});

describe("lifecycle (spec §5.4, §5.5)", () => {
  it("defaults an absent or unknown status to stable", () => {
    assert.equal(conceptStatus(frontmatter("---\ntype: Note\n---\n\nB.\n")), "stable");
    assert.equal(
      conceptStatus(frontmatter("---\ntype: Note\nstatus: retired\n---\n\nB.\n")),
      "stable",
    );
    assert.equal(
      conceptStatus(frontmatter("---\ntype: Note\nstatus: draft\n---\n\nB.\n")),
      "draft",
    );
  });

  it("is stale on and after stale_after, never without it", () => {
    const fm = frontmatter("---\ntype: Note\nstale_after: 2026-06-15\n---\n\nB.\n");
    assert.equal(isStale(fm, "2026-06-14"), false);
    assert.equal(isStale(fm, "2026-06-15"), true, "stale on the day itself");
    assert.equal(isStale(fm, "2026-12-31"), true);
    assert.equal(isStale(frontmatter("---\ntype: Note\n---\n\nB.\n"), "2099-01-01"), false);
  });
});

describe("generated, with the v0.1 fallback (spec §5.2, §13.1)", () => {
  it("reads generated.at and generated.by", () => {
    const fm = frontmatter(
      "---\ntype: Note\ngenerated: { by: human:a, at: 2026-06-20T22:53:05Z }\n---\n\nB.\n",
    );
    assert.equal(generatedAt(fm), "2026-06-20T22:53:05Z");
    assert.equal(generatedBy(fm), "human:a");
  });

  it("falls back to a v0.1 timestamp when generated is absent", () => {
    const fm = frontmatter("---\ntype: Note\ntimestamp: '2026-05-28T22:53:05Z'\n---\n\nB.\n");
    assert.equal(generatedAt(fm), "2026-05-28T22:53:05Z");
    assert.equal(generatedBy(fm), undefined, "v0.1 records no producer");
  });

  it("prefers generated over a stale timestamp on a half-migrated document", () => {
    const fm = frontmatter(
      "---\ntype: Note\ntimestamp: '2020-01-01T00:00:00Z'\ngenerated: { by: human:a, at: 2026-06-20T22:53:05Z }\n---\n\nB.\n",
    );
    assert.equal(generatedAt(fm), "2026-06-20T22:53:05Z");
  });
});

describe("conceptSources, with the # Citations fallback (spec §5.1, §13.1)", () => {
  it("returns declared frontmatter sources", () => {
    const result = conceptSources(
      concept(
        "---\ntype: Note\nsources:\n  - id: ga4-schema\n    resource: https://example.com/schema\n    title: GA4 schema\n---\n\nB.\n",
      ),
    );
    assert.equal(result.origin, "frontmatter");
    assert.equal(result.sources[0]?.id, "ga4-schema");
  });

  it("synthesizes entries with slugged ids from a v0.1 Citations list", () => {
    const result = conceptSources(
      concept(
        "---\ntype: Note\n---\n\nB.\n\n# Citations\n\n[1] [GA4 Export schema](https://example.com/a)\n[2] [Runbook](https://example.com/b)\n",
      ),
    );
    assert.equal(result.origin, "citations");
    assert.deepEqual(result.sources, [
      { id: "ga4-export-schema", resource: "https://example.com/a", title: "GA4 Export schema" },
      { id: "runbook", resource: "https://example.com/b", title: "Runbook" },
    ]);
  });

  it("dedupes synthesized ids so two same-titled citations stay distinguishable", () => {
    const result = conceptSources(
      concept(
        "---\ntype: Note\n---\n\nB.\n\n# Citations\n\n[1] [Runbook](https://example.com/a)\n[2] [Runbook](https://example.com/b)\n",
      ),
    );
    assert.deepEqual(result.sources.map((s) => s.id), ["runbook", "runbook-2"]);
  });

  it("reports none when the document records no provenance either way", () => {
    const result = conceptSources(concept("---\ntype: Note\n---\n\nB.\n"));
    assert.equal(result.origin, "none");
    assert.deepEqual(result.sources, []);
  });

  it("lets frontmatter win outright over a legacy section", () => {
    // Merging two provenance lists is a judgement call; the validator warns
    // about the mixed state rather than this silently reconciling it.
    const result = conceptSources(
      concept(
        "---\ntype: Note\nsources:\n  - { id: a, resource: https://example.com/a }\n---\n\nB.\n\n# Citations\n\n[1] [Other](https://example.com/b)\n",
      ),
    );
    assert.equal(result.origin, "frontmatter");
    assert.deepEqual(result.sources.map((s) => s.resource), ["https://example.com/a"]);
  });
});

describe("slugifySourceId", () => {
  it("slugs a title, caps the length, and strips a URL scheme", () => {
    assert.equal(slugifySourceId("GA4 BigQuery Export schema"), "ga4-bigquery-export-schema");
    assert.equal(
      slugifySourceId("https://wiki.acme/finance/fpa-handbook"),
      "wiki-acme-finance-fpa-handbook",
    );
    assert.equal(slugifySourceId("!!!"), "source");
  });
});

describe("footnoteLabels (spec §5.1 per-claim attribution)", () => {
  it("separates definitions from inline references", () => {
    const { defined, referenced } = footnoteLabels(
      "Sharded daily.[^ga4-schema] Also true.[^runbook]\n\n[^ga4-schema]: GA4 schema\n",
    );
    assert.deepEqual([...referenced].sort(), ["ga4-schema", "runbook"]);
    assert.deepEqual([...defined], ["ga4-schema"]);
  });
});

describe("usage windows (spec §5.1)", () => {
  it("prefers an entry's own window over the shared one", () => {
    const fm = frontmatter(
      "---\ntype: Note\nusage_window: { from: 2026-06-01, to: 2026-06-30 }\nsources:\n" +
        "  - { id: a, resource: https://example.com/a }\n" +
        "  - { id: b, resource: https://example.com/b, usage_window: { from: 2026-01-01, to: 2026-01-31 } }\n---\n\nB.\n",
    );
    const [shared, own] = fm.sources!;
    assert.equal(usageWindowFor(fm, shared!)?.from, "2026-06-01");
    assert.equal(usageWindowFor(fm, own!)?.from, "2026-01-01");
  });
});

describe("attested computations (spec §10)", () => {
  it("recognizes the type case-insensitively", () => {
    assert.equal(
      isAttestedComputation(frontmatter("---\ntype: Attested Computation\n---\n\nB.\n")),
      true,
    );
    assert.equal(
      isAttestedComputation(frontmatter("---\ntype: attested computation\n---\n\nB.\n")),
      true,
    );
    assert.equal(isAttestedComputation(frontmatter("---\ntype: Metric\n---\n\nB.\n")), false);
  });
});

describe("extractFrontmatterLinks (spec §6.2 path-valued fields)", () => {
  const links = (source: string) =>
    parseConceptDocument(source, "computations/revenue.md").frontmatterLinks;

  it("extracts every §6.2 field, labelled by where it came from", () => {
    const result = links(
      "---\ntype: Attested Computation\nruntime: bigquery\n" +
        "computation: lib/revenue.sql\n" +
        "executor: { resource: ../references/run-on-bq.md }\n" +
        "attester: { resource: ../references/sql-equality.py }\n" +
        "sources:\n  - { id: policy, resource: ../policies/revenue.md }\n---\n\nB.\n",
    );
    assert.deepEqual(
      result.map((l) => l.field).sort(),
      ["attester.resource", "computation", "executor.resource", "sources[0].resource"],
    );
    const source = result.find((l) => l.field === "sources[0].resource");
    assert.equal(source?.kind, "concept");
    assert.equal(source?.path, "policies/revenue.md");
  });

  it("skips a scope descriptor, which is a legitimate sources[].resource", () => {
    // §5.1 allows "all queries in BigQuery project X" — not a path, and it
    // must not surface as a broken link.
    const result = links(
      "---\ntype: Note\nsources:\n  - { resource: all queries in BigQuery project X }\n---\n\nB.\n",
    );
    assert.deepEqual(result, []);
  });

  it("excludes top-level resource, which names the described asset", () => {
    const result = links(
      "---\ntype: Note\nresource: ../tables/orders.md\n---\n\nB.\n",
    );
    assert.deepEqual(result, []);
  });

  it("classifies an absolute URL as external", () => {
    const result = links(
      "---\ntype: Note\nsources:\n  - { resource: https://example.com/policy }\n---\n\nB.\n",
    );
    assert.equal(result[0]?.kind, "external");
  });
});

describe("frontmatter links resolve like body links", () => {
  it("resolves a sources entry to a concept and warns when it dangles", () => {
    const bundle = buildBundle("t", "/t", [
      {
        path: "metrics/revenue.md",
        source:
          "---\ntype: Metric\nsources:\n" +
          "  - { id: comp, resource: ../computations/revenue.md }\n" +
          "  - { id: gone, resource: ../computations/missing.md }\n---\n\nB.\n",
      },
      { path: "computations/revenue.md", source: "---\ntype: Attested Computation\nruntime: bigquery\n---\n\nB.\n" },
    ]);
    const metric = bundle.concepts.get("metrics/revenue")!;
    const [resolved, dangling] = metric.frontmatterLinks;
    assert.equal(resolved?.resolvedId, "computations/revenue");
    assert.equal(dangling?.broken, true);
    assert.ok(
      bundle.problems.some(
        (p) =>
          p.severity === "warning" &&
          /missing concept/.test(p.message) &&
          /sources\[1\]\.resource/.test(p.message),
      ),
      "a dangling frontmatter path should name the field it came from",
    );
  });

  it("does not warn on an attester pointing at a non-markdown file", () => {
    const bundle = buildBundle("t", "/t", [
      {
        path: "computations/revenue.md",
        source:
          "---\ntype: Attested Computation\nruntime: bigquery\nattester: { resource: ../references/sql-equality.py }\n---\n\nB.\n",
      },
    ]);
    assert.deepEqual(bundle.problems, []);
  });
});
