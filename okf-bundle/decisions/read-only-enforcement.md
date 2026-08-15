---
type: Design Decision
title: Read-only enforcement in three layers
description: How writability is enforced at the bundle flag, per-tool assertion,
  and tool-registration levels, and which commands respect it.
tags:
  - authoring
  - mcp
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:20:35.553Z
sources:
  - id: src-server-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/server.ts
    title: src/server.ts
---

`--writable` is **server-wide**, and read-only is enforced at three independent levels:

1. `LoadedBundle.readOnly` — set on all remote bundles regardless of flags.
2. `assertWritableBundle` — checked on every authoring tool call in `src/server.ts`.
3. Registration gating — the seven authoring tools are not registered at all unless the server started with `--writable`, so a read-only server doesn't even advertise them.

Consequences and edge cases:

- To mount a read-only org brain beside a writable project brain, use `--remote-bundle` for the org brain — that is the intended way around `--writable` being server-wide.
- `repair` refuses read-only bundles (it rewrites source on disk); `pack` accepts them, because packing regenerates indexes **in memory** and never writes to the source — so a read-only remote bundle can be re-exported.
- Writes are constrained to safe relative `.md` paths inside the bundle; reserved filenames (`index.md`, `log.md`) and dot-directories are rejected as concept paths. The server's document-path assertion is deliberately looser than the concept-path one: reserved files and non-`.md` files may be *read*, never written as concepts.
