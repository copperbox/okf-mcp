---
type: Design Decision
title: reload_bundles re-runs config discovery
description: Why the no-argument reload_bundles re-resolves local mounts from
  disk so a config file added or edited mid-session takes effect without a
  restart, and the boundaries of that re-discovery.
tags:
  - bundles
  - mcp
  - cli
timestamp: 2026-08-14T22:23:55.178Z
---

Config resolution used to run exactly once, at launch: the CLI resolved the
[config layers](config-file-layering.md), baked a fixed `configs` array into the
`OkfStore`, and never revisited it. `reload_bundles` only re-read the *content*
of already-mounted bundles. So the state the global-declaration shape makes
normal — a directory that starts with nothing mounted — had no in-session
recovery: adding an `okf.config.json` and reloading did nothing, and picking up
the new bundle meant restarting the server (effectively the agent).

The no-argument `reload_bundles` now **re-runs discovery** before reloading
content. The store takes an injected `rediscover` callback (`OkfStoreOptions`)
that re-resolves the local bundle set from disk — the same resolution the launch
did: config layers, `--bundle` overlays, colocated-local expansion, canonical
URLs. `reloadWithRediscovery` diffs that fresh set against what is mounted:

- **New** local ids mount and load eagerly, reported under `mounted` and as an
  all-added delta. Eager (not lazy) because an explicit reload wants them
  visible now — the whole point is that the agent could not see them before.
- **Vanished** ids unmount, reported under `unmounted` and as an all-removed
  delta.
- **Changed** configs (new root, writability) drop any stale lazy-pending entry
  so the reload loads them afresh.
- Every surviving bundle still reloads its content, exactly as before.

The tool result shape is therefore `{ mounted, unmounted, bundles }` (plus
`notes` when relevant) for the no-arg form; naming a bundle id keeps the old
targeted-reload path and returns its delta array directly.

## Boundaries, chosen deliberately

- **Local bundles only.** Remote and colocated-remote mounts stay fixed for the
  process; a new one still needs a restart or the runtime `load_remote_bundle`
  tool. They involve network fetches and their own collision rules, and the
  friction report was about local project configs.
- **A broken config never tears down a working index.** If the `rediscover`
  callback throws (malformed `okf.config.json`), the current mounts are kept and
  the failure is reported under `notes`, rather than reloading into nothing.
- **A new id colliding with a remote or colocated-remote mount is skipped**, not
  thrown, with the reason in `notes` — one bad local declaration should not fail
  the whole reload.
- **Writability is still fixed at launch.** Authoring tools are registered once,
  gated by the server-wide writable state at startup, and MCP server
  instructions cannot change mid-session. So a rediscovered bundle that declares
  `"writable": true` on a server that started read-only is mounted readable but
  not writable; the reload result says to restart. Making authoring activate
  mid-session (register the tools always, enable/disable like `get_bundle_guide`
  does via `tools/list_changed`) is a deliberate follow-up, not done here.

The CLI builds the `rediscover` closure only for the long-lived `mcp` command;
one-shot commands have no reload and pass no callback, so `reloadWithRediscovery`
degrades to a plain reload with an empty `mounted`/`unmounted` summary.

See also [config file layering](config-file-layering.md),
[lazy bundle mounting](lazy-bundle-mounting.md), and the
[OkfStore](../architecture/okf-store.md).

# Citations

[1] [src/store.ts](https://github.com/copperbox/okf-mcp/blob/main/src/store.ts)
[2] [src/cli.ts](https://github.com/copperbox/okf-mcp/blob/main/src/cli.ts)
[3] [src/server.ts](https://github.com/copperbox/okf-mcp/blob/main/src/server.ts)
