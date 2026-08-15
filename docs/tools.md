# MCP surface

Resources: one `text/markdown` resource per document, at `okf://<bundle>/<path>`.

The server declares MCP server-level instructions — a short primer on OKF conventions that clients inject into the agent's context. Authoring guidance is included only when the server runs with `--writable`. The two entry-point tools, `search_concepts` and `get_concept`, declare `anthropic/alwaysLoad` in their `_meta` so deferred-loading clients keep their schemas visible.

## Read tools

| Tool | Purpose |
|---|---|
| `list_bundles` | Configured bundles with concept counts, read-only flags, declared `description`s, and a `loaded` marker for [lazily mounted](colocated-bundles.md#lazy-mounting) bundles |
| `get_bundle_guide` | Each colocated root's [`AGENTS.md` guide](colocated-bundles.md#root-agentsmd-the-bundle-guide) plus every bundle's `description`; registered only while a colocated root is mounted |
| `reload_bundles` | Re-read bundles to pick up external edits; reports added/removed/changed. No-arg form also re-runs config discovery, mounting/unmounting bundles as `okf.config.json` files change (`{ mounted, unmounted, bundles }`); naming a bundle reloads just it |
| `load_remote_bundle` | Index a read-only bundle from a GitHub tree URL or archive, in memory only |
| `load_colocated_remote_bundles` | Mount a [published colocated root](remote-bundles.md#consuming-a-published-colocated-root-by-one-url) by URL, returning the root `AGENTS.md` inline |
| `list_remote_bundles` | Loaded remote bundles with source URLs and `description`s |
| `list_concepts` | Concept metadata, filterable by prefix/type |
| `get_concept` | One full document: frontmatter, body, outgoing links, section headings; pass `section` for a single section |
| `get_sources` | A concept's `sources` entries (spec §5.1) with their credibility signals, which body footnotes cite each one, plus the derived trust tier and staleness; falls back to a v0.1 `# Citations` list, marked `origin: "citations"` |
| `get_citations` | *Deprecated — use `get_sources`.* Numbered `# Citations` entries (the v0.1 §8 form), classified `external` / `concept` / `missing`; duplicate `# Citations` sections are merged |
| `read_document` | Raw markdown of any document, including reserved files; a missing `index.md` is synthesized (`synthesized: true`) |
| `search_concepts` | Keyword query + type/tag/path/link/orphan filters and the v0.2 lifecycle/trust filters (`status`, `minTrust`, `stale`), paginated (default 10/page). Every hit carries its `status` and `trust` tier, and `stale: true` when past `stale_after`. All-keyword hits rank first with a fallback to any-keyword (`termMatching: "any"`); low scorers under a quarter of the top score are dropped into `omitted`; zero hits return `tagHints`; an exact-`resource` filter maps an asset URI to its concept |
| `list_types` | Distinct concept `type` values with usage counts |
| `list_tags` | Distinct tag values with usage counts |
| `suggest_concept_path` | Where a new concept should live, ranked by where same-type/tag concepts already are |
| `graph_summary` | Counts, types, tags, orphans, derived `crossBundleEdges` |
| `get_neighbors` | Bounded expansion around a concept; `crossBundle: true` follows [derived edges](cross-bundle.md) |
| `find_path` | Shortest directed path between concepts; `crossBundle: true` accepts `bundle:concept` IDs |
| `export_graph` | Graph as `json` / `dot` / `mermaid`; `crossBundle: true` exports one namespaced graph |
| `concept_history` | Git commit history for a concept file, newest first, following renames |
| `concept_diff` | Unified git diff of a concept file against a ref; on non-git bundles, returns a `not a git repository` result instead of failing |
| `validate_bundle` | OKF conformance errors + soft warnings; warnings with a safe mechanical fix name their [`repair`](cli.md#repair) fixer id |

## Write tools (only with `--writable`)

| Tool | Purpose |
|---|---|
| `write_concept` | Create/update a concept (stamping `generated: {by, at}` with the server's actor and write time), append a `log.md` entry, regenerate indexes. In a v0.1 bundle a `timestamp` is stamped instead and ordered-list `# Citations` entries are normalized to the v0.1 §8 form |
| `update_concept` | Partial update: shallow frontmatter patch (`null` deletes a key) and/or replace one body section by heading — everything else survives byte-for-byte. `generated` refreshes unless patched or pinned with `keepGenerated` (`keepTimestamp` is a deprecated alias); `actor` credits a different writer |
| `delete_concept` | Delete a concept (optionally refusing while inbound links exist), log, reindex |
| `rename_concept` | Move a concept, rewriting inbound links across the bundle, log, reindex |
| `promote_concept` | Move a concept into another writable bundle, leaving a citation stub at the old path (or `stub: false` to just report dangling inbound links); logs and reindexes both bundles |
| `append_log_entry` | Record a narrative entry in the root `log.md` — or a per-directory one via `directory` — without touching any concept |
| `regenerate_indexes` | Rewrite `index.md` navigation, reporting hand-curated (`generated: false`) indexes it skipped |

Writes are constrained to safe relative `.md` paths inside the bundle; reserved filenames and dot-directories are rejected as concept paths.

Automatic log entries go to the nearest existing directory-level `log.md` above the concept (spec §9 scoped logs), falling back to the bundle root's. The automatic path never creates per-directory logs — start one with `append_log_entry`. A rename crossing scopes is logged in both.
