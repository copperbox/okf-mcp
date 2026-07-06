import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { writeConcept } from "../src/authoring.js";
import { createOkfServer, type ServerOptions } from "../src/server.js";
import { OkfStore } from "../src/store.js";

describe("server tools", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-server-test-"));
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function connect(options: ServerOptions = {}): Promise<Client> {
    const store = new OkfStore([{ id: "t", root }]);
    await store.load();
    const server = createOkfServer(store, options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  describe("append_log_entry", () => {
    it("is not registered on a read-only server", async () => {
      const client = await connect();
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((tool) => tool.name === "append_log_entry"));
    });

    it("prepends the message to log.md under today's date", async () => {
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "append_log_entry",
        arguments: { message: "**Deprecation**: [Orders](/tables/orders.md) is legacy." },
      });
      assert.notEqual(result.isError, true);

      const log = await fs.readFile(path.join(root, "log.md"), "utf8");
      const today = new Date().toISOString().slice(0, 10);
      const headingIndex = log.indexOf(`## ${today}`);
      assert.notEqual(headingIndex, -1);
      assert.ok(headingIndex < log.indexOf("**Deprecation**"));
      assert.match(log, /\* \*\*Deprecation\*\*: \[Orders\]\(\/tables\/orders\.md\) is legacy\./);
    });

    it("rejects an unknown bundle", async () => {
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "append_log_entry",
        arguments: { bundle: "nope", message: "**Update**: x" },
      });
      assert.equal(result.isError, true);
    });
  });
});
