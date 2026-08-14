# The bundle (your "OKF brain")

A bundle is a directory tree of Markdown concept documents per OKF v0.1:

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

Only `type` is required; `title`, `description`, `resource`, `tags`, and `timestamp` are recommended, and unknown keys are preserved. When `title` is omitted, display names derive from the filename per spec §4.1 (`customer-order-history.md` → "Customer Order History"), and hits carry `titleDerived: true`.

The bundle-root `index.md` may declare frontmatter of its own (spec §11): an `okf_version` — reported by `list_bundles`/`graph_summary`; `validate_bundle` warns (without failing) on a newer major — and a one-line `description` written for an agent deciding whether to look inside. Root frontmatter survives index regeneration.

## Links

Relationships are ordinary markdown links, becoming directed graph edges:

- **Document-relative** (`./customers.md`, `../tables/orders.md`) is recommended — it resolves identically in the graph, on GitHub, and in Obsidian.
- **Bundle-absolute** (`/tables/orders.md`) is accepted but discouraged: GitHub resolves a leading `/` from the *repository* root, so these render broken when the bundle is a repo subfolder. The `absolute-links-to-relative` [repair fixer](cli.md#repair) rewrites them.
- Broken links are warnings, never errors.

## Generated indexes

Writes regenerate every `index.md` as a generated artifact, with two exceptions for human curation: an index declaring `generated: false` in frontmatter is hand-curated and never rewritten (spec §6), and the bundle-root index's frontmatter is always carried over (`okf_version` stamped only when absent).

## Obsidian

Open the bundle directory as a vault (File → Open folder as vault). Generated `index.md` files double as navigation pages, standard markdown links work as-is, and `.obsidian/` is ignored by the indexer. Obsidian is never required — the format is pure OKF markdown.
