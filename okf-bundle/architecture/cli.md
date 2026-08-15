---
type: Architecture
title: CLI surface
description: The CLI subcommands, key flags, the okf.config.json layer, and
  which commands load bundles lazily versus eagerly.
tags:
  - cli
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T19:54:21.941Z
sources:
  - id: src-cli-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/cli.ts
    title: src/cli.ts
---

`src/cli.ts` (`main(argv)` → exit code, arg parsing via `node:util` `parseArgs`) exposes ten subcommands, default `mcp`:

`mcp` · `inspect` · `validate` (exit 1 on errors) · `search <query>` · `concept <id>` · `graph [json|dot|mermaid|html] [bundle]` · `index` · `pack [bundle]` · `repair [bundle]` · `migrate [bundle]`

Key flags: `--bundle [id=]path` (repeatable; id defaults to the directory basename), `--colocated-bundles <root>` with `--only`, `--remote-bundle id=url`, `--colocated-remote-bundles <url>`, `--canonical-url [id=]url`, `--writable`, `--watch`, `--config` / `--no-config`, `--search-limit`, `--search-cutoff`, `--actor`, and per-command flags (`--out`, `--community`, `--include-external`, `--include`/`--exclude` for pack, `--write`/`--list` for repair and migrate, `--all` for migrate).

Every command also reads the [`okf.config.json` layers](../decisions/config-file-layering.md) before applying flags, so no mount flag is required: `configs` starts from the resolved config and each `--bundle` replaces the entry with the same id or appends. The same merge-then-override shape applies to remote bundles (by id) and colocated roots (by resolved path); a config-declared root carries its own `only`, `writable`, and `canonicalUrl`, while a root named on the command line shares the global `--only`.

Gotchas and asymmetries:

- **`--only` is overloaded:** under normal mounting it names colocated subfolders; under `repair` and `migrate` it names **fixer ids**, resolved against that command's own registry.
- Only the `mcp` command mounts colocated bundles [lazily](../decisions/lazy-bundle-mounting.md); every one-shot command loads eagerly. Remote mounts are always eager.
- `--writable` is the server-wide authoring gate, but a config file declaring any bundle writable turns authoring on by itself, and `"writable": false` keeps a bundle read-only regardless — see [per-bundle writability](../decisions/per-bundle-writability.md). The `mcp` startup line on stderr names the writable bundles rather than saying `(writable)`.
- `pack`, `repair`, `visualize` (graph html), and `watch` are CLI-only features — the [MCP server](mcp-server.md) never imports them.
- The `graph html` export is a fully self-contained interactive page: embedded JSON plus a hand-rolled force simulation on canvas, zero network. Every left angle bracket in the embedded JSON is escaped as `\u003c` so a title containing a closing script tag cannot break out of the data block.
- `repair` is dry-run by default and prints per-fixer findings; `--write` applies, appends a `log.md` sweep entry, and regenerates indexes. Unprovable rewrites are reported, never guessed.
- `migrate` shares that machinery but runs a [separate registry](../decisions/okf-0.2-migration-is-its-own-command.md) and, unlike `repair`, refuses an unscoped `--write` across several bundles without `--all`.
