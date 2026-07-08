import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { searchConcepts } from "../src/search.js";
import type { LoadedBundle } from "../src/types.js";
import { makeBundle } from "./helpers.js";

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

  it("derives hit titles from the filename when frontmatter has none", () => {
    const synthetic = makeBundle([{ id: "docs/customer-order-history", type: "Doc" }]);
    const { hits } = searchConcepts([synthetic]);
    assert.equal(hits[0]?.title, "Customer Order History");
    assert.equal(hits[0]?.titleDerived, true);
  });

  it("passes authored titles through without the titleDerived flag", () => {
    const { hits } = searchConcepts(bundles, { query: "orders" });
    const orders = hits.find((h) => h.id === "tables/orders");
    assert.equal(orders?.title, "Orders");
    assert.equal(orders?.titleDerived, undefined);
  });

  it("includes the resource URI in hits when present, omitting it otherwise", () => {
    const { hits } = searchConcepts(bundles, {});
    const orders = hits.find((h) => h.id === "tables/orders");
    assert.equal(
      orders?.resource,
      "https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders",
    );
    const freshness = hits.find((h) => h.id === "playbooks/freshness");
    assert.ok(freshness);
    assert.equal("resource" in freshness, false);
  });

  it("matches the text query against the resource URI", () => {
    const { hits } = searchConcepts(bundles, { query: "t=customers" });
    assert.deepEqual(hits.map((h) => h.id), ["tables/customers"]);
    assert.deepEqual(hits[0]?.matchedIn, ["resource"]);
  });

  it("filters by exact resource URI", () => {
    const { hits, total } = searchConcepts(bundles, {
      resource: "https://console.cloud.google.com/bigquery?p=acme&d=sales",
    });
    assert.equal(total, 1);
    assert.deepEqual(hits.map((h) => h.id), ["datasets/sales"]);
  });

  it("finds nothing for a resource URI no concept carries", () => {
    const { total } = searchConcepts(bundles, { resource: "bq://acme/sales/refunds" });
    assert.equal(total, 0);
  });

  it("applies limit and reports the pre-pagination total", () => {
    const result = searchConcepts(bundles, { pathPrefix: "tables/", limit: 1 });
    assert.equal(result.hits.length, 1);
    assert.equal(result.total, 2);
  });

  it("reports matchedIn and a body snippet for body matches", () => {
    const { hits } = searchConcepts(bundles, { query: "lags more than" });
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.id, "playbooks/freshness");
    assert.deepEqual(hit.matchedIn, ["body"]);
    // the matched line, markdown intact, plus the following line for context
    assert.ok(hit.snippet?.includes("[orders](/tables/orders.md) lags more than"));
    assert.ok(hit.snippet?.includes("30 minutes behind its SLA"));
  });

  it("omits the snippet when the query only matched frontmatter", () => {
    const { hits } = searchConcepts(bundles, { query: "registered" });
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.equal(hit.id, "tables/customers");
    assert.deepEqual(hit.matchedIn, ["description"]);
    assert.equal("snippet" in hit, false);
    assert.equal("section" in hit, false);
  });

  it("reports the enclosing section heading for body matches", () => {
    const { hits } = searchConcepts(bundles, { query: "lags more than" });
    assert.equal(hits[0]?.section, "Trigger");
  });

  it("omits the section when the body match precedes any heading", () => {
    const body = "The needle sits in the preamble.\n\n# Later\n\nMore text.\n";
    const { hits } = searchConcepts(
      [makeBundle([{ id: "notes/pre", type: "Note", body }])],
      { query: "needle" },
    );
    assert.deepEqual(hits[0]?.matchedIn, ["body"]);
    assert.equal("section" in hits[0]!, false);
  });

  it("lists every matched field in matchedIn", () => {
    const { hits } = searchConcepts(bundles, { query: "orders" });
    const hit = hits.find((h) => h.id === "tables/orders");
    assert.deepEqual(hit?.matchedIn, ["id", "title", "resource", "tags", "body"]);
    assert.ok(hit?.snippet?.includes("orders"));
  });

  it("omits matchedIn and snippet when no query is given", () => {
    const { hits } = searchConcepts(bundles, { pathPrefix: "tables/" });
    for (const hit of hits) {
      assert.equal("matchedIn" in hit, false);
      assert.equal("snippet" in hit, false);
    }
  });

  it("caps snippet length on long lines, keeping the match visible", () => {
    const body = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
    const { hits } = searchConcepts([makeBundle([{ id: "notes/long", type: "Note", body }])], { query: "needle" });
    const snippet = hits[0]?.snippet;
    assert.ok(snippet !== undefined);
    assert.ok(snippet.includes("needle"));
    assert.ok(snippet.length <= 260, `snippet too long: ${snippet.length}`);
    assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
  });

  it("never splits multi-byte characters when truncating", () => {
    const body = `${"😀".repeat(200)}needle${"😀".repeat(200)}`;
    const { hits } = searchConcepts([makeBundle([{ id: "notes/long", type: "Note", body }])], { query: "needle" });
    const snippet = hits[0]?.snippet;
    assert.ok(snippet !== undefined);
    assert.ok(snippet.includes("needle"));
    const loneSurrogate = /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    assert.doesNotMatch(snippet, loneSurrogate, "snippet contains a lone surrogate");
  });
});
