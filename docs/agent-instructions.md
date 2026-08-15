# Teaching your agent to maintain the brain

The server is deliberately unopinionated about *when* knowledge gets captured. Its built-in instructions teach connected agents the OKF conventions and the write flow (`suggest_concept_path` → `write_concept`), but capture policy belongs in your agent's own configuration — `CLAUDE.md`, `AGENTS.md`, or the system prompt, whichever your client reads. The same holds in reverse: nothing tells an agent to re-check existing concepts after changing what they describe, and capture without reconciliation produces a brain that grows and rots at the same time.

The server also performs no git sync. A shared bundle is only as fresh as its clone's last `git pull`, and writes reach teammates only after an out-of-band commit and push — so syncing belongs in the same standing instructions.

## Capture

Copy into your agent config and adjust to taste:

```markdown
## Knowledge capture (OKF brain)

This project keeps a persistent knowledge base (the "brain") behind the `okf` MCP server.

- Before starting non-trivial work, check the brain: orient with `graph_summary`, then
  `search_concepts` for anything related to the task, and treat what you find as prior
  context.
- When you learn something durable — a decision and its rationale, a gotcha, how a
  system actually works, a convention worth keeping — record it before finishing:
  call `suggest_concept_path` to pick a placement, then `write_concept`. Prefer
  updating an existing concept over creating a near-duplicate.
- Keep concepts small and linked: one idea per concept, document-relative markdown
  links (`../tables/orders.md`) to related concepts, and reuse existing types and tags.
- Record where the knowledge came from in `sources`, and attribute a specific claim
  with a footnote keyed to that entry's `id`. Set `stale_after` when something has a
  known shelf life, and `status: draft` when you are not confident yet.
- Don't record ephemera (task status, one-off debugging detail) — the brain is for
  knowledge that should still be true next month.
- If the brain is shared (a clone of a team repo), the server never syncs git for you.
  Before relying on it, make sure the clone is current — run `git pull` in the bundle
  repo, then call `reload_bundles` so the index picks up the changes. For
  `--remote-bundle` mounts, calling `reload_bundles` refetches.
- After writing durable knowledge to a shared brain, commit and push it if you're
  authorized to, or remind the user to — until then the new knowledge is invisible
  to teammates.
```

## Reconciliation

Capture keeps the brain growing; reconciliation keeps it true. A change that falsifies a concept is worse than a missing concept — the next agent is told to trust the brain, so a stale claim misleads more than a gap.

```markdown
## Knowledge reconciliation (OKF brain)

Capture keeps the brain growing; reconciliation keeps it true.

- Before ending any task that changed the project, collect two small sets:
  the concepts you read while working, and the concepts that describe what
  you changed (`search_concepts` for the paths, symbols, and feature names
  in your diff).
- For each concept in either set, do exactly one of:
  - **Update** it (`update_concept`) if any claim is now false. Watch
    especially for claims that invert silently: "X does not exist" when
    your change created X, and any open-status flag your work closed.
  - **Verify** it: you checked and it still holds.
  - **Explain**: if you leave a concept untouched that names something you
    changed, say why when you report your work.
- Keep it bounded: only concepts intersecting your work, never a
  bundle-wide audit.
- If the bundle is not mounted `--writable`, report the needed updates
  instead of editing.
```

The claims that rot fastest are the ones no diff ever touches: absence claims and status flags are falsified by changes that create something new, so no file the concept cites is ever modified.

OKF v0.2 gives reconciliation real vocabulary for this. `verified: {by, at}` records that someone checked a concept against reality, which is a different fact from `generated`, when it was last *written* — a concept can be rewritten without re-confirmation, and re-confirmed without a rewrite. So the **verify** branch above can now leave a trace instead of being silent:

```markdown
  - **Verify** it: you checked and it still holds — record that with
    `verified: {by: <your actor>, at: <ISO now>}` so the next agent can tell a
    checked concept from an unexamined one. Use `human:<id>` only for a human's
    own sign-off; `search_concepts` derives its human-reviewed tier from that
    prefix.
```

Two things follow. `search_concepts` can now find what needs attention rather than waiting for a diff to point at it — `{stale: true}` surfaces concepts past their `stale_after`, and `{minTrust: "unverified"}` surfaces ones nothing has ever confirmed. And the "explain" branch can escalate from convention to gate once tooling computes which concepts a diff intersects.

For routing guidance when several brains are mounted, see [multi-bundle setups](multi-bundle.md).
