---
type: Design Decision
title: Capture policy lives in agent config, not the server
description: The server teaches OKF mechanics but stays unopinionated about when
  knowledge is captured, and performs no git sync.
tags:
  - philosophy
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T02:07:17.110Z
sources:
  - id: docs-agent-instructions-md
    resource: https://github.com/copperbox/okf-mcp/blob/main/docs/agent-instructions.md
    title: docs/agent-instructions.md
---

The server is deliberately unopinionated about *when* knowledge gets captured. Its built-in instructions teach OKF conventions and the write flow (`suggest_concept_path` → `write_concept`), but capture and reconciliation policy belongs in the agent's own configuration — CLAUDE.md / AGENTS.md / system prompt. This repo dogfoods that: its own `AGENTS.md` carries the Knowledge capture and Knowledge reconciliation standing instructions, and `.mcp.json` mounts this very bundle writable as `brain`.

Two corollaries the docs (docs/agent-instructions.md) treat as first-class:

- **No git sync.** The server never pulls or pushes. A shared bundle is only as fresh as its last `git pull`, and writes reach teammates only after an out-of-band commit and push. `reload_bundles` after a pull.
- **Absence claims and status flags rot fastest.** The reconciliation instruction (Update / Verify / Explain each concept your change touches) exists because claims like "X does not exist" are falsified by changes no diff of the bundle would touch. OKF v0.2 turned what was an optional refinement here into real vocabulary: `verified: {by, at}` records that someone *checked* a concept, distinct from `generated`, which records when it was last *written*. So the Verify branch now leaves a trace, and `search_concepts` can hunt for what needs attention (`stale: true`, `minTrust: "unverified"`) instead of waiting for a diff to point at it.
