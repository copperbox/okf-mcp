# okf-mcp

An MCP server that gives AI agents a standardized [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) backend: a knowledge base of plain Markdown files with YAML frontmatter, indexed into a link graph and exposed through MCP resources and tools for search, traversal, validation, and authoring.

The knowledge base itself is just a directory of Markdown ("a bundle"). Humans can browse and edit it with any editor — including opening it directly as an **Obsidian vault** — while agents work through the MCP server. Obsidian is never required: the format is pure OKF v0.1 Markdown, and any `.obsidian/` directory is ignored by the indexer.

- No database, no embeddings; the only network calls are for optional read-only remote bundles you explicitly configure.
- Permissive by design (spec §9): malformed documents are reported, valid concepts keep serving.
- The write path keeps `index.md` navigation pages and the `log.md` history up to date, so the human view stays browsable as agents write.

## Quick start

```bash
npm install
npm test
npm run dev -- --bundle acme=examples/acme inspect
```

Start the stdio MCP server (the default command):

```bash
npm run dev -- --bundle acme=examples/acme            # read-only
npm run dev -- --bundle acme=examples/acme --writable # + authoring tools
```

Or build and run the compiled binary:

```bash
npm run build
node dist/cli.js --bundle /path/to/your/bundle
```

## MCP client configuration

The package is published to npm, so the easiest setup runs it through `npx`:

```json
{
  "mcpServers": {
    "okf": {
      "command": "npx",
      "args": [
        "-y", "@copperbox/okf-mcp",
        "--bundle", "brain=/absolute/path/to/your/bundle",
        "--writable"
      ]
    }
  }
}
```

Alternatively, point at a local checkout you built yourself (`npm run build`):

```json
{
  "mcpServers": {
    "okf": {
      "command": "node",
      "args": [
        "/absolute/path/to/okf-mcp/dist/cli.js",
        "--bundle", "brain=/absolute/path/to/your/bundle",
        "--writable"
      ]
    }
  }
}
```

`--bundle` accepts `path` or `id=path` and is repeatable. Omit `--writable` for a read-only server.

## Teaching your agent to maintain the brain

The server is deliberately not opinionated about *when* knowledge gets captured: its built-in instructions teach connected agents the OKF conventions and the write flow (`suggest_concept_path` → `write_concept`), but nothing tells an agent to record what it learns as a side effect of ordinary work. Capture policy belongs in your agent's own configuration — `CLAUDE.md`, `AGENTS.md`, or the system prompt, whichever your client reads.

The server also performs no git sync. If the bundle is shared — mounted from a local clone of a team repository — it is only as fresh as the clone's last `git pull`, and concepts written through `write_concept` reach teammates only after an out-of-band commit and push. Keeping a shared bundle in sync is your (or your agent's) responsibility, so it belongs in the same standing instructions.

If you want the ambient "brain grows while you work" behavior, a standing instruction like this is enough to get started — copy it into your agent config and adjust to taste:

```markdown
## Knowledge capture (OKF brain)

This project keeps a persistent knowledge base (the "brain") behind the `okf` MCP server.

- Before starting non-trivial work, check the brain: orient with `graph_summary`, then
  `search_concepts` for anything related to the task, and treat what you find as prior
  context.
- When you learn something durable — a decision and its rationale, a gotcha, how a
  system actually works, a convention worth keeping — record it before finishing:
  call `suggest_concept_path` to pick a placement, then `write_concept`. Prefer
  updating an existing concept over creating a near-duplicate.
- Keep concepts small and linked: one idea per concept, bundle-absolute markdown
  links (`/tables/orders.md`) to related concepts, and reuse existing types and tags.
- Don't record ephemera (task status, one-off debugging detail) — the brain is for
  knowledge that should still be true next month.
- If the brain is shared (a clone of a team repo), the server never syncs git for you.
  Before relying on it, make sure the clone is current — run `git pull` in the bundle
  repo, then call `reload_bundles` so the index picks up the changes. For
  `--remote-bundle` mounts, calling `reload_bundles` refetches.
- After writing durable knowledge to a shared brain, commit and push it if you're
  authorized to, or remind the user to — until then the new knowledge is invisible
  to teammates.
```

