---
type: Design Decision
title: Permissive parsing
description: Malformed documents are reported as problems while every valid
  concept keeps serving; the parser never throws.
tags:
  - parsing
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:19:41.197Z
sources:
  - id: src-parser-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/parser.ts
    title: src/parser.ts
---

Per OKF spec §9 the server is **permissive by design**: malformed documents are reported as `BundleProblem`s, but valid concepts keep serving. One broken file must never take down the bundle.

How that is implemented:

- `parseConceptDocument` (`src/parser.ts`) never throws — problems are reported alongside whatever was still understood.
- `splitFrontmatter` (`src/frontmatter.ts`) is equally permissive on read and never throws on a broken YAML block. The asymmetry is deliberate: `patchFrontmatter` **does** throw when there is no parseable mapping to patch, because a write must not guess.
- Unresolved links are **warnings, never errors** (§5.3), and "broken" is only claimed when the target plausibly names a concept: a `.md` target, or an extensionless target naming neither a directory nor a reserved file. Trailing-slash targets and non-`.md` extensions are exempt.
- The `test/fixtures/malformed/` bundle exists specifically to exercise this path.

Related: [read-only enforcement](read-only-enforcement.md) applies the same "report, don't guess" stance to repairs — the [repair registry](../architecture/cli.md) reports unprovable rewrites instead of applying them.
