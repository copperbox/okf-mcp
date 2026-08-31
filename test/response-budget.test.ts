import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createOkfServer } from "../src/server.js";
import { OkfStore } from "../src/store.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

/**
 * Regression guard for response bloat: every read-tool response against the
 * acme fixture must stay under an explicit byte budget (~20% above the size
 * measured when compact serialization landed). A failure here means a change
 * silently fattened a payload every agent session pays for — trim the
 * response before raising a budget.
 */
describe("response byte budgets", () => {
  let client: Client;
  before(async () => {
    const store = new OkfStore([{ id: "acme", root: FIXTURE }]);
    await store.load();
    const server = createOkfServer(store, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  const budgets: Array<[string, Record<string, unknown>, number]> = [
    ["list_bundles", {}, 256],
    ["list_concepts", {}, 1500],
    ["search_concepts", { query: "orders" }, 700],
    ["get_concept", { id: "tables/orders" }, 2400],
    ["get_concept", { id: "tables/orders", outline: true }, 600],
    ["graph_summary", {}, 350],
    ["list_types", {}, 160],
    ["list_tags", {}, 175],
    ["validate_bundle", {}, 3500],
    ["read_document", { path: "tables/orders.md" }, 1100],
  ];

  for (const [name, args, budget] of budgets) {
    it(`${name} ${JSON.stringify(args)} stays under ${budget} bytes`, async () => {
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      assert.ok(!result.isError);
      const size = result.content.reduce(
        (sum, part) =>
          sum + (part.type === "text" ? Buffer.byteLength(part.text) : 0),
        0,
      );
      assert.ok(
        size <= budget,
        `${name} response is ${size} bytes, over its ${budget}-byte budget`,
      );
    });
  }
});
