import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createOkfServer } from "../src/server.js";
import { OkfStore } from "../src/store.js";
import { commitAll, initRepo } from "./helpers.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

/** Load the store's bundles and connect an in-memory client to a fresh server. */
async function connectClient(store: OkfStore): Promise<Client> {
  await store.load();
  const server = createOkfServer(store);
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
