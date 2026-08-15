---
type: Design Decision
title: Writability is per bundle, and a cloned config cannot grant it
description: How the server-wide --writable flag and a config file's per-bundle
  writable interact, plus the trust guard on discovered configs.
tags:
  - bundles
  - authoring
  - security
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T19:53:58.748Z
sources:
  - id: src-config-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/config.ts
    title: src/config.ts
  - id: src-bundle-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/bundle.ts
    title: src/bundle.ts
---

`--writable` was server-wide: every local bundle was writable or none was, so
mixing a writable project brain with a read-only shared one meant mounting the
shared one as a remote bundle just to borrow its read-only-ness. A config file
declares writability per bundle instead.

The resolution rules, chosen so nothing about the flag's old behaviour changed:

- `BundleConfig.writable` is tri-state. `loadBundle` marks a bundle read-only
  only on an explicit `false`; `undefined` means *undeclared* and defers to the
  server-wide gate, which is exactly how `--bundle` flags have always behaved.
- A config file's per-bundle `writable` wins over that file's file-level
  `writable` default, which defaults to `false`. Config-declared bundles are
  therefore opt-in writable, while flag-declared bundles keep following
  `--writable`.
- Declaring **any** bundle writable turns on the authoring tools, so
  `--writable` is unnecessary alongside a config file. `createOkfServer`'s
  `writable` option stays the switch for whether the tools exist at all;
  `assertWritableBundle` is the per-bundle enforcement, and it already existed
  for remote bundles.

The trust guard: a **discovered** config file may only grant write access to
paths inside its own directory. Otherwise cloning a repository would let its
committed `okf.config.json` mount `~/notes` writable the moment you opened the
folder. An out-of-tree grant is downgraded to read-only with a warning on
stderr naming the fix. The user config and an explicitly passed `--config` file
are trusted — both were named by the person running the server, not by a
repository.

Reading a bundle from anywhere stays unrestricted: the grant is the dangerous
half, not the mount.

See also [config file layering](config-file-layering.md).
