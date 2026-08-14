---
type: Design Decision
title: Capture policy lives in agent config, not the server
description: The server teaches OKF mechanics but stays unopinionated about when
  knowledge is captured, and performs no git sync.
tags:
  - philosophy
timestamp: 2026-08-14T02:07:17.110Z
---

The server is deliberately unopinionated about *when* knowledge gets captured. Its built-in instructions teach OKF conventions and the write flow (`suggest_concept_path` → `write_concept`), but capture and reconciliation policy belongs in the agent's own configuration — CLAUDE.md / AGENTS.md / system prompt. This repo dogfoods that: its own `AGENTS.md` carries the Knowledge capture and Knowledge reconciliation standing instructions, and `.mcp.json` mounts this very bundle writable as `brain`.

Two corollaries the docs (docs/agent-instructions.md) treat as first-class:

- **No git sync.** The server never pulls or pushes. A shared bundle is only as fresh as its last `git pull`, and writes reach teammates only after an out-of-band commit and push. `reload_bundles` after a pull.
- **Absence claims and status flags rot fastest.** The reconciliation instruction (Update / Verify / Explain each concept your change touches) exists because claims like "X does not exist" are falsified by changes no diff of the bundle would touch. Optional refinement: a `verified: <ISO date>` frontmatter key, distinct from `timestamp` (which records last *edit*) — unknown keys round-trip untouched by design.

# Citations

[1] [docs/agent-instructions.md](https://github.com/copperbox/okf-mcp/blob/main/docs/agent-instructions.md)
