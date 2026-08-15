---
type: Gotcha
title: Release workflow pins npm 11
description: Why release.yml installs npm@11 explicitly and must not move to npm 12.
tags:
  - release
  - ci
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:21:28.946Z
sources:
  - id: release-yml
    resource: https://github.com/copperbox/okf-mcp/blob/main/.github/workflows/release.yml
    title: release.yml
---

`release.yml` runs `npm install -g npm@11` before publishing, for two stacked reasons:

1. **OIDC trusted publishing needs npm >= 11.5.1**, which the Node 22 runner does not bundle. The workflow publishes with `--provenance` and `id-token: write` — there is no `NPM_TOKEN` secret anywhere.
2. **npm 12 is broken twice over** for this workflow: `npm pack --json` changed output shape (breaking the pack-verification gate), and `npm publish --provenance` crashes with sigstore missing.

So the pin is to major 11, not latest. If a release fails around pack verification or provenance, check whether the npm version on the runner changed before debugging anything else. See the [release process](../workflows/release-process.md) for the full chain and its gates.
