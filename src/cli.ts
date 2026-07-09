#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { generateIndexes } from "./authoring.js";
import { discoverColocatedBundles, readColocatedAgentsGuide } from "./bundle.js";
import { buildGraph, exportGraph, graphSummary } from "./graph.js";
import type { GraphFormat } from "./graph.js";
import { packBundle } from "./pack.js";
import { archiveKind } from "./remote.js";
import { searchConcepts } from "./search.js";
import { BUNDLE_GUIDE_BUDGET, createOkfServer } from "./server.js";
import type { BundleGuide } from "./server.js";
import { OkfStore } from "./store.js";
import type { BundleConfig, RemoteBundleConfig } from "./types.js";
import { validateBundle } from "./validate.js";
import { watchBundles } from "./watch.js";

const USAGE = `okf-mcp — Open Knowledge Format MCP server and CLI

Usage:
  okf-mcp --bundle [id=]<path> [--colocated-bundles <root> [--only <a,b,c>]]
          [--remote-bundle id=<url>] [--canonical-url [id=]<url>]
          [--writable] [--watch] [command]

Commands:
  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report OKF v0.1 conformance errors and warnings
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format]      Export the link graph (json | dot | mermaid)
  index               Regenerate index.md files (requires --writable)
  pack [bundle]       Publish a bundle as a distributable archive; indexes are
                      regenerated in-memory, so the source stays untouched

Options:
  --bundle [id=]path      Bundle directory; repeatable. ID defaults to the dir name.
  --colocated-bundles root
                          Mount every immediate subdirectory of <root> that
                          contains markdown as its own bundle (id = folder
                          name); repeatable. Dot directories and loose files
                          at the root are skipped. A root AGENTS.md is served
                          as a bundle guide in the MCP server instructions.
  --only a,b,c            With --colocated-bundles: mount only the named
                          subfolders (comma-separated); the rest of the root
                          is ignored entirely. A name that is not a bundle
                          subdirectory of the root is an error.
  --remote-bundle id=url  Read-only bundle from a public GitHub tree URL
                          (https://github.com/<owner>/<repo>/tree/<ref>[/<path>])
                          or a .tar.gz/.tgz/.zip archive (URL or local path);
                          repeatable, indexed in memory at startup.
  --canonical-url [id=]url
                          Canonical published URL of a bundle's root (e.g. its
                          GitHub tree URL); repeatable. Citations and external
                          links under it resolve to that bundle's concepts as
                          derived cross-bundle graph edges. With a colocated
                          root's path as the id — or a bare url when exactly
                          one --colocated-bundles root is configured — every
                          bundle under the root derives <url>/<folder>; an
                          explicit per-bundle id=url still overrides.
  --out <file>            pack only: output archive path ending in .tar.gz,
                          .tgz, or .zip; defaults to <bundle>.tar.gz
  --include <glob>        pack only: pack matching bundle-relative paths only;
                          repeatable, same semantics as load_remote_bundle
  --exclude <glob>        pack only: skip matching bundle-relative paths;
                          repeatable
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
 * Attach `--canonical-url` values to the matching bundle configs (mutating in
 * place). `id=url` targets a local or remote bundle; a colocated root's path
 * as the id — or a bare URL when exactly one root is configured — declares
 * the root's published URL, and every bundle discovered under it derives
 * `<rootUrl>/<folder>` (a GitHub tree URL stays a tree URL, so the derived
 * value expands to tree/blob/raw prefixes like any other). An explicit
 * per-bundle `id=url` beats the derived value regardless of flag order.
 * Unknown IDs are an error — a typo would otherwise silently disable
 * cross-bundle matching.
 */
function applyCanonicalUrlFlags(
  values: string[],
  configs: BundleConfig[],
  remotes: RemoteBundleConfig[],
  colocatedRoots: string[],
): void {
  const rootUrls = new Map<string, string>();
  for (const value of values) {
    if (/^https?:\/\//i.test(value)) {
      const roots = [...new Set(colocatedRoots.map((r) => path.resolve(r)))];
      if (roots.length !== 1) {
        throw new Error(
          "--canonical-url without id= requires exactly one --colocated-bundles " +
            `root (found ${roots.length}); use --canonical-url <root>=<url>`,
        );
      }
      rootUrls.set(roots[0]!, value);
      continue;
    }
    const [id, url] = splitIdFlag("--canonical-url", "id=<url>", value);
    const config =
      configs.find((c) => c.id === id) ?? remotes.find((r) => r.id === id);
    if (config !== undefined) {
      config.canonicalUrl = url;
      continue;
    }
    const root = colocatedRoots.find((r) => path.resolve(r) === path.resolve(id));
    if (root === undefined) {
      throw new Error(
        `--canonical-url names an unknown bundle or colocated root: ${id}`,
      );
    }
    rootUrls.set(path.resolve(root), url);
  }
  for (const config of configs) {
    if (config.canonicalUrl !== undefined || config.colocatedRoot === undefined) {
      continue;
    }
    const rootUrl = rootUrls.get(path.resolve(config.colocatedRoot));
    if (rootUrl === undefined) continue;
    config.canonicalUrl = `${rootUrl.replace(/\/+$/, "")}/${config.id}`;
  }
}

/**
 * Read each colocated root's AGENTS.md (agent-facing bundle guide) for the
 * server instructions, warning on stderr when one exceeds the injection
 * budget and will be truncated.
 */
async function collectBundleGuides(roots: string[]): Promise<BundleGuide[]> {
  const guides: BundleGuide[] = [];
  for (const root of [...new Set(roots)]) {
    const text = await readColocatedAgentsGuide(root);
    if (text === undefined) continue;
    const source = path.resolve(root, "AGENTS.md");
    if (text.length > BUNDLE_GUIDE_BUDGET) {
      console.error(
        `okf-mcp: ${source} is ${text.length} chars; instructions carry the first ` +
          `~${BUNDLE_GUIDE_BUDGET} and point at the full file — keep it a short bundle registry`,
      );
    }
    guides.push({ text, source });
  }
  return guides;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      bundle: { type: "string", multiple: true },
      "colocated-bundles": { type: "string", multiple: true },
      only: { type: "string" },
      "remote-bundle": { type: "string", multiple: true },
      "canonical-url": { type: "string", multiple: true },
      out: { type: "string" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
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
  const only = values.only
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (only !== undefined) {
    if ((values["colocated-bundles"] ?? []).length === 0) {
      console.error("error: --only requires --colocated-bundles");
      return 2;
    }
    if (only.length === 0) {
      console.error("error: --only requires at least one folder name");
      return 2;
    }
  }
  for (const root of values["colocated-bundles"] ?? []) {
    let discovered: BundleConfig[];
    try {
      discovered = await discoverColocatedBundles(root, { only });
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      return 2;
    }
    if (discovered.length === 0) {
      console.error(
        `error: --colocated-bundles found no bundle subdirectories under: ${root}`,
      );
      return 2;
    }
    configs.push(...discovered);
  }
  const remotes = parseRemoteBundleFlags(values["remote-bundle"] ?? []);
  try {
    applyCanonicalUrlFlags(
      values["canonical-url"] ?? [],
      configs,
      remotes,
      values["colocated-bundles"] ?? [],
    );
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  if (configs.length === 0 && remotes.length === 0) {
    console.error(
      "error: at least one --bundle, --colocated-bundles, or --remote-bundle is required\n",
    );
    console.error(USAGE);
    return 2;
  }

  const store = new OkfStore(configs, { remotes });
  await store.load();
  const [command = "mcp", ...rest] = positionals;

  switch (command) {
    case "mcp": {
      const server = createOkfServer(store, {
        writable: values.writable ?? false,
        bundleGuides: await collectBundleGuides(values["colocated-bundles"] ?? []),
      });
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
        const report = await validateBundle(bundle, store.bundles());
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
    case "pack": {
      const bundle = store.bundle(rest[0]);
      const out = values.out ?? `${bundle.id}.tar.gz`;
      const format = archiveKind(out);
      if (format === null) {
        console.error(`error: --out must end in .tar.gz, .tgz, or .zip: ${out}`);
        return 2;
      }
      const result = await packBundle(bundle, {
        include: values.include,
        exclude: values.exclude,
        format,
      });
      await fs.writeFile(out, result.bytes);
      console.log(`${bundle.id}: packed ${result.files.length} files to ${out}`);
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
