/**
 * Context-efficiency benchmark for okf-mcp.
 *
 * Spins up an in-memory server (same idiom as test/server.test.ts) against the
 * acme fixture plus a generated synthetic bundle, replays a realistic agent
 * tool-call sequence, and reports the serialized response size of every call
 * alongside the session-fixed costs (server instructions + tool definitions).
 *
 * This is experimental tooling for A/B-testing context-efficiency changes; it
 * is not part of the published package.
 *
 * Usage:
 *   npm run bench                        # human-readable table
 *   npm run bench -- --json              # machine-readable results on stdout
 *   npm run bench -- --baseline <file>   # print deltas vs a saved --json run
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createOkfServer } from "../src/server.js";
import type { ServerOptions } from "../src/server.js";
import { OkfStore } from "../src/store.js";
import { PACKAGE_VERSION } from "../src/version.js";

const FIXTURE = path.join(import.meta.dirname, "..", "test", "fixtures", "acme");

// Token heuristic: ~4 characters per token, the usual rough figure for English
// prose and JSON. Good enough for A/B deltas; absolute numbers are estimates.
const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Scenarios: encoded as data so new experiments just append entries.
// ---------------------------------------------------------------------------

interface BenchCall {
  /** Stable label used for table rows and baseline matching. */
  label: string;
  tool: string;
  args: Record<string, unknown>;
}

