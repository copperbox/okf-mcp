---
type: Architecture
title: Module layering
description: The acyclic five-tier import layering of src/ and which modules are
  surface-only.
tags:
  - modules
timestamp: 2026-08-14T01:18:00.711Z
---

Imports across `src/` are strictly acyclic and form five tiers:

```
L0 leaves      types.ts        frontmatter.ts   git.ts
L1 parse       parser.ts       canonical.ts
L2 model       bundle.ts
L3 features    search  graph  suggest  authoring  validate  remote  visualize
L4 composite   store.ts (bundle+remote)   repair  promote  pack  watch (store)
L5 surfaces    server.ts (MCP)   cli.ts   index.ts (public re-export barrel)
```

Notable asymmetries between the two surfaces:

- `server.ts` does **not** import `remote`, `pack`, `repair`, `visualize`, or `watch`. Remote loading reaches the server only through the [store](okf-store.md); pack, repair, visualize, and watch are CLI-only features.
- `cli.ts` does not import `git`, `promote`, or `suggest` — those are server-only (`concept_history`/`concept_diff`, `promote_concept`, `suggest_concept_path`).

Other roles worth knowing: `types.ts` is the OKF v0.1 vocabulary with spec-section doc comments and holds `RESERVED_FILENAMES = ["index.md", "log.md"]`; `parser.ts` is single-document parsing (links, sections, citations) and never throws (see [permissive parsing](../decisions/permissive-parsing.md)); `canonical.ts` maps GitHub URLs to bundles for [derived cross-bundle edges](../decisions/derived-cross-bundle-edges.md); `authoring.ts` is the **only** concept write path; `index.ts` contains no logic.

# Citations

[1] [src/](https://github.com/copperbox/okf-mcp/tree/main/src)
