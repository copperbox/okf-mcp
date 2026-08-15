# Cross-bundle awareness

OKF §5 deliberately has no cross-bundle link syntax, but the server knows every mounted bundle's canonical location and *derives* cross-bundle relationships from spec-clean data — read-only, no new syntax in documents. A derived `kind: "cross-bundle"` edge is recorded when:

- a concept's body link, §6.2 path-valued frontmatter field (`sources[].resource`, `computation`, `executor.resource`, `attester.resource`), or frontmatter `resource` URL points under another mounted bundle's canonical location, or
- an ordinary relative link like `[orders](../acme/tables/orders.md)` — which Obsidian resolves natively in a shared vault — has a first path segment naming a mounted [colocated sibling](colocated-bundles.md) and the remainder resolves to one of its concepts (`.md` optional).

Citations through such links classify as `concept` instead of `missing`, and `validate` warns when a `../` link points into a mounted sibling at a concept it does not have. Links to unmounted folders stay silent — colocation is declared, never inferred from disk.

`promote_concept` emits exactly such links: between colocated siblings the citation stub cites the promoted copy by relative path (the on-disk vault UX is the point of colocation; [`pack`](cli.md#pack) rewrites relative links to canonical URLs at publish time), while the stub's frontmatter `resource` stays a parseable URI. Non-colocated promotions cite the canonical location.

Canonical locations:

- GitHub tree mounts get theirs automatically — the `tree`, `blob`, and `raw.githubusercontent.com` forms all match.
- Local clones and archives have no inherent URL: declare one with `--canonical-url id=<url>` (or `canonicalUrl` on `load_remote_bundle`), e.g. the bundle's published tree URL, so citations resolve even when it is mounted from a local checkout.
- A colocated root published as one repo needs only a root-level `--canonical-url <rootUrl>`; each bundle derives `<rootUrl>/<folder>`.

In the graph tools: `graph_summary` reports `crossBundleEdges`; `get_neighbors` and `find_path` traverse derived edges with `crossBundle: true` (node IDs become `bundle:concept`); `export_graph` with `crossBundle: true` emits one namespaced multi-bundle graph with derived edges rendered dashed in `dot`/`mermaid`.
