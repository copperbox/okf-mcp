---
type: Design Decision
title: Context-window frugality is server surface
description: Why the server actively steers agents toward cheap reads, and where
  those levers live.
tags:
  - mcp
  - philosophy
generated:
  by: okf-mcp/1.5.0
  at: 2026-08-31T01:59:35.440Z
sources:
  - id: src-server-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/server.ts
    title: src/server.ts
---

Every byte a tool returns occupies the agent's context for the rest of its session, so an agent that dumps whole documents or re-orients repeatedly pays for it in reasoning capacity. Analysis of real sessions (2026-08) showed three dominant wastes: `list_concepts` used where `search_concepts` would do, `list_bundles`/`get_bundle_guide` re-fired per step and inside subagents that already inherited the answers, and whole-document `get_concept` reads when one section was needed.

The decision (1.4.0): frugality is not left to client configuration — the server steers, through five levers.

- **Instructions** name search_concepts the entry point, tell agents to read sections rather than documents, and declare orientation once-per-session. They are themselves budgeted: a test caps them (~48 lines), because instructions are the one cost every session pays unconditionally.
- **Tool descriptions** carry the same routing (`list_concepts` defers to search; `list_bundles`/`get_bundle_guide` say "call once"; `read_document` routes concept reads to `get_concept`).
- **Search hits point into sections**: `section`/`matchedSections` on body matches feed [`get_concept`'s `section` argument](../architecture/search-scoring.md).
- **`get_concept` offers graduated reads**: `outline: true` (shape only), `section` (one subtree), full body — see the [server surface](../architecture/mcp-server.md).
- **Responses are shaped, not just routed** (2.0 Stage 1): JSON serializes compact (no pretty-printing), `list_concepts` paginates (default 50, with `total`), `read_document` takes `startLine`/`endLine` slices (with `totalLines`), and unbounded arrays are capped by default — `validate_bundle` at 50 problems per list (with `errorsTotal`/`warningsTotal`), `graph_summary` at 25 orphans (with `orphanCount`), `concept_diff` at 200 lines. Every truncated result carries a one-clause steering note saying what to call next, and prose inside machine payloads (the sweep-exclusion note, the read-only error, the unknown-section error) stays to one actionable clause.

The design rule for any tool that can return a lot: cap by default, make truncation evident in the data (total vs returned), steer in one clause. `test/response-budget.test.ts` pins byte budgets for the main read tools so bloat cannot creep back silently, the same way the instruction cap is a test rather than a comment.

The counterweight: guidance lines are only worth adding when they save more context than they cost, which is why the instruction cap stays a test rather than a comment. This composes with [capture policy living in agent config](capture-policy-lives-in-agent-config.md) — the server teaches *how to read cheaply*, while *when to capture* remains the client's policy.
