import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { writeConcept } from "../src/authoring.js";
import { createOkfServer, type ServerOptions } from "../src/server.js";
import { OkfStore } from "../src/store.js";
import { commitAll, initRepo } from "./helpers.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

/** Load the store's bundles and connect an in-memory client to a fresh server. */
async function connectClient(store: OkfStore, options: ServerOptions = {}): Promise<Client> {
  await store.load();
  const server = createOkfServer(store, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function textContent(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first?.type === "text");
  return first.text;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return JSON.parse(textContent(await callTool(client, name, args)));
}

describe("server tools", () => {
  let client: Client;
  before(async () => {
    client = await connectClient(new OkfStore([{ id: "acme", root: FIXTURE }]));
  });
  after(async () => {
    await client.close();
  });

  it("list_types returns type counts sorted by count", async () => {
    assert.deepEqual(await callJson(client, "list_types", { bundle: "acme" }), [
      { type: "BigQuery Table", count: 2 },
      { type: "", count: 1 },
      { type: "BigQuery Dataset", count: 1 },
      { type: "Playbook", count: 1 },
    ]);
  });

  it("list_tags returns tag counts sorted by count", async () => {
    assert.deepEqual(await callJson(client, "list_tags", {}), [
      { tag: "sales", count: 3 },
      { tag: "customers", count: 1 },
      { tag: "incident", count: 1 },
      { tag: "oncall", count: 1 },
      { tag: "orders", count: 1 },
    ]);
  });

  it("read_document returns reserved files as raw markdown", async () => {
    const result = await callTool(client, "read_document", { bundle: "acme", path: "log.md" });
    assert.ok(!result.isError);
    assert.match(textContent(result), /^# Update Log/);
  });

  it("read_document returns concepts with frontmatter intact", async () => {
    const result = await callTool(client, "read_document", { path: "tables/orders.md" });
    assert.ok(!result.isError);
    assert.match(textContent(result), /^---\ntype: BigQuery Table\n/);
  });

  it("read_document normalizes redundant path segments", async () => {
    const result = await callTool(client, "read_document", { path: "tables/./orders.md" });
    assert.ok(!result.isError);
  });

  it("read_document rejects unsafe paths", async () => {
    for (const unsafePath of ["../outside.md", "/etc/passwd", ".obsidian/x.md", "tables/../../x.md"]) {
      const result = await callTool(client, "read_document", { path: unsafePath });
      assert.ok(result.isError, `expected error for ${unsafePath}`);
    }
  });

  it("read_document reports missing files as errors", async () => {
    const result = await callTool(client, "read_document", { path: "tables/nope.md" });
    assert.ok(result.isError);
  });

  it("suggest_concept_path ranks directories by existing type placement", async () => {
    const suggestions = (await callJson(client, "suggest_concept_path", {
      bundle: "acme",
      type: "Playbook",
      title: "Schema Drift Runbook",
    })) as Array<{ path: string; reason: string }>;
    assert.equal(suggestions[0]?.path, "playbooks/schema-drift-runbook.md");
    assert.match(suggestions[0]?.reason ?? "", /`Playbook`/);
  });

  it("suggest_concept_path falls back to a root-level path for new types", async () => {
    const suggestions = (await callJson(client, "suggest_concept_path", {
      type: "Dashboard",
      title: "Revenue Overview",
    })) as Array<{ path: string; reason: string }>;
    assert.deepEqual(
      suggestions.map((s) => s.path),
      ["revenue-overview.md"],
    );
  });

  it("suggest_concept_path requires a non-empty type", async () => {
    const result = await callTool(client, "suggest_concept_path", { type: "" });
    assert.ok(result.isError);
  });
});

describe("git tools", () => {
  let tmp: string;
  let client: Client;
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "okf-server-git-"));

    const repoRoot = path.join(tmp, "repo");
    await fs.mkdir(path.join(repoRoot, "notes"), { recursive: true });
    const alpha = path.join(repoRoot, "notes", "alpha.md");
    await fs.writeFile(alpha, "---\ntype: Note\ntitle: Alpha\n---\n\nFirst draft.\n");
    await initRepo(repoRoot);
    await commitAll(repoRoot, "add alpha");
    await fs.appendFile(alpha, "\nSecond thoughts.\n");
    await commitAll(repoRoot, "update alpha");
    await fs.appendFile(alpha, "\nThird pass.\n");
    await commitAll(repoRoot, "polish alpha");

    const plainRoot = path.join(tmp, "plain");
    await fs.mkdir(path.join(plainRoot, "notes"), { recursive: true });
    await fs.writeFile(
      path.join(plainRoot, "notes", "beta.md"),
      "---\ntype: Note\n---\n\nNo repo here.\n",
    );

    client = await connectClient(
      new OkfStore([
        { id: "repo", root: repoRoot },
        { id: "plain", root: plainRoot },
      ]),
    );
  });
  after(async () => {
    await client.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("concept_history returns commits newest-first", async () => {
    const result = await callTool(client, "concept_history", { bundle: "repo", id: "notes/alpha" });
    assert.ok(!result.isError);
    const commits = JSON.parse(textContent(result)) as Array<Record<string, string>>;
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["polish alpha", "update alpha", "add alpha"],
    );
    assert.match(commits[0]?.hash ?? "", /^[0-9a-f]{40}$/);
    assert.equal(commits[0]?.author, "Test Author");
    assert.match(commits[0]?.date ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });

  it("concept_history honors limit", async () => {
    const result = await callTool(client, "concept_history", {
      bundle: "repo",
      id: "notes/alpha",
      limit: 1,
    });
    const commits = JSON.parse(textContent(result)) as Array<Record<string, string>>;
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.subject, "polish alpha");
  });

  it("concept_history rejects unknown concepts", async () => {
    const result = await callTool(client, "concept_history", { bundle: "repo", id: "notes/nope" });
    assert.ok(result.isError);
  });

  it("concept_history degrades gracefully outside a git work tree", async () => {
    const result = await callTool(client, "concept_history", { bundle: "plain", id: "notes/beta" });
    assert.ok(!result.isError);
    assert.match(textContent(result), /not a git repository/);
  });

  it("concept_diff defaults to the most recent change", async () => {
    const result = await callTool(client, "concept_diff", { bundle: "repo", id: "notes/alpha" });
    assert.ok(!result.isError);
    const diff = textContent(result);
    assert.match(diff, /^diff --git/);
    assert.match(diff, /\+Third pass\./);
    assert.doesNotMatch(diff, /\+Second thoughts\./);
  });

  it("concept_diff accepts an explicit ref", async () => {
    const result = await callTool(client, "concept_diff", {
      bundle: "repo",
      id: "notes/alpha",
      ref: "HEAD~2",
    });
    assert.ok(!result.isError);
    const diff = textContent(result);
    assert.match(diff, /\+Second thoughts\./);
    assert.match(diff, /\+Third pass\./);
  });

  it("concept_diff degrades gracefully outside a git work tree", async () => {
    const result = await callTool(client, "concept_diff", { bundle: "plain", id: "notes/beta" });
    assert.ok(!result.isError);
    assert.match(textContent(result), /not a git repository/);
  });
});

describe("authoring tools", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-server-test-"));
    await writeConcept(root, "tables/orders.md", { type: "Table", title: "Orders" }, "Body");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function connect(options: ServerOptions = {}): Promise<Client> {
    return connectClient(new OkfStore([{ id: "t", root }]), options);
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
