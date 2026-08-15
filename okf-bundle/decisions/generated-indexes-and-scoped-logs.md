---
type: Design Decision
title: Generated indexes and scoped logs
description: How index.md regeneration, the generated:false opt-out,
  root-frontmatter carry-over, and nearest-existing-log routing work.
tags:
  - indexes
  - logs
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:20:55.796Z
sources:
  - id: src-authoring-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/authoring.ts
    title: src/authoring.ts
---

`index.md` and `log.md` are reserved at every directory level and never appear in the concept map.

**Indexes (§6).** Every write regenerates every `index.md`, with two carve-outs:

- A `generated: false` frontmatter key marks a hand-curated index that is never rewritten (and its directory is left alone on delete).
- The bundle-root index's declared frontmatter is *carried over* rather than restamped — that is where `okf_version` and the bundle-level `description` live (only the root index may carry frontmatter, §11); `okf_version` is stamped only when absent.

Index entries link to `subdir/index.md`, not `subdir/`, because Obsidian does not resolve trailing-slash links (see [Obsidian compatibility](../gotchas/obsidian-compatibility.md)). For directories with no index at all, the server synthesizes one on the fly (`_meta.synthesized`) — the entry point for remote bundles published without index files.

**Logs (§7).** `log.md` is newest-first under ISO date headings. Automatic entries route to the **nearest existing** directory-level `log.md` above the touched path, falling back to the bundle root; the automatic path uses scoped logs but never *creates* them — start a per-directory log deliberately with `append_log_entry`. A rename spanning two log scopes is recorded in both.