This works from a standing start: point `--bundle` at an empty directory with `--writable` and the first `write_concept` creates the folder structure, navigation indexes, and log.

## Multi-bundle setups (org brain + project brain)

`--bundle` and `--remote-bundle` are repeatable, so one server can mount a shared org-wide brain next to the project's own bundle. Mount the org brain from a local clone when agents should write to it:

```json
{
  "mcpServers": {
    "okf": {
      "command": "npx",
      "args": [
        "-y", "@copperbox/okf-mcp",
        "--bundle", "org=/absolute/path/to/org-brain-clone",
        "--bundle", "project=/absolute/path/to/this-repo/brain",
        "--writable"
      ]
    }
  }
}
```

If consuming the org brain is enough, swap its mount for a read-only GitHub tree — no clone to keep fresh, and `reload_bundles` refetches it: `"--remote-bundle", "org=https://github.com/your-org/brain/tree/main/bundle"`. Note that `--writable` is server-wide — every local `--bundle` it mounts becomes writable — so `--remote-bundle` is also the way to keep the org brain read-only for agents while the project bundle stays writable.

Two routing behaviors make this workable:

- Aggregate read tools — `search_concepts`, `list_concepts`, `list_types`, `list_tags`, `graph_summary`, `validate_bundle` — cover **all** bundles when the `bundle` parameter is omitted, so one search spans both brains.
- Per-concept and write tools (`get_concept`, `get_neighbors`, `write_concept`, …) require an explicit `bundle` once more than one is mounted, so a write always names its destination.

Split knowledge by scope: standards, environment architecture, and cross-repo system maps belong in the org bundle; decisions and gotchas specific to one repo belong in that repo's project bundle. Cross-bundle markdown links are not part of OKF (§5 links resolve within a single bundle, so a link into another bundle just indexes as broken) — to reference an org concept from a project concept, cite it in a `# Citations` section (spec §8) using the org bundle's canonical URL; when a real graph edge matters, add a small stub concept under `references/` in the project bundle that mirrors the org concept, link to the stub, and let the stub's citation point at the source. When project knowledge turns out to be org-wide, `promote_concept` moves it into the org bundle and leaves exactly such a citation stub behind at the old path, so the project bundle's inbound links keep resolving.

Append routing guidance to the CLAUDE.md snippet above:

```markdown
- Two brains are mounted: `org` (cross-project standards, environment architecture,
  system maps) and `project` (this repo's decisions, gotchas, conventions). Before
  starting work, search both — omit the `bundle` parameter so `search_concepts` and
  `graph_summary` cover all bundles, or query each in turn.
- Route writes by scope: knowledge specific to this repo goes to the `project`
  bundle. Knowledge that holds across projects — standards, shared infrastructure,
  org-wide architecture — goes to the `org` bundle; if the org brain is mounted
  read-only, record it in the project bundle and flag it for promotion.
- Never write markdown links from one bundle into another — they index as broken.
  Reference org concepts from project concepts via a `# Citations` entry using the
  org bundle's canonical URL, or through a `references/` stub concept when a graph
  edge is needed.
