import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createOkfServer } from "../src/server.js";
import { OkfStore } from "../src/store.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

describe("server vocabulary tools", () => {
  let client: Client;
  before(async () => {
    const store = new OkfStore([{ id: "acme", root: FIXTURE }]);
    await store.load();
    const server = createOkfServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });
  after(async () => {
    await client.close();
  });

  async function callJson(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    assert.ok(first?.type === "text");
    return JSON.parse(first.text);
  }

  it("list_types returns type counts sorted by count", async () => {
    assert.deepEqual(await callJson("list_types", { bundle: "acme" }), [
      { type: "BigQuery Table", count: 2 },
      { type: "", count: 1 },
      { type: "BigQuery Dataset", count: 1 },
      { type: "Playbook", count: 1 },
    ]);
  });

  it("list_tags returns tag counts sorted by count", async () => {
    assert.deepEqual(await callJson("list_tags", {}), [
      { tag: "sales", count: 3 },
      { tag: "customers", count: 1 },
      { tag: "incident", count: 1 },
      { tag: "oncall", count: 1 },
      { tag: "orders", count: 1 },
    ]);
  });

  async function callText(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  it("read_document returns reserved files as raw markdown", async () => {
    const result = await callText("read_document", { bundle: "acme", path: "log.md" });
    assert.ok(!result.isError);
    const first = result.content[0];
    assert.ok(first?.type === "text");
    assert.match(first.text, /^# Update Log/);
  });

  it("read_document returns concepts with frontmatter intact", async () => {
    const result = await callText("read_document", { path: "tables/orders.md" });
    assert.ok(!result.isError);
    const first = result.content[0];
    assert.ok(first?.type === "text");
    assert.match(first.text, /^---\ntype: BigQuery Table\n/);
  });

  it("read_document normalizes redundant path segments", async () => {
    const result = await callText("read_document", { path: "tables/./orders.md" });
    assert.ok(!result.isError);
  });

  it("read_document rejects unsafe paths", async () => {
    for (const path of ["../outside.md", "/etc/passwd", ".obsidian/x.md", "tables/../../x.md"]) {
      const result = await callText("read_document", { path });
      assert.ok(result.isError, `expected error for ${path}`);
    }
  });

  it("read_document reports missing files as errors", async () => {
    const result = await callText("read_document", { path: "tables/nope.md" });
    assert.ok(result.isError);
  });
});
