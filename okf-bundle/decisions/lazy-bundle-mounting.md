---
type: Design Decision
title: Lazy colocated bundle mounting
description: Colocated bundles are discovered cheaply at startup and fully
  parsed only on first access, with sweeps reporting what they excluded.
tags:
  - bundles
  - mcp
timestamp: 2026-08-14T01:20:24.082Z
---

Under the `mcp` command, colocated bundles mount **lazily** (issue #64): startup costs only the folder name plus a frontmatter-only read of the root `index.md` for `description`. The full parse happens on first `store.bundle(id)` access; concurrent first accesses share one in-flight parse.

The honesty rules that make laziness safe:

- `bundles()` returns loaded bundles only; `discoveredBundles()` lists the rest, and every no-arg sweep (`search_concepts`, `graph_summary`, `validate_bundle`, ...) appends a note naming the discovered-but-unloaded bundles it excluded — a sweep must never silently read as complete.
- Any tool naming an unloaded bundle hydrates it on the spot; `list_bundles` shows a `loaded` marker; `resources/list` represents an unloaded bundle by its root `index.md`, and reading that resource hydrates it.
- No-arg `reload_bundles` covers loaded bundles only; naming an unloaded bundle hydrates it and reports an all-added delta.
- Cross-bundle derivation sees loaded siblings only; edges into a discovered bundle appear when it hydrates.
- The store's `onHydrate` hook exists specifically so `--watch` can start watching a bundle the moment it loads.

Scope: only the `mcp` command is lazy — one-shot [CLI commands](../architecture/cli.md) load eagerly, and remote mounts are always eager.

# Citations

[1] [src/store.ts](https://github.com/copperbox/okf-mcp/blob/main/src/store.ts)
