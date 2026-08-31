# Context-efficiency benchmark

Experimental harness for A/B-testing how much conversation context okf-mcp
responses consume. It is not shipped with the package (`files` in package.json
only includes `dist` and `README.md`).

The harness starts an in-memory server over two bundles — the `acme` test
fixture and a deterministic ~130-concept synthetic bundle generated in a temp
dir — then replays a realistic agent session (orient, research, maintenance)
and measures each tool response's serialized size in UTF-8 bytes plus an
estimated token count (chars / 4 — a rough heuristic, fine for deltas). It
also reports the session-fixed costs: server instructions length and the
summed size of the advertised tool definitions (name, description, and the
zod-derived JSON schema, as `tools/list` returns them).

A "fixed cost by feature set" section additionally measures the tool-definition
cost of servers started with the experimental `features` option (feature-group
toolset gating): all features writable and read-only, `["read"]`, and
`["read", "graph"]`. Edit `FEATURE_SETS` in `context-bench.ts` to compare other
sets; the section is additive, so baselines recorded before it exist still diff
cleanly.

## Running

```sh
npm run bench                                        # human-readable table
npm run bench --silent -- --json > run.json          # machine-readable results
npm run bench -- --baseline bench/baselines/2.0.0.json   # deltas vs a saved run
```

The process exits non-zero if any benchmark call returned a tool error, since
error responses make sizes incomparable.

## Adding scenarios

Scenarios are data: edit the `SCENARIOS` array in `context-bench.ts`. Each
scenario is a named list of `{ label, tool, args }` calls; the `label` must be
stable and unique within its scenario because baseline comparison matches rows
by `scenario` + `label`. If a call needs richer synthetic content, extend
`writeSyntheticBundle` — keep it deterministic so runs stay diffable.

## Baselines

Save a baseline after a meaningful change on a branch you want to compare
against:

```sh
npm run bench --silent -- --json > bench/baselines/<version-or-experiment>.json
```

Then run experiments with `--baseline <that file>` to see per-call, fixed-cost,
and grand-total deltas (bytes and %). `bench/baselines/2.0.0.json` is the
pre-experiment reference for the 2.0 context-efficiency work.
