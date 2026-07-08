#!/usr/bin/env node
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { generateIndexes } from "./authoring.js";
import { buildGraph, exportGraph, graphSummary } from "./graph.js";
import type { GraphFormat } from "./graph.js";
import { searchConcepts } from "./search.js";
import { createOkfServer } from "./server.js";
import { OkfStore } from "./store.js";
import type { BundleConfig, RemoteBundleConfig } from "./types.js";
import { validateBundle } from "./validate.js";
import { watchBundles } from "./watch.js";

const USAGE = `okf-mcp — Open Knowledge Format MCP server and CLI

Usage:
  okf-mcp --bundle [id=]<path> [--remote-bundle id=<url>] [--canonical-url id=<url>]
          [--writable] [--watch] [command]

Commands:
  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report OKF v0.1 conformance errors and warnings
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format]      Export the link graph (json | dot | mermaid)
  index               Regenerate index.md files (requires --writable)

Options:
  --bundle [id=]path      Bundle directory; repeatable. ID defaults to the dir name.
  --remote-bundle id=url  Read-only bundle from a public GitHub tree URL
                          (https://github.com/<owner>/<repo>/tree/<ref>[/<path>])
                          or a .tar.gz/.tgz/.zip archive (URL or local path);
                          repeatable, indexed in memory at startup.
  --canonical-url id=url  Canonical published URL of a bundle's root (e.g. its
                          GitHub tree URL); repeatable. Citations and external
                          links under it resolve to that bundle's concepts as
                          derived cross-bundle graph edges.
  --writable              Enable authoring: write_concept tool and index command
  --watch                 mcp only: auto-reload local bundles when .md files
                          change on disk (remote bundles still reload only via
                          the reload_bundles tool)
  --help                  Show this help
`;

function parseBundleFlags(values: string[]): BundleConfig[] {
  return values.map((value) => {
    const eq = value.indexOf("=");
    if (eq > 0) {
      return { id: value.slice(0, eq), root: value.slice(eq + 1) };
    }
    const id = value.replace(/\/+$/, "").split("/").pop() || "bundle";
    return { id, root: value };
  });
}

/** Split an `id=<value>` flag argument, rejecting a missing id or value. */
function splitIdFlag(flag: string, expected: string, value: string): [string, string] {
  const eq = value.indexOf("=");
  if (eq <= 0 || value.slice(eq + 1) === "") {
    throw new Error(`${flag} requires ${expected}, got: ${value}`);
  }
  return [value.slice(0, eq), value.slice(eq + 1)];
}

function parseRemoteBundleFlags(values: string[]): RemoteBundleConfig[] {
  return values.map((value) => {
    const [id, url] = splitIdFlag("--remote-bundle", "id=<tree url or archive>", value);
    return { id, url };
  });
}

/**
 * Attach `--canonical-url id=url` values to the matching local or remote
 * bundle config (mutating in place). Unknown IDs are an error — a typo would
 * otherwise silently disable cross-bundle matching.
 */
function applyCanonicalUrlFlags(
  values: string[],
  configs: BundleConfig[],
  remotes: RemoteBundleConfig[],
): void {
  for (const value of values) {
    const [id, url] = splitIdFlag("--canonical-url", "id=<url>", value);
    const config =
      configs.find((c) => c.id === id) ?? remotes.find((r) => r.id === id);
    if (config === undefined) {
      throw new Error(`--canonical-url names an unknown bundle: ${id}`);
    }
    config.canonicalUrl = url;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      bundle: { type: "string", multiple: true },
      "remote-bundle": { type: "string", multiple: true },
      "canonical-url": { type: "string", multiple: true },
      writable: { type: "boolean" },
      watch: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const configs = parseBundleFlags(values.bundle ?? []);
  const remotes = parseRemoteBundleFlags(values["remote-bundle"] ?? []);
  applyCanonicalUrlFlags(values["canonical-url"] ?? [], configs, remotes);
  if (configs.length === 0 && remotes.length === 0) {
    console.error("error: at least one --bundle or --remote-bundle is required\n");
    console.error(USAGE);
    return 2;
  }

  const store = new OkfStore(configs, { remotes });
  await store.load();
  const [command = "mcp", ...rest] = positionals;

  switch (command) {
    case "mcp": {
      const server = createOkfServer(store, { writable: values.writable ?? false });
      await server.connect(new StdioServerTransport());
      // stdout carries the protocol; log to stderr only.
      console.error(
        `okf-mcp serving ${[...configs, ...remotes].map((c) => c.id).join(", ")} over stdio` +
          (values.writable ? " (writable)" : " (read-only)"),
      );
      if (values.watch) {
        const watcher = watchBundles(store, configs, {
          onReload: (stats) => {
            for (const s of stats) {
              if (s.added.length + s.removed.length + s.changed.length === 0) continue;
              console.error(
                `okf-mcp: reloaded ${s.bundle} ` +
                  `(+${s.added.length} -${s.removed.length} ~${s.changed.length})`,
              );
            }
          },
          onError: (bundleId, error) =>
            console.error(`okf-mcp: watch ${bundleId}: ${error.message}`),
        });
        if (watcher.watching.length > 0) {
          console.error(`okf-mcp: watching ${watcher.watching.join(", ")} for changes`);
        } else {
          console.error("okf-mcp: --watch: no local bundles are being watched");
        }
      }
      return -1; // keep the process alive for the transport
    }
    case "inspect": {
      for (const bundle of store.bundles()) {
        console.log(JSON.stringify(graphSummary(bundle, store.bundles()), null, 2));
      }
      return 0;
    }
    case "validate": {
      let failed = false;
      for (const bundle of store.bundles()) {
        const report = await validateBundle(bundle);
        console.log(JSON.stringify(report, null, 2));
        if (!report.conformant) failed = true;
      }
      return failed ? 1 : 0;
    }
    case "search": {
      const query = rest.join(" ");
      if (query === "") {
        console.error("error: search requires a query");
        return 2;
      }
      console.log(JSON.stringify(searchConcepts(store.bundles(), { query }), null, 2));
      return 0;
    }
    case "concept": {
      const id = rest[0];
      if (id === undefined) {
        console.error("error: concept requires an ID");
        return 2;
      }
      const concept = store.getConcept(undefined, id);
      if (!concept) {
        console.error(`error: unknown concept: ${id}`);
        return 1;
      }
      console.log(JSON.stringify(concept, null, 2));
      return 0;
    }
    case "graph": {
      const format = (rest[0] ?? "json") as GraphFormat;
      if (!["json", "dot", "mermaid"].includes(format)) {
        console.error(`error: unknown graph format: ${format}`);
        return 2;
      }
      console.log(exportGraph(buildGraph(store.bundle(undefined)), format));
      return 0;
    }
    case "index": {
      if (!values.writable) {
        console.error("error: index regeneration requires --writable");
        return 2;
      }
      for (const bundle of store.bundles()) {
        if (bundle.readOnly) {
          console.error(`${bundle.id}: skipped (read-only remote bundle)`);
          continue;
        }
        const { written, skipped } = await generateIndexes(bundle);
        const skippedNote =
          skipped.length > 0 ? `, skipped ${skipped.length} hand-curated` : "";
        console.log(`${bundle.id}: wrote ${written.length} index files${skippedNote}`);
      }
      return 0;
    }
    default:
      console.error(`error: unknown command: ${command}\n`);
      console.error(USAGE);
      return 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
