---
type: Design Decision
title: Cross-bundle edges are derived, not written
description: Why OKF gets no cross-bundle link syntax and how cross-bundle graph
  edges are derived from spec-clean data instead.
tags:
  - graph
  - links
  - bundles
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:19:53.725Z
sources:
  - id: src-canonical-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/canonical.ts
    title: src/canonical.ts
  - id: src-graph-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/graph.ts
    title: src/graph.ts
---

OKF §6 links resolve within one bundle, and the project deliberately adds **no new cross-bundle link syntax** — that would make bundles unreadable by anything but this server. Instead, cross-bundle graph edges (`kind: "cross-bundle"`) are *derived, read-only* from data that is already spec-clean:

1. A body link, a §6.2 [path-valued frontmatter field](frontmatter-paths-are-graph-links.md) (`sources[].resource`, `computation`, `executor.resource`, `attester.resource`), or a frontmatter `resource` URL that falls under another mounted bundle's canonical URL prefixes (`src/canonical.ts` expands a GitHub tree URL to tree + blob + raw forms; references use the **blob** form).
2. A relative `../sibling/...` link between bundles that declare the same colocated root — and **colocation is declared (`colocatedRoot`), never inferred from disk paths**.

Consequences:

- Such references classify as `concept` rather than `missing`; `validate` warns on a dangling `../` into a mounted sibling — in a body link or in a frontmatter path, which names the offending field — while unmounted folders stay silent.
- A URL that derived a cross-bundle edge is not also emitted as an external node.
- `graph_summary` reports `crossBundleEdges`; `get_neighbors`/`find_path`/`export_graph` accept `crossBundle: true`, namespacing node IDs as `bundle:concept`; derived edges render dashed in dot/mermaid and gold in the HTML view.
- The recommended way to reference across bundles by hand is a `sources` entry with the other bundle's canonical URL (a `# Citations` entry in a v0.1 bundle), or a `references/` stub concept when a real edge matters; `promote_concept` leaves exactly such a stub behind when moving a concept between bundles, in whichever vocabulary the source bundle uses.
- Limitation: GitHub refs containing `/` are unsupported in canonical URLs.
