# architecture

# Concepts

* [CLI surface](cli.md) - The CLI subcommands, key flags, and which commands load bundles lazily versus eagerly.
* [MCP server surface](mcp-server.md) - How server.ts wires the store, groups its ~28 tools, composes instructions, and gates writes.
* [Module layering](module-layering.md) - The acyclic five-tier import layering of src/ and which modules are surface-only.
* [OkfStore](okf-store.md) - The store as the single mutable runtime object, and why authoring functions never mutate the in-memory index.
* [Search scoring](search-scoring.md) - How search_concepts scores hits: field weights, two-pass keyword matching, phrase bonus, and the relative relevance cutoff.
