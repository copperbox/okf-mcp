import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { writeConcept } from "../src/authoring.js";
import { createOkfServer } from "../src/server.js";
import type { ServerOptions } from "../src/server.js";
import { OkfStore } from "../src/store.js";
import { fakeGitHub } from "./fake-github.js";
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

    const del = await client.callTool({
      name: "delete_concept",
      arguments: { bundle: "shared", id: "tables/orders" },
    });
    assert.equal(del.isError, true);
    assert.match((del.content as Array<{ text: string }>)[0]!.text, /read-only/);

    const rename = await client.callTool({
      name: "rename_concept",
      arguments: { bundle: "shared", from: "tables/orders", to: "tables/moved.md" },
    });
    assert.equal(rename.isError, true);
    assert.match((rename.content as Array<{ text: string }>)[0]!.text, /read-only/);

    const log = await client.callTool({
      name: "append_log_entry",
      arguments: { bundle: "shared", message: "**Update**: nope" },
    });
    assert.equal(log.isError, true);
    assert.match((log.content as Array<{ text: string }>)[0]!.text, /read-only/);
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

  it("get_concept lists body section headings alongside the full body", async () => {
    const concept = (await callJson(client, "get_concept", { id: "tables/orders" })) as {
      body: string;
      sections: string[];
    };
    assert.deepEqual(concept.sections, ["Schema", "Citations"]);
    assert.match(concept.body, /# Schema/);
  });

  it("get_concept returns a single section case-insensitively", async () => {
    const result = (await callJson(client, "get_concept", {
      id: "tables/orders",
      section: "citations",
    })) as {
      id: string;
      frontmatter: { type: string };
      section: { heading: string; level: number; content: string };
      sections: string[];
    };
    assert.equal(result.id, "tables/orders");
    assert.equal(result.frontmatter.type, "BigQuery Table");
    assert.deepEqual(result.sections, ["Schema", "Citations"]);
    assert.equal(result.section.heading, "Citations");
    assert.equal(result.section.level, 1);
    assert.match(result.section.content, /BigQuery table schema/);
    assert.doesNotMatch(result.section.content, /order_id/);
    assert.equal("body" in result, false);
  });

  it("get_concept rejects an unknown section, listing what is available", async () => {
    const result = await callTool(client, "get_concept", {
      id: "tables/orders",
      section: "Examples",
    });
    assert.ok(result.isError);
    assert.match(textContent(result), /Schema, Citations/);
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

  async function connectLocal(options: ServerOptions = {}): Promise<Client> {
    return connectClient(new OkfStore([{ id: "t", root }]), options);
  }

  describe("delete_concept", () => {
    it("is not registered on a read-only server", async () => {
      const client = await connectLocal();
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
      const client = await connectLocal({ writable: true });
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
      const client = await connectLocal({ writable: true });
      const result = await client.callTool({
        name: "delete_concept",
        arguments: { id: "tables/orders", failIfLinked: true },
      });
      assert.equal(result.isError, true);
      await fs.access(path.join(root, "tables/orders.md"));
    });

    it("rejects reserved files", async () => {
      const client = await connectLocal({ writable: true });
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
      const client = await connectLocal();
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
      const client = await connectLocal({ writable: true });
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
      const client = await connectLocal({ writable: true });
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
      const client = await connectLocal();
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((tool) => tool.name === "append_log_entry"));
    });

    it("prepends the message to log.md under today's date", async () => {
      const client = await connectLocal({ writable: true });
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
      const client = await connectLocal({ writable: true });
      const result = await client.callTool({
        name: "append_log_entry",
        arguments: { bundle: "nope", message: "**Update**: x" },
      });
      assert.equal(result.isError, true);
    });
  });
});

describe("README tool documentation", () => {
  it("documents every registered tool in a table row", async () => {
    const store = new OkfStore([{ id: "acme", root: FIXTURE }]);
    const client = await connectClient(store, { writable: true });
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);

    const readme = await fs.readFile(
      path.join(import.meta.dirname, "..", "README.md"),
      "utf8",
    );
    const undocumented = tools
      .map((tool) => tool.name)
      .filter((name) => !readme.includes(`| \`${name}\` |`));
    assert.deepEqual(undocumented, []);
  });
});
