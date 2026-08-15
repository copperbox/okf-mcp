---
type: Design Decision
title: Document-relative links are the recommended form
description: Why bundle-absolute links are discouraged and how link parsing and
  rewriting preserve author intent.
tags:
  - links
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-14T01:20:04.274Z
sources:
  - id: src-parser-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/parser.ts
    title: src/parser.ts
  - id: src-authoring-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/authoring.ts
    title: src/authoring.ts
---

Relationships are ordinary markdown links; **document-relative** targets (`./customers.md`, `../tables/orders.md`) are the recommended form because they resolve identically in the link graph, on GitHub, and in Obsidian. Bundle-absolute (`/tables/orders.md`) is accepted but discouraged: GitHub resolves a leading `/` from the *repository* root, so absolute links render broken whenever the bundle is a repo subfolder. `validate` warns on them unconditionally and the `absolute-links-to-relative` repair fixer rewrites them.

Parsing and rewriting details that keep this honest:

- Link syntax inside fenced code blocks is code, not a link — the same fence rule applies to headings. **Inline code spans are not exempt**: example link syntax in backticks still parses as a link (and warns if it looks like a missing concept), so put illustrative link syntax in a fenced block.
- Every parsed link records the byte offsets of its raw target, so renames and repairs **splice** the original source rather than regenerating it (a pillar of [byte-for-byte preservation](byte-for-byte-preservation.md)).
- `.md` is optional in targets (Obsidian extensionless links resolve — see [Obsidian compatibility](../gotchas/obsidian-compatibility.md)).
- `renderTarget` (`src/authoring.ts`) preserves the original link *form* on rewrite: absolute stays absolute, relative is recomputed from the new directory (keeping a written `./`), extensionless stays extensionless, and `#fragment`/`?query` suffixes carry over.
