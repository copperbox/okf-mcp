#!/usr/bin/env node
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { generateIndexes } from "./authoring.js";
import { buildGraph, exportGraph, graphSummary } from "./graph.js";
import type { GraphFormat } from "./graph.js";
import { searchConcepts } from "./search.js";
import { createOkfServer } from "./server.js";
import { OkfStore } from "./store.js";
import type { BundleConfig } from "./types.js";
import { validateBundle } from "./validate.js";

const USAGE = `okf-mcp — Open Knowledge Format MCP server and CLI

Usage:
  okf-mcp --bundle [id=]<path> [--bundle ...] [--writable] [command]

Commands:
  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report OKF v0.1 conformance errors and warnings
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format]      Export the link graph (json | dot | mermaid)
  index               Regenerate index.md files (requires --writable)

Options:
  --bundle [id=]path  Bundle directory; repeatable. ID defaults to the dir name.
  --writable          Enable authoring: write_concept tool and index command
  --help              Show this help
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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      bundle: { type: "string", multiple: true },
      writable: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const configs = parseBundleFlags(values.bundle ?? []);
  if (configs.length === 0) {
    console.error("error: at least one --bundle is required\n");
    console.error(USAGE);
    return 2;
  }

  const store = new OkfStore(configs);
  await store.load();
  const [command = "mcp", ...rest] = positionals;

  switch (command) {
    case "mcp": {
      const server = createOkfServer(store, { writable: values.writable ?? false });
      await server.connect(new StdioServerTransport());
      // stdout carries the protocol; log to stderr only.
      console.error(
        `okf-mcp serving ${configs.map((c) => c.id).join(", ")} over stdio` +
          (values.writable ? " (writable)" : " (read-only)"),
      );
      return -1; // keep the process alive for the transport
    }
    case "inspect": {
      for (const bundle of store.bundles()) {
        console.log(JSON.stringify(graphSummary(bundle), null, 2));
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
        const written = await generateIndexes(bundle);
        console.log(`${bundle.id}: wrote ${written.length} index files`);
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
