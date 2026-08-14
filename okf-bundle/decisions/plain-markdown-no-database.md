---
type: Design Decision
title: Plain markdown, no database, no embeddings
description: Why the knowledge base is just a directory of markdown with no
  database or embedding index.
tags:
  - philosophy
timestamp: 2026-08-14T01:19:31.305Z
---

A knowledge base is *just a directory of markdown* (a bundle). There is no database, no embeddings, no external index; [search is pure substring scoring](../architecture/search-scoring.md) computed in memory. The only network calls are optional read-only [remote bundles](remote-bundle-sandbox.md) the operator explicitly configures.

**Why:** humans must be able to edit the brain in any editor — including opening the bundle directly as an Obsidian vault (see [Obsidian compatibility](../gotchas/obsidian-compatibility.md)) — and publish it as an ordinary git repo that renders on GitHub. Any derived store would rot the moment someone edited outside the server; instead everything is re-derived from the markdown on load, and `reload_bundles` (or `--watch`) refreshes after external edits.

A consequence for the write path: the server keeps generated `index.md` navigation and `log.md` history current as agents write, so the human-browsable view never falls behind the agent-written content (see [generated indexes and scoped logs](generated-indexes-and-scoped-logs.md)).
