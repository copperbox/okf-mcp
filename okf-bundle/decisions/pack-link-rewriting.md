---
type: Design Decision
title: Pack rewrites sibling links or fails
description: Packing rewrites relative sibling links to canonical URLs and
  refuses to ship a link it cannot resolve.
tags:
  - remote
  - links
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:21:19.759Z
sources:
  - id: src-pack-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/pack.ts
    title: src/pack.ts
---

`okf-mcp pack` emits a distributable `.tar.gz` or `.zip` that `loadRemoteBundle` round-trips. Indexes are regenerated **in memory**, so the source is never written — no `--writable` needed, and read-only remote bundles can be re-exported. Root frontmatter (including `okf_version`) is preserved and hand-curated (`generated: false`) indexes travel verbatim.

The link invariant: a packed bundle leaves its colocated context behind, so relative `../sibling/...` links into a colocated sibling are **rewritten to the sibling's canonical concept URL** (blob form for GitHub). If a resolving sibling link exists but the sibling has no canonical URL, the pack **fails** rather than shipping a dead link — the same "never silently degrade" stance as [lazy mounting's](lazy-bundle-mounting.md) sweep notes and the CLI's strict `--only` handling.
