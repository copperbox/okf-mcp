---
type: Design Decision
title: Byte-for-byte preservation on writes
description: Edits splice the document as it exists on disk so human formatting,
  comments, and concurrent edits survive agent writes.
tags:
  - authoring
timestamp: 2026-08-14T01:20:13.932Z
---

Because humans co-edit bundles in ordinary editors, partial writes must not clobber what they didn't touch. The write path treats **byte-for-byte preservation as a guarantee**:

- `patchFrontmatter` (`src/frontmatter.ts`) edits YAML in place via node offsets, so comments, formatting, and unknown keys survive untouched; `insertAfter` anchors place newly created keys in canonical position rather than appending.
- `update_concept` splices the document **as it is on disk**, not the loaded snapshot — so a concurrent human edit between load and write survives. `repair` does the same.
- Link rewrites splice recorded target offsets rather than regenerating markdown (see [document-relative links](document-relative-links.md)).
- `timestamp` semantics: refreshed to write time by default (spec §4.1, last meaningful change); an explicit patch value (or `null`) or `keepTimestamp: true` pins it. The implicit refresh is best-effort — a section-only update of a document with no patchable frontmatter still succeeds, just unstamped.
- A leading heading in section-replacement content that repeats the target section's heading is stripped, not duplicated (the bug behind issue #78).

# Citations

[1] [src/frontmatter.ts](https://github.com/copperbox/okf-mcp/blob/main/src/frontmatter.ts)
[2] [src/authoring.ts](https://github.com/copperbox/okf-mcp/blob/main/src/authoring.ts)
