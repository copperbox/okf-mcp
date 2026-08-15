---
type: Design Decision
title: Path-valued frontmatter fields are graph links
description: Why the OKF v0.2 §6.2 frontmatter paths resolve into real graph
  edges, and why top-level `resource` is deliberately left out.
tags:
  - graph
  - links
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-15T21:00:00.000Z
sources:
  - id: src-parser-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/parser.ts
    title: src/parser.ts
  - id: src-graph-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/graph.ts
    title: src/graph.ts
---

Under OKF v0.1 every link a concept asserted lived in the body, so a graph built from body links was complete. v0.2 breaks that: moving provenance from `# Citations` into frontmatter `sources` moves real references out of the body. A graph that only read body links would have watched bundles *lose* edges as they migrated — silently, since nothing would report the loss.

The spec is explicit that this is not what it means. §5.1 says lineage is expressed through links rather than a dedicated field, "the derivation edge already exists in the bundle graph," and §6.2 names the path-valued fields: `sources[].resource`, `computation`, `executor.resource`, `attester.resource`.

So the parser extracts those into `Concept.frontmatterLinks`, and the loader resolves them in the *same* pass as body links, by the same rules — `resolvedId` when they hit a concept, `broken` (a warning, never an error) when they plausibly do not. `buildGraph` and the cross-bundle derivation then treat both lists identically.

Kept as a separate list rather than merged into `links` because a `ConceptLink` carries body offsets for in-place splicing, which a frontmatter path has no meaningful equivalent of — and because callers usually want to know which field a path came from. Broken-link warnings name the field for that reason.

**Top-level `resource` is deliberately excluded** from in-bundle edges. It names the asset a concept *describes*, not knowledge it derives from; a concept whose `resource` points at another concept means "this documents that document", which is not a knowledge edge. It still contributes URLs to [derived cross-bundle edges](derived-cross-bundle-edges.md), which is the behavior it has always had.

Two smaller consequences. A `sources[].resource` may legitimately hold a *scope descriptor* rather than a path ("all queries in BigQuery project X"), so whitespace-bearing values produce no link and — more importantly — no broken-link warning. And parallel edges are kept: a concept that both links a target in prose and lists it in `sources` gets two edges, consistent with two body links to one target already counting twice. An edge is one link instance, not one relationship.

[^src-parser-ts]: src/parser.ts
[^src-graph-ts]: src/graph.ts
