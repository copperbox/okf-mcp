---
type: Overview
title: okf-mcp project overview
description: What the okf-mcp project is and how this brain bundle is organized.
tags:
  - orientation
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:24:12.814Z
sources:
  - id: okf-mcp-repository
    resource: https://github.com/copperbox/okf-mcp
    title: okf-mcp repository
  - id: okf-v0-1-spec
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: OKF v0.1 spec
---

okf-mcp (`@copperbox/okf-mcp`) is an MCP server and CLI over **OKF (Open Knowledge Format) v0.1** bundles: directories of plain markdown concept documents with YAML frontmatter, indexed into a link graph and exposed to AI agents through MCP resources and tools for search, traversal, validation, and authoring. It is a small ESM TypeScript package (Node >= 20) with only three runtime dependencies: the MCP SDK, `yaml`, and `zod`.

This bundle is the project's own brain — the project dogfoods itself via `.mcp.json`, which mounts `okf-bundle/` writable as bundle `brain`.

## How this bundle is organized

- **architecture/** — how the code is structured: [module layering](architecture/module-layering.md), the [store](architecture/okf-store.md), the [MCP server surface](architecture/mcp-server.md), the [CLI](architecture/cli.md), and [search scoring](architecture/search-scoring.md).
- **decisions/** — durable design decisions and their rationale, e.g. [no database or embeddings](decisions/plain-markdown-no-database.md), [permissive parsing](decisions/permissive-parsing.md), [derived cross-bundle edges](decisions/derived-cross-bundle-edges.md), [byte-for-byte preservation](decisions/byte-for-byte-preservation.md), and [capture policy living in agent config](decisions/capture-policy-lives-in-agent-config.md).
- **gotchas/** — traps that cost time once and shouldn't again, mostly around [releases](gotchas/npm-11-release-pin.md) and platform quirks.
- **workflows/** — how work gets done: the [release process](workflows/release-process.md) and [testing conventions](workflows/testing-conventions.md).
