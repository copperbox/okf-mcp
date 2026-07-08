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
import { fakeArchiveServer, makeTarGz } from "./archives.js";
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

    const promote = await client.callTool({
      name: "promote_concept",
      arguments: { id: "local", fromBundle: "t", toBundle: "shared" },
    });
    assert.equal(promote.isError, true);
    assert.match(
      (promote.content as Array<{ text: string }>)[0]!.text,
      /read-only/,
    );
  });

  it("load_remote_bundle indexes a tar.gz archive URL and reports it as the source", async () => {
    const archiveUrl = "https://example.com/dist/kb.tar.gz";
    const store = new OkfStore([{ id: "t", root }], {
      fetchImpl: fakeArchiveServer({
        [archiveUrl]: makeTarGz({
          "kb/index.md": "# Index\n",
          "kb/tables/orders.md": DOC,
        }),
      }),
    });
    await store.load();
    const client = await connect(store);

    const loaded = toolJson(
      await client.callTool({
        name: "load_remote_bundle",
        arguments: { id: "shared", url: archiveUrl },
      }),
    );
    assert.deepEqual(loaded, {
      id: "shared",
      url: archiveUrl,
      concepts: 1,
      problems: 0,
      readOnly: true,
    });

    // list_remote_bundles reports the archive URL as the source.
    const listed = toolJson(
      await client.callTool({ name: "list_remote_bundles", arguments: {} }),
    );
    assert.deepEqual(listed, [
      { id: "shared", url: archiveUrl, concepts: 1, problems: 0, readOnly: true },
    ]);

    // Documents are served as resources straight from memory.
    const resource = await client.readResource({
      uri: "okf://shared/tables/orders.md",
    });
    assert.equal((resource.contents[0] as { text: string }).text, DOC);
  });

  it("synthesizes index.md views for remote bundles published without them", async () => {
    const store = new OkfStore([{ id: "t", root }], {
      fetchImpl: fakeGitHub({ "kb/tables/orders.md": DOC }),
    });
    await store.load();
    await store.addRemoteBundle({ id: "shared", url: URL });
    const client = await connect(store);

    const rootIndex = await callTool(client, "read_document", {
      bundle: "shared",
      path: "index.md",
    });
    assert.notEqual(rootIndex.isError, true);
    assert.equal((rootIndex as { synthesized?: boolean }).synthesized, true);
    assert.match(textContent(rootIndex), /# Bundle Index/);
    assert.match(textContent(rootIndex), /\[tables\]\(tables\/\)/);

    const tablesIndex = await callTool(client, "read_document", {
      bundle: "shared",
      path: "tables/index.md",
    });
    assert.equal((tablesIndex as { synthesized?: boolean }).synthesized, true);
    assert.match(textContent(tablesIndex), /\* \[Orders\]\(orders\.md\)/);

    // The okf:// resource serves the same synthesized view.
    const resource = await client.readResource({ uri: "okf://shared/index.md" });
    assert.match((resource.contents[0] as { text: string }).text, /# Bundle Index/);

    // Indexes of directories the bundle does not have still fail.
    const missing = await callTool(client, "read_document", {
      bundle: "shared",
      path: "nope/index.md",
    });
    assert.equal(missing.isError, true);
  });

  it("serves a real remote index.md verbatim without the synthesized mark", async () => {
    const store = storeWithRemote();
    await store.load();
    await store.addRemoteBundle({ id: "shared", url: URL });
    const client = await connect(store);

    const result = await callTool(client, "read_document", {
      bundle: "shared",
      path: "index.md",
    });
    assert.notEqual(result.isError, true);
    assert.equal(textContent(result), "# Index\n");
    assert.equal((result as { synthesized?: boolean }).synthesized, undefined);
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

  it("get_citations classifies external, concept, and missing targets", async () => {
    assert.deepEqual(await callJson(client, "get_citations", { id: "tables/orders" }), [
      {
        index: 1,
        text: "BigQuery table schema",
        target: "https://console.cloud.google.com/bigquery?p=acme&d=sales&t=orders",
        kind: "external",
      },
      {
        index: 2,
        text: "Customer dimension table",
        target: "/tables/customers.md",
        kind: "concept",
      },
      {
        index: 3,
        text: "Retired ingestion runbook",
        target: "/playbooks/retired-runbook",
        kind: "missing",
      },
    ]);
  });

  it("get_citations returns an empty list for a concept without a Citations section", async () => {
    assert.deepEqual(await callJson(client, "get_citations", { id: "datasets/sales" }), []);
  });

  it("get_citations rejects an unknown concept", async () => {
    const result = await callTool(client, "get_citations", { id: "tables/nope" });
    assert.ok(result.isError);
    assert.match(textContent(result), /unknown concept/);
  });

  it("validate_bundle reports citation warnings", async () => {
    const [report] = (await callJson(client, "validate_bundle", { bundle: "acme" })) as Array<{
      warnings: Array<{ path?: string; message: string }>;
    }>;
    assert.ok(
      report!.warnings.some((w) => /malformed citation entry/.test(w.message)),
    );
  });

  it("list_bundles and graph_summary surface the declared okf_version", async () => {
    const bundles = (await callJson(client, "list_bundles", {})) as Array<{
      id: string;
      okfVersion?: string;
    }>;
    assert.equal(bundles[0]?.okfVersion, "0.1");

    const summary = (await callJson(client, "graph_summary", {
      bundle: "acme",
    })) as { okfVersion?: string };
    assert.equal(summary.okfVersion, "0.1");
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

  it("read_document synthesizes a missing directory index for local bundles", async () => {
    const result = await callTool(client, "read_document", { path: "tables/index.md" });
    assert.ok(!result.isError);
    assert.equal((result as { synthesized?: boolean }).synthesized, true);
    assert.match(textContent(result), /\* \[.+\]\(orders\.md\)/);
    // Synthesized views are never written to disk.
    await assert.rejects(fs.access(path.join(FIXTURE, "tables", "index.md")));
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

  describe("promote_concept", () => {
    let orgRoot: string;
    beforeEach(async () => {
      orgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okf-server-org-"));
      await writeConcept(
        orgRoot,
        "standards/reviews.md",
        { type: "Table", title: "Reviews" },
        "Review rules.",
      );
    });
    afterEach(async () => {
      await fs.rm(orgRoot, { recursive: true, force: true });
    });

    async function connectTwo(options: ServerOptions = {}): Promise<Client> {
      return connectClient(
        new OkfStore([
          { id: "proj", root },
          { id: "org", root: orgRoot },
        ]),
        options,
      );
    }

    it("is not registered on a read-only server", async () => {
      const client = await connectTwo();
      const tools = await client.listTools();
      assert.ok(!tools.tools.some((tool) => tool.name === "promote_concept"));
    });

    it("moves the concept, leaves a stub, and logs and reindexes both bundles", async () => {
      await writeConcept(
        root,
        "metrics/revenue.md",
        { type: "Metric", title: "Revenue" },
        "From [Orders](/tables/orders.md).",
      );
      const client = await connectTwo({ writable: true });
      const result = await client.callTool({
        name: "promote_concept",
        arguments: { id: "tables/orders", fromBundle: "proj", toBundle: "org" },
      });
      assert.notEqual(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      // Default placement: org's only Table lives in standards/.
      assert.equal(payload.to, "standards/orders.md");
      assert.equal(payload.id, "standards/orders");
      assert.equal(payload.citation, "okf://org/standards/orders.md");
      assert.equal(payload.stubPath, "tables/orders.md");
      assert.deepEqual(payload.inboundLinks, ["metrics/revenue"]);
      assert.equal(payload.uri, "okf://org/standards/orders.md");

      await fs.access(path.join(orgRoot, "standards/orders.md"));
      const stub = await fs.readFile(path.join(root, "tables/orders.md"), "utf8");
      assert.match(stub, /resource: okf:\/\/org\/standards\/orders\.md/);
      assert.match(stub, /# Citations/);

      const projLog = await fs.readFile(path.join(root, "log.md"), "utf8");
      assert.match(
        projLog,
        /\*\*Update\*\*: Promoted \[Orders\]\(\/tables\/orders\.md\) to bundle "org" \(okf:\/\/org\/standards\/orders\.md\)\./,
      );
      const orgLog = await fs.readFile(path.join(orgRoot, "log.md"), "utf8");
      assert.match(
        orgLog,
        /\*\*Creation\*\*: Promoted \[Orders\]\(\/standards\/orders\.md\) from bundle "proj"\./,
      );
      const orgIndex = await fs.readFile(path.join(orgRoot, "index.md"), "utf8");
      assert.match(orgIndex, /standards/);
      // The stub keeps the source index entry alive, with the redirect description.
      const projIndex = await fs.readFile(
        path.join(root, "tables", "index.md"),
        "utf8",
      );
      assert.match(projIndex, /Promoted to bundle "org"/);

      // Both in-memory bundles reflect the promotion.
      const promoted = await client.callTool({
        name: "get_concept",
        arguments: { bundle: "org", id: "standards/orders" },
      });
      assert.notEqual(promoted.isError, true);
    });

    it("with stub: false deletes the source copy and reports dangling links", async () => {
      await writeConcept(
        root,
        "metrics/revenue.md",
        { type: "Metric", title: "Revenue" },
        "From [Orders](/tables/orders.md).",
      );
      const client = await connectTwo({ writable: true });
      const result = await client.callTool({
        name: "promote_concept",
        arguments: {
          id: "tables/orders",
          fromBundle: "proj",
          toBundle: "org",
          toPath: "tables/orders.md",
          stub: false,
        },
      });
      assert.notEqual(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      assert.equal(payload.to, "tables/orders.md");
      assert.equal(payload.stubPath, undefined);
      assert.deepEqual(payload.inboundLinks, ["metrics/revenue"]);
      assert.deepEqual(payload.removedDirs, ["tables"]);
      await assert.rejects(fs.access(path.join(root, "tables")));
    });

    it("rejects promoting a concept onto itself or across identical bundles", async () => {
      const client = await connectTwo({ writable: true });
      const result = await client.callTool({
        name: "promote_concept",
        arguments: { id: "tables/orders", fromBundle: "proj", toBundle: "proj" },
      });
      assert.equal(result.isError, true);
      assert.match(
        (result.content as Array<{ text: string }>)[0]!.text,
        /source and target bundle are the same/,
      );
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

    it("writes a scoped entry to the directory's log.md and exposes it as a resource", async () => {
      const client = await connectLocal({ writable: true });
      const result = await client.callTool({
        name: "append_log_entry",
        arguments: { message: "**Update**: Orders got a new column.", directory: "tables" },
      });
      assert.notEqual(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0]!.text,
      );
      assert.equal(payload.path, "tables/log.md");
      assert.equal(payload.uri, "okf://t/tables/log.md");

      const log = await fs.readFile(path.join(root, "tables/log.md"), "utf8");
      assert.ok(log.startsWith("# Directory Update Log\n"));
      assert.match(log, /\* \*\*Update\*\*: Orders got a new column\./);
      // Root log untouched.
      await assert.rejects(fs.access(path.join(root, "log.md")));
      // The reloaded bundle serves the new scoped log as a reserved resource.
      const resources = await client.listResources();
      assert.ok(resources.resources.some((r) => r.uri === "okf://t/tables/log.md"));
    });

    it("rejects a directory that escapes the bundle", async () => {
      const client = await connectLocal({ writable: true });
      const result = await client.callTool({
        name: "append_log_entry",
        arguments: { message: "**Update**: x", directory: "../outside" },
      });
      assert.equal(result.isError, true);
      assert.match(
        (result.content as Array<{ text: string }>)[0]!.text,
        /inside the bundle/,
      );
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

describe("server instructions", () => {
  it("teaches the OKF conventions, including the write flow when writable", async () => {
    const client = await connectClient(
      new OkfStore([{ id: "acme", root: FIXTURE }]),
      { writable: true },
    );
    const instructions = client.getInstructions();
    assert.ok(instructions, "server should declare instructions");
    for (const needle of [
      "concept",
      "frontmatter",
      "bundle-absolute",
      "graph_summary",
      "search_concepts",
      "get_concept",
      "get_neighbors",
      "suggest_concept_path",
      "write_concept",
      "append_log_entry",
      "reload_bundles",
      "index.md",
      "log.md",
    ]) {
      assert.ok(instructions.includes(needle), `instructions should mention ${needle}`);
    }
    // Instructions cost context in every session — keep them short.
    const lineCount = instructions.split("\n").length;
    assert.ok(
      lineCount <= 40,
      `instructions should stay under ~40 lines, got ${lineCount}`,
    );
    await client.close();
  });

  it("omits authoring guidance on a read-only server", async () => {
    const client = await connectClient(new OkfStore([{ id: "acme", root: FIXTURE }]));
    const instructions = client.getInstructions();
    assert.ok(instructions, "server should declare instructions");
    assert.ok(!instructions.includes("write_concept"));
    assert.ok(!instructions.includes("suggest_concept_path"));
    assert.ok(instructions.includes("read-only"));
    assert.ok(instructions.includes("reload_bundles"));
    await client.close();
  });
});

describe("cross-bundle graph tools", () => {
  const ORG_URL = "https://github.com/acme/kb/tree/main/kb";
  const NAMING_BLOB = "https://github.com/acme/kb/blob/main/kb/standards/naming.md";
  const ORG_DOC =
    "---\ntype: Standard\ntitle: Naming\n---\n\nSee [reviews](/standards/reviews.md).\n";
  const REVIEWS_DOC = "---\ntype: Standard\ntitle: Reviews\n---\n\nReview rules.\n";

  let root: string;
  let client: Client;
  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "okf-cross-bundle-test-"));
    await fs.writeFile(
      path.join(root, "setup.md"),
      `---\ntype: Guide\ntitle: Setup\n---\n\n# Citations\n\n[1] [Naming standard](${NAMING_BLOB})\n`,
    );
    const store = new OkfStore([{ id: "proj", root }], {
      remotes: [{ id: "org", url: ORG_URL }],
      fetchImpl: fakeGitHub({
        "kb/standards/naming.md": ORG_DOC,
        "kb/standards/reviews.md": REVIEWS_DOC,
      }),
    });
    client = await connectClient(store);
  });
  after(async () => {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("graph_summary reports derived cross-bundle edge counts", async () => {
    const summaries = (await callJson(client, "graph_summary", {})) as Array<{
      bundle: string;
      crossBundleEdges: number;
    }>;
    for (const summary of summaries) {
      assert.equal(summary.crossBundleEdges, 1, summary.bundle);
    }
  });

  it("get_neighbors traverses derived edges only when crossBundle is set", async () => {
    const plain = (await callJson(client, "get_neighbors", {
      bundle: "proj",
      id: "setup",
    })) as { nodes: Array<{ id: string }> };
    assert.deepEqual(plain.nodes.map((n) => n.id), ["setup"]);

    const cross = (await callJson(client, "get_neighbors", {
      bundle: "proj",
      id: "setup",
      crossBundle: true,
    })) as { nodes: Array<{ id: string; bundle: string }> };
    const naming = cross.nodes.find((n) => n.id === "org:standards/naming");
    assert.equal(naming?.bundle, "org");
  });

  it("find_path crosses bundles with qualified IDs", async () => {
    const { path: found } = (await callJson(client, "find_path", {
      bundle: "proj",
      from: "setup",
      to: "org:standards/reviews",
      crossBundle: true,
    })) as { path: string[] };
    assert.deepEqual(found, [
      "proj:setup",
      "org:standards/naming",
      "org:standards/reviews",
    ]);
  });

  it("export_graph renders a namespaced multi-bundle graph with dashed derived edges", async () => {
    const dot = textContent(
      await callTool(client, "export_graph", { format: "dot", crossBundle: true }),
    );
    assert.match(dot, /"proj:setup" -> "org:standards\/naming" \[style=dashed\];/);
    assert.match(dot, /"org:standards\/naming" -> "org:standards\/reviews";/);
  });

  it("load_remote_bundle accepts and list_remote_bundles echoes a canonicalUrl", async () => {
    await callTool(client, "load_remote_bundle", {
      id: "org2",
      url: "https://github.com/acme/kb/tree/main/kb",
      canonicalUrl: "https://kb.example.com/org",
    });
    const listed = (await callJson(client, "list_remote_bundles", {})) as Array<{
      id: string;
      canonicalUrl?: string;
    }>;
    assert.equal(
      listed.find((b) => b.id === "org2")?.canonicalUrl,
      "https://kb.example.com/org",
    );
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
