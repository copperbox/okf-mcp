---
type: Architecture
title: OkfStore
description: The store as the single mutable runtime object, and why authoring
  functions never mutate the in-memory index.
tags:
  - bundles
  - authoring
timestamp: 2026-08-14T01:18:10.838Z
---

`OkfStore` (`src/store.ts`) is the in-memory multi-bundle index and the **single mutable runtime object**. It owns bundle configs, [lazy mounting](../decisions/lazy-bundle-mounting.md), remote mounts, reload deltas (`BundleReloadStats`), and the `onHydrate` hook (which exists so `--watch` can start watching a bundle the moment it loads). It never watches the filesystem itself — `watch.ts` drives it from outside.

Two invariants around it:

- **Authoring functions never mutate the in-memory index.** Every function in `authoring.ts` writes to disk and expects the caller to reload. The server's `logAndReindex` helper does the full dance: append log entry → reload → `generateIndexes` → reload *again*, so the store also sees the freshly regenerated index files.
- **Bundle id collisions are hard errors at mount time**, and the error message names the colocated root when the id came from a folder name the user never typed. Similarly, `--only` naming a non-existent subfolder is an error rather than a silent no-op, because a silent no-op would read as "loaded" when it wasn't.

Small affordance: `store.getConcept()` tolerates a trailing `.md` on concept IDs.

# Citations

[1] [src/store.ts](https://github.com/copperbox/okf-mcp/blob/main/src/store.ts)
