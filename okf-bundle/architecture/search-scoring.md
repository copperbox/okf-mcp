---
type: Architecture
title: Search scoring
description: "How search_concepts scores hits: field weights, two-pass keyword
  matching, phrase bonus, the relative relevance cutoff, and section-level match
  reporting."
tags:
  - search
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-19T21:13:34.547Z
sources:
  - id: src-search-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/search.ts
    title: src/search.ts
---

`searchConcepts` (`src/search.ts`) is pure substring filtering and scoring — no embeddings, no external index (see [no database](../decisions/plain-markdown-no-database.md)). This area evolved most recently (0.22.x), so check here before touching relevance behavior.

How scoring works:

- The query is lowercased and split on whitespace; each keyword is scored independently per field: id 5, title 5, resource 4, exact tag 4, partial tag / description 3, body 1.
- Multi-keyword queries add a bonus equal to the score of the whole phrase matched verbatim, so exact-phrase hits outrank scattered keyword hits.
- **Two-pass matching:** concepts matching *every* keyword are preferred; if none match all, it falls back to any-keyword matches and flags the result `termMatching: "any"`.
- **Relative relevance cutoff** (default 0.25 × top score, tunable via `--search-cutoff`): drops incidental low scorers when the top hit is strong, but because the threshold scales with the top score, a weak field hides nothing. Dropped hits are counted in `omitted`.
- Zero matches produce `tagHints`: existing tags related to the keywords by substring in either direction.
- Default page size is 10 (`DEFAULT_SEARCH_LIMIT`, tunable via `--search-limit`), with `offset` paging; `total` counts all matches.
- Snippets are whole-line context around the best anchor plus the enclosing `section` heading, truncated without splitting surrogate pairs.
- **Section-level match map** (1.4.0): a body-matched hit also carries `matchedSections` — headings of every section containing a match, in document order — but only when more than one section matched (otherwise `section` already names it). Like the snippet anchor, the verbatim phrase wins over individual keywords so common words don't flag unrelated sections. Both fields feed `get_concept`'s `section` argument, the context-frugal read path.

Filtering (not scoring) also covers the OKF v0.2 lifecycle and trust families: `status` (an absent one counts as `stable`), `minTrust` over the derived tier, and `stale` against `stale_after`. All three are computed per call from frontmatter rather than indexed — see [provenance reads](provenance-reads.md) — and every hit reports its `status` and `trust`, plus `stale: true` when it applies.
