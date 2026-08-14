# okf-mcp

An MCP server that gives AI agents a standardized [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) backend: a knowledge base of plain Markdown files with YAML frontmatter, indexed into a link graph and exposed through MCP resources and tools for search, traversal, validation, and authoring.

The knowledge base is just a directory of Markdown ("a bundle"). Humans browse and edit it with any editor — including opening it directly as an **Obsidian vault** — while agents work through the MCP server.

- No database, no embeddings; the only network calls are for optional read-only remote bundles you explicitly configure.
- Permissive by design (spec §9): malformed documents are reported, valid concepts keep serving.
- The write path keeps `index.md` navigation and `log.md` history current, so the human view stays browsable as agents write.

## Quick start

Declare the server **once, globally**, in your agent harness — with no arguments:

```json
{
  "mcpServers": {
    "okf": {
      "command": "npx",
      "args": ["-y", "@copperbox/okf-mcp"]
    }
  }
}
```

Then let each directory decide what it mounts, with an `okf.config.json` beside the project (an empty bundle directory works — the first write creates the structure):

```json
{
  "bundles": {
    "brain": { "path": "okf-bundle/", "writable": true }
  }
}
```

That file is safe to commit: paths resolve against the config file, and writability is per bundle. Config files merge from your home directory down to the project, so a project commits its own bundle while each developer adds personal ones locally — something a harness config cannot express, since it keys servers by name and has no merge semantics. See [configuration](docs/configuration.md) for the layering rules and the full schema; bundles can still be declared as `--bundle` flags instead when one fixed bundle is all you need.

To make agents capture and maintain knowledge as they work, add standing instructions to your agent config — copy-paste blocks in [teaching your agent](docs/agent-instructions.md).

To explore from a checkout instead: `npm install && npm run dev -- inspect` — this repository has its own `okf.config.json`, so no mount flags are needed. `okf-bundle/` is this repository's own knowledge base — the project dogfoods itself, so the example bundle is the real brain the project's agents read and write.

## Documentation

- [Configuration](docs/configuration.md) — `okf.config.json` layering, MCP client setup, flags, per-bundle writability
- [Teaching your agent](docs/agent-instructions.md) — knowledge capture and reconciliation instructions for your agent config
- [Bundle format](docs/bundle-format.md) — layout, frontmatter, links, generated indexes, Obsidian
- [MCP tools](docs/tools.md) — every resource, read tool, and write tool
- [CLI](docs/cli.md) — `inspect`, `validate`, `graph` (incl. interactive HTML), `pack`, `repair`, `--watch`
- [Multi-bundle setups](docs/multi-bundle.md) — org brain + project brain, routing, referencing across bundles
- [Colocated bundles](docs/colocated-bundles.md) — a vault/monorepo of sibling bundles, lazy mounting, the root `AGENTS.md` guide
- [Remote bundles](docs/remote-bundles.md) — mounting published bundles by URL, sandboxing
- [Cross-bundle awareness](docs/cross-bundle.md) — derived edges between bundles, canonical URLs
- [Development](docs/development.md) — building, testing, source layout

## License

[ISC](LICENSE)
