# Development

```bash
npm run typecheck   # tsc over src + tests
npm test            # node:test via tsx
npm run build       # emit dist/
```

Source layout: `frontmatter.ts` / `parser.ts` (document parsing, links, sections), `bundle.ts` / `store.ts` (loading and the in-memory index), `remote.ts` (read-only remote bundles), `pack.ts` / `repair.ts` (the `pack` and `repair` commands), `canonical.ts` (canonical-URL matching for derived cross-bundle edges), `graph.ts` / `search.ts` (traversal and search), `visualize.ts` (the `graph html` export), `validate.ts` (conformance), `git.ts` (history/diff), `suggest.ts` (placement suggestions), `authoring.ts` (the only write path), `watch.ts` (`--watch`), `server.ts` (MCP wiring), `cli.ts` (entry point).

Releases are automated: bump the version in `package.json` and merge to `main` — CI tags, verifies, and publishes to npm with provenance.

The repo's own knowledge base lives in `okf-bundle/` (mounted by `.mcp.json`); it records the architecture, design decisions, and gotchas in depth. Without `--watch` there is no file watcher — call `reload_bundles` after editing bundle files outside the server.
