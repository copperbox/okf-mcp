import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { searchConcepts } from "../src/search.js";
import type { LoadedBundle } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

describe("searchConcepts", () => {
  let bundles: LoadedBundle[];
  before(async () => {
    bundles = [await loadBundle({ id: "acme", root: FIXTURE })];
  });

  it("ranks title matches above body-only matches", () => {
    const { hits } = searchConcepts(bundles, { query: "orders" });
    assert.equal(hits[0]?.id, "tables/orders");
    assert.ok(hits.length >= 2);
  });

  it("filters by type case-insensitively", () => {
    const { hits } = searchConcepts(bundles, { types: ["bigquery table"] });
    assert.deepEqual(hits.map((h) => h.id).sort(), ["tables/customers", "tables/orders"]);
  });

  it("requires every tag with tagsAll", () => {
    const { hits } = searchConcepts(bundles, { tagsAll: ["sales", "orders"] });
    assert.deepEqual(hits.map((h) => h.id), ["tables/orders"]);
  });

  it("filters by link relationships", () => {
    const toOrders = searchConcepts(bundles, { linkedTo: "tables/orders" });
    assert.deepEqual(
      toOrders.hits.map((h) => h.id).sort(),
      ["datasets/sales", "playbooks/freshness"],
    );
    const fromSales = searchConcepts(bundles, { linkedFrom: "datasets/sales" });
    assert.deepEqual(
      fromSales.hits.map((h) => h.id).sort(),
      ["tables/customers", "tables/orders"],
    );
  });

  it("finds concepts with no resolved links via orphanOnly", () => {
    const { hits } = searchConcepts(bundles, { orphanOnly: true });
    assert.deepEqual(hits.map((h) => h.id), ["notes/no-type"]);
  });

  it("applies limit and reports the pre-pagination total", () => {
    const result = searchConcepts(bundles, { pathPrefix: "tables/", limit: 1 });
    assert.equal(result.hits.length, 1);
    assert.equal(result.total, 2);
  });
});
