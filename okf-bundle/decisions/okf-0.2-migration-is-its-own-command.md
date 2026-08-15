---
type: Design Decision
title: Migration is its own command, not a repair fixer
description: Why converting a bundle to OKF v0.2 lives in `okf-mcp migrate`
  rather than the repair sweep, and how it handles the actor it cannot infer.
tags:
  - cli
  - spec
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-15T21:00:00.000Z
sources:
  - id: src-repair-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/repair.ts
    title: src/repair.ts
  - id: src-cli-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/cli.ts
    title: src/cli.ts
---

The [repair registry](../architecture/cli.md) was the obvious home for the v0.1 → v0.2 conversion, and it is the wrong one. Every fixer in `FIXERS` normalizes *form*: safe to run on any bundle at any time, idempotent, and never a decision. The two migration fixers rewrite a document's *vocabulary* — one-way, and a choice about the bundle as a whole.

So they live in a separate `MIGRATION_FIXERS` registry behind `okf-mcp migrate`. `selectFixers` takes a registry argument and, when `--only` names a fixer from the other one, says which command owns it rather than reporting it as unknown. Both commands share `repairBundle`'s machinery — dry-run by default, splice-based edits, a `log.md` sweep entry, regenerated indexes.

Three things the migration deliberately refuses to do:

- **`citations-to-sources`** reports rather than merges when a document has both a `# Citations` section and a `sources` list. Deciding which entries are duplicates is a judgement call.
- **`timestamp-to-generated`** reports rather than guessing when no actor is configured. `generated.by` is information a v0.1 document does not contain, and [a fabricated one is worse than no migration](server-actor.md) because trust tiers derive from exactly that field.
- **The version stamp goes last**, and only when nothing was left unfixed. `okf_version: "0.2"` is what flips the [write vocabulary](write-vocabulary-follows-the-bundle.md); setting it over half-converted documents is how a bundle ends up permanently mixed.

**The actor, in practice.** Refusing outright was the first design and it was too strict: a one-off migration should not require editing a config file you then have to remember to remove. So `--write` without an actor prompts, offering the server's own actor as the default and `cancel` as the way out. Non-interactive runs (CI, piped stdin) take the server actor without asking — honest, since okf-mcp really is what rewrote the files, and the `<producer>/<version>` form never inflates a tier.

**`--write` needs a scope.** An unscoped `migrate --write` used to sweep every mounted bundle, which converted a user-config bundle mounted in every directory during development of this feature. With more than one bundle mounted it now requires a named bundle or `--all`. `repair` keeps the unscoped sweep because its fixers are form-only and idempotent; this one is not.

[^src-repair-ts]: src/repair.ts
[^src-cli-ts]: src/cli.ts
