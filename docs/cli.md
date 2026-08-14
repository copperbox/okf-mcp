# CLI

```
okf-mcp [--bundle [id=]<path>] [--colocated-bundles <root> [--only <a,b,c>]]
        [--remote-bundle id=<url>] [--colocated-remote-bundles <url>]
        [--canonical-url [id=]<url>] [--writable] [--watch]
        [--config <file> | --no-config]
        [--search-limit <n>] [--search-cutoff <ratio>] [command]

  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report conformance errors and warnings (exit 1 on errors)
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format] [bundle]
                      Export the link graph (json | dot | mermaid | html)
  index               Regenerate index.md files (requires --writable)
  pack [bundle]       Publish a bundle as a distributable archive
  repair [bundle]     Detect and auto-fix known bundle defect classes
                      (dry-run by default; --write applies)
```

Every command reads the same `okf.config.json` layers the MCP server does, so `okf-mcp inspect` with no flags works in a configured project. With nothing to mount, `mcp` still starts and serves an empty set — a globally declared server has to survive directories that configure nothing — while the one-shot commands exit 2 with a usage error. `--config <file>` uses one file and skips discovery; `--no-config` ignores config files entirely (both also settable as `OKF_CONFIG` / `OKF_NO_CONFIG=1`).

Mounting flags and the config file are covered in [configuration](configuration.md), [colocated bundles](colocated-bundles.md), and [remote bundles](remote-bundles.md); `--canonical-url` in [cross-bundle awareness](cross-bundle.md).

## graph

With several bundles mounted and no bundle argument, everything exports as one merged graph — node IDs namespaced `bundle:concept`, derived [cross-bundle edges](cross-bundle.md) rendered dashed in `dot`/`mermaid`. Name a bundle to scope the export. `--include-external` adds external link targets as opaque nodes; `--out <file>` writes to a file.

The `html` format renders **one self-contained interactive page** — embedded data plus a hand-rolled force simulation on `<canvas>`, no CDN or network — shareable anywhere a browser opens it:

```bash
okf-mcp --colocated-bundles /path/to/vault graph html --out graph.html
```

Nodes are colored by community with a click-to-focus legend: a merged export groups by **bundle** (cross-bundle edges emphasized in dashed gold); a single bundle groups by concept **type** unless `--community folder` or `--community tag` overrides (`--community` is rejected on a merged graph — name a bundle). Edges carry direction arrowheads, node radius scales with degree, hover shows id/title/description/tags, clicking highlights neighbors, and a search box filters by substring; the view supports dragging, wheel zoom, and panning. Embedded titles are escaped so a `</script>` in a document cannot break out of the page.

## pack

`pack` emits a `.tar.gz` (or `.zip`, by `--out` extension) of a mounted bundle — the counterpart of `--remote-bundle`, which loads such archives back:

```bash
okf-mcp --bundle brain=/path/to/bundle pack --out brain.tar.gz --exclude 'drafts/**'
```

`index.md` files are regenerated in-memory so the archive is self-describing; root frontmatter is preserved and hand-curated indexes travel verbatim. The source bundle is never written, so `pack` needs no `--writable` and read-only remote bundles can be re-exported. Repeatable `--include`/`--exclude` globs select content.

Relative `../sibling/...` links into [colocated](colocated-bundles.md) siblings only mean something while the shared layout holds, so the archived copy carries the sibling's canonical concept URL instead (blob form for GitHub). A resolving link whose sibling has no canonical URL fails the pack rather than shipping a dead link.

## repair

`repair` runs a registry of named auto-fixers — a bundle doctor pairing detection with mechanical, provably-safe splice-based rewrites (formatting and unknown frontmatter survive byte-for-byte outside the touched spans). Dry-run by default; `--write` applies, appends a `log.md` sweep entry, and regenerates indexes. Unprovable rewrites are reported, never guessed; read-only remote bundles are skipped. `--list` prints the registry; under this command `--only` names **fixers**, not subfolders:

```bash
okf-mcp --bundle ./kb repair                              # dry-run: report findings
okf-mcp --bundle ./kb repair --only citation-format --write
okf-mcp repair --list
```

Fixers: `citation-format` (ordered-list citations → spec §8 form, the same transformation the write paths apply), `duplicate-citation-headings` (drop empty duplicate `# Citations` sections; report content-bearing duplicates for manual merge), `okf-uri-to-canonical` (rewrite `okf://` targets to canonical URLs once configured), `absolute-links-to-relative` (bundle-absolute → document-relative links).

## --watch

`--watch` (mcp only) auto-reloads local bundles when `.md` files change, debounced so an editor save burst triggers one reload; dot directories are ignored. Remote bundles still reload only via `reload_bundles`. Where recursive `fs.watch` is unsupported, the server logs a note and continues without watching.
