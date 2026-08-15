# Multi-bundle setups (org brain + project brain)

One server can mount a shared org-wide brain next to the project's own bundle. In an [`okf.config.json`](configuration.md) beside the project:

```json
{
  "bundles": {
    "org": { "path": "~/brains/org", "writable": false },
    "project": { "path": "brain/", "writable": true }
  }
}
```

Writability is per bundle, so the org brain stays read-only while the project bundle takes writes. Because config files merge across directories, the committed project file can declare only `project` and leave `org` to a config higher up the tree — or to each developer's `~/.config/okf/config.json`, so nobody's local clone path ends up in the repository. With the server [declared once globally](configuration.md), an org brain in the user config is then mounted alongside whatever project you happen to be working in, and each project adds its own.

The same mounts as CLI flags — `--bundle` and `--remote-bundle` are repeatable:

```json
{
  "mcpServers": {
    "okf": {
      "command": "npx",
      "args": [
        "-y", "@copperbox/okf-mcp",
        "--bundle", "org=/absolute/path/to/org-brain-clone",
        "--bundle", "project=/absolute/path/to/this-repo/brain",
        "--writable"
      ]
    }
  }
}
```

`--writable` is server-wide, so with flags alone both bundles are writable; per-bundle control needs the config file.

If consuming the org brain is enough, mount it as a read-only GitHub tree instead — no clone to keep fresh, and `reload_bundles` refetches: `"--remote-bundle", "org=https://github.com/your-org/brain/tree/main/bundle"`, or `"remoteBundles": { "org": "https://github.com/your-org/brain/tree/main/bundle" }` in a config file.

## Routing

- Aggregate read tools — `search_concepts`, `list_concepts`, `list_types`, `list_tags`, `graph_summary`, `validate_bundle` — cover **all** bundles when the `bundle` parameter is omitted.
- Per-concept and write tools (`get_concept`, `write_concept`, …) require an explicit `bundle` once more than one is mounted, so a write always names its destination.

Split knowledge by scope: standards, environment architecture, and cross-repo system maps belong in the org bundle; decisions and gotchas specific to one repo belong in that repo's bundle.

## Referencing across bundles

Cross-bundle markdown links are not part of OKF — §6 links resolve within one bundle, so a link into another bundle indexes as broken. Instead:

- Cite the other bundle's concept in a frontmatter `sources` entry (spec §5.1) using its canonical URL — or, in a v0.1 bundle, a `# Citations` entry.
- When a real graph edge matters, add a small stub concept under `references/` (spec §6.3) that mirrors the org concept, link to the stub, and let its own `sources` entry point at the original.
- When project knowledge turns out to be org-wide, `promote_concept` moves it and leaves exactly such a stub behind, so inbound links keep resolving.

The server also *derives* cross-bundle graph edges from citations and canonical URLs — see [cross-bundle awareness](cross-bundle.md).

## Agent routing snippet

Append to the [capture instructions](agent-instructions.md):

```markdown
- Two brains are mounted: `org` (cross-project standards, environment architecture,
  system maps) and `project` (this repo's decisions, gotchas, conventions). Before
  starting work, search both — omit the `bundle` parameter so `search_concepts` and
  `graph_summary` cover all bundles, or query each in turn.
- Route writes by scope: knowledge specific to this repo goes to the `project`
  bundle. Knowledge that holds across projects — standards, shared infrastructure,
  org-wide architecture — goes to the `org` bundle; if the org brain is mounted
  read-only, record it in the project bundle and flag it for promotion.
- Never write markdown links from one bundle into another — they index as broken.
  Reference org concepts from project concepts via a `# Citations` entry using the
  org bundle's canonical URL, or through a `references/` stub concept when a graph
  edge is needed.
```
