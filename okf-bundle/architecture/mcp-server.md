---
type: Architecture
title: MCP server surface
description: How server.ts wires the store, groups its ~28 tools, composes
  instructions, and gates writes.
tags:
  - mcp
timestamp: 2026-08-14T01:18:24.340Z
---

`createOkfServer(store, options)` in `src/server.ts` builds the MCP server; the [store](okf-store.md) is injected, never constructed by the server. `ServerOptions` carries `writable`, `bundleGuides`, `searchLimit`, `searchCutoff`.

## Tools by area

- **Lifecycle/mounting:** `list_bundles`, `get_bundle_guide`, `reload_bundles`, `load_remote_bundle`, `load_colocated_remote_bundles`, `list_remote_bundles`
- **Reading:** `list_concepts`, `get_concept`, `get_citations`, `read_document`
- **Search/taxonomy/placement:** `search_concepts`, `list_types`, `list_tags`, `suggest_concept_path`
- **Graph:** `graph_summary`, `get_neighbors`, `find_path`, `export_graph`
- **History (git):** `concept_history`, `concept_diff` — degrade to a "not a git repository" result outside a work tree
- **Validation:** `validate_bundle`
- **Authoring (registered only under `--writable`):** `write_concept`, `update_concept`, `delete_concept`, `rename_concept`, `promote_concept`, `append_log_entry`, `regenerate_indexes` — see [read-only enforcement](../decisions/read-only-enforcement.md)

## Wiring details worth remembering

- Server **instructions** are composed from a shared OKF primer plus a writing block (only when writable) plus colocated-root `AGENTS.md` bundle guides, each budgeted at 4 000 characters — past that the server warns and injects a truncated guide pointing at `get_bundle_guide`.
- `get_bundle_guide` is dynamically enabled: hidden when no colocated root is mounted, `enable()`d (firing `tools/list_changed`) when a runtime mount introduces the first root.
- `get_concept` and `search_concepts` carry `_meta["anthropic/alwaysLoad"]: true` so deferred-loading clients keep those schemas resident.
- Resources: one `okf://{bundle}/{+path}` template per document. A discovered-but-unloaded bundle is represented by its root `index.md` alone; reading it hydrates the bundle. Missing indexes are synthesized on the fly and flagged `_meta.synthesized` — the entry point for remote bundles published without index files.
- No-arg sweeps go through `sweepJson`, which appends a note listing discovered-but-unloaded bundles that were excluded (see [lazy mounting](../decisions/lazy-bundle-mounting.md)).

# Citations

[1] [src/server.ts](https://github.com/copperbox/okf-mcp/blob/main/src/server.ts)
