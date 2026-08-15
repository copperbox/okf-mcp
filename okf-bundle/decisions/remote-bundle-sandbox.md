---
type: Design Decision
title: Remote bundle sandbox
description: The safety caps and guarantees around loading remote bundles from
  GitHub trees and archives.
tags:
  - remote
  - security
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:21:07.762Z
sources:
  - id: src-remote-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/remote.ts
    title: src/remote.ts
  - id: src-pack-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/pack.ts
    title: src/pack.ts
---

Remote bundles (`--remote-bundle`, `load_remote_bundle`, colocated-remote variants) index a published bundle without cloning: a GitHub tree API walk, or a `.tar.gz`/`.tgz`/`.zip` archive read by hand-rolled minimal tar and zip readers in `src/remote.ts`. All remote bundles are read-only (see [read-only enforcement](read-only-enforcement.md)) and live in memory only.

Sandbox guarantees:

- Only `.md` files are fetched; content is parsed as markdown, never executed, never written to disk.
- `GITHUB_TOKEN` is used for rate limits and **never sent to non-GitHub hosts**; archive fetches from arbitrary hosts send no auth headers at all.
- Caps enforced *before* unpacking: compressed download size (10 MiB), an unpacked-gunzip cap (decompression-bomb guard), then 500 files / 10 MiB summed per bundle (`MAX_REMOTE_FILES`, `MAX_REMOTE_BYTES`). For colocated remote roots the ceilings apply across the **whole root**, not per bundle.
- Path normalization rejects traversal entries, skips dot files and macOS zip junk, and strips a single GitHub-style top-level wrapper directory — `packBundle` deliberately *adds* that wrapper so pack → load round-trips. Zip64 is unsupported.
- Remote bundles have no directory to watch; they refresh only via `reload_bundles`.

Trivia: `pack` carries a hand-rolled CRC-32 table because `zlib.crc32` requires Node 20.15+ and the package supports Node >= 20.
