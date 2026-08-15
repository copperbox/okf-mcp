---
type: Design Decision
title: The write vocabulary follows the bundle, not the server
description: How okf-mcp decides whether to write a concept in OKF v0.1 or v0.2
  frontmatter, and why upgrading the server never converts a bundle by itself.
tags:
  - authoring
  - spec
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-15T21:00:00.000Z
sources:
  - id: src-authoring-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/authoring.ts
    title: src/authoring.ts
  - id: okf-spec
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: Open Knowledge Format specification
---

OKF v0.2 renamed two things v0.1 documents carry: `timestamp` became `generated: {by, at}`, and the body `# Citations` list became the frontmatter `sources` list.[^okf-spec] Both v0.1 forms stay readable forever — the spec blesses the fallbacks in its §13.1 — so the interesting question is not what to *read* but what to *write*.

Writing whichever vocabulary the server happens to implement is the wrong answer. It produces documents that are neither cleanly v0.1 nor cleanly v0.2, and a consumer that prefers one silently ignores the other. Merely upgrading okf-mcp would then half-migrate every bundle the first time an agent touched it.

So the vocabulary is a property of the **bundle**, resolved by `bundleVocabulary`:

- A root `index.md` declaring `okf_version` decides it outright.
- Undeclared, the bundle's own documents decide: one already carrying `generated`/`sources`/`verified` is v0.2, one carrying only `timestamp` is v0.1.
- An empty bundle gets the current version.

Inferring rather than defaulting is the whole point — a v0.1 bundle that never declared a version is still recognizably v0.1, and treating it as new would be the silent conversion this exists to prevent.

Everything downstream keys off this: `writeConcept`/`updateConcept` stamp `generated` or `timestamp` accordingly, `generateIndexes` stamps the matching `okf_version`, and [promote_concept](../architecture/mcp-server.md) leaves a `sources` stub or a `# Citations` stub to match. Converting a bundle is [an explicit, one-way migration](okf-0.2-migration-is-its-own-command.md), never a side effect of a write.

An explicit `generated` **or** `timestamp` in a caller's frontmatter always wins, in either vocabulary — otherwise a caller deliberately writing a v0.1 `timestamp` would also get a `generated` it never asked for, which is exactly the mixed state described above. `validate_bundle` warns when a document ends up carrying both.

[^src-authoring-ts]: src/authoring.ts
[^okf-spec]: Open Knowledge Format specification
