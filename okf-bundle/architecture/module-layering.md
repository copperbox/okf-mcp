---
type: Architecture
title: Module layering
description: The acyclic five-tier import layering of src/ and which modules are
  surface-only.
tags:
  - modules
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T19:55:18.656Z
sources:
  - id: src
    resource: https://github.com/copperbox/okf-mcp/tree/main/src
    title: src/
---

Imports across `src/` are strictly acyclic and form five tiers:

```
L0 leaves      types.ts    frontmatter.ts   git.ts   version.ts
L1 parse       parser.ts   canonical.ts     config.ts
L1.5 derive    provenance.ts (parser)
L2 model       bundle.ts
L3 features    search  graph  suggest  authoring  validate  remote  visualize
L4 composite   store.ts (bundle+remote)   repair  promote  pack  watch (store)
L5 surfaces    server.ts (MCP)   cli.ts   index.ts (curated public barrel)
```

Notable asymmetries between the two surfaces:

- `server.ts` does **not** import `remote`, `pack`, `repair`, `visualize`, `watch`, or `config`. Remote loading reaches the server only through the [store](okf-store.md); pack, repair, visualize, and watch are CLI-only features; [config-file resolution](../decisions/config-file-layering.md) happens in `cli.ts` before the store is built, so the server only ever sees resolved `BundleConfig`s.
- `cli.ts` does not import `git`, `promote`, or `suggest` — those are server-only (`concept_history`/`concept_diff`, `promote_concept`, `suggest_concept_path`).
- `config.ts` depends only on `types.ts` (plus node builtins), which is what lets it sit below `bundle.ts` and be exported from the barrel for embedders wanting the same layering semantics.

Other roles worth knowing: `types.ts` is the OKF v0.2 vocabulary with spec-section doc comments and holds `RESERVED_FILENAMES = ["index.md", "log.md"]`; `parser.ts` is single-document parsing (links, sections, citations, and the §6.2 [frontmatter path links](../decisions/frontmatter-paths-are-graph-links.md)) and never throws (see [permissive parsing](../decisions/permissive-parsing.md)); [`provenance.ts`](provenance-reads.md) is the derived reads over the v0.2 trust/lifecycle families and the single home of the v0.1 fallbacks; `version.ts` is just the package version, shared by the MCP handshake and the [server actor](../decisions/server-actor.md); `canonical.ts` maps GitHub URLs to bundles for [derived cross-bundle edges](../decisions/derived-cross-bundle-edges.md); `authoring.ts` is the **only** concept write path; `index.ts` contains no logic and, since 1.0.0, is a deliberately **curated** export surface rather than a re-export of everything (see [the semver surface decision](../decisions/semver-surface.md)).
