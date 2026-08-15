# Update Log

## 2026-08-15
* Migration to OKF 0.2 (okf-mcp migrate): citations-to-sources (28 files), timestamp-to-generated (29 files)
* Record that --watch tracks rediscovered mounts via onMountChange

## 2026-08-14
* Give the OkfStore mutable-mounts note its own section
* Clean the OkfStore Citations section back to citation entries only
* Note reloadWithRediscovery/hasWritableBundle on the OkfStore concept
* Link config-file-layering to the new reload re-discovery decision
* Add decision: reload_bundles re-runs config discovery for local mounts
* Note the empty-mount instruction block and zero-bundle sweep behaviour
* Record that nothing-to-mount is a normal state for the mcp command
* Record the global-declaration deployment shape and its two consequences
* Refresh description for the global-declaration guidance
* Note the two-level write gate now that writability is per bundle
* Place config.ts in the module layering
* Record the configuration.md and multi-bundle config-file doc guards
* Record the okf.config.json layer and per-bundle writability in the CLI surface
* Record per-bundle writability and the discovered-config trust guard
* Record the okf.config.json layering decision
* **Creation**: Created [The 1.0 semver surface is three things](/decisions/semver-surface.md).
* **Creation**: Created [Documentation structure and guards](/workflows/documentation-structure.md).
* Repoint citation: agent guidance moved from README to docs/agent-instructions.md
* Link capture-policy concept from overview (was orphaned)
* Drop reserved index.md links from overview hub
* Move citation-form examples into a fenced block so they don't parse as links
* **Creation**: Created [Capture policy lives in agent config, not the server](/decisions/capture-policy-lives-in-agent-config.md).
* **Creation**: Created [Testing conventions](/workflows/testing-conventions.md).
* **Creation**: Created [Release process](/workflows/release-process.md).
* **Creation**: Created [Obsidian compatibility rules](/gotchas/obsidian-compatibility.md).
* **Creation**: Created [fs.watch quirks handled by the watcher](/gotchas/fs-watch-quirks.md).
* **Creation**: Created [Tags pushed with GITHUB_TOKEN don't trigger workflows](/gotchas/tag-workflow-token-limitation.md).
* **Creation**: Created [Release workflow pins npm 11](/gotchas/npm-11-release-pin.md).
* **Creation**: Created [Pack rewrites sibling links or fails](/decisions/pack-link-rewriting.md).
* **Creation**: Created [Remote bundle sandbox](/decisions/remote-bundle-sandbox.md).
* **Creation**: Created [Generated indexes and scoped logs](/decisions/generated-indexes-and-scoped-logs.md).
* **Creation**: Created [Citation normalization shares one code path](/decisions/citation-normalization.md).
* **Creation**: Created [Read-only enforcement in three layers](/decisions/read-only-enforcement.md).
* **Creation**: Created [Lazy colocated bundle mounting](/decisions/lazy-bundle-mounting.md).
* **Creation**: Created [Byte-for-byte preservation on writes](/decisions/byte-for-byte-preservation.md).
* **Creation**: Created [Document-relative links are the recommended form](/decisions/document-relative-links.md).
* **Creation**: Created [Cross-bundle edges are derived, not written](/decisions/derived-cross-bundle-edges.md).
* **Creation**: Created [Permissive parsing](/decisions/permissive-parsing.md).
* **Creation**: Created [Plain markdown, no database, no embeddings](/decisions/plain-markdown-no-database.md).
* **Creation**: Created [Search scoring](/architecture/search-scoring.md).
* Correct escape-sequence detail in CLI surface concept
* Fix garbled escaping sentence in CLI surface concept
* **Creation**: Created [CLI surface](/architecture/cli.md).
* **Creation**: Created [MCP server surface](/architecture/mcp-server.md).
* **Creation**: Created [OkfStore](/architecture/okf-store.md).
* **Creation**: Created [Module layering](/architecture/module-layering.md).
* Seed the brain: project overview hub
