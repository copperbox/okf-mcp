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
    const { hits } = searchConcepts(bundles, { query: "orders", cutoffRatio: 0 });
    assert.equal(hits[0]?.id, "tables/orders");
    assert.ok(hits.length >= 2);
  });

  it("drops low scorers below the relevance cutoff and reports them as omitted", () => {
    const { hits, total, omitted } = searchConcepts(bundles, { query: "orders" });
    // tables/orders matches in id/title/resource/tags; body-only matches
    // elsewhere score far below a quarter of that and are suppressed.
    assert.deepEqual(hits.map((h) => h.id), ["tables/orders"]);
    assert.equal(total, 1);
    assert.ok((omitted ?? 0) >= 1);
  });

  it("keeps uniformly weak hits — the cutoff is relative, not absolute", () => {
    const synthetic = makeBundle([
      { id: "notes/a", type: "Note", body: "slack mentioned in passing" },
      { id: "notes/b", type: "Note", body: "slack also here" },
    ]);
    const { hits, omitted } = searchConcepts([synthetic], { query: "slack" });
    // Both score 1 (body only); threshold 1 × 0.25 hides neither.
    assert.equal(hits.length, 2);
    assert.equal(omitted, undefined);
  });

  it("disables the cutoff when cutoffRatio is 0", () => {
    const { hits, omitted } = searchConcepts(bundles, { query: "orders", cutoffRatio: 0 });
    assert.ok(hits.length >= 2);
    assert.equal(omitted, undefined);
  });

  it("applies the cutoff before pagination, so total reflects surviving hits", () => {
    const specs = Array.from({ length: 15 }, (_, i) => ({
      id: `notes/weak-${String(i).padStart(2, "0")}`,
      type: "Note",
      body: "slack in the body only",
    }));
    specs.push({ id: "notes/strong", type: "Note", body: "" });
    const synthetic = makeBundle(specs);
    synthetic.concepts.get("notes/strong")!.frontmatter.tags = ["slack"];
    const { hits, total, omitted } = searchConcepts([synthetic], { query: "slack" });
    // Strong tag hit (4) sets threshold 1; body-only hits (1) survive it.
    assert.equal(total, 16);
    assert.equal(omitted, undefined);
    assert.equal(hits.length, 10); // default page size
    assert.equal(hits[0]?.id, "notes/strong");
  });

  it("defaults to 10 hits per page, pageable via offset", () => {
    const synthetic = makeBundle(
      Array.from({ length: 12 }, (_, i) => ({
        id: `notes/n-${String(i).padStart(2, "0")}`,
        type: "Note",
        body: "slack",
      })),
    );
    const first = searchConcepts([synthetic], { query: "slack" });
    assert.equal(first.hits.length, 10);
    assert.equal(first.total, 12);
    const second = searchConcepts([synthetic], { query: "slack", offset: 10 });
    assert.equal(second.hits.length, 2);
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

  it("matches multi-keyword queries with each keyword scored independently", () => {
    const synthetic = makeBundle([
      {
        id: "tools/slack-clipboard",
        type: "Tool",
        tags: ["slack", "clipboard"],
        body: "Copy a message from Slack into the clipboard.",
      },
      { id: "tools/unrelated", type: "Tool", body: "Nothing relevant here." },
    ]);
    const { hits, termMatching } = searchConcepts([synthetic], {
      query: "slack message clipboard",
    });
    assert.deepEqual(hits.map((h) => h.id), ["tools/slack-clipboard"]);
    assert.equal(termMatching, undefined);
  });

  it("ranks concepts matching every keyword above partial matches", () => {
    const synthetic = makeBundle([
      { id: "notes/partial", type: "Note", body: "Only slack appears here." },
      {
        id: "notes/full",
        type: "Note",
        body: "Both slack and clipboard appear here.",
      },
    ]);
    const { hits } = searchConcepts([synthetic], { query: "clipboard slack" });
    assert.equal(hits[0]?.id, "notes/full");
  });

  it("ranks a verbatim phrase match above the same keywords scattered", () => {
    const synthetic = makeBundle([
      { id: "notes/scattered", type: "Note", body: "The slack app and the clipboard tool." },
      { id: "notes/phrase", type: "Note", body: "Use the slack clipboard integration." },
    ]);
    const { hits } = searchConcepts([synthetic], { query: "slack clipboard" });
    assert.equal(hits[0]?.id, "notes/phrase");
  });

  it("falls back to any-keyword matching when no concept matches every keyword", () => {
    const synthetic = makeBundle([
      {
        id: "tools/slack-clipboard",
        type: "Tool",
        tags: ["slack"],
        body: "Slack helpers.",
      },
    ]);
    const { hits, termMatching } = searchConcepts([synthetic], {
      query: "slack clipboard shortcuts",
    });
    assert.deepEqual(hits.map((h) => h.id), ["tools/slack-clipboard"]);
    assert.equal(termMatching, "any");
  });

  it("does not fall back to any-keyword matching for single-keyword queries", () => {
    const { hits, termMatching } = searchConcepts(bundles, { query: "nonexistentword" });
    assert.equal(hits.length, 0);
    assert.equal(termMatching, undefined);
  });

  it("scores an exact tag match above a substring tag match", () => {
    const synthetic = makeBundle([
      { id: "notes/substring", type: "Note", tags: ["slack-adjacent"] },
      { id: "notes/exact", type: "Note", tags: ["slack"] },
    ]);
    const { hits } = searchConcepts([synthetic], { query: "slack" });
    assert.equal(hits[0]?.id, "notes/exact");
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
  });

  it("anchors the snippet on the earliest matched keyword in the body", () => {
    const synthetic = makeBundle([
      {
        id: "notes/anchor",
        type: "Note",
        body: "The clipboard line comes first.\n\nMuch later, slack appears.",
      },
    ]);
    const { hits } = searchConcepts([synthetic], { query: "slack clipboard" });
    assert.ok(hits[0]?.snippet?.includes("clipboard line comes first"));
  });

  it("suggests related tags when a query matches nothing", () => {
    const synthetic = makeBundle([
      { id: "notes/a", type: "Note", tags: ["slack", "messaging"] },
      { id: "notes/b", type: "Note", tags: ["slack"] },
      { id: "notes/c", type: "Note", tags: ["unrelated"] },
    ]);
    const { hits, tagHints } = searchConcepts([synthetic], { query: "slacking" });
    assert.equal(hits.length, 0);
    assert.deepEqual(tagHints, [{ tag: "slack", count: 2 }]);
  });

  it("omits tagHints when hits exist or no query is given", () => {
    const withHits = searchConcepts(bundles, { query: "orders" });
    assert.equal("tagHints" in withHits, false);
    const noQuery = searchConcepts(bundles, {});
    assert.equal("tagHints" in noQuery, false);
  });

  it("respects structural filters when collecting tag hints", () => {
    const synthetic = makeBundle([
      { id: "notes/a", type: "Note", tags: ["slack"] },
      { id: "tools/b", type: "Tool", tags: ["slack"] },
    ]);
    const { tagHints } = searchConcepts([synthetic], {
      query: "slacking",
      types: ["Note"],
    });
    assert.deepEqual(tagHints, [{ tag: "slack", count: 1 }]);
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
