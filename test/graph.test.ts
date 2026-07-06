import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import {
  buildGraph,
  exportGraph,
  findPath,
  getNeighbors,
  graphSummary,
  listTags,
  listTypes,
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
    assert.equal(graph.warnings.length, 1);
    assert.match(graph.warnings[0]!, /shipments/);
  });

  it("includes external targets as opaque nodes when asked", () => {
    const graph = buildGraph(bundle, { includeExternal: true });
    const external = graph.nodes.filter((n) => n.external);
    assert.ok(external.length >= 2); // resource dashboards, citations
  });

  it("summarizes types, tags, and orphans", () => {
    const summary = graphSummary(bundle);
    assert.equal(summary.concepts, 5);
    assert.equal(summary.types["BigQuery Table"], 2);
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
