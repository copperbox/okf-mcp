---
type: Architecture
title: Search scoring
description: "How search_concepts scores hits: field weights, two-pass keyword
  matching, phrase bonus, and the relative relevance cutoff."
tags:
  - search
timestamp: 2026-08-14T01:19:21.896Z
---

`searchConcepts` (`src/search.ts`) is pure substring filtering and scoring — no embeddings, no external index (see [no database](../decisions/plain-markdown-no-database.md)). This area evolved most recently (0.22.x), so check here before touching relevance behavior.

How scoring works:

- The query is lowercased and split on whitespace; each keyword is scored independently per field: id 5, title 5, resource 4, exact tag 4, partial tag / description 3, body 1.
- Multi-keyword queries add a bonus equal to the score of the whole phrase matched verbatim, so exact-phrase hits outrank scattered keyword hits.
- **Two-pass matching:** concepts matching *every* keyword are preferred; if none match all, it falls back to any-keyword matches and flags the result `termMatching: "any"`.
- **Relative relevance cutoff** (default 0.25 × top score, tunable via `--search-cutoff`): drops incidental low scorers when the top hit is strong, but because the threshold scales with the top score, a weak field hides nothing. Dropped hits are counted in `omitted`.
- Zero matches produce `tagHints`: existing tags related to the keywords by substring in either direction.
- Default page size is 10 (`DEFAULT_SEARCH_LIMIT`, tunable via `--search-limit`), with `offset` paging; `total` counts all matches.
- Snippets are whole-line context around the best anchor plus the enclosing section heading, truncated without splitting surrogate pairs.

# Citations

[1] [src/search.ts](https://github.com/copperbox/okf-mcp/blob/main/src/search.ts)
