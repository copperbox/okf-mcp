# Colocated bundles (vault as monorepo)

A common layout keeps several bundles as sibling subdirectories of one root — for example a repo opened as a single Obsidian vault:

```
knowledge/          ← repo root, opened as an Obsidian vault
├── AGENTS.md       ← belongs to no bundle
├── acme/           ← bundle "acme"
└── ops/            ← bundle "ops"
```

Mount them all with one flag:

```bash
okf-mcp --colocated-bundles /path/to/knowledge
```

Every **immediate subdirectory** containing at least one markdown file (at any depth) mounts as its own bundle, folder name as bundle id. Dot directories are skipped; loose root files belong to no bundle; an id colliding with another mount is a startup error naming the root. Folders with no markdown (assets, templates, a freshly created bundle-to-be) are not mounted — the CLI notes them on stderr so a missing bundle is explained: add a `.md` file to a folder to mount it. The flag is repeatable and combines with `--bundle` / `--remote-bundle`.

Beyond saving flags, `--colocated-bundles` *declares* the sibling layout (`colocatedRoot`) — colocation is never inferred from disk paths. Relative `../sibling/...` links between colocated bundles derive [cross-bundle edges](cross-bundle.md), resolve citations, are checked by `validate`, and are rewritten to canonical URLs by [`pack`](cli.md#pack).

## Scoped mounting with `--only`

```bash
okf-mcp --colocated-bundles /path/to/knowledge --only acme,ops
```

Only the named subfolders mount; everything else is not even discovered, keeping startup light and search vocabularies undiluted. A name that doesn't exist (or has no markdown) is a startup error, not a silent skip; `--only` without `--colocated-bundles` is an error too.

## Canonical URLs for a published root

When the root is published as one repo, one flag declares every bundle's canonical URL:

```bash
okf-mcp --colocated-bundles /path/to/knowledge \
        --canonical-url https://github.com/acme/knowledge/tree/main
```

Each bundle derives `canonicalUrl = <rootUrl>/<folder>`, with the usual tree/blob/raw prefix expansion. A bare URL works with exactly one colocated root; with several, name the root (`--canonical-url /path/to/knowledge=<url>`). Explicit per-bundle `--canonical-url id=<url>` overrides. Consumers can mount the whole published root by one URL with [`--colocated-remote-bundles`](remote-bundles.md#consuming-a-published-colocated-root-by-one-url).

## Lazy mounting

The MCP server (`mcp`, the default command) mounts colocated bundles **lazily**: startup costs only discovery (folder name + a frontmatter-only read of the root `index.md` for its `description`); a bundle is parsed the first time any tool names it. The semantics are chosen so nothing is silently truncated:

- `list_bundles` lists every bundle with a `loaded` marker, unloaded ones with name and description.
- No-arg sweeps (`search_concepts`, `graph_summary`, `validate_bundle`, …) cover **loaded** bundles only, and the result carries a note naming the excluded discovered bundles.
- `resources/list` represents an unloaded bundle by its root `index.md` alone; reading it loads the bundle.
- Cross-bundle derivation sees loaded siblings only; edges into an unloaded bundle appear when it loads.
- No-arg `reload_bundles` covers loaded bundles; naming an unloaded one loads it. `--watch` starts watching a lazy bundle the moment it hydrates.
- `--only` composes: filtered-out subfolders are not discovered at all.

One-shot CLI commands sweep everything by design, so they load eagerly. Remote mounts are always eager.

## Root `AGENTS.md`: the bundle guide

If the colocated root holds an `AGENTS.md` (exact name), its content is appended to the MCP server instructions under a `Bundle guide (from AGENTS.md):` delimiter, so every session starts knowing which bundles matter for what work. Write it as a short registry: a line or two per bundle — what it covers, when to reach for it. It doubles as a readable vault-root note in Obsidian.

The guide loads into the agent's context every session, so it is budgeted: past 4 000 characters the server warns and injects a truncated guide pointing at the `get_bundle_guide` tool, which returns each root's guide in full plus every bundle's one-line `description`. The tool is registered whenever a colocated root (local or remote) is mounted — including mid-session via `tools/list_changed`.
