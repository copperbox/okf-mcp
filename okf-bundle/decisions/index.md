# decisions

# Concepts

* [Byte-for-byte preservation on writes](byte-for-byte-preservation.md) - Edits splice the document as it exists on disk so human formatting, comments, and concurrent edits survive agent writes.
* [Capture policy lives in agent config, not the server](capture-policy-lives-in-agent-config.md) - The server teaches OKF mechanics but stays unopinionated about when knowledge is captured, and performs no git sync.
* [Citation normalization shares one code path](citation-normalization.md) - Write-time citation normalization and the after-the-fact repair fixer share the same function so prevention and repair cannot drift.
* [Bundle mounts layer through okf.config.json](config-file-layering.md) - Why mount declarations moved out of MCP client config into discovered config files, how the layers merge, and the global-declaration deployment shape it enables.
* [Cross-bundle edges are derived, not written](derived-cross-bundle-edges.md) - Why OKF gets no cross-bundle link syntax and how cross-bundle graph edges are derived from spec-clean data instead.
* [Document-relative links are the recommended form](document-relative-links.md) - Why bundle-absolute links are discouraged and how link parsing and rewriting preserve author intent.
* [Generated indexes and scoped logs](generated-indexes-and-scoped-logs.md) - How index.md regeneration, the generated:false opt-out, root-frontmatter carry-over, and nearest-existing-log routing work.
* [Lazy colocated bundle mounting](lazy-bundle-mounting.md) - Colocated bundles are discovered cheaply at startup and fully parsed only on first access, with sweeps reporting what they excluded.
* [Pack rewrites sibling links or fails](pack-link-rewriting.md) - Packing rewrites relative sibling links to canonical URLs and refuses to ship a link it cannot resolve.
* [Writability is per bundle, and a cloned config cannot grant it](per-bundle-writability.md) - How the server-wide --writable flag and a config file's per-bundle writable interact, plus the trust guard on discovered configs.
* [Permissive parsing](permissive-parsing.md) - Malformed documents are reported as problems while every valid concept keeps serving; the parser never throws.
* [Plain markdown, no database, no embeddings](plain-markdown-no-database.md) - Why the knowledge base is just a directory of markdown with no database or embedding index.
* [Read-only enforcement in three layers](read-only-enforcement.md) - How writability is enforced at the bundle flag, per-tool assertion, and tool-registration levels, and which commands respect it.
* [reload_bundles re-runs config discovery](reload-bundles-re-runs-config-discovery.md) - Why the no-argument reload_bundles re-resolves local mounts from disk so a config file added or edited mid-session takes effect without a restart, and the boundaries of that re-discovery.
* [Remote bundle sandbox](remote-bundle-sandbox.md) - The safety caps and guarantees around loading remote bundles from GitHub trees and archives.
* [The 1.0 semver surface is three things](semver-surface.md) - What semver covers since 1.0.0 — MCP tools, CLI, and the curated index.ts barrel — and why the barrel was pruned before the bump.
