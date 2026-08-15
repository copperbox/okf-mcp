---
type: Gotcha
title: fs.watch quirks handled by the watcher
description: Platform quirks of recursive fs.watch that watch.ts works around,
  and the watcher's debounce and serialization rules.
tags:
  - watch
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:21:48.026Z
sources:
  - id: src-watch-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/watch.ts
    title: src/watch.ts
---

`watchBundles` (`src/watch.ts`) drives debounced auto-reload of local bundles through the same reload path as `reload_bundles`. Quirks it explicitly handles:

- **On newer Node, `fs.watch` on a missing path returns a watcher that never fires instead of throwing** — so path existence is verified manually before watching.
- A `null` filename in a watch event (the platform can't say what changed) triggers a reload anyway, to be safe.
- Recursive `fs.watch` is not supported everywhere; the watcher degrades gracefully where it isn't.

Behavior rules: only `.md` changes matter and dot paths are dropped; reloads are debounced 250 ms (`DEFAULT_WATCH_DEBOUNCE_MS`) and **serialized** so overlapping refreshes cannot interleave; remote bundles have no directory to watch and refresh only via `reload_bundles`.

One subtlety from the reload-delta side: a "changed" concept means its own source bytes differ — not that its link resolution shifted because a neighbor appeared.
