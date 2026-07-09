import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { buildBundle, loadBundle } from "../src/bundle.js";
import { canonicalUrlPrefixes } from "../src/canonical.js";
import {
  buildGraph,
  buildMultiGraph,
  deriveCrossBundleEdges,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
  listTags,
  listTypes,
  neighborsInGraph,
  pathInGraph,
  qualifyNodeId,
} from "../src/graph.js";
import type { LoadedBundle } from "../src/types.js";
import { makeBundle } from "./helpers.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

describe("graph", () => {
  let bundle: LoadedBundle;
  before(async () => {
    bundle = await loadBundle({ id: "acme", root: FIXTURE });
  });

  it("builds one edge per resolved link and warns on broken links", () => {
    const graph = buildGraph(bundle);
    assert.equal(graph.nodes.length, 5);
    assert.equal(graph.edges.length, 6); // includes both orders→customers links (schema + citation)
    // Broken .md and extensionless links both count (issue #49).
    assert.equal(graph.warnings.length, 2);
    assert.ok(graph.warnings.some((w) => /shipments/.test(w)));
    assert.ok(graph.warnings.some((w) => /retired-runbook/.test(w)));
  });

  it("includes external targets as opaque nodes when asked", () => {
    const graph = buildGraph(bundle, { includeExternal: true });
    const external = graph.nodes.filter((n) => n.external);
    assert.ok(external.length >= 2); // resource dashboards, citations
  });

  it("summarizes types, tags, and orphans", () => {
    const summary = graphSummary(bundle);
    assert.equal(summary.okfVersion, "0.1");
    assert.equal(summary.concepts, 5);
    assert.equal(summary.types["BigQuery Table"], 2);
    assert.equal(summary.brokenLinks, 2); // shipments (.md) + retired-runbook (extensionless)
    assert.deepEqual(summary.orphans, ["notes/no-type"]);
  });

  it("lists types sorted by count", () => {
    assert.deepEqual(listTypes([bundle]), [
      { type: "BigQuery Table", count: 2 },
      { type: "", count: 1 },
      { type: "BigQuery Dataset", count: 1 },
      { type: "Playbook", count: 1 },
    ]);
  });

  it("lists tags sorted by count", () => {
    assert.deepEqual(listTags([bundle]), [
      { tag: "sales", count: 3 },
      { tag: "customers", count: 1 },
      { tag: "incident", count: 1 },
      { tag: "oncall", count: 1 },
      { tag: "orders", count: 1 },
    ]);
  });

  it("counts vocabulary case-insensitively but preserves first-seen casing", () => {
    const synthetic = makeBundle([
      { id: "a", type: "BigQuery Table", tags: ["OnCall"] },
      { id: "b", type: "bigquery table", tags: ["oncall", "Sales"] },
    ]);
    assert.deepEqual(listTypes([synthetic]), [{ type: "BigQuery Table", count: 2 }]);
    assert.deepEqual(listTags([synthetic]), [
      { tag: "OnCall", count: 2 },
      { tag: "Sales", count: 1 },
    ]);
  });

  it("aggregates vocabulary across multiple bundles", () => {
    const other = makeBundle([{ id: "c", type: "Playbook", tags: ["sales"] }]);
    const types = listTypes([bundle, other]);
    assert.deepEqual(types.find((t) => t.type === "Playbook"), {
      type: "Playbook",
      count: 2,
    });
    assert.deepEqual(listTags([bundle, other])[0], { tag: "sales", count: 4 });
  });

  it("returns bounded neighbors in both directions", () => {
    const result = getNeighbors(bundle, "tables/orders", "both", 1);
    const ids = result.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, [
      "datasets/sales",
      "playbooks/freshness",
      "tables/customers",
      "tables/orders",
    ]);
  });

  it("finds a shortest directed path", () => {
    assert.deepEqual(findPath(bundle, "playbooks/freshness", "tables/customers"), [
      "playbooks/freshness",
      "tables/orders",
      "tables/customers",
    ]);
    assert.equal(findPath(bundle, "tables/customers", "playbooks/freshness"), null);
  });

  it("exports dot and mermaid formats", () => {
    const graph = buildGraph(bundle);
    assert.match(exportGraph(graph, "dot"), /digraph okf \{/);
    assert.match(exportGraph(graph, "mermaid"), /^graph TD/);
  });
});

