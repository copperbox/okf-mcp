---
type: Gotcha
title: Tags pushed with GITHUB_TOKEN don't trigger workflows
description: Why tag-release.yml must explicitly dispatch release.yml instead of
  relying on the tag-push trigger.
tags:
  - release
  - ci
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:21:37.989Z
sources:
  - id: tag-release-yml
    resource: https://github.com/copperbox/okf-mcp/blob/main/.github/workflows/tag-release.yml
    title: tag-release.yml
---

GitHub Actions deliberately suppresses workflow triggers for events created with the default `GITHUB_TOKEN` (to prevent workflow recursion). So when `tag-release.yml` pushes the `v$VERSION` tag on merge to `main`, that push does **not** fire `release.yml`'s `on: push: tags` trigger.

The workaround is baked into `tag-release.yml`: after pushing the tag it explicitly runs `gh workflow run release.yml --ref <tag>`, which requires `permissions: actions: write` alongside `contents: write`.

If you ever see a version tag exist on the repo with no corresponding release run, this chain is the first place to look. If the tag already exists, `tag-release.yml` skips silently — re-releasing a version requires a manual dispatch of `release.yml`. Full chain: [release process](../workflows/release-process.md).
