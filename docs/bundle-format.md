# The bundle (your "OKF brain")

A bundle is a directory tree of Markdown concept documents per OKF v0.2:

```
brain/
├── index.md          # generated navigation (reserved, progressive disclosure)
├── log.md            # generated update history (reserved, newest-first)
├── tables/
│   ├── index.md
│   └── orders.md     # a concept: frontmatter + markdown body
└── playbooks/
    └── freshness.md
```

Every non-reserved `.md` file is a concept; its ID is the file path without `.md` (`tables/orders`).

## Frontmatter

Only `type` is required; `title`, `description`, `resource`, and `tags` are recommended, and unknown keys are preserved. When `title` is omitted, display names derive from the filename per spec §4.1 (`customer-order-history.md` → "Customer Order History"), and hits carry `titleDerived: true`.

On top of that, v0.2 adds three optional families the server reads and writes (spec §5):

| Family | Keys | What it answers |
|---|---|---|
| Provenance | `sources` (each entry: `resource` plus optional `id`, `title`, `author`, `usage_count`, `last_modified`), `usage_window` | Where did this come from, and how much is that source worth? |
| Trust | `generated: {by, at}`, `verified: [{by, at}]` | Who wrote it, and who has confirmed it? |
| Lifecycle | `status` (`draft`/`stable`/`deprecated`), `stale_after` | Is it still current? |

Identities in `by` and `author` follow the actor convention (spec §7): `human:<id>`, `process:<id>`, or `<producer>/<version>`. This matters — `search_concepts`' `minTrust` filter derives a concept's tier from whether any verifier carries the `human:` prefix (§5.3), so an actor written without it silently reads as machine-confirmed. The server stamps `generated` itself using its configured [`actor`](configuration.md), which is `okf-mcp/<version>` unless you set one.

To attribute a specific claim rather than the whole document, use a markdown footnote whose label is a `sources[].id`:

```markdown
The `events_` table is sharded daily as `events_YYYYMMDD`.[^ga4-schema]

[^ga4-schema]: GA4 BigQuery Export schema
```

`validate_bundle` warns when a footnote resolves to no entry. `get_sources` returns the entries with their signals and marks which ones the body actually cites.

An `Attested Computation` concept (spec §10) additionally carries `runtime` (required for the type), `parameters`, `computation`, `executor`, and `attester`, with the sanctioned computation in a `# Computation` body fence. The server represents and validates these; it never executes them.

The bundle-root `index.md` may declare frontmatter of its own (spec §8, §12): an `okf_version` — reported by `list_bundles`/`graph_summary`; `validate_bundle` warns (without failing) on a newer major — and a one-line `description` written for an agent deciding whether to look inside. Root frontmatter survives index regeneration.

## OKF v0.1 bundles

v0.1 bundles keep working, permanently. The spec blesses both fallbacks (§13.1) and the server reads them: `timestamp` stands in for `generated.at`, and a body `# Citations` list stands in for `sources` (`get_sources` marks those entries `origin: "citations"`).

Writes follow the bundle rather than the server. A bundle declaring `okf_version: "0.1"` keeps getting `timestamp` and `# Citations`; one declaring `"0.2"` gets the new families. An undeclared bundle is judged by its own documents, so upgrading this server never half-migrates a bundle behind your back.

To convert one, run [`okf-mcp migrate`](cli.md#migrate). Until you do, `validate_bundle` only warns about documents caught between the two vocabularies — carrying both `timestamp` and `generated`, or both `# Citations` and `sources` — because there a consumer reading one silently ignores the other.

## Links

Relationships are ordinary markdown links, becoming directed graph edges:

- **Document-relative** (`./customers.md`, `../tables/orders.md`) is recommended — it resolves identically in the graph, on GitHub, and in Obsidian.
- **Bundle-absolute** (`/tables/orders.md`) is accepted but discouraged: GitHub resolves a leading `/` from the *repository* root, so these render broken when the bundle is a repo subfolder. The `absolute-links-to-relative` [repair fixer](cli.md#repair) rewrites them.
- Broken links are warnings, never errors.

The path-valued frontmatter fields of spec §6.2 — `sources[].resource`, `computation`, `executor.resource`, `attester.resource` — resolve by the same rules and become the same untyped edges, which is what §5.1 means when it says a `sources` entry pointing at another concept is already a derivation edge in the graph. A `sources[].resource` holding a scope descriptor rather than a path ("all queries in BigQuery project X") is left alone, not reported as broken. Top-level `resource` is deliberately not an in-bundle edge: it names the asset a concept *describes*, not knowledge it derives from.

## Generated indexes

Writes regenerate every `index.md` as a generated artifact, with two exceptions for human curation: an index declaring `generated: false` in frontmatter is hand-curated and never rewritten (spec §8), and the bundle-root index's frontmatter is always carried over (`okf_version` stamped only when absent, with the vocabulary the bundle is actually written in).

## Obsidian

Open the bundle directory as a vault (File → Open folder as vault). Generated `index.md` files double as navigation pages, standard markdown links work as-is, and `.obsidian/` is ignored by the indexer. Obsidian is never required — the format is pure OKF markdown.
