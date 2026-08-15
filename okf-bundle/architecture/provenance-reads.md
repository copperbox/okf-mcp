---
type: Architecture
title: Provenance reads are derived, never stored
description: What `provenance.ts` is for — trust tiers, staleness, and the one
  place the OKF v0.1 fallbacks live.
tags:
  - modules
  - spec
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-15T21:00:00.000Z
sources:
  - id: src-provenance-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/provenance.ts
    title: src/provenance.ts
---

`provenance.ts` holds every derived read over OKF v0.2's provenance, trust, lifecycle, and computation families. It sits above `parser.ts` and below everything that consumes concepts, and it has two jobs.

**Nothing here is stored.** The spec insists on this in two places, for the same reason: a stored judgement goes stale and is unportable between consumers. §5.1 records per-source signals (`author`, `usage_count` over a `usage_window`, `last_modified`) and pointedly *not* a credibility score. §5.3 derives the trust tier from `verified` rather than writing it down. `isStale` follows suit — a plain `today >= stale_after` comparison, which is exactly why the spec chose an absolute date over a relative TTL. So this module computes; it never writes, and no caller caches what it returns.

**It is the only place the v0.1 fallbacks live.** `generatedAt` reads `generated.at` and falls back to a legacy `timestamp`; `conceptSources` returns declared `sources` and otherwise synthesizes entries from a `# Citations` list, reporting `origin` so an honest caller can say which it got. Callers ask for provenance and get it — whether the document is v0.1 or v0.2 shaped is this module's problem, not theirs. Keeping that in one file is what stops the fallback from being reimplemented slightly differently in the search path, the graph path, and the `get_sources` tool.

Two details worth knowing. `actorKind` returns undefined for a bare name like `ahormati`: it is not `human:`, so a tier-deriving consumer silently reads a person as machine-confirmed, which is why the validator warns rather than shrugging. And normalizing a bare `verified` mapping into a one-element list happens in the **parser**, not here — it is one of the few outright consumer MUSTs in §11, so nothing downstream should have to know the document could carry either shape.

[^src-provenance-ts]: src/provenance.ts
