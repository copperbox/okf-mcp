# decisions

# Concepts

* [Byte-for-byte preservation on writes](byte-for-byte-preservation.md) - Edits splice the document as it exists on disk so human formatting, comments, and concurrent edits survive agent writes.
* [Capture policy lives in agent config, not the server](capture-policy-lives-in-agent-config.md) - The server teaches OKF mechanics but stays unopinionated about when knowledge is captured, and performs no git sync.
* [Citation normalization shares one code path](citation-normalization.md) - Write-time citation normalization and the after-the-fact repair fixer share the same function so prevention and repair cannot drift.
* [Cross-bundle edges are derived, not written](derived-cross-bundle-edges.md) - Why OKF gets no cross-bundle link syntax and how cross-bundle graph edges are derived from spec-clean data instead.
* [Document-relative links are the recommended form](document-relative-links.md) - Why bundle-absolute links are discouraged and how link parsing and rewriting preserve author intent.
* [Generated indexes and scoped logs](generated-indexes-and-scoped-logs.md) - How index.md regeneration, the generated:false opt-out, root-frontmatter carry-over, and nearest-existing-log routing work.
* [Lazy colocated bundle mounting](lazy-bundle-mounting.md) - Colocated bundles are discovered cheaply at startup and fully parsed only on first access, with sweeps reporting what they excluded.
* [Pack rewrites sibling links or fails](pack-link-rewriting.md) - Packing rewrites relative sibling links to canonical URLs and refuses to ship a link it cannot resolve.
* [Permissive parsing](permissive-parsing.md) - Malformed documents are reported as problems while every valid concept keeps serving; the parser never throws.
* [Plain markdown, no database, no embeddings](plain-markdown-no-database.md) - Why the knowledge base is just a directory of markdown with no database or embedding index.
* [Read-only enforcement in three layers](read-only-enforcement.md) - How writability is enforced at the bundle flag, per-tool assertion, and tool-registration levels, and which commands respect it.
* [Remote bundle sandbox](remote-bundle-sandbox.md) - The safety caps and guarantees around loading remote bundles from GitHub trees and archives.
* [The 1.0 semver surface is three things](semver-surface.md) - What semver covers since 1.0.0 — MCP tools, CLI, and the curated index.ts barrel — and why the barrel was pruned before the bump.