```

### Colocated bundles (vault as monorepo)

A common layout keeps several bundles as sibling subdirectories of one root — for example a repo opened as a single Obsidian vault:

```
knowledge/          ← repo root, opened as an Obsidian vault
├── AGENTS.md       ← belongs to no bundle
├── acme/           ← bundle "acme"
└── ops/            ← bundle "ops"
```

Instead of repeating `--bundle` for each subdirectory, mount them all with one flag:

```bash
okf-mcp --colocated-bundles /path/to/knowledge
```

Every **immediate subdirectory** of the root that contains at least one markdown file is mounted as its own bundle, with the folder name as its bundle id (the same default-id rule `--bundle <path>` uses). Dot directories (`.obsidian`, `.git`) are skipped, and loose files at the root (`README.md`, `AGENTS.md`) belong to no bundle. The flag is repeatable and combines with `--bundle` / `--remote-bundle`; a discovered id colliding with another mount is a startup error naming the colocated root. Beyond saving flags, `--colocated-bundles` *declares* the sibling layout (`colocatedRoot` on each discovered bundle's config), so features that reason about colocated siblings can tell them apart from independently mounted bundles. Relative `../sibling/...` links between colocated bundles derive [cross-bundle graph edges](#cross-bundle-awareness), resolve citations, are checked by `validate`, and are rewritten to the sibling's canonical URL by [`pack`](#cli).

When the root holds many bundles but the current project only needs a few, `--only <folder,folder,...>` is the escape hatch for scoped mounting:

```bash
okf-mcp --colocated-bundles /path/to/knowledge --only acme,ops
```

Only the named subfolders are mounted; everything else in the root is ignored entirely — not discovered, not listed — which keeps startup light and stops irrelevant bundles from diluting search results, type/tag vocabularies, and `graph_summary` sweeps. A name that doesn't exist as a subdirectory of the root (or exists but contains no markdown) is a startup error rather than a silent skip, and passing `--only` without `--colocated-bundles` is an error too.

When the root is published as one repo, every bundle's canonical URL is mechanical — the repo's tree URL plus the folder name — so one flag declares them all for [cross-bundle awareness](#cross-bundle-awareness):

```bash
okf-mcp --colocated-bundles /path/to/knowledge \
        --canonical-url https://github.com/acme/knowledge/tree/main
```

Each colocated bundle derives `canonicalUrl = <rootUrl>/<folder>` (here `…/tree/main/acme`, `…/tree/main/ops`), and the derived URLs get the same tree/blob/raw prefix expansion as explicitly declared ones. A bare URL works when exactly one colocated root is configured; with several, name the root: `--canonical-url /path/to/knowledge=<url>`. An explicit per-bundle `--canonical-url id=<url>` still overrides the derived value. Non-GitHub root URLs work too — the folder name is appended to the literal prefix. Consumers can still mount an individual bundle straight from its subdirectory tree URL (`--remote-bundle acme=https://github.com/acme/knowledge/tree/main/acme`) — or mount the whole published root by one URL with [`--colocated-remote-bundles`](#consuming-a-published-colocated-root-by-one-url).

#### Lazy mounting: discover all, load on first access

A colocated root may hold many bundles a given project never touches, so the MCP server (`mcp`, the default command) mounts colocated bundles **lazily**: at startup each subdirectory costs only its discovery — the folder name plus a frontmatter-only read of its root `index.md` for the `description` — and a bundle is parsed and indexed the first time any tool names it (`bundle` argument, `okf://` resource read, `reload_bundles <id>`, …). The semantics, chosen so nothing is silently truncated:

