# Configuration

Configuration splits in two, and keeping the halves separate is the point:

1. **Declare the server once, globally**, in whichever agent harness you use — with no arguments.
2. **Declare bundles per directory** in `okf.config.json` files, which the server discovers itself.

Then working in a directory determines which bundles are mounted, without touching any harness config. A project commits its own bundle; each developer adds personal ones locally; nothing in the committed file names a machine-specific path.

## 1. Declare the server globally

Add the server to your harness's **user-level** (global) MCP config, with no arguments:

```json
{
  "mcpServers": {
    "okf": {
      "command": "npx",
      "args": ["-y", "@copperbox/okf-mcp"]
    }
  }
}
```

In Claude Code that is `claude mcp add -s user okf -- npx -y @copperbox/okf-mcp`; other harnesses have their own global config file, but the entry is the same. Or point `node` at a local checkout you built yourself (`npm run build`): `"command": "node", "args": ["/absolute/path/to/okf-mcp/dist/cli.js"]`.

This works because harnesses launch a stdio MCP server with the working directory set to the project you have open, and the server resolves its bundles from there. One declaration serves every project, and in directories that configure nothing it simply serves an empty set rather than failing.

Nothing stops you from passing `--bundle` flags in a per-project server declaration instead — see [CLI flags](#alternative-cli-flags) below — but flags cannot compose across scopes, which is what the rest of this page is about.

## 2. Declare bundles per directory

Put an `okf.config.json` beside the project:

```json
{
  "bundles": {
    "brain": { "path": "okf-bundle/", "writable": true }
  }
}
```

Commit it: paths resolve against the config file, so the mount means the same thing on every machine.

### Composing layers

Layers apply lowest precedence first:

1. the user config, `~/.config/okf/config.json`
   (or `$XDG_CONFIG_HOME/okf/config.json`; `$OKF_CONFIG_HOME` overrides both)
2. `okf.config.json`, then `okf.config.local.json`, in every directory from the
   filesystem root down to the working directory
3. CLI flags

Bundles and remote bundles are keyed by id, colocated roots by resolved path or URL. A higher layer **replaces** an entry with the same key and **adds** everything else, so layers accumulate rather than shadow one another. Scalars (`searchLimit`, `searchCutoff`) are last-wins.

```
~/.config/okf/config.json      { "bundles": { "user": { "path": "~/notes", "writable": true } } }
~/projects/okf.config.json     { "bundles": { "team": "~/projects/team-brain" } }
~/projects/app/okf.config.json { "bundles": { "brain": { "path": "okf-bundle/", "writable": true } } }   ← committed
```

Working in `~/projects/app` mounts all three. Working in a different project under `~/projects` mounts `user` and `team` plus whatever that project declares.

The same thing cannot be expressed in harness config: MCP client configs key servers by name and have no merge semantics, so a second file declaring `okf` replaces the first outright instead of adding to it. That is the friction this file layer removes.

For a personal bundle you do not want in a committed file, use `okf.config.local.json` beside it and add that name to `.gitignore` — it applies after `okf.config.json` in the same directory.

Add `"root": true` to stop the upward search at that directory. Discovery can be bypassed entirely with `--config <file>` (use only that file) or `--no-config` (use none); both are also settable as `OKF_CONFIG` and `OKF_NO_CONFIG=1`.

### Put your personal bundle in the user config

With a global server declaration, `~/.config/okf/config.json` is the natural home for a bundle you want everywhere — preferences, environment notes, cross-project conventions:

```json
{
  "bundles": {
    "user": { "path": "~/notes/brain", "writable": true }
  }
}
```

Mounting it there means every project sees it alongside whatever that project declares, with nothing repeated per repo.

A global declaration is launched in **every** directory you open, including ones that configure nothing. That is fine: the server starts and serves an empty set, reporting `serving no bundles over stdio` on stderr and telling the agent that nothing is mounted for this directory. Only the one-shot CLI commands treat having nothing to mount as a usage error, since those were typed deliberately.

### Writability

Writability is per bundle. `"writable": true` on a bundle enables authoring for it; a file-level `"writable": true` sets the default for every bundle in that file, and a per-bundle value still wins:

```json
{
  "writable": true,
  "bundles": {
    "brain": "okf-bundle/",
    "reference": { "path": "../vendor-docs", "writable": false }
  }
}
```

Declaring any bundle writable enables the authoring tools, so `--writable` is not needed alongside a config file. When you do pass `--writable`, it applies to every bundle that does not declare its own value — including CLI `--bundle` mounts, which is how the flag has always behaved.

One guard: a **discovered** config file can only grant write access to paths inside its own directory. A repository you cloned must not be able to mount `~/notes` writable just because you opened it. Such a grant is downgraded to read-only with a warning on stderr; declare the bundle in your user config, or pass the file explicitly with `--config`, to allow it. This is worth knowing when a project mounts a bundle living in another checkout: from the project's own config that mount is read-only, and making it writable means moving the declaration up to the user config.

### Full schema

Every key is optional.

```jsonc
{
  "root": false,          // stop the upward search at this directory
  "writable": false,      // default writability for this file's bundles

  "bundles": {
    "brain": "okf-bundle/",                                  // shorthand: just the path
    "team": { "path": "~/brains/team", "writable": false, "canonicalUrl": "https://..." }
  },

  "colocatedRoots": [
    "~/brains",                                              // shorthand: just the path
    { "path": "~/brains", "only": ["team", "ops"], "writable": true, "canonicalUrl": "https://..." }
  ],

  "remoteBundles": {
    "specs": "https://github.com/acme/specs/tree/main",      // shorthand: just the URL
    "docs": { "url": "https://example.com/docs.tar.gz", "include": ["**/*.md"], "exclude": ["drafts/**"] }
  },

  "colocatedRemoteRoots": [
    "https://github.com/acme/brains/tree/main",
    { "url": "https://acme.example/brains.tar.gz", "only": ["ops"] }
  ],

  "searchLimit": 10,
  "searchCutoff": 0.25
}
```

Paths are resolved against the config file's own directory and a leading `~` expands to your home directory. The file is strict JSON — no comments. Unknown keys are ignored with a warning, so a config written for a newer version still loads.

## Alternative: CLI flags

Nothing here is required. Mounting entirely through flags works exactly as it always has, and is the simpler choice for a single fixed bundle used from one project:

```json
{
  "mcpServers": {
    "okf": {
      "command": "npx",
      "args": [
        "-y", "@copperbox/okf-mcp",
        "--bundle", "brain=/absolute/path/to/your/bundle",
        "--writable"
      ]
    }
  }
}
```

Notes:

- `--bundle` accepts `path` or `id=path` (id defaults to the directory basename) and is repeatable.
- Omit `--writable` for a read-only server. The flag is server-wide; per-bundle control needs a config file.
- Flags do not disable discovery — they apply *above* every config layer, so they override rather than replace: a `--bundle` reusing a config file's id wins, and any other configured bundle still mounts. In a directory with no config files anywhere above it, flags are the only source and behave exactly as before. To guarantee that regardless of what config files exist, pass `--no-config` (or set `OKF_NO_CONFIG=1`).
- Works from a standing start: point `--bundle` at an empty directory with `--writable` and the first `write_concept` creates the folder structure, indexes, and log.
- `--watch` auto-reloads local bundles when `.md` files change on disk (see [CLI](cli.md)). Without it, call `reload_bundles` after editing bundle files outside the server.

See also: [multi-bundle setups](multi-bundle.md), [colocated bundles](colocated-bundles.md), [teaching your agent](agent-instructions.md).
