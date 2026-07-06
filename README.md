# okf-mcp

An MCP server that gives AI agents a standardized [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) backend: a knowledge base of plain Markdown files with YAML frontmatter, indexed into a link graph and exposed through MCP resources and tools for search, traversal, validation, and authoring.

The knowledge base itself is just a directory of Markdown ("a bundle"). Humans can browse and edit it with any editor — including opening it directly as an **Obsidian vault** — while agents work through the MCP server. Obsidian is never required: the format is pure OKF v0.1 Markdown, and any `.obsidian/` directory is ignored by the indexer.

- No database, no embeddings, no network calls.
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

Every non-reserved `.md` file is a concept. Frontmatter requires only `type`; `title`, `description`, `resource`, `tags`, and `timestamp` are recommended, and unknown keys are preserved. The concept ID is the file path without `.md` (`tables/orders`). Relationships are ordinary markdown links — bundle-absolute (`/tables/orders.md`, recommended) or relative (`./customers.md`) — and become directed edges in the graph. Broken links are warnings, never errors.

To view the brain in Obsidian, open the bundle directory as a vault (File → Open folder as vault). The generated `index.md` files double as navigation pages, and standard markdown links work as-is.

## MCP surface

Resources: one `text/markdown` resource per document, at `okf://<bundle>/<path>`.

Read tools:

| Tool | Purpose |
|---|---|
| `list_bundles` | Configured bundles with concept counts |
| `reload_bundles` | Re-read bundles from disk to pick up external edits; reports added/removed/changed concepts |
| `list_concepts` | Concept metadata, filterable by prefix/type |
| `get_concept` | One full document: frontmatter, body, outgoing links |
| `search_concepts` | Text query + type/tag/path/link/orphan filters, paginated |
| `graph_summary` | Compact overview: counts, types, tags, orphans |
| `get_neighbors` | Bounded expansion around a concept (`in`/`out`/`both`, depth) |
| `find_path` | Shortest directed link path between two concepts |
| `export_graph` | Graph as `json`, `dot`, or `mermaid` |
| `validate_bundle` | OKF v0.1 conformance errors + soft warnings |

Write tools (only with `--writable`):

| Tool | Purpose |
|---|---|
| `write_concept` | Create/update a concept, append a `log.md` entry, regenerate `index.md` files |
| `regenerate_indexes` | Rewrite `index.md` navigation from frontmatter |

Writes are constrained to safe relative `.md` paths inside the bundle; reserved filenames (`index.md`, `log.md`) and dot-directories are rejected as concept paths.

## CLI

```
okf-mcp --bundle [id=]<path> [--bundle ...] [--writable] [command]

  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report conformance errors and warnings (exit 1 on errors)
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format]      Export the link graph (json | dot | mermaid)
  index               Regenerate index.md files (requires --writable)
```

## Development

```bash
npm run typecheck   # tsc over src + tests
npm test            # node:test via tsx
npm run build       # emit dist/
```

Source layout: `frontmatter.ts` / `parser.ts` (document parsing and link extraction), `bundle.ts` / `store.ts` (loading and the in-memory index), `graph.ts` / `search.ts` (traversal and structured search), `validate.ts` (conformance), `authoring.ts` (the only write path), `server.ts` (MCP wiring), `cli.ts` (entry point).

There is no file watcher: call `reload_bundles` after editing bundle files outside the server (e.g. in Obsidian). Concepts written through `write_concept` refresh the index immediately.
