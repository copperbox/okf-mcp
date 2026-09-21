---
type: Architecture
title: Search scoring
description: "How search_concepts scores hits: field weights, two-pass keyword
  matching, phrase bonus, the relative relevance cutoff, section-level match
  reporting, and read coverage."
tags:
  - search
generated:
  by: process:claude-code
  at: 2026-09-18T22:26:24.394Z
sources:
  - id: src-search-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/search.ts
    title: src/search.ts
verified:
  by: process:claude-code
  at: 2026-08-30T00:00:00Z
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
- **Section-level match map** (1.4.0): a body-matched hit also carries `matchedSections` — headings of every section containing a match, in document order — but only when more than one section matched (otherwise `section` already names it), or (2.1.0) when the single match anchor sits before the first heading, so `section` is absent and the hit would otherwise recommend `sections` with nothing to pass. A heading name that repeats appears once per occurrence, and `get_concept`'s `sections` returns each of them. Like the snippet anchor, the verbatim phrase wins over individual keywords so common words don't flag unrelated sections. Both fields feed `get_concept`'s `sections` / `section` arguments, the context-frugal read path.
- **Read coverage** (2.1.0): a body-matched hit in a document with sections also carries `recommendedRead`, computed from `matchedSectionCount`, `sectionCount`, `matchedCharacters`, and `documentCharacters`; the four counts ride only on `detail: "full"` hits, since the guidance tells agents to follow the recommendation rather than recompute it. `matchedCharacters` is what reading every matched section's subtree would return, so a nested match inside a matched parent counts once. `recommendedRead` is `full` when every section matched, when no section matched (the match sits before the first heading), or when the matched sections hold at least 70% of the body (`FULL_READ_THRESHOLD`); otherwise `sections`. The point is to stop agents fetching a whole document one section at a time.

Filtering (not scoring) also covers the OKF v0.2 lifecycle and trust families: `status` (an absent one counts as `stable`), `minTrust` over the derived tier, and `stale` against `stale_after`. All three are computed per call from frontmatter rather than indexed — see [provenance reads](provenance-reads.md). Since 2.0, the wire hit is concise by default: `score`, `matchedIn`, `status`, `trust`, and `stale` return only with `detail: "full"` (the [frugality decision](../decisions/context-window-frugality-is-server-surface.md)); search.ts itself still computes and returns them all.
