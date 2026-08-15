---
type: Gotcha
title: Obsidian compatibility rules
description: The deliberate accommodations that let a bundle double as an Obsidian vault.
tags:
  - obsidian
  - links
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:21:57.115Z
sources:
  - id: src-bundle-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/bundle.ts
    title: src/bundle.ts
---

A bundle is meant to open directly as an Obsidian vault (File → Open folder as vault), and several behaviors exist specifically for that:

- **Dot directories and dot files are never indexed**, so `.obsidian/` cannot leak into the concept map. The `test/fixtures/acme` bundle carries a `.obsidian/workspace.md` precisely to guard this.
- **`.md` is optional in link targets** — Obsidian-style extensionless links resolve in the graph.
- **Generated index entries link to `subdir/index.md`, never `subdir/`**, because Obsidian does not resolve trailing-slash links.
- [Document-relative links](../decisions/document-relative-links.md) are recommended partly because they resolve identically in Obsidian, on GitHub, and in the graph.

Obsidian is never *required* — it's one supported human editor among any. Related: after any external edit (Obsidian or otherwise) the server needs `reload_bundles` or [`--watch`](fs-watch-quirks.md) to notice.
