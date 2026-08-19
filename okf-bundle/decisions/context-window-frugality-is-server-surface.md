---
type: Design Decision
title: Context-window frugality is server surface
description: Why the server actively steers agents toward cheap reads, and where
  those levers live.
tags:
  - mcp
  - philosophy
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-19T21:14:32.556Z
sources:
  - id: src-server-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/server.ts
    title: src/server.ts
---

Every byte a tool returns occupies the agent's context for the rest of its session, so an agent that dumps whole documents or re-orients repeatedly pays for it in reasoning capacity. Analysis of real sessions (2026-08) showed three dominant wastes: `list_concepts` used where `search_concepts` would do, `list_bundles`/`get_bundle_guide` re-fired per step and inside subagents that already inherited the answers, and whole-document `get_concept` reads when one section was needed.

The decision (1.4.0): frugality is not left to client configuration — the server steers, through four levers.

- **Instructions** name search_concepts the entry point, tell agents to read sections rather than documents, and declare orientation once-per-session. They are themselves budgeted: a test caps them (~48 lines), because instructions are the one cost every session pays unconditionally.
- **Tool descriptions** carry the same routing (`list_concepts` defers to search; `list_bundles`/`get_bundle_guide` say "call once").
- **Search hits point into sections**: `section`/`matchedSections` on body matches feed [`get_concept`'s `section` argument](../architecture/search-scoring.md).
- **`get_concept` offers graduated reads**: `outline: true` (shape only), `section` (one subtree), full body — see the [server surface](../architecture/mcp-server.md).

The counterweight: guidance lines are only worth adding when they save more context than they cost, which is why the instruction cap stays a test rather than a comment. This composes with [capture policy living in agent config](capture-policy-lives-in-agent-config.md) — the server teaches *how to read cheaply*, while *when to capture* remains the client's policy.
