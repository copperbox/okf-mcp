---
type: Design Decision
title: Bundle mounts layer through okf.config.json
description: Why mount declarations moved out of MCP client config into
  discovered config files, how the layers merge, and the global-declaration
  deployment shape it enables.
tags:
  - bundles
  - cli
  - mcp
timestamp: 2026-08-14T21:06:02.897Z
---

MCP client configs (`.mcp.json` and every harness equivalent) key servers **by
name** and have no merge semantics: a second file declaring `okf` replaces the
first outright rather than unioning its arguments. That makes the ordinary
request — commit the project bundle, add personal bundles locally — impossible
to express, in every client. `src/config.ts` moves mount declarations into
files the server discovers itself, so the client config shrinks to
`npx -y @copperbox/okf-mcp` with no arguments and composition happens here,
identically for every harness.

Layers apply lowest precedence first:

1. the user config — `$OKF_CONFIG_HOME`, else `$XDG_CONFIG_HOME/okf`, else `~/.config/okf/config.json`
2. `okf.config.json` then `okf.config.local.json` in every directory from the
   filesystem root down to the working directory
3. CLI flags

Bundles and remote bundles are keyed by id, colocated roots by resolved path or
URL: a higher layer **replaces** the same key and **adds** everything else, so
layers accumulate instead of shadowing. Scalars (`searchLimit`, `searchCutoff`)
are last-wins. `"root": true` truncates the upward walk; `--config`/`OKF_CONFIG`
uses one file and skips discovery; `--no-config`/`OKF_NO_CONFIG=1` skips all of
them.

## The deployment shape this unlocks

The documented setup is now: declare the server **once, globally**, in the
harness with no arguments, and let each directory decide what it mounts. This
works because harnesses launch a stdio MCP server with the working directory
set to the project the user has open — verified against running Claude Code
servers, whose `/proc/<pid>/cwd` is the project root. Discovery walks up from
there.

Two consequences to keep in mind:

- A globally declared server is launched in **every** directory, including ones
  configuring nothing, where it exits 2 on "nothing to mount" and the harness
  reports a failed server. One bundle in the user config avoids that
  everywhere at once, which is why the docs push personal bundles there.
- Flags do not disable discovery; they layer above it. Mounting purely through
  flags is unchanged in a directory with no config files, and `--no-config`
  guarantees it regardless.

## Deliberate choices worth keeping

- **Paths resolve against the config file's own directory**, not the cwd, so a
  committed config means the same thing however the server was launched. A
  leading `~` expands. Together these are what make the file committable, and
  they mean only *discovery* depends on cwd, never the mounts themselves.
- **Discovery is an upward walk, not a single cwd read.** A parent directory
  holding several repos is a natural home for a shared mount, and it is the
  layer the original friction report was actually about.
- **Strict JSON, no comments**, and unknown keys warn rather than fail — a
  config written for a newer version still loads.
- **One-shot CLI commands read the same layers**, so `okf-mcp inspect` with no
  flags works in a configured project.

Test isolation depends on this being switchable: `runCli` in `test/cli.test.ts`
sets `OKF_NO_CONFIG=1` so neither the repo's own `okf.config.json` nor anything
in an ancestor of a developer's checkout leaks into unrelated CLI assertions.
That helper also resolves `tsx` to an absolute specifier, because tests that run
the CLI from a temp cwd cannot resolve a bare module name against it.

See also [per-bundle writability](per-bundle-writability.md) and the
[CLI surface](../architecture/cli.md).

# Citations

[1] [src/config.ts](https://github.com/copperbox/okf-mcp/blob/main/src/config.ts)
[2] [docs/configuration.md](https://github.com/copperbox/okf-mcp/blob/main/docs/configuration.md)
