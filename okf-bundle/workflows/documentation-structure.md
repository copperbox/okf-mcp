---
type: Workflow
title: Documentation structure and guards
description: The README is a minimal entry point linking into docs/, and tests
  assert specific docs content stays present.
tags:
  - docs
  - testing
timestamp: 2026-08-14T02:07:41.805Z
---

The README is deliberately minimal: purpose, quick-start MCP config, and a link list into `docs/`, where each aspect gets one concise file (configuration, agent-instructions, bundle-format, tools, cli, multi-bundle, colocated-bundles, remote-bundles, cross-bundle, development).

Constraints to respect when editing docs:

- **Doc guards in the test suite.** `test/server.test.ts` asserts every registered MCP tool appears as a table row in `docs/tools.md` (pattern: pipe, backtick, tool name, backtick, pipe — so each tool needs its own row, no combined rows). `test/package.test.ts` asserts `docs/agent-instructions.md` covers git pull / `reload_bundles` / push and that `docs/multi-bundle.md` covers the org+project workflow (two mounted bundles, `--remote-bundle`, citations, `references/` stubs). It also asserts the README documents the npx install path.
- **npm ships only `README.md`** (the `files` whitelist — see [release process](release-process.md)), so `docs/` is not in the package. Relative `docs/` links in the README still render on npmjs.com because npm rewrites them against the `repository` field.
- Keep prose short; docs are reference material, not tutorials.

# Citations

[1] [docs/](https://github.com/copperbox/okf-mcp/tree/main/docs)
