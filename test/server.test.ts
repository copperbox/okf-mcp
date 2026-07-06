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

  describe("delete_concept", () => {
    it("is not registered on a read-only server", async () => {
      const client = await connect();
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((tool) => tool.name === "delete_concept"));
    });

    it("deletes the file, logs a Deletion entry, and reports inbound links", async () => {
      await writeConcept(
        root,
        "metrics/revenue.md",
        { type: "Metric", title: "Revenue" },
        "From [Orders](/tables/orders.md).",
      );
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "delete_concept",
        arguments: { id: "tables/orders" },
      });
      assert.notEqual(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      assert.deepEqual(payload.inboundLinks, ["metrics/revenue"]);
      assert.deepEqual(payload.removedDirs, ["tables"]);

      await assert.rejects(fs.access(path.join(root, "tables")));
      const log = await fs.readFile(path.join(root, "log.md"), "utf8");
      assert.match(log, /\*\*Deletion\*\*: Deleted \[Orders\]\(\/tables\/orders\.md\)\./);
      const index = await fs.readFile(path.join(root, "index.md"), "utf8");
      assert.doesNotMatch(index, /tables/);
    });

    it("fails without deleting when failIfLinked is set and links exist", async () => {
      await writeConcept(
        root,
        "metrics/revenue.md",
        { type: "Metric" },
        "From [Orders](/tables/orders.md).",
      );
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "delete_concept",
        arguments: { id: "tables/orders", failIfLinked: true },
      });
      assert.equal(result.isError, true);
      await fs.access(path.join(root, "tables/orders.md"));
    });

    it("rejects reserved files", async () => {
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "delete_concept",
        arguments: { id: "log.md" },
      });
      assert.equal(result.isError, true);
      await fs.access(path.join(root, "tables/orders.md"));
    });
  });

  describe("rename_concept", () => {
    it("is not registered on a read-only server", async () => {
      const client = await connect();
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((tool) => tool.name === "rename_concept"));
    });

    it("moves the file, rewrites inbound links, logs an Update entry, and reindexes", async () => {
      await writeConcept(
        root,
        "metrics/revenue.md",
        { type: "Metric", title: "Revenue" },
        "From [Orders](/tables/orders.md).",
      );
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "rename_concept",
        arguments: { from: "tables/orders", to: "archive/orders.md" },
      });
      assert.notEqual(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      assert.equal(payload.from, "tables/orders.md");
      assert.equal(payload.to, "archive/orders.md");
      assert.deepEqual(payload.rewrittenFiles, ["metrics/revenue.md"]);
      assert.deepEqual(payload.removedDirs, ["tables"]);

      await fs.access(path.join(root, "archive/orders.md"));
      const revenue = await fs.readFile(path.join(root, "metrics/revenue.md"), "utf8");
      assert.match(revenue, /\[Orders\]\(\/archive\/orders\.md\)/);
      const log = await fs.readFile(path.join(root, "log.md"), "utf8");
      assert.match(log, /\*\*Update\*\*: Renamed \[Orders\]\(\/archive\/orders\.md\) \(was \/tables\/orders\.md\)\./);
      const index = await fs.readFile(path.join(root, "index.md"), "utf8");
      assert.match(index, /archive/);
      assert.doesNotMatch(index, /tables/);
    });

    it("refuses to overwrite an existing concept", async () => {
      await writeConcept(root, "tables/customers.md", { type: "Table" }, "Body");
      const client = await connect({ writable: true });
      const result = await client.callTool({
        name: "rename_concept",
        arguments: { from: "tables/orders", to: "tables/customers.md" },
      });
      assert.equal(result.isError, true);
      await fs.access(path.join(root, "tables/orders.md"));
    });
  });

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
