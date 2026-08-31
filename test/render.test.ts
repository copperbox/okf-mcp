import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { renderHitList, renderNeighbors } from "../src/render.js";
import { createOkfServer } from "../src/server.js";
import { OkfStore } from "../src/store.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

describe("renderHitList line grammar", () => {
  it("renders every field in stable order on one line per hit", () => {
    const text = renderHitList({
      total: 12,
      omitted: 3,
      termMatching: "any",
      hits: [
        {
          bundle: "brain",
          id: "tables/orders",
          type: "Table",
          title: "Orders",
          description: "Daily order facts",
          matchedSections: ["Schema", "Grain"],
          tags: ["sales", "finance"],
          resource: "warehouse://analytics.orders",
          score: 12.345,
          matchedIn: ["title", "body"],
          status: "stable",
          trust: "human-reviewed",
          stale: true,
        },
      ],
    });
    assert.equal(
      text,
      [
        "1 of 12 hits, 3 omitted, termMatching: any",
        "- brain:tables/orders [Table] Orders — Daily order facts (§Schema, §Grain) tags:sales,finance resource:warehouse://analytics.orders score:12.35 matchedIn:title,body status:stable trust:human-reviewed stale",
      ].join("\n"),
    );
  });

  it("omits absent fields and falls back to `section` when matchedSections is absent", () => {
    const text = renderHitList({
      total: 1,
      hits: [
        {
          bundle: "acme",
          id: "tables/orders",
          type: "Table",
          title: "Orders",
          section: "Schema",
        },
      ],
    });
    assert.equal(text, "1 of 1 hits\n- acme:tables/orders [Table] Orders (§Schema)");
  });

  it("collapses newlines in fields so each hit stays on one line", () => {
    const text = renderHitList({
      total: 1,
      hits: [
        {
          bundle: "b",
          id: "a/x",
          type: "Note",
          title: "Multi\nline title",
          description: "first line\n  second line\r\nthird",
        },
      ],
    });
    assert.equal(
      text,
      "1 of 1 hits\n- b:a/x [Note] Multi line title — first line second line third",
    );
  });

  it("renders the empty-result form with tagHints", () => {
    const text = renderHitList({
      total: 0,
      hits: [],
      tagHints: [
        { tag: "sales", count: 4 },
        { tag: "finance", count: 2 },
      ],
    });
    assert.equal(text, "0 of 0 hits\ntagHints: sales(4), finance(2)");
  });

  it("adds a snippet continuation line only when it adds signal beyond the description", () => {
    const hit = {
      bundle: "b",
      id: "a/x",
      type: "Note",
      title: "X",
      description: "Retries use exponential backoff.",
    };
    const redundant = renderHitList({
      total: 1,
      hits: [{ ...hit, snippet: "exponential backoff" }],
    });
    assert.ok(!redundant.includes(">"), "contained snippet should be suppressed");

    const informative = renderHitList({
      total: 1,
      hits: [{ ...hit, snippet: "drain the dead-letter\nqueue first" }],
    });
    assert.equal(
      informative.split("\n")[2],
      "  > drain the dead-letter queue first",
    );
  });

  it("names catalog pages with the caller's noun", () => {
    const text = renderHitList({ total: 40, hits: [] }, "concepts");
    assert.equal(text, "0 of 40 concepts");
  });
});

describe("renderNeighbors line grammar", () => {
  it("renders header, node lines, and edge lines", () => {
    const text = renderNeighbors({
      center: "services/core-gateway",
      depth: 1,
      note: "showing 50 of 81 nodes; lower depth or narrow direction",
      nodes: [
        { id: "services/core-gateway", type: "Service", title: "Core Gateway" },
        { id: "services/svc-1", type: "Service", title: "Service 1" },
      ],
      edges: [
        { from: "services/svc-1", to: "services/core-gateway", label: "routes via" },
        { from: "a:x", to: "b:y", kind: "cross-bundle" },
      ],
    });
    assert.equal(
      text,
      [
        "services/core-gateway (depth 1): 2 nodes, 2 edges — showing 50 of 81 nodes; lower depth or narrow direction",
        "- services/core-gateway [Service] Core Gateway",
        "- services/svc-1 [Service] Service 1",
        "edges:",
        '- services/svc-1 -> services/core-gateway "routes via"',
        "- a:x -> b:y cross-bundle",
      ].join("\n"),
    );
  });

  it("omits the edges block when there are no edges", () => {
    const text = renderNeighbors({
      center: "a/x",
      depth: 1,
      nodes: [{ id: "a/x", type: "Note" }],
      edges: [],
    });
    assert.equal(text, "a/x (depth 1): 1 nodes, 0 edges\n- a/x [Note]");
  });
});

describe("format: compact over MCP", () => {
  let client: Client;
  before(async () => {
    const store = new OkfStore([{ id: "acme", root: FIXTURE }]);
    await store.load();
    const server = createOkfServer(store, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  const text = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    assert.ok(!result.isError, `${name} errored: ${JSON.stringify(result.content)}`);
    const part = result.content[0];
    assert.ok(part !== undefined && part.type === "text");
    return part.text;
  };

  it("search_concepts renders compact hit lines instead of JSON", async () => {
    const body = await text("search_concepts", { query: "orders", format: "compact" });
    assert.ok(body.split("\n")[0]?.includes("hits"));
    assert.ok(body.includes("- acme:tables/orders [BigQuery Table]"));
    assert.throws(() => JSON.parse(body) as unknown, "should not be JSON");
  });

  it("format composes with detail: full adds fields, concise omits them", async () => {
    const concise = await text("search_concepts", {
      query: "orders",
      format: "compact",
    });
    assert.ok(!concise.includes("score:"));
    assert.ok(!concise.includes("status:"));

    const full = await text("search_concepts", {
      query: "orders",
      format: "compact",
      detail: "full",
    });
    assert.ok(full.includes("score:"));
    assert.ok(full.includes("status:stable"));
    assert.ok(full.includes("matchedIn:"));
  });

  it("search_concepts default format is unchanged JSON", async () => {
    const body = await text("search_concepts", { query: "orders" });
    const parsed = JSON.parse(body) as { hits: unknown[] };
    assert.ok(Array.isArray(parsed.hits));
  });

  it("list_concepts renders a compact concepts page", async () => {
    const body = await text("list_concepts", { format: "compact" });
    assert.ok(/^\d+ of \d+ concepts$/.test(body.split("\n")[0] ?? ""));
    assert.ok(body.includes("- acme:tables/orders [BigQuery Table]"));
  });

  it("get_neighbors renders node-per-line and edge-per-line", async () => {
    const body = await text("get_neighbors", {
      id: "tables/orders",
      format: "compact",
    });
    const lines = body.split("\n");
    assert.ok(lines[0]?.startsWith("tables/orders (depth 1):"));
    assert.ok(lines.some((l) => l.startsWith("- ") && l.includes(" [")));
    assert.ok(lines.includes("edges:"));
    assert.ok(lines.some((l) => l.includes(" -> ")));
  });
});