- `list_bundles` lists every bundle with a `loaded` marker; unloaded ones carry their name and description so an agent can see what exists and choose what to hydrate.
- No-arg sweeps (`search_concepts`, `list_concepts`, `list_types`, `list_tags`, `graph_summary`, `validate_bundle`) cover **loaded** bundles only, and the tool result carries a note naming the discovered bundles that were excluded — irrelevant bundles stop polluting results, without the truncation reading as complete coverage.
- `resources/list` represents an unloaded bundle by its root `index.md` alone (with the discovered description); reading it loads the bundle, after which its documents list individually.
- [Cross-bundle derivation](#cross-bundle-awareness) sees loaded siblings only: a `../sibling/...` link into an unloaded bundle derives no edge and its citation classifies `missing` until the sibling loads (any access to it makes the edges appear); `validate`'s dangling-link warnings likewise stay silent for unloaded siblings.
- No-arg `reload_bundles` reloads loaded bundles only (an unloaded bundle has no stale index); naming an unloaded bundle loads it. `--watch` watches loaded bundles and starts watching a lazy bundle the moment it hydrates.
- `--only` composes: filtered-out subfolders are not even discovered.

One-shot CLI commands (`inspect`, `validate`, `search`, …) sweep every bundle by design, so they load colocated bundles eagerly as before. Remote mounts are always eager — a remote root is one fetch, and its folder names are unknown until fetched.

#### Root `AGENTS.md`: the bundle guide

If the colocated root holds an `AGENTS.md` (exact name), its content is appended to the MCP server instructions under a `Bundle guide (from AGENTS.md):` delimiter, so every session starts knowing which bundles exist and which matter for what kind of work — and passes explicit `bundle` arguments instead of sweeping everything. Write it as a short registry for an agent deciding where to look: a line or two per bundle, what it covers, when to reach for it. It doubles as a readable vault-root note in Obsidian and travels with the repo.

Instructions load into the agent's context every session, so the guide is budgeted: past 4 000 characters the server logs a warning and injects a truncated guide with a pointer at `get_bundle_guide` (and the full file). Keep it lean.

The guide is also available on demand through the `get_bundle_guide` tool, which is registered whenever a colocated root (local or remote) is mounted — including mid-session, via `tools/list_changed`, when `load_colocated_remote_bundles` mounts the first one. It returns each root's `AGENTS.md` in full (local roots are read from disk per call, so external edits show up; remote roots return the guide fetched with the mount) plus every bundle's one-line `description`, for one root (`root` argument: the local path or remote URL) or all mounted roots when omitted. The base instructions tell agents to call it before exploring, so the guide stays reachable at any point in a session — not just at the initialize handshake.

## Remote bundles (knowledge exchange)

OKF's third goal is exchanging knowledge across systems. You can index a bundle published in another repository without cloning it, straight from a public GitHub tree:

```bash
npm run dev -- \
  --remote-bundle okf=https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf \
  inspect
```

`--remote-bundle id=url` is repeatable and takes a `https://github.com/<owner>/<repo>/tree/<ref>/<path>` URL (refs containing `/` are not supported), or a `.tar.gz` / `.tgz` / `.zip` archive detected by extension — any http(s) URL, or a local archive path. The same thing is available at runtime through the `load_remote_bundle` tool (`{ id, url, include?, exclude?, canonicalUrl? }`, glob filters over bundle-relative paths), which mutates only the in-memory index; `list_remote_bundles` lists what is loaded, with the tree or archive URL as the source.

### Consuming a published colocated root by one URL

A [colocated root](#colocated-bundles-vault-as-monorepo) published as a single repo can be mounted whole — each subfolder becoming its own read-only bundle — instead of repeating `--remote-bundle` per subdirectory tree URL:

```bash
okf-mcp --colocated-remote-bundles https://github.com/acme/knowledge/tree/main inspect
```

The same discovery rules as local `--colocated-bundles` apply: every immediate subdirectory containing markdown mounts as a bundle with the folder name as its id (a collision with another mount is an error naming the root), dot directories are skipped, and loose root files belong to no bundle. The mounted bundles declare the root URL as their shared colocated root, so relative `../sibling/...` links inside the published repo derive [cross-bundle edges](#cross-bundle-awareness) between the remote siblings — a repo mounted by URL stays as coherent as a local clone, with no rewrite step. Tree mounts derive each bundle's canonical URL as `<treeUrl>/<folder>` automatically (tree/blob/raw forms all match); `.tar.gz`/`.tgz`/`.zip` roots (any http(s) URL, or a local path; entries are partitioned by first path segment after the wrapper directory) have no per-file URLs, so they derive canonicals only from an explicit root `canonicalUrl`. The flag is repeatable, `--only <folder,folder,...>` restricts the mount to named subfolders exactly as for local roots, and the 500-file / 10 MiB ceilings apply across the whole root — not per bundle — so mounting a root is never more expensive than mounting one big bundle.

A root `AGENTS.md` travels with the mount: the CLI fetches it and appends it to the server instructions as a [bundle guide](#root-agentsmd-the-bundle-guide), same as a local colocated root. The runtime counterpart is the `load_colocated_remote_bundles` tool (`{ url, only?, include?, exclude?, canonicalUrl? }`) — MCP instructions are fixed at initialization, so the tool returns the `AGENTS.md` content in its result (`agentsGuide`) instead, registers `get_bundle_guide` (announced via `tools/list_changed`) so the guide stays retrievable for the rest of the session, and the agent still receives the guide. Reloading any mounted bundle refetches the whole root, tracking subfolders that appeared or vanished upstream.

Remote bundles are strictly read-only and sandboxed:

- Only `.md` files are indexed (GitHub trees via the contents API; `GITHUB_TOKEN` is used for rate limits when set, and never sent to non-GitHub hosts), bounded to 500 files / 10 MiB per bundle; archive downloads are additionally capped at 10 MiB compressed.
- Archive entries with path traversal (`..`, absolute paths) are rejected; a single top-level directory wrapping all files (as in GitHub source tarballs) is stripped; zip64 archives are not supported.
- Remote content is parsed as markdown, never executed, and never written to disk.
- All authoring tools reject read-only bundles, and `regenerate_indexes` / the `index` command skip them.
- `reload_bundles` refetches them, reporting the same added/removed/changed delta as local bundles.

### Cross-bundle awareness

OKF §5 deliberately has no cross-bundle link syntax, but the server knows every mounted bundle's canonical location and can *derive* cross-bundle relationships from spec-clean data. When a concept's §8 citation target, external link, or frontmatter `resource` URL points under another mounted bundle's canonical location, the graph tools record a derived `kind: "cross-bundle"` edge to that concept — read-only, no new syntax in documents.

[Colocated bundles](#colocated-bundles-vault-as-monorepo) get the same treatment without any URL: an ordinary relative link like `[orders](../acme/tables/orders.md)` — which Obsidian resolves natively when the colocated root is opened as one vault — derives a `kind: "cross-bundle"` edge when its first path segment names a mounted sibling (a bundle declaring the same colocated root) and the remainder resolves to one of its concepts (`.md` optional, like body links). Citations through such a link classify as `concept` instead of `missing`, and `validate` warns when a `../` link points into a mounted sibling at a concept it does not have (dangling); links to unmounted folders or loose root files stay silent — colocation is declared, never inferred from disk.

`promote_concept` emits exactly such links: between colocated siblings the citation stub cites the promoted copy by relative path (e.g. `../../org/standards/naming.md` from a stub one directory deep) instead of an `okf://` URI — and prefers the relative form even when the target has a canonical URL, since the on-disk vault UX is the point of colocation and publishing rewrites relative links to canonical URLs at pack time. The stub's frontmatter `resource` stays the canonical/`okf://` URI (spec §4.1 wants a parseable URI). Non-colocated promotions keep citing the canonical location.

- GitHub tree mounts get their canonical location automatically (the `tree`, `blob`, and `raw.githubusercontent.com` forms of the tree URL all match).
- Local clones and archives have no inherent URL: give them one with `--canonical-url id=<url>` (or `canonicalUrl` on `load_remote_bundle`), e.g. the GitHub tree URL of the shared bundle's published location, so citations to it resolve even when it is mounted from a local checkout.
- [Colocated bundles](#colocated-bundles-vault-as-monorepo) published as one repo need only a root-level `--canonical-url <rootUrl>`: each bundle derives `<rootUrl>/<folder>`, and explicit per-bundle flags override.
- `graph_summary` reports `crossBundleEdges`; `get_neighbors` and `find_path` traverse derived edges when called with `crossBundle: true` (node IDs become `bundle:concept` and carry the target's bundle); `export_graph` with `crossBundle: true` emits one namespaced multi-bundle graph with derived edges rendered dashed in `dot`/`mermaid`.

## The bundle (your "OKF brain")

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

Every non-reserved `.md` file is a concept. Frontmatter requires only `type`; `title`, `description`, `resource`, `tags`, and `timestamp` are recommended, and unknown keys are preserved. When `title` is omitted, display names (index entries, MCP resource names, search/list hits) are derived from the filename per spec §4.1 — `customer-order-history.md` becomes "Customer Order History" — and search/list hits carry `titleDerived: true` so agents can tell a derived title from an authored one. The bundle-root `index.md` may declare an `okf_version` in its frontmatter (spec §11): `list_bundles` and `graph_summary` report it, and `validate_bundle` warns — without failing — when it names a newer major version than the server supports. The same frontmatter may declare a `description` — one line saying what the bundle is for, written for an agent deciding whether to look inside (e.g. `description: "Payments-team runbooks and schema notes"`): `list_bundles` and `list_remote_bundles` report it, the root `index.md` MCP resource carries it, and like the rest of the root frontmatter it survives index regeneration. The concept ID is the file path without `.md` (`tables/orders`). Relationships are ordinary markdown links — bundle-absolute (`/tables/orders.md`, recommended) or relative (`./customers.md`) — and become directed edges in the graph. Broken links are warnings, never errors.

Writes regenerate every `index.md` as a generated artifact, with two exceptions for human curation (spec §6 supports hand-curated indexes with meaningful section groupings). An `index.md` whose frontmatter declares `generated: false` is treated as hand-curated and never rewritten — `regenerate_indexes` reports it as skipped, and deletes leave its directory in place. And the bundle-root `index.md`'s frontmatter always survives regeneration: a declared `okf_version` and any extension keys are carried over; `okf_version` is stamped only when absent.

To view the brain in Obsidian, open the bundle directory as a vault (File → Open folder as vault). The generated `index.md` files double as navigation pages, and standard markdown links work as-is.

## MCP surface

Resources: one `text/markdown` resource per document, at `okf://<bundle>/<path>`.

The server also declares MCP server-level instructions — a short primer on OKF conventions (concept IDs, link form, reserved files, the read/write tool flow) that clients inject into the agent's context. Authoring guidance is included only when the server runs with `--writable`.

Read tools:

| Tool | Purpose |
|---|---|
| `list_bundles` | Configured bundles with concept counts, read-only flags, each bundle's declared `description`, and a `loaded` marker for [lazily mounted](#lazy-mounting-discover-all-load-on-first-access) colocated bundles |
| `get_bundle_guide` | Each colocated root's [`AGENTS.md` guide](#root-agentsmd-the-bundle-guide) in full plus every bundle's one-line `description`; registered only while a colocated root is mounted (dynamically, on the first runtime mount) |
| `reload_bundles` | Re-read bundles (disk, remote tree, or archive) to pick up external edits; reports added/removed/changed concepts. No-arg form covers loaded bundles; naming an unloaded discovered bundle loads it |
| `load_remote_bundle` | Index a read-only bundle from a public GitHub tree URL or a `.tar.gz`/`.tgz`/`.zip` archive, in memory only |
| `load_colocated_remote_bundles` | Mount a published colocated root by URL — every subfolder becomes its own read-only bundle — returning the root `AGENTS.md` guide inline in the result |
| `list_remote_bundles` | Remote bundles currently loaded, with their source URLs and declared `description`s |
| `list_concepts` | Concept metadata (including the `resource` URI when set), filterable by prefix/type |
| `get_concept` | One full document: frontmatter, body, outgoing links, and a `sections` heading list; pass `section` to fetch a single body section |
| `get_citations` | Numbered `# Citations` entries for a concept (spec §8), each classified `external` / `concept` / `missing`; `../` targets resolving into a colocated sibling count as `concept` |
| `read_document` | Raw markdown of any bundle document by path, including reserved `index.md` / `log.md`; a missing `index.md` is synthesized from frontmatter (spec §6, marked `synthesized: true`) — the entry point for remote bundles published without index files |
| `search_concepts` | Text query + type/tag/path/link/orphan filters, paginated; an exact-`resource` filter maps an asset URI to its concept; hits include match locations, a body snippet, and the enclosing section heading |
| `list_types` | Distinct concept `type` values with usage counts |
| `list_tags` | Distinct tag values with usage counts |
| `suggest_concept_path` | Where a new concept should live, ranked by where same-type (and same-tag) concepts already are |
| `graph_summary` | Compact overview: counts, types, tags, orphans, derived `crossBundleEdges` |
| `get_neighbors` | Bounded expansion around a concept (`in`/`out`/`both`, depth); `crossBundle: true` follows derived edges into other mounted bundles |
| `find_path` | Shortest directed link path between two concepts; `crossBundle: true` accepts `bundle:concept` IDs and crosses bundles |
| `export_graph` | Graph as `json`, `dot`, or `mermaid`; `crossBundle: true` exports all mounted bundles as one namespaced graph with dashed derived edges |
| `concept_history` | Git commit history for a concept file, newest first, following renames |
| `concept_diff` | Unified git diff of a concept file against a ref (default: its most recent change) |
| `validate_bundle` | OKF v0.1 conformance errors + soft warnings (broken links, dangling `../` links into colocated siblings, malformed recommended frontmatter fields, malformed or unresolved citations, `index.md` / `log.md` structure checks) |

`concept_history` and `concept_diff` require the bundle to live inside a git work tree; on non-git bundles they return a `not a git repository` result instead of failing.

Write tools (only with `--writable`):

| Tool | Purpose |
|---|---|
| `write_concept` | Create/update a concept (defaulting `timestamp` to the write time), append a `log.md` entry, regenerate `index.md` files |
| `update_concept` | Partial update: shallow frontmatter patch (an explicit `null` deletes a key) and/or replace one body section by heading — everything else, YAML comments and formatting included, survives byte-for-byte. `timestamp` refreshes to the write time like `write_concept` (a concept without one gains it in its spec-order slot) unless the patch names it or `keepTimestamp: true` pins it; log + reindex |
| `delete_concept` | Delete a concept (optionally refusing while inbound links exist), log it, regenerate indexes |
| `rename_concept` | Move a concept to a new path, rewriting inbound links across the bundle, log it, regenerate indexes |
| `promote_concept` | Move a concept into another writable bundle (explicit `toPath`, or `suggest_concept_path`-style placement), leaving a citation stub at the old path that points at the promoted copy (relative `../<bundle>/<path>` link between colocated siblings, canonical location otherwise) — or `stub: false` to just report dangling inbound links; logs and reindexes both bundles |
| `append_log_entry` | Record a change-narrative entry in the bundle-root `log.md` — or a per-directory one via `directory` — without touching any concept |
| `regenerate_indexes` | Rewrite `index.md` navigation from frontmatter, reporting hand-curated indexes (`generated: false`) it skipped |

Writes are constrained to safe relative `.md` paths inside the bundle; reserved filenames (`index.md`, `log.md`) and dot-directories are rejected as concept paths.

The automatic log entry from a concept write, update, delete, or rename goes to the nearest existing directory-level `log.md` above the concept (spec §7 scoped logs), falling back to the bundle root's; the auto path never creates per-directory logs — start one with `append_log_entry` and subsequent concept changes under that directory keep it current. A rename that crosses scopes is logged in both the old and new paths' logs so neither history has a gap.

## CLI

```
okf-mcp --bundle [id=]<path> [--colocated-bundles <root> [--only <a,b,c>]]
        [--remote-bundle id=<url>] [--colocated-remote-bundles <url>]
        [--canonical-url [id=]<url>] [--writable] [--watch] [command]

  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report conformance errors and warnings (exit 1 on errors)
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format] [bundle]
                      Export the link graph (json | dot | mermaid | html)
  index               Regenerate index.md files (requires --writable)
  pack [bundle]       Publish a bundle as a distributable archive
```

`graph` exports the link graph in the named format. With several bundles mounted and no bundle argument, all of them export as one merged graph — node IDs namespaced `bundle:concept`, with derived [cross-bundle edges](#cross-bundle-awareness) included and rendered dashed in `dot`/`mermaid` — so a `--colocated-bundles` root exports whole. Name a bundle to scope the export to it (unqualified node IDs, same as the single-bundle output). `--include-external` adds external link targets as opaque nodes; a URL that derived a cross-bundle edge is not duplicated as one. `--out <file>` writes the export to a file instead of stdout.

The `html` format renders the graph as **one self-contained interactive page** — embedded data plus a small hand-rolled force simulation on `<canvas>`, no CDN or network access — so the file is shareable and viewable anywhere a browser opens it:

```bash
okf-mcp --colocated-bundles /path/to/vault graph html --out graph.html
```

Nodes are colored by *community*, with a legend (click an entry to focus that community: everything else fades — edges keep full strength while either endpoint is inside — and clicking the entry again, or the background, clears the focus): a merged multi-bundle export groups by **bundle** — each bundle reads as a cluster, with cross-bundle edges emphasized between them (bright dashed gold, wider and more opaque than in-bundle links) — while a single bundle groups by concept **type** unless `--community folder` (first path segment of the concept ID; top-level concepts group as `(root)`) or `--community tag` (first frontmatter tag; `(untagged)` when absent) overrides. Because bundle grouping always wins for a merged graph, `--community` is rejected there — name a bundle to use it. Every edge carries a direction arrowhead at its target, colored to match the edge. Node radius scales with degree, hovering shows id/title/description/tags, clicking a node highlights its neighbors, a search box filters by case-insensitive substring against id/title/tags (non-matching nodes fade; an edge stays bright only when both endpoints match), and the view supports node dragging, wheel zoom, and panning; external nodes (`--include-external`) render as muted squares. Titles and descriptions are embedded with `<` escaped, so a `</script>` in a document cannot break out of the page.

`pack` emits a `.tar.gz` (or `.zip`, by `--out` extension) of a mounted bundle for exchange with systems that can't reach its git remote — the counterpart of `--remote-bundle`, which loads such archives back. `index.md` files are regenerated in-memory from the packed concept set so the archive is self-describing, with the bundle root's declared frontmatter (including `okf_version`) preserved and hand-curated indexes (`generated: false`) traveling verbatim; the source bundle is never written, so `pack` needs no `--writable` and read-only remote bundles can be re-exported too. Repeatable `--include`/`--exclude` globs select concepts and logs with the same semantics `load_remote_bundle` uses (regenerated indexes are always emitted and describe only what was packed):

```bash
okf-mcp --bundle brain=/path/to/bundle pack --out brain.tar.gz --exclude 'drafts/**'
```

Relative `../<sibling>/...` links into [colocated](#colocated-bundles-vault-as-monorepo) siblings only mean something while the shared layout holds, so the archived copy carries the sibling's canonical concept URL instead (its blob form for GitHub canonicals) — a spec §8 citation form that resolves anywhere; only the link targets change, every other byte travels verbatim, and the source files stay untouched. A resolving link whose sibling has no canonical URL (explicit or derived from a root-level `--canonical-url`) fails the pack rather than shipping a dead link.

`--colocated-bundles <root>` (repeatable) mounts every immediate subdirectory of a shared root as its own bundle; `--only <folder,folder,...>` restricts the mount to the named subfolders — see [colocated bundles](#colocated-bundles-vault-as-monorepo). `--colocated-remote-bundles <url>` (repeatable) does the same for a published root — a GitHub tree URL or `.tar.gz`/`.tgz`/`.zip` archive — mounting each subfolder as a read-only bundle; see [consuming a published colocated root](#consuming-a-published-colocated-root-by-one-url).

`--canonical-url id=url` (repeatable) declares a bundle's published canonical URL for [cross-bundle awareness](#cross-bundle-awareness); with a colocated root's path as the id — or a bare URL when exactly one colocated root is configured — every bundle under the root derives `<url>/<folder>`, with explicit per-bundle flags taking precedence.

`--watch` (mcp only) auto-reloads local bundles when `.md` files change on disk, debounced so an editor save burst triggers one reload; `.obsidian/` and other dot directories are ignored. Remote bundles still reload only via the `reload_bundles` tool. Where recursive `fs.watch` is unsupported, the server logs a note to stderr and continues without watching.

## Development

```bash
npm run typecheck   # tsc over src + tests
npm test            # node:test via tsx
npm run build       # emit dist/
```

Source layout: `frontmatter.ts` / `parser.ts` (document parsing, link extraction, and body sections), `bundle.ts` / `store.ts` (loading and the in-memory index), `remote.ts` (read-only bundles from public GitHub trees and tar.gz/zip archives), `pack.ts` (the `pack` command's archive writer), `canonical.ts` (canonical-URL matching for derived cross-bundle edges), `graph.ts` / `search.ts` (traversal, structured search, and vocabulary listings), `visualize.ts` (the `graph html` self-contained force-directed export), `validate.ts` (conformance), `git.ts` (history/diff via the bundle's git repo), `suggest.ts` (concept placement suggestions), `authoring.ts` (the only write path), `watch.ts` (the `--watch` file watcher), `server.ts` (MCP wiring), `cli.ts` (entry point).

Without `--watch` there is no file watcher: call `reload_bundles` after editing bundle files outside the server (e.g. in Obsidian). Concepts written through `write_concept` refresh the index immediately.
