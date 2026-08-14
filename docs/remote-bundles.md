# Remote bundles (knowledge exchange)

Index a bundle published in another repository without cloning it, straight from a public GitHub tree:

```bash
okf-mcp --remote-bundle okf=https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf inspect
```

In a [config file](configuration.md) the same mount is `{ "remoteBundles": { "okf": "https://github.com/.../tree/main/okf" } }`, with the object form taking `include`, `exclude`, and `canonicalUrl`; published colocated roots go in `colocatedRemoteRoots`.

`--remote-bundle id=url` is repeatable and takes a `https://github.com/<owner>/<repo>/tree/<ref>/<path>` URL (refs containing `/` are unsupported), or a `.tar.gz` / `.tgz` / `.zip` archive detected by extension — any http(s) URL, or a local archive path. The runtime equivalent is the `load_remote_bundle` tool (`{ id, url, include?, exclude?, canonicalUrl? }`, glob filters over bundle-relative paths), which mutates only the in-memory index; `list_remote_bundles` lists what is loaded.

## Consuming a published colocated root by one URL

A [colocated root](colocated-bundles.md) published as a single repo can be mounted whole, each subfolder becoming its own read-only bundle:

```bash
okf-mcp --colocated-remote-bundles https://github.com/acme/knowledge/tree/main inspect
```

The same discovery rules as local roots apply (immediate markdown-bearing subdirectories, folder name as id, dot dirs skipped, collisions are errors). The mounted bundles share the root URL as their colocated root, so relative `../sibling/...` links derive [cross-bundle edges](cross-bundle.md) between the remote siblings. Tree mounts derive each bundle's canonical URL as `<treeUrl>/<folder>`; archive roots have no per-file URLs, so they derive canonicals only from an explicit root `canonicalUrl`. `--only` restricts the mount as for local roots, and the size ceilings below apply across the whole root — not per bundle.

A root `AGENTS.md` travels with the mount as a [bundle guide](colocated-bundles.md#root-agentsmd-the-bundle-guide). The runtime counterpart, `load_colocated_remote_bundles`, returns the guide inline in its result (`agentsGuide`) — MCP instructions are fixed at initialization — and registers `get_bundle_guide` via `tools/list_changed`. Reloading any mounted bundle refetches the whole root, tracking subfolders that appeared or vanished upstream.

## Sandbox

Remote bundles are strictly read-only and sandboxed:

- Only `.md` files are indexed (GitHub trees via the contents API; `GITHUB_TOKEN` is used for rate limits when set, never sent to non-GitHub hosts), bounded to 500 files / 10 MiB per bundle; archive downloads capped at 10 MiB compressed.
- Archive entries with path traversal are rejected; a single top-level wrapper directory (as in GitHub source tarballs) is stripped; zip64 is unsupported.
- Content is parsed as markdown, never executed, never written to disk.
- All authoring tools reject read-only bundles; `regenerate_indexes` and the `index` command skip them.
- `reload_bundles` refetches, reporting the same added/removed/changed delta as local bundles.
