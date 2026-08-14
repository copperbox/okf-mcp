---
type: Workflow
title: Testing conventions
description: The node:test setup, fixture-versus-tmpdir styles, shared helpers,
  and the rule that features ship with tests.
tags:
  - testing
timestamp: 2026-08-14T01:22:19.236Z
---

Tests use Node's built-in `node:test` via tsx (`npm test` = `node --import tsx --test test/*.test.ts`) with `node:assert/strict`. No jest/vitest, no mocking library, no coverage tooling. One test file per `src/` module, plus `test/package.test.ts` as a release guard (see [release process](release-process.md)).

Two complementary styles:

- **Fixture-driven** (read-only behavior): tests read `test/fixtures/acme` — a demo bundle *plus* deliberate defects (`.obsidian/workspace.md` that must be ignored, `notes/no-type.md` missing the required `type`) — or `test/fixtures/malformed`, which exercises [permissive parsing](../decisions/permissive-parsing.md). (`test/fixtures/acme` is self-contained — the former `examples/acme` demo bundle it once mirrored was replaced by this brain bundle serving as the live example.)
- **Tmpdir-driven** (anything that writes): `fs.mkdtemp` sandboxes, used heavily by server, cli, and store tests.

Shared infrastructure in `test/`:

- `helpers.ts`: `makeBundle(specs)` builds an in-memory `LoadedBundle` with no disk fixture; git helpers run with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null` and fixed author env so test repos are isolated from user git config; `embeddedGraphData(html)` extracts the JSON payload from a `graph html` export.
- `fake-github.ts` and `archives.ts`: a fake GitHub contents API and archive servers — **no real network in any test**.
- `server.test.ts` connects a real MCP `Client` to `createOkfServer` over an in-memory transport pair.

House rule visible in history: **every feature commit ships its tests in the same commit** — no `src/` change lands without a matching `test/` change apart from docs/CI-only commits.

# Citations

[1] [test/](https://github.com/copperbox/okf-mcp/tree/main/test)
