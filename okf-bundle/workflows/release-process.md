---
type: Workflow
title: Release process
description: Releasing is bumping package.json and merging to main; the tag,
  verification gates, and npm publish are fully automated.
tags:
  - release
  - ci
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:22:07.626Z
sources:
  - id: github-workflows
    resource: https://github.com/copperbox/okf-mcp/tree/main/.github/workflows
    title: .github/workflows
---

**Releasing = bump the version in `package.json` and merge to `main`.** Everything after is automated by a three-workflow chain in `.github/workflows/`:

1. `test.yml` — on PRs to `main`: Node 22 only (deliberately narrowed from a matrix), `npm ci` → `typecheck` → `test` → `build`.
2. `tag-release.yml` — on push to `main`: reads the package version, creates and pushes `v$VERSION` if absent (skips silently if the tag exists), then explicitly dispatches `release.yml` — see [the GITHUB_TOKEN trigger gotcha](../gotchas/tag-workflow-token-limitation.md).
3. `release.yml` — on `v*` tag or dispatch: publishes via **npm trusted publishing (OIDC) with provenance** — no `NPM_TOKEN` secret exists. Requires the [npm 11 pin](../gotchas/npm-11-release-pin.md).

`release.yml` enforces three gates before `npm publish --provenance --access public`:

- The tag must match the `package.json` version.
- `dist/cli.js` must have the `#!/usr/bin/env node` shebang and the executable bit.
- `npm pack --dry-run --json` must contain nothing outside `package.json` / `README.md` / `LICENSE` / `dist/`, and must include `dist/cli.js`.

These gates are mirrored locally by `test/package.test.ts`, a release-guard test asserting `bin`, `files`, license, and that `prepack` runs the build so a publish can never ship a stale `dist` (see [testing conventions](testing-conventions.md)).
