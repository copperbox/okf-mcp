# MCP client configuration

The package is on npm, so the easiest setup runs it through `npx`:

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

Or point `node` at a local checkout you built yourself (`npm run build`):

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

Notes:

- `--bundle` accepts `path` or `id=path` (id defaults to the directory basename) and is repeatable.
- Omit `--writable` for a read-only server. The flag is server-wide: every local `--bundle` becomes writable. To mix writable and read-only bundles, mount the read-only ones with `--remote-bundle` (see [remote bundles](remote-bundles.md)).
- Works from a standing start: point `--bundle` at an empty directory with `--writable` and the first `write_concept` creates the folder structure, indexes, and log.
- `--watch` auto-reloads local bundles when `.md` files change on disk (see [CLI](cli.md)). Without it, call `reload_bundles` after editing bundle files outside the server.

See also: [multi-bundle setups](multi-bundle.md), [colocated bundles](colocated-bundles.md), [teaching your agent](agent-instructions.md).
