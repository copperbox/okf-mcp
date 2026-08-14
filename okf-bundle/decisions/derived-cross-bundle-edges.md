---
type: Design Decision
title: Cross-bundle edges are derived, not written
description: Why OKF gets no cross-bundle link syntax and how cross-bundle graph
  edges are derived from spec-clean data instead.
tags:
  - graph
  - links
  - bundles
timestamp: 2026-08-14T01:19:53.725Z
---

OKF §5 links resolve within one bundle, and the project deliberately adds **no new cross-bundle link syntax** — that would make bundles unreadable by anything but this server. Instead, cross-bundle graph edges (`kind: "cross-bundle"`) are *derived, read-only* from data that is already spec-clean:

1. A §8 citation target, external link, or frontmatter `resource` URL that falls under another mounted bundle's canonical URL prefixes (`src/canonical.ts` expands a GitHub tree URL to tree + blob + raw forms; citations use the **blob** form).
2. A relative `../sibling/...` link between bundles that declare the same colocated root — and **colocation is declared (`colocatedRoot`), never inferred from disk paths**.

Consequences:

- Such citations classify as `concept` rather than `missing`; `validate` warns on a dangling `../` into a mounted sibling; unmounted folders stay silent.
- A URL that derived a cross-bundle edge is not also emitted as an external node.
- `graph_summary` reports `crossBundleEdges`; `get_neighbors`/`find_path`/`export_graph` accept `crossBundle: true`, namespacing node IDs as `bundle:concept`; derived edges render dashed in dot/mermaid and gold in the HTML view.
- The recommended way to reference across bundles by hand is a `# Citations` entry with the other bundle's canonical URL, or a `references/` stub concept when a real edge matters; `promote_concept` leaves exactly such a citation stub behind when moving a concept between bundles.
- Limitation: GitHub refs containing `/` are unsupported in canonical URLs.

# Citations

[1] [src/canonical.ts](https://github.com/copperbox/okf-mcp/blob/main/src/canonical.ts)
[2] [src/graph.ts](https://github.com/copperbox/okf-mcp/blob/main/src/graph.ts)
