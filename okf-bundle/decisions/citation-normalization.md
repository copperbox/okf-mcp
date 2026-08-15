---
type: Design Decision
title: Citation normalization shares one code path
description: Write-time citation normalization and the after-the-fact repair
  fixer share the same function so prevention and repair cannot drift.
tags:
  - citations
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:23:35.062Z
sources:
  - id: src-parser-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/parser.ts
    title: src/parser.ts
  - id: src-repair-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/repair.ts
    title: src/repair.ts
---

**This concept describes the OKF v0.1 form.** v0.2 superseded the body `# Citations` list with frontmatter `sources` (see [the write vocabulary](write-vocabulary-follows-the-bundle.md) and [the migration](okf-0.2-migration-is-its-own-command.md)), but reading and repairing the v0.1 form stays supported indefinitely, so everything below is still live for v0.1 bundles.

Canonical citation form (v0.1 §8) under a `# Citations` heading, versus the natural-but-wrong ordered-list form:

```
[1] [Some source](https://example.com)     <- canonical
1. [Some source](https://example.com)      <- normalized on write
```

The ordered-list form is handled twice, deliberately through the **same** `normalizeCitationEntries` function (issue #78):

- **At write time**: `write_concept` and `update_concept` normalize ordered-list entries before they land on disk.
- **After the fact**: the `citation-format` repair fixer applies the identical normalization to existing documents.

Sharing the function means prevention and repair cannot drift apart — a form the writer accepts is exactly the form the fixer produces.

Reader hardening in the same spirit: duplicate `# Citations` headings are **merged on read**, so an accidentally empty first section cannot mask the real entries below it. The `duplicate-citation-headings` fixer drops empty duplicates but only *reports* duplicates that both have content — it never guesses a merge (see [permissive parsing](permissive-parsing.md) for the same stance).

Citation targets classify as `external`, `concept` (including [derived cross-bundle](derived-cross-bundle-edges.md) targets), or `missing`.

The `citations-to-sources` migration fixer refuses to run on a document with malformed entries, precisely so `citation-format` can be run first and nothing is dropped in the conversion.
