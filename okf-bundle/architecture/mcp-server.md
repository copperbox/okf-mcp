---
type: Architecture
title: MCP server surface
description: How server.ts wires the store, groups its ~29 tools, composes
  instructions, and gates writes.
tags:
  - mcp
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-19T21:13:54.515Z
sources:
  - id: src-server-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/server.ts
    title: src/server.ts
---

`createOkfServer(store, options)` in `src/server.ts` builds the MCP server; the [store](okf-store.md) is injected, never constructed by the server. `ServerOptions` carries `writable`, `bundleGuides`, `searchLimit`, `searchCutoff`.

## Tools by area

- **Lifecycle/mounting:** `list_bundles`, `get_bundle_guide`, `reload_bundles`, `load_remote_bundle`, `load_colocated_remote_bundles`, `list_remote_bundles`
- **Reading:** `list_concepts`, `get_concept`, `get_sources` (`get_citations` is a deprecated alias), `read_document`
- **Search/taxonomy/placement:** `search_concepts`, `list_types`, `list_tags`, `suggest_concept_path`
- **Graph:** `graph_summary`, `get_neighbors`, `find_path`, `export_graph`
- **History (git):** `concept_history`, `concept_diff` — degrade to a "not a git repository" result outside a work tree
- **Validation:** `validate_bundle`
- **Authoring (registered only under `--writable`):** `write_concept`, `update_concept`, `delete_concept`, `rename_concept`, `promote_concept`, `append_log_entry`, `regenerate_indexes` — see [read-only enforcement](../decisions/read-only-enforcement.md)

## Wiring details worth remembering

- Server **instructions** are composed from a shared OKF primer plus a writing block (only when writable) plus colocated-root `AGENTS.md` bundle guides, each budgeted at 4 000 characters — past that the server warns and injects a truncated guide pointing at `get_bundle_guide`. Since 1.4.0 the primer is context-frugality-first: search_concepts is named the entry point (list_concepts reserved for whole-catalog needs), section reads are preferred over whole documents, and orientation tools (graph_summary, list_types/list_tags, list_bundles, get_bundle_guide) are once-per-session — not to be re-fired in subagents that inherit context. With **no bundles mounted** an extra block is prepended telling the agent that this is configuration, not an empty knowledge base (see [config-file layering](../decisions/config-file-layering.md)); a test caps the mounted instructions at ~48 lines.
- `get_concept` supports three read granularities: full document, one `section` subtree, and `outline: true` (frontmatter plus each section's heading/level/char count, no body or links) — pick the smallest that answers. search_concepts hits point into them via `section`/`matchedSections`.
- `ServerOptions.writable` gates whether the authoring tools are registered at all; whether a *particular* write is allowed is `assertWritableBundle`, reading `LoadedBundle.readOnly`. Remote bundles are always read-only, and a local bundle is too when its config declares [`"writable": false`](../decisions/per-bundle-writability.md) — so the instructions tell agents to check `list_bundles`' `readOnly` before planning a write.
- `get_bundle_guide` is dynamically enabled: hidden when no colocated root is mounted, `enable()`d (firing `tools/list_changed`) when a runtime mount introduces the first root.
- `get_concept` and `search_concepts` carry `_meta["anthropic/alwaysLoad"]: true` so deferred-loading clients keep those schemas resident.
- Resources: one `okf://{bundle}/{+path}` template per document. A discovered-but-unloaded bundle is represented by its root `index.md` alone; reading it hydrates the bundle. Missing indexes are synthesized on the fly and flagged `_meta.synthesized` — the entry point for remote bundles published without index files.
- No-arg sweeps go through `sweepJson`, which appends a note listing discovered-but-unloaded bundles that were excluded (see [lazy mounting](../decisions/lazy-bundle-mounting.md)). With zero bundles they return empty results rather than erroring.
