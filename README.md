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
        "-y", "okf-mcp",
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

## Remote bundles (knowledge exchange)

OKF's third goal is exchanging knowledge across systems. You can index a bundle published in another repository without cloning it, straight from a public GitHub tree:

```bash
npm run dev -- \
  --remote-bundle okf=https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf \
  inspect
```

`--remote-bundle id=url` is repeatable and takes a `https://github.com/<owner>/<repo>/tree/<ref>/<path>` URL (refs containing `/` are not supported), or a `.tar.gz` / `.tgz` / `.zip` archive detected by extension — any http(s) URL, or a local archive path. The same thing is available at runtime through the `load_remote_bundle` tool (`{ id, url, include?, exclude? }`, glob filters over bundle-relative paths), which mutates only the in-memory index; `list_remote_bundles` lists what is loaded, with the tree or archive URL as the source.

Remote bundles are strictly read-only and sandboxed:

- Only `.md` files are indexed (GitHub trees via the contents API; `GITHUB_TOKEN` is used for rate limits when set, and never sent to non-GitHub hosts), bounded to 500 files / 10 MiB per bundle; archive downloads are additionally capped at 10 MiB compressed.
- Archive entries with path traversal (`..`, absolute paths) are rejected; a single top-level directory wrapping all files (as in GitHub source tarballs) is stripped; zip64 archives are not supported.
- Remote content is parsed as markdown, never executed, and never written to disk.
- All authoring tools reject read-only bundles, and `regenerate_indexes` / the `index` command skip them.
- `reload_bundles` refetches them, reporting the same added/removed/changed delta as local bundles.

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

Every non-reserved `.md` file is a concept. Frontmatter requires only `type`; `title`, `description`, `resource`, `tags`, and `timestamp` are recommended, and unknown keys are preserved. The bundle-root `index.md` may declare an `okf_version` in its frontmatter (spec §11): `list_bundles` and `graph_summary` report it, and `validate_bundle` warns — without failing — when it names a newer major version than the server supports. The concept ID is the file path without `.md` (`tables/orders`). Relationships are ordinary markdown links — bundle-absolute (`/tables/orders.md`, recommended) or relative (`./customers.md`) — and become directed edges in the graph. Broken links are warnings, never errors.

To view the brain in Obsidian, open the bundle directory as a vault (File → Open folder as vault). The generated `index.md` files double as navigation pages, and standard markdown links work as-is.

## MCP surface

Resources: one `text/markdown` resource per document, at `okf://<bundle>/<path>`.

The server also declares MCP server-level instructions — a short primer on OKF conventions (concept IDs, link form, reserved files, the read/write tool flow) that clients inject into the agent's context. Authoring guidance is included only when the server runs with `--writable`.

Read tools:

| Tool | Purpose |
|---|---|
| `list_bundles` | Configured bundles with concept counts and read-only flags |
| `reload_bundles` | Re-read bundles (disk, remote tree, or archive) to pick up external edits; reports added/removed/changed concepts |
| `load_remote_bundle` | Index a read-only bundle from a public GitHub tree URL or a `.tar.gz`/`.tgz`/`.zip` archive, in memory only |
| `list_remote_bundles` | Remote bundles currently loaded, with their source URLs |
| `list_concepts` | Concept metadata, filterable by prefix/type |
| `get_concept` | One full document: frontmatter, body, outgoing links, and a `sections` heading list; pass `section` to fetch a single body section |
| `get_citations` | Numbered `# Citations` entries for a concept (spec §8), each classified `external` / `concept` / `missing` |
| `read_document` | Raw markdown of any bundle document by path, including reserved `index.md` / `log.md`; a missing `index.md` is synthesized from frontmatter (spec §6, marked `synthesized: true`) — the entry point for remote bundles published without index files |
| `search_concepts` | Text query + type/tag/path/link/orphan filters, paginated; hits include match locations, a body snippet, and the enclosing section heading |
| `list_types` | Distinct concept `type` values with usage counts |
| `list_tags` | Distinct tag values with usage counts |
| `suggest_concept_path` | Where a new concept should live, ranked by where same-type (and same-tag) concepts already are |
| `graph_summary` | Compact overview: counts, types, tags, orphans |
| `get_neighbors` | Bounded expansion around a concept (`in`/`out`/`both`, depth) |
| `find_path` | Shortest directed link path between two concepts |
| `export_graph` | Graph as `json`, `dot`, or `mermaid` |
| `concept_history` | Git commit history for a concept file, newest first, following renames |
| `concept_diff` | Unified git diff of a concept file against a ref (default: its most recent change) |
| `validate_bundle` | OKF v0.1 conformance errors + soft warnings (broken links, malformed or unresolved citations, `index.md` / `log.md` structure checks) |

`concept_history` and `concept_diff` require the bundle to live inside a git work tree; on non-git bundles they return a `not a git repository` result instead of failing.

Write tools (only with `--writable`):

| Tool | Purpose |
|---|---|
| `write_concept` | Create/update a concept (defaulting `timestamp` to the write time), append a `log.md` entry, regenerate `index.md` files |
| `delete_concept` | Delete a concept (optionally refusing while inbound links exist), log it, regenerate indexes |
| `rename_concept` | Move a concept to a new path, rewriting inbound links across the bundle, log it, regenerate indexes |
| `append_log_entry` | Record a change-narrative entry in the bundle-root `log.md` — or a per-directory one via `directory` — without touching any concept |
| `regenerate_indexes` | Rewrite `index.md` navigation from frontmatter |

Writes are constrained to safe relative `.md` paths inside the bundle; reserved filenames (`index.md`, `log.md`) and dot-directories are rejected as concept paths.

## CLI

```
okf-mcp --bundle [id=]<path> [--remote-bundle id=<url>] [--writable] [--watch] [command]

  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report conformance errors and warnings (exit 1 on errors)
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format]      Export the link graph (json | dot | mermaid)
  index               Regenerate index.md files (requires --writable)
```

`--watch` (mcp only) auto-reloads local bundles when `.md` files change on disk, debounced so an editor save burst triggers one reload; `.obsidian/` and other dot directories are ignored. Remote bundles still reload only via the `reload_bundles` tool. Where recursive `fs.watch` is unsupported, the server logs a note to stderr and continues without watching.

## Development

```bash
npm run typecheck   # tsc over src + tests
npm test            # node:test via tsx
npm run build       # emit dist/
```

Source layout: `frontmatter.ts` / `parser.ts` (document parsing, link extraction, and body sections), `bundle.ts` / `store.ts` (loading and the in-memory index), `remote.ts` (read-only bundles from public GitHub trees and tar.gz/zip archives), `graph.ts` / `search.ts` (traversal, structured search, and vocabulary listings), `validate.ts` (conformance), `git.ts` (history/diff via the bundle's git repo), `suggest.ts` (concept placement suggestions), `authoring.ts` (the only write path), `watch.ts` (the `--watch` file watcher), `server.ts` (MCP wiring), `cli.ts` (entry point).

Without `--watch` there is no file watcher: call `reload_bundles` after editing bundle files outside the server (e.g. in Obsidian). Concepts written through `write_concept` refresh the index immediately.