describe("cross-bundle graph", () => {
  const ORG_URL = "https://github.com/acme/org-brain/tree/main";
  const NAMING_URL = "https://github.com/acme/org-brain/blob/main/standards/naming.md";

  const org = () =>
    buildBundle(
      "org",
      ORG_URL,
      [
        {
          path: "standards/naming.md",
          source:
            "---\ntype: Standard\ntitle: Naming\n---\n\nSee [reviews](/standards/reviews.md).\n",
        },
        {
          path: "standards/reviews.md",
          source:
            // Self-citation via the org bundle's own canonical URL: stays in-bundle.
            `---\ntype: Standard\n---\n\n# Citations\n\n[1] [Naming](${NAMING_URL})\n`,
        },
      ],
      { readOnly: true, canonicalUrls: canonicalUrlPrefixes(ORG_URL) },
    );

  const proj = () =>
    buildBundle("proj", "/proj", [
      {
        path: "guides/setup.md",
        source: `---
type: Guide
title: Setup
resource: ${ORG_URL}/standards/reviews.md
---

Also see [the docs](https://example.com/docs).

# Citations

[1] [Naming standard](${NAMING_URL})
[2] [Naming standard again](${NAMING_URL}#conventions)
`,
      },
    ]);

  it("derives edges from citation and resource URLs matching another bundle's canonical location", () => {
    const edges = deriveCrossBundleEdges([proj(), org()]);
    assert.deepEqual(edges, [
      { from: "proj:guides/setup", to: "org:standards/naming", kind: "cross-bundle" },
      { from: "proj:guides/setup", to: "org:standards/reviews", kind: "cross-bundle" },
    ]);
  });

  it("never derives an edge into the concept's own bundle", () => {
    assert.deepEqual(deriveCrossBundleEdges([org()]), []);
  });

  it("builds a multi-bundle graph with namespaced nodes and distinct derived edges", () => {
    const graph = buildMultiGraph([proj(), org()]);
    const ids = graph.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, [
      "org:standards/naming",
      "org:standards/reviews",
      "proj:guides/setup",
    ]);
    const setup = graph.nodes.find((n) => n.id === "proj:guides/setup")!;
    assert.equal(setup.bundle, "proj");
    assert.ok(
      graph.edges.some(
        (e) =>
          e.from === "org:standards/naming" &&
          e.to === "org:standards/reviews" &&
          e.kind === undefined,
      ),
    );
    assert.ok(
      graph.edges.some(
        (e) =>
          e.from === "proj:guides/setup" &&
          e.to === "org:standards/naming" &&
          e.kind === "cross-bundle",
      ),
    );
  });

  it("does not duplicate a matched URL as an external node", () => {
    const graph = buildMultiGraph([proj(), org()], { includeExternal: true });
    const external = graph.nodes.filter((n) => n.external).map((n) => n.id);
    // proj's matched citations are suppressed; org's self-bundle citation is
    // not a cross-bundle match, so it stays an ordinary external link.
    assert.deepEqual(external, ["https://example.com/docs", NAMING_URL]);
  });

  it("expands neighbors across bundles, carrying the target's bundle ID", () => {
    const graph = buildMultiGraph([proj(), org()]);
    const result = neighborsInGraph(
      graph,
      qualifyNodeId("proj", "guides/setup"),
      "both",
      1,
    );
    const naming = result.nodes.find((n) => n.id === "org:standards/naming");
    assert.equal(naming?.bundle, "org");
  });

  it("finds paths that traverse derived edges", () => {
    const graph = buildMultiGraph([proj(), org()]);
    assert.deepEqual(
      pathInGraph(graph, "proj:guides/setup", "org:standards/reviews"),
      ["proj:guides/setup", "org:standards/reviews"],
    );
    assert.equal(pathInGraph(graph, "org:standards/naming", "proj:guides/setup"), null);
  });

  it("reports derived cross-bundle edge counts in the summary", () => {
    const bundles = [proj(), org()];
    assert.equal(graphSummary(bundles[0]!, bundles).crossBundleEdges, 2);
    assert.equal(graphSummary(bundles[1]!, bundles).crossBundleEdges, 2);
    assert.equal(graphSummary(bundles[0]!).crossBundleEdges, 0);
  });

  it("renders derived edges visually distinct in dot and mermaid exports", () => {
    const graph = buildMultiGraph([proj(), org()]);
    assert.match(
      exportGraph(graph, "dot"),
      /"proj:guides\/setup" -> "org:standards\/naming" \[style=dashed\];/,
    );
    assert.match(exportGraph(graph, "mermaid"), /n\d+ -\.-> n\d+/);
  });
});

describe("colocated cross-bundle links", () => {
  const acme = (colocatedRoot: string | null = "/vault") =>
    buildBundle(
      "acme",
      "/vault/acme",
      [{ path: "tables/orders.md", source: "---\ntype: Table\n---\n\nRows.\n" }],
      colocatedRoot === null ? {} : { colocatedRoot },
    );

  const ops = (colocatedRoot: string | null = "/vault") =>
    buildBundle(
      "ops",
      "/vault/ops",
      [
        {
          path: "runbooks/freshness.md",
          source: [
            "---",
            "type: Runbook",
            "---",
            "",
            "Check [orders](../../acme/tables/orders.md) and",
            "[the same, extensionless](../../acme/tables/orders).",
            "Ignore [a missing sibling concept](../../acme/tables/shipments.md),",
            "[an unmounted folder](../../lore/tales.md), and",
            "[an escape](../../../elsewhere/thing.md).",
          ].join("\n"),
        },
      ],
      colocatedRoot === null ? {} : { colocatedRoot },
    );

  it("derives edges from ../sibling links between colocated bundles, deduplicated", () => {
    // The .md and extensionless links to the same concept collapse into one
    // edge; unresolvable targets derive nothing.
    assert.deepEqual(deriveCrossBundleEdges([ops(), acme()]), [
      { from: "ops:runbooks/freshness", to: "acme:tables/orders", kind: "cross-bundle" },
    ]);
  });

  it("derives nothing between non-colocated mounts", () => {
    assert.deepEqual(deriveCrossBundleEdges([ops(null), acme(null)]), []);
    // A ../ link only reaches bundles declaring the *same* colocated root.
    assert.deepEqual(deriveCrossBundleEdges([ops("/vault"), acme("/other")]), []);
    assert.deepEqual(deriveCrossBundleEdges([ops("/vault"), acme(null)]), []);
  });

  it("carries colocated edges into the multi-bundle graph and the summary", () => {
    const bundles = [ops(), acme()];
    const graph = buildMultiGraph(bundles);
    assert.ok(
      graph.edges.some(
        (e) =>
          e.from === "ops:runbooks/freshness" &&
          e.to === "acme:tables/orders" &&
          e.kind === "cross-bundle",
      ),
    );
    assert.equal(graphSummary(bundles[0]!, bundles).crossBundleEdges, 1);
    assert.equal(graphSummary(bundles[1]!, bundles).crossBundleEdges, 1);
  });
});
