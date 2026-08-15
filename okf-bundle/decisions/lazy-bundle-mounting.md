---
type: Design Decision
title: Lazy colocated bundle mounting
description: Colocated bundles are discovered cheaply at startup and fully
  parsed only on first access, with sweeps reporting what they excluded.
tags:
  - bundles
  - mcp
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:20:24.082Z
sources:
  - id: src-store-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/store.ts
    title: src/store.ts
---

Under the `mcp` command, colocated bundles mount **lazily** (issue #64): startup costs only the folder name plus a frontmatter-only read of the root `index.md` for `description`. The full parse happens on first `store.bundle(id)` access; concurrent first accesses share one in-flight parse.

The honesty rules that make laziness safe:

- `bundles()` returns loaded bundles only; `discoveredBundles()` lists the rest, and every no-arg sweep (`search_concepts`, `graph_summary`, `validate_bundle`, ...) appends a note naming the discovered-but-unloaded bundles it excluded — a sweep must never silently read as complete.
- Any tool naming an unloaded bundle hydrates it on the spot; `list_bundles` shows a `loaded` marker; `resources/list` represents an unloaded bundle by its root `index.md`, and reading that resource hydrates it.
- No-arg `reload_bundles` covers loaded bundles only; naming an unloaded bundle hydrates it and reports an all-added delta.
- Cross-bundle derivation sees loaded siblings only; edges into a discovered bundle appear when it hydrates.
- The store's `onHydrate` hook exists specifically so `--watch` can start watching a bundle the moment it loads.
- Discovery itself follows the same honesty rule: a subfolder with no markdown anywhere (assets, templates, a freshly created empty bundle) is not mounted, and the CLI prints a stderr note naming the skipped folders — a fresh folder that silently fails to appear as a bundle would otherwise read as a bug.

Scope: only the `mcp` command is lazy — one-shot [CLI commands](../architecture/cli.md) load eagerly, and remote mounts are always eager.
