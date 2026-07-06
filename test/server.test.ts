import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createOkfServer } from "../src/server.js";
import type { ServerOptions } from "../src/server.js";
import { OkfStore } from "../src/store.js";
import { fakeGitHub } from "./fake-github.js";

async function connect(store: OkfStore, options?: ServerOptions): Promise<Client> {
  const server = createOkfServer(store, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function toolJson(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return JSON.parse(
    (result.content as Array<{ type: string; text: string }>)[0]!.text,
  );
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

describe("remote bundle tools", () => {
  const DOC = "---\ntype: Table\ntitle: Orders\n---\n\nOrder rows.\n";
  const URL = "https://github.com/acme/kb/tree/main/kb";

  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-server-test-"));
    await fs.writeFile(
      path.join(root, "local.md"),
      "---\ntype: Note\n---\n\nLocal.\n",
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function storeWithRemote(): OkfStore {
    return new OkfStore([{ id: "t", root }], {
      fetchImpl: fakeGitHub({ "kb/tables/orders.md": DOC, "kb/index.md": "# Index\n" }),
    });
  }

  it("load_remote_bundle indexes the tree in memory and list_remote_bundles reports it", async () => {
    const store = storeWithRemote();
    await store.load();
    const client = await connect(store);

    const loaded = toolJson(
      await client.callTool({
        name: "load_remote_bundle",
        arguments: { id: "shared", url: URL },
      }),
    );
    assert.deepEqual(loaded, {
      id: "shared",
      url: URL,
      concepts: 1,
      problems: 0,
      readOnly: true,
    });

    const listed = toolJson(
      await client.callTool({ name: "list_remote_bundles", arguments: {} }),
    );
    assert.deepEqual(listed, [
      { id: "shared", url: URL, concepts: 1, problems: 0, readOnly: true },
    ]);

    // Remote concepts are queryable like local ones.
    const concept = toolJson(
      await client.callTool({
        name: "get_concept",
        arguments: { bundle: "shared", id: "tables/orders" },
      }),
    ) as { frontmatter: { title: string } };
    assert.equal(concept.frontmatter.title, "Orders");

    // list_bundles marks the remote bundle read-only.
    const bundles = toolJson(
      await client.callTool({ name: "list_bundles", arguments: {} }),
    ) as Array<{ id: string; readOnly: boolean }>;
    assert.deepEqual(
      bundles.map((b) => [b.id, b.readOnly]),
      [["t", false], ["shared", true]],
    );

    // Documents are served as resources straight from memory.
    const resource = await client.readResource({
      uri: "okf://shared/tables/orders.md",
    });
    assert.equal((resource.contents[0] as { text: string }).text, DOC);
  });

  it("rejects authoring tools against read-only remote bundles", async () => {
    const store = storeWithRemote();
    await store.load();
    await store.addRemoteBundle({ id: "shared", url: URL });
    const client = await connect(store, { writable: true });

    const write = await client.callTool({
      name: "write_concept",
      arguments: {
        bundle: "shared",
        path: "new.md",
        frontmatter: { type: "Note" },
        body: "nope",
      },
    });
    assert.equal(write.isError, true);
    assert.match(
      (write.content as Array<{ text: string }>)[0]!.text,
      /read-only/,
    );

    const regen = await client.callTool({
      name: "regenerate_indexes",
      arguments: { bundle: "shared" },
    });
    assert.equal(regen.isError, true);
    assert.match(
      (regen.content as Array<{ text: string }>)[0]!.text,
      /read-only/,
    );
  });

  it("load_remote_bundle reports duplicate ids as tool errors", async () => {
    const store = storeWithRemote();
    await store.load();
    const client = await connect(store);
    const result = await client.callTool({
      name: "load_remote_bundle",
      arguments: { id: "t", url: URL },
    });
    assert.equal(result.isError, true);
    assert.match(
      (result.content as Array<{ text: string }>)[0]!.text,
      /duplicate bundle id/,
    );
  });
});
