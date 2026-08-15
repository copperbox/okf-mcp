---
type: Design Decision
title: The 1.0 semver surface is three things
description: What semver covers since 1.0.0 — MCP tools, CLI, and the curated
  index.ts barrel — and why the barrel was pruned before the bump.
tags:
  - release
  - modules
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T02:23:03.133Z
sources:
  - id: src-index-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/index.ts
    title: src/index.ts
---

Since 1.0.0, semver covers exactly three surfaces:

1. The MCP tools (names, parameters, result shapes).
2. The CLI commands and flags.
3. The **curated** library exports in `src/index.ts`.

Anything not re-exported by the barrel is internal and may change in any release — deeper functionality (parser section machinery, frontmatter splicing, remote/pack/repair/visualize/watch internals) is reached through the MCP server or the CLI instead.

**Why the barrel was pruned before 1.0:** it previously re-exported essentially every internal module (~80 symbols). Under 0.x that was harmless; under 1.0 it would have made any internal rename a technically breaking change requiring a major bump. The barrel was cut to ~22 value exports — embedding the server (`createOkfServer`, `OkfStore`), loading (`loadBundle`, `buildBundle`), querying (`searchConcepts`, graph functions, `validateBundle`, `parseConceptDocument`), the high-level authoring path (`writeConcept`, `updateConcept`, `appendLogEntry`, `generateIndexes`, `suggestConceptPath`), and core types. Re-adding an export later is semver-minor; removing one is major — so when in doubt a symbol stays out.

Related invariant fixed in the same change: the MCP handshake used to hardcode `version: "0.1.0"`; it now reads the real package version from `package.json` via `createRequire` (guarded by a server test), so clients see the published version.

The policy is stated for users in [docs/development.md](https://github.com/copperbox/okf-mcp/blob/main/docs/development.md).
