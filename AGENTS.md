## Knowledge capture (OKF brain)

This project keeps a persistent knowledge base (the "brain") behind the `okf` MCP server.

- Before starting non-trivial work, check the brain: orient with `graph_summary`, then
  `search_concepts` for anything related to the task, and treat what you find as prior
  context.
- When you learn something durable — a decision and its rationale, a gotcha, how a
  system actually works, a convention worth keeping — record it before finishing:
  call `suggest_concept_path` to pick a placement, then `write_concept`. Prefer
  updating an existing concept over creating a near-duplicate.
- Always give every concept a `description` in frontmatter: a single short, consice
  sentence of clear prose that says at a high levelwhat the concept is about. A signposts,
  not a summary. Its job is to let a reader decide whether they need to open the concept,
  so name the topic and leave the specifics inside the body where they are discoverable.
- Keep concepts small and linked: one idea per concept, document-relative markdown
  links (`../tables/orders.md`) to related concepts, and reuse existing types and tags.
- Don't record ephemera (task status, one-off debugging detail) — the brain is for
  knowledge that should still be true next month.
- After writing durable knowledge to a shared brain, commit and push it if you're
  authorized to, or remind the user to — until then the new knowledge is invisible
  to teammates.

## Knowledge reconciliation (OKF brain)

Capture keeps the brain growing; reconciliation keeps it true.

- **IMPORTANT**: Before ending any task that changed the project, collect two small sets:
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