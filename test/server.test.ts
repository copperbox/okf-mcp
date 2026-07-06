import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createOkfServer } from "../src/server.js";
import { OkfStore } from "../src/store.js";

async function connect(store: OkfStore): Promise<Client> {
  const server = createOkfServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("reload_bundles tool", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-server-test-"));
    await fs.writeFile(
      path.join(root, "orders.md"),
      "---\ntype: Table\n---\n\nOrder rows.\n",
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is available without --writable and reports the reload delta", async () => {
    const store = new OkfStore([{ id: "t", root }]);
    await store.load();
    const client = await connect(store);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "reload_bundles"));

    await fs.writeFile(
      path.join(root, "customers.md"),
      "---\ntype: Table\n---\n\nCustomer rows.\n",
    );

    const result = await client.callTool({ name: "reload_bundles", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    assert.deepEqual(JSON.parse(text), [
      {
        bundle: "t",
        concepts: 2,
        problems: 0,
        added: ["customers"],
        removed: [],
        changed: [],
      },
    ]);

    // The externally-added concept is now visible through other tools.
    const get = await client.callTool({
      name: "get_concept",
      arguments: { id: "customers" },
    });
    const concept = JSON.parse(
      (get.content as Array<{ type: string; text: string }>)[0]!.text,
    );
    assert.equal(concept.frontmatter.type, "Table");
  });
});
