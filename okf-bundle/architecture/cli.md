---
type: Architecture
title: CLI surface
description: The CLI subcommands, key flags, and which commands load bundles
  lazily versus eagerly.
tags:
  - cli
timestamp: 2026-08-14T01:19:08.890Z
---

`src/cli.ts` (`main(argv)` → exit code, arg parsing via `node:util` `parseArgs`) exposes eight subcommands, default `mcp`:

`mcp` · `inspect` · `validate` (exit 1 on errors) · `search <query>` · `concept <id>` · `graph [json|dot|mermaid|html] [bundle]` · `index` · `pack [bundle]` · `repair [bundle]`

Key flags: `--bundle [id=]path` (repeatable; id defaults to the directory basename), `--colocated-bundles <root>` with `--only`, `--remote-bundle id=url`, `--colocated-remote-bundles <url>`, `--canonical-url [id=]url`, `--writable`, `--watch`, `--search-limit`, `--search-cutoff`, and per-command flags (`--out`, `--community`, `--include-external`, `--include`/`--exclude` for pack, `--write`/`--list` for repair).

Gotchas and asymmetries:

- **`--only` is overloaded:** under normal mounting it names colocated subfolders; under `repair` it names **fixer ids**.
- Only the `mcp` command mounts colocated bundles [lazily](../decisions/lazy-bundle-mounting.md); every one-shot command loads eagerly. Remote mounts are always eager.
- `pack`, `repair`, `visualize` (graph html), and `watch` are CLI-only features — the [MCP server](mcp-server.md) never imports them.
- The `graph html` export is a fully self-contained interactive page: embedded JSON plus a hand-rolled force simulation on canvas, zero network. Every left angle bracket in the embedded JSON is escaped as `\u003c` so a title containing a closing script tag cannot break out of the data block.
- `repair` is dry-run by default and prints per-fixer findings; `--write` applies, appends a `log.md` sweep entry, and regenerates indexes. Unprovable rewrites are reported, never guessed.

# Citations

[1] [src/cli.ts](https://github.com/copperbox/okf-mcp/blob/main/src/cli.ts)
