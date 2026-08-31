import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { loadOkfConfig } from "../src/config.js";
import { ALL_FEATURE_GROUPS, FEATURE_GROUPS } from "../src/features.js";
import { createOkfServer } from "../src/server.js";
import type { ServerOptions } from "../src/server.js";
import { OkfStore } from "../src/store.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

/** Every tool name any group claims. */
const ALL_GROUPED_TOOLS = new Set(
  ALL_FEATURE_GROUPS.flatMap((group) => [...FEATURE_GROUPS[group]]),
);

async function connect(options: ServerOptions = {}): Promise<Client> {
  const store = new OkfStore([{ id: "acme", root: FIXTURE }]);
  await store.load();
  const server = createOkfServer(store, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Attempt a write_concept call and return the error text it was refused with. */
async function refuseWrite(client: Client): Promise<string> {
  const result = (await client.callTool({
    name: "write_concept",
    arguments: { bundle: "acme", path: "x.md", content: "---\ntype: T\n---\nx" },
  })) as CallToolResult;
  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.ok(first?.type === "text");
  return first.text;
}

async function advertisedTools(options: ServerOptions = {}): Promise<Set<string>> {
  const client = await connect(options);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

describe("feature groups", () => {
  it("assigns every tool to exactly one group", () => {
    const total = ALL_FEATURE_GROUPS.reduce(
      (sum, group) => sum + FEATURE_GROUPS[group].length,
      0,
    );
    // A tool listed in two groups would collapse in the union.
    assert.equal(ALL_GROUPED_TOOLS.size, total);
  });

  it("covers every registered tool, so new tools cannot dodge gating", async () => {
    // Registration throws for a tool no group claims (featureEnabled in
    // createOkfServer), so a writable all-features server coming up at all
    // proves coverage in that direction; the set comparison below catches
    // stale group entries that no longer match a registered tool.
    const advertised = await advertisedTools({ writable: true });
    // get_bundle_guide is registered but mount-gated: the fixture has no
    // colocated root, so it is the one grouped tool absent from tools/list.
    const expected = new Set(ALL_GROUPED_TOOLS);
    expected.delete("get_bundle_guide");
    assert.deepEqual(advertised, expected);
  });

  it("exposes every group by default (no features configured)", async () => {
    const withFeatures = await advertisedTools({
      writable: true,
      features: [...ALL_FEATURE_GROUPS],
    });
    const withDefault = await advertisedTools({ writable: true });
    assert.deepEqual(withDefault, withFeatures);
    for (const group of ALL_FEATURE_GROUPS) {
      assert.ok(
        FEATURE_GROUPS[group].some((tool) => withDefault.has(tool)),
        `default config advertises nothing from group "${group}"`,
      );
    }
  });

  it('features: ["read"] hides write, graph, remote, and maintenance tools', async () => {
    const advertised = await advertisedTools({ writable: true, features: ["read"] });
    const expected = new Set<string>(FEATURE_GROUPS.read);
    expected.delete("get_bundle_guide"); // mount-gated, no colocated root here
    assert.deepEqual(advertised, expected);
  });

  it('features: ["read", "graph"] adds only the graph tools', async () => {
    const advertised = await advertisedTools({
      writable: true,
      features: ["read", "graph"],
    });
    for (const tool of FEATURE_GROUPS.graph) assert.ok(advertised.has(tool), tool);
    for (const group of ["write", "remote", "maintenance"] as const) {
      for (const tool of FEATURE_GROUPS[group]) {
        assert.ok(!advertised.has(tool), `${tool} should be hidden`);
      }
    }
  });

  it("gated write tools are disabled even on a writable server", async () => {
    const client = await connect({ writable: true, features: ["read"] });
    try {
      const result = await refuseWrite(client);
      assert.match(result, /write_concept disabled/);
    } finally {
      await client.close();
    }
  });

  it("the write feature without writability still refuses writes", async () => {
    // features composes with writable: the group alone never enables authoring.
    const advertised = await advertisedTools({ features: ["read", "write"] });
    for (const tool of FEATURE_GROUPS.write) {
      assert.ok(!advertised.has(tool), `${tool} advertised without writability`);
    }
    const client = await connect({ features: ["read", "write"] });
    try {
      const result = await refuseWrite(client);
      assert.match(result, /write_concept not found/);
    } finally {
      await client.close();
    }
  });
});

describe("features config key", () => {
  it("flows from okf.config.json into the resolved config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-features-test-"));
    try {
      await fs.writeFile(
        path.join(dir, "okf.config.json"),
        JSON.stringify({ root: true, features: ["read", "graph"] }),
      );
      const resolved = await loadOkfConfig({
        cwd: dir,
        configHome: path.join(dir, "no-user-config"),
      });
      assert.deepEqual(resolved.features, ["read", "graph"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown feature group, naming the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "okf-features-test-"));
    try {
      await fs.writeFile(
        path.join(dir, "okf.config.json"),
        JSON.stringify({ root: true, features: ["read", "telepathy"] }),
      );
      await assert.rejects(
        loadOkfConfig({ cwd: dir, configHome: path.join(dir, "no-user-config") }),
        /okf\.config\.json.*telepathy/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