interface Scenario {
  name: string;
  calls: BenchCall[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "orient",
    calls: [
      { label: "list_bundles", tool: "list_bundles", args: {} },
      { label: "graph_summary (all bundles)", tool: "graph_summary", args: {} },
    ],
  },
  {
    name: "research",
    calls: [
      {
        label: "search #1 (orders sales)",
        tool: "search_concepts",
        args: { query: "orders sales" },
      },
      {
        label: "search #1 (orders sales, compact)",
        tool: "search_concepts",
        args: { query: "orders sales", format: "compact" },
      },
      {
        label: "search #2 (checkout pipeline)",
        tool: "search_concepts",
        args: { query: "checkout pipeline" },
      },
      {
        label: "search #3 (retry backoff runbook)",
        tool: "search_concepts",
        args: { query: "retry backoff runbook" },
      },
      {
        label: "search #3 (retry backoff runbook, compact)",
        tool: "search_concepts",
        args: { query: "retry backoff runbook", format: "compact" },
      },
      {
        label: "get_concept outline",
        tool: "get_concept",
        args: { bundle: "acme", id: "tables/orders", outline: true },
      },
      {
        label: "get_concept section",
        tool: "get_concept",
        args: { bundle: "acme", id: "tables/orders", section: "Schema" },
      },
      {
        label: "get_concept full",
        tool: "get_concept",
        args: { bundle: "acme", id: "tables/orders" },
      },
      {
        label: "get_neighbors (hub)",
        tool: "get_neighbors",
        args: { bundle: "synth", id: "services/core-gateway" },
      },
      {
        label: "get_neighbors (hub, compact)",
        tool: "get_neighbors",
        args: { bundle: "synth", id: "services/core-gateway", format: "compact" },
      },
      {
        label: "export_graph summary",
        tool: "export_graph",
        args: { bundle: "synth", detail: "summary" },
      },
    ],
  },
  {
    name: "maintenance",
    calls: [
      { label: "validate_bundle (all)", tool: "validate_bundle", args: {} },
      {
        label: "list_concepts page",
        tool: "list_concepts",
        args: { bundle: "synth", limit: 50 },
      },
      {
        label: "list_concepts page (compact)",
        tool: "list_concepts",
        args: { bundle: "synth", limit: 50, format: "compact" },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Synthetic bundle: deterministic, mid-sized (130 concepts + hub) so numbers
// aren't toy-sized. Same shape as the cap tests' generated bundles.
// ---------------------------------------------------------------------------

async function writeSyntheticBundle(root: string): Promise<void> {
  const write = (rel: string, content: string) =>
    fs.writeFile(path.join(root, rel), content);

  await fs.mkdir(path.join(root, "services"), { recursive: true });
  await fs.mkdir(path.join(root, "pipelines"), { recursive: true });
  await fs.mkdir(path.join(root, "runbooks"), { recursive: true });
  await fs.mkdir(path.join(root, "decisions"), { recursive: true });

  await write(
    "services/core-gateway.md",
    [
      "---",
      "type: Service",
      "title: Core Gateway",
      "description: The API gateway every service routes through.",
      "tags: [platform, gateway]",
      "---",
      "",
      "# Overview",
      "",
      "Terminates TLS and routes checkout, billing, and catalog traffic.",
      "",
      "# Operations",
      "",
      "Rollouts are canaried; see per-service runbooks.",
      "",
    ].join("\n"),
  );

  for (let i = 0; i < 40; i++) {
    await write(
      `services/svc-${i}.md`,
      [
        "---",
        "type: Service",
        `title: Service ${i}`,
        `description: Backend service ${i} in the checkout fleet.`,
        `tags: [checkout, tier-${i % 3}]`,
        "---",
        "",
        "# Overview",
        "",
        `Handles slice ${i} of checkout traffic behind the`,
        "[core gateway](./core-gateway.md).",
        "",
        "# Dependencies",
        "",
        `Talks to [service ${(i + 1) % 40}](./svc-${(i + 1) % 40}.md) for fallback.`,
        "",
      ].join("\n"),
    );
  }

  for (let i = 0; i < 40; i++) {
    await write(
      `pipelines/pipe-${i}.md`,
      [
        "---",
        "type: Pipeline",
        `title: Pipeline ${i}`,
        `description: Batch pipeline ${i} feeding the checkout warehouse tables.`,
        `tags: [data, batch, shard-${i % 5}]`,
        "---",
        "",
        "# Schedule",
        "",
        `Runs hourly at :${String(i % 60).padStart(2, "0")} against`,
        `[service ${i}](../services/svc-${i}.md) event streams.`,
        "",
        "# Failure modes",
        "",
        "Upstream lag shows up as empty partitions; retries are idempotent.",
        "",
      ].join("\n"),
    );
  }

  for (let i = 0; i < 30; i++) {
    await write(
      `runbooks/rb-${i}.md`,
      [
        "---",
        "type: Runbook",
        `title: Runbook ${i}`,
        `description: Incident response for pipeline ${i} stalls.`,
        "tags: [oncall, runbook]",
        "---",
        "",
        "# Symptoms",
        "",
        `[Pipeline ${i}](../pipelines/pipe-${i}.md) checkpoints stop advancing.`,
        "",
        "# Remediation",
        "",
        "Bump the retry backoff, drain the dead-letter queue, and replay from",
        "the last good checkpoint. Escalate if a second retry cycle fails.",
        "",
      ].join("\n"),
    );
  }

  for (let i = 0; i < 20; i++) {
    await write(
      `decisions/adr-${i}.md`,
      [
        "---",
        "type: Decision",
        `title: ADR ${i}`,
        `description: Why service ${i * 2} owns its own datastore.`,
        "tags: [architecture, adr]",
        "---",
        "",
        "# Context",
        "",
        `[Service ${i * 2}](../services/svc-${i * 2}.md) previously shared a`,
        "database with the [core gateway](../services/core-gateway.md).",
        "",
        "# Decision",
        "",
        "Split the datastore; shared-schema coupling caused lockstep deploys.",
        "",
      ].join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

interface CallResult {
  scenario: string;
  label: string;
  tool: string;
  bytes: number;
  tokens: number;
  isError: boolean;
}

interface FixedCosts {
  instructionsBytes: number;
  instructionsTokens: number;
  toolCount: number;
  toolDefsBytes: number;
  toolDefsTokens: number;
}

/**
 * Fixed tool-definition cost of one feature-set configuration: what tools/list
 * advertises when the server is started with those `features` (experimental
 * feature-group toolset gating).
 */
interface FeatureSetCost {
  label: string;
  toolCount: number;
  toolDefsBytes: number;
  toolDefsTokens: number;
}

interface BenchResults {
  version: string;
  generatedAt: string;
  fixed: FixedCosts;
  /** Absent in baselines recorded before feature-group gating existed. */
  featureSets?: FeatureSetCost[];
  calls: CallResult[];
  callTotalBytes: number;
  callTotalTokens: number;
  grandTotalBytes: number;
  grandTotalTokens: number;
}

/**
 * Size of a tool response as an agent's context sees it: the serialized
 * content blocks of the CallToolResult (what the client injects into the
 * conversation), measured in UTF-8 bytes.
 */
function responseSize(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result.content), "utf8");
}

/**
 * Serialized size of every tool definition a server configured with `options`
 * advertises — the fixed cost a client injects into the model's context.
 */
async function measureToolDefs(
  store: OkfStore,
  options: ServerOptions,
): Promise<{ toolCount: number; toolDefsBytes: number }> {
  const server = createOkfServer(store, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "context-bench-fixed", version: PACKAGE_VERSION });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const toolDefsBytes = tools.reduce(
    (sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool), "utf8"),
    0,
  );
  await client.close();
  return { toolCount: tools.length, toolDefsBytes };
}

/**
 * Feature-set configurations whose fixed tool-definition cost the bench
 * reports. Measured writable so "all features" prices the full catalog and
 * the gated sets show what a features-scoped session saves.
 */
const FEATURE_SETS: { label: string; options: ServerOptions }[] = [
  { label: "all features (writable)", options: { writable: true } },
  { label: "all features (read-only)", options: {} },
  { label: 'features ["read"]', options: { writable: true, features: ["read"] } },
  {
    label: 'features ["read","graph"]',
    options: { writable: true, features: ["read", "graph"] },
  },
];

async function runBench(): Promise<BenchResults> {
  const synthRoot = await fs.mkdtemp(path.join(os.tmpdir(), "okf-bench-"));
  try {
    await writeSyntheticBundle(synthRoot);

    const store = new OkfStore([
      { id: "acme", root: FIXTURE },
      { id: "synth", root: synthRoot },
    ]);
    await store.load();
    const server = createOkfServer(store, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "context-bench", version: PACKAGE_VERSION });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // Fixed costs: paid once per session, before any tool call.
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    // Serialize each advertised tool definition (name, title, description,
    // JSON-schema derived from the zod input schema) the way a client would
    // inject it into the model's context.
    const toolDefsBytes = tools.reduce(
      (sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool), "utf8"),
      0,
    );
    const fixed: FixedCosts = {
      instructionsBytes: Buffer.byteLength(instructions, "utf8"),
      instructionsTokens: estimateTokens(instructions.length),
      toolCount: tools.length,
      toolDefsBytes,
      toolDefsTokens: estimateTokens(toolDefsBytes),
    };

    const calls: CallResult[] = [];
    for (const scenario of SCENARIOS) {
      for (const call of scenario.calls) {
        const result = (await client.callTool({
          name: call.tool,
          arguments: call.args,
        })) as CallToolResult;
        const bytes = responseSize(result);
        calls.push({
          scenario: scenario.name,
          label: call.label,
          tool: call.tool,
          bytes,
          tokens: estimateTokens(bytes),
          isError: result.isError === true,
        });
      }
    }

    await client.close();

    // Fixed-cost measurement per feature set (experimental toolset gating).
    const featureSets: FeatureSetCost[] = [];
    for (const set of FEATURE_SETS) {
      const measured = await measureToolDefs(store, set.options);
      featureSets.push({
        label: set.label,
        ...measured,
        toolDefsTokens: estimateTokens(measured.toolDefsBytes),
      });
    }

    const callTotalBytes = calls.reduce((sum, c) => sum + c.bytes, 0);
    const callTotalTokens = calls.reduce((sum, c) => sum + c.tokens, 0);
    return {
      version: PACKAGE_VERSION,
      generatedAt: new Date().toISOString(),
      fixed,
      featureSets,
      calls,
      callTotalBytes,
      callTotalTokens,
      grandTotalBytes: callTotalBytes + fixed.instructionsBytes + fixed.toolDefsBytes,
      grandTotalTokens:
        callTotalTokens + fixed.instructionsTokens + fixed.toolDefsTokens,
    };
  } finally {
    await fs.rm(synthRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function row(label: string, bytes: number, tokens: number, indent = "  "): string {
  return `${(indent + label).padEnd(44)} ${String(bytes).padStart(9)} ${String(tokens).padStart(8)}`;
}

function printTable(results: BenchResults): void {
  console.log(`okf-mcp context bench (v${results.version})`);
  console.log();
  console.log(`${"".padEnd(44)} ${"bytes".padStart(9)} ${"~tokens".padStart(8)}`);
  console.log("-".repeat(63));

  for (const scenario of new Set(results.calls.map((c) => c.scenario))) {
    console.log(`${scenario}:`);
    const scenarioCalls = results.calls.filter((c) => c.scenario === scenario);
    for (const call of scenarioCalls) {
      const flag = call.isError ? "  [ERROR]" : "";
      console.log(row(call.label, call.bytes, call.tokens) + flag);
    }
    console.log(
      row(
        "subtotal",
        scenarioCalls.reduce((s, c) => s + c.bytes, 0),
        scenarioCalls.reduce((s, c) => s + c.tokens, 0),
        "  = ",
      ),
    );
  }

  console.log("fixed (per-session):");
  console.log(
    row(
      "server instructions",
      results.fixed.instructionsBytes,
      results.fixed.instructionsTokens,
    ),
  );
  console.log(
    row(
      `tool definitions (${results.fixed.toolCount} tools)`,
      results.fixed.toolDefsBytes,
      results.fixed.toolDefsTokens,
    ),
  );
  if (results.featureSets !== undefined) {
    console.log("fixed cost by feature set (tool definitions):");
    for (const set of results.featureSets) {
      console.log(
        row(`${set.label} (${set.toolCount} tools)`, set.toolDefsBytes, set.toolDefsTokens),
      );
    }
  }
  console.log("-".repeat(63));
  console.log(row("calls total", results.callTotalBytes, results.callTotalTokens, ""));
  console.log(
    row("grand total (fixed + calls)", results.grandTotalBytes, results.grandTotalTokens, ""),
  );
}

function pct(current: number, base: number): string {
  if (base === 0) return "n/a";
  const delta = ((current - base) / base) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function deltaRow(label: string, current: number, base: number): string {
  const diff = current - base;
  return `${("  " + label).padEnd(44)} ${String(diff >= 0 ? `+${diff}` : diff).padStart(9)} ${pct(current, base).padStart(8)}`;
}

function printBaselineDiff(results: BenchResults, baseline: BenchResults): void {
  console.log();
  console.log(`vs baseline v${baseline.version} (${baseline.generatedAt})`);
  console.log(`${"".padEnd(44)} ${"Δbytes".padStart(9)} ${"Δ%".padStart(8)}`);
  console.log("-".repeat(63));
  for (const call of results.calls) {
    const base = baseline.calls.find(
      (b) => b.scenario === call.scenario && b.label === call.label,
    );
    if (base === undefined) {
      console.log(`  ${call.scenario}/${call.label}: not in baseline`);
      continue;
    }
    console.log(deltaRow(`${call.scenario}/${call.label}`, call.bytes, base.bytes));
  }
  for (const base of baseline.calls) {
    if (
      !results.calls.some(
        (c) => c.scenario === base.scenario && c.label === base.label,
      )
    ) {
      console.log(`  ${base.scenario}/${base.label}: only in baseline`);
    }
  }
  console.log(
    deltaRow(
      "server instructions",
      results.fixed.instructionsBytes,
      baseline.fixed.instructionsBytes,
    ),
  );
  console.log(
    deltaRow("tool definitions", results.fixed.toolDefsBytes, baseline.fixed.toolDefsBytes),
  );
  console.log("-".repeat(63));
  console.log(deltaRow("calls total", results.callTotalBytes, baseline.callTotalBytes));
  console.log(
    deltaRow("grand total", results.grandTotalBytes, baseline.grandTotalBytes),
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const baselineIndex = args.indexOf("--baseline");
  const baselinePath = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;
  if (baselineIndex >= 0 && baselinePath === undefined) {
    console.error("--baseline requires a file argument");
    process.exit(2);
  }

  const results = await runBench();

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printTable(results);
  }

  if (baselinePath !== undefined) {
    const baseline = JSON.parse(
      await fs.readFile(baselinePath, "utf8"),
    ) as BenchResults;
    printBaselineDiff(results, baseline);
  }

  if (results.calls.some((c) => c.isError)) {
    console.error("\nsome benchmark calls returned errors — results are not comparable");
    process.exit(1);
  }
}

await main();
