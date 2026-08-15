---
type: Design Decision
title: The server's actor, and why it is never human by default
description: Where `generated.by` comes from on every write, and the trust-tier
  reason the default is a tool identity rather than a person.
tags:
  - authoring
  - spec
generated:
  by: okf-mcp/1.3.0
  at: 2026-08-15T21:00:00.000Z
sources:
  - id: src-provenance-ts
    resource: https://github.com/copperbox/okf-mcp/blob/main/src/provenance.ts
    title: src/provenance.ts
  - id: okf-spec
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: Open Knowledge Format specification
  - id: docs-configuration
    resource: https://github.com/copperbox/okf-mcp/blob/main/docs/configuration.md
    title: docs/configuration.md
---

OKF v0.2 requires `by` within `generated`, so a server that stamps provenance needs an identity. okf-mcp has one: `SERVER_ACTOR`, built as `okf-mcp/<package version>` — the spec's `<producer>/<version>` form for an agent or tool.[^okf-spec] It is read from `package.json` rather than hardcoded, for the same reason the MCP handshake version is: a stale copy would misreport what actually produced a concept.

Precedence, lowest first: `SERVER_ACTOR` → the `actor` key in `okf.config.json` → `--actor` → a per-call `actor` on `update_concept`.

**Why the default is not `human:`.** Trust tiers are derived, not stored: a concept verified only by non-`human:` actors is machine-confirmed, and one verified by any `human:<id>` is human-reviewed. That prefix is the entire signal. A server defaulting to a person's id would mark everything it writes as human-reviewed, destroying the distinction the tier exists to carry — and it would be false, because the server is not a person. Setting `actor: "human:<id>"` in config is supported and correct for a single-human deployment, and wrong for a shared one; the [configuration docs](https://github.com/copperbox/okf-mcp/blob/main/docs/configuration.md) say so explicitly.[^docs-configuration]

The same reasoning governs `verified`. The server never writes it — an agent or human does, deliberately, because "someone checked this" is a claim only they can make.

[^src-provenance-ts]: src/provenance.ts
[^okf-spec]: Open Knowledge Format specification
[^docs-configuration]: docs/configuration.md
