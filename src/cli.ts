#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { generateIndexes } from "./authoring.js";
import { citationPrefix } from "./canonical.js";
import { discoverColocatedBundles, readColocatedAgentsGuide } from "./bundle.js";
import {
  CONFIG_FILENAME,
  LOCAL_CONFIG_FILENAME,
  loadOkfConfig,
  userConfigDir,
} from "./config.js";
import type { ResolvedColocatedRoot, ResolvedConfig } from "./config.js";
import { buildGraph, buildMultiGraph, exportGraph, graphSummary } from "./graph.js";
import type { GraphFormat } from "./graph.js";
import { packBundle } from "./pack.js";
import { archiveKind } from "./remote.js";
import { repairBundle, selectFixers } from "./repair.js";
import { searchConcepts } from "./search.js";
import { BUNDLE_GUIDE_BUDGET, createOkfServer } from "./server.js";
import type { BundleGuide } from "./server.js";
import { OkfStore } from "./store.js";
import type { BundleConfig, RemoteBundleConfig } from "./types.js";
import { validateBundle } from "./validate.js";
import { communityAssigner, exportGraphHtml } from "./visualize.js";
import type { CommunityMode } from "./visualize.js";
import { watchBundles } from "./watch.js";

const USAGE = `okf-mcp — Open Knowledge Format MCP server and CLI

Usage:
  okf-mcp [--bundle [id=]<path>] [--colocated-bundles <root> [--only <a,b,c>]]
          [--remote-bundle id=<url>] [--colocated-remote-bundles <url>]
          [--canonical-url [id=]<url>] [--writable] [--watch]
          [--config <file> | --no-config]
          [--search-limit <n>] [--search-cutoff <ratio>] [command]

Bundles may be declared in ${CONFIG_FILENAME} files instead of on the command
line, which is how a project commits its own mounts while each developer adds
personal ones locally. Layers apply lowest precedence first: the user config
(~/.config/okf/config.json), then ${CONFIG_FILENAME} and ${LOCAL_CONFIG_FILENAME}
in every directory from the filesystem root down to the working directory, then
these flags. Same-id bundles are replaced by the higher layer; everything else
unions.

  {
    "bundles": {
      "brain": { "path": "okf-bundle/", "writable": true },
      "team": "../shared/team-brain"
    }
  }

Commands:
  mcp                 Start the stdio MCP server (default)
  inspect             Print a summary of each bundle's graph
  validate            Report OKF v0.1 conformance errors and warnings
  search <query>      Search concepts
  concept <id>        Print one concept document as JSON
  graph [format] [bundle]
                      Export the link graph (json | dot | mermaid | html).
                      With several bundles mounted and no bundle named, all
                      export as one merged graph: bundle:concept node IDs plus
                      derived cross-bundle edges (dashed in dot/mermaid).
                      html is one self-contained interactive page (embedded
                      data + force-directed canvas, no network access): nodes
                      colored by community — bundle for a merged graph,
                      concept type for a single bundle unless --community
                      overrides
  index               Regenerate index.md files (requires --writable)
  pack [bundle]       Publish a bundle as a distributable archive; indexes are
                      regenerated in-memory, so the source stays untouched
  repair [bundle]     Detect known bundle defect classes via a registry of
                      auto-fixers and report per-fixer findings (dry-run);
                      --write applies the safe rewrites, appends a log.md
                      entry, and regenerates indexes. For this command --only
                      names fixers (--only citation-format,...) and --list
                      prints the fixer registry. Read-only remote bundles are
                      skipped

Options:
  --bundle [id=]path      Bundle directory; repeatable. ID defaults to the dir name.
  --colocated-bundles root
                          Mount every immediate subdirectory of <root> that
                          contains markdown as its own bundle (id = folder
                          name); repeatable. Dot directories and loose files
                          at the root are skipped. A root AGENTS.md is served
                          as a bundle guide in the MCP server instructions.
                          The mcp command mounts these lazily: discovered at
                          startup (name + index.md description), parsed on
                          first access; other commands load them eagerly.
  --only a,b,c            With --colocated-bundles or
                          --colocated-remote-bundles: mount only the named
                          subfolders (comma-separated); the rest of the root
                          is ignored entirely. A name that is not a bundle
                          subdirectory of the root is an error. With the
                          repair command, names fixers instead.
  --remote-bundle id=url  Read-only bundle from a public GitHub tree URL
                          (https://github.com/<owner>/<repo>/tree/<ref>[/<path>])
                          or a .tar.gz/.tgz/.zip archive (URL or local path);
                          repeatable, indexed in memory at startup.
  --colocated-remote-bundles url
                          Mount a published colocated root by URL (GitHub
                          tree, or .tar.gz/.tgz/.zip archive): every
                          immediate subdirectory containing markdown becomes
                          its own read-only bundle (id = folder name);
                          repeatable. Tree mounts derive per-bundle canonical
                          URLs as <url>/<folder>; size/count limits apply
                          across the whole root. A root AGENTS.md is fetched
                          and served as a bundle guide in the MCP server
                          instructions.
  --canonical-url [id=]url
                          Canonical published URL of a bundle's root (e.g. its
                          GitHub tree URL); repeatable. Citations and external
                          links under it resolve to that bundle's concepts as
                          derived cross-bundle graph edges. With a colocated
                          root's path as the id — or a bare url when exactly
                          one --colocated-bundles root is configured — every
                          bundle under the root derives <url>/<folder>; an
                          explicit per-bundle id=url still overrides.
  --search-limit n        Default hits per search_concepts page (and for the
                          search command). Default: 10; agents may still pass
                          a per-call limit up to 200.
  --search-cutoff ratio   Relevance cutoff for text queries: hits scoring
                          below <ratio> × the top hit's score are dropped and
                          counted in the result's \`omitted\` field. 0 disables.
                          Default: 0.25.
  --include-external      graph only: include external link targets (https:,
                          repo:, ...) as opaque nodes; a URL that derived a
                          cross-bundle edge is not duplicated as one
  --community mode        graph html only: how a single bundle's nodes group
                          into communities — type (default; the concept type),
                          folder (first path segment of the concept ID, (root)
                          for top-level concepts), or tag (first frontmatter
                          tag, (untagged) when absent). A merged multi-bundle
                          graph always groups by bundle, so --community is
                          rejected there; name a bundle to use it
  --out <file>            graph: write the export there instead of stdout.
                          pack: output archive path ending in .tar.gz, .tgz,
                          or .zip; defaults to <bundle>.tar.gz
  --include <glob>        pack only: pack matching bundle-relative paths only;
                          repeatable, same semantics as load_remote_bundle
  --exclude <glob>        pack only: skip matching bundle-relative paths;
                          repeatable
  --write                 repair only: apply the safe rewrites (repair is a
                          dry run without it)
  --list                  repair only: print the fixer registry and exit
  --config <file>         Use this config file only, skipping discovery. Also
                          settable as OKF_CONFIG.
  --no-config             Ignore every ${CONFIG_FILENAME}; mount only what these
                          flags declare. Also settable as OKF_NO_CONFIG=1.
  --writable              Enable authoring: write_concept tool and index
                          command. Server-wide — every bundle that does not
                          declare its own "writable" in a config file becomes
                          writable. A config file's per-bundle "writable": false
                          keeps that bundle read-only even here, and a bundle
                          declaring "writable": true enables authoring without
                          this flag.
  --watch                 mcp only: auto-reload local bundles when .md files
                          change on disk (remote bundles still reload only via
                          the reload_bundles tool). Lazily mounted colocated
                          bundles are watched from the moment they load.
  --help                  Show this help
`;

function parseBundleFlags(values: string[]): BundleConfig[] {
  return values.map((value) => {
    const eq = value.indexOf("=");
    if (eq === 0) {
      throw new Error(
        `--bundle has an empty id: "${value}" — use id=<path>, or just <path> to derive the id from the directory name`,
      );
    }
    if (eq > 0) {
      const root = value.slice(eq + 1);
      if (root === "") {
        throw new Error(`--bundle has an empty path: "${value}" — use id=<path>`);
      }
      return { id: value.slice(0, eq), root };
    }
    const id = value.replace(/\/+$/, "").split("/").pop() || "bundle";
    return { id, root: value };
  });
}

/** Parse a numeric flag value, rejecting non-numbers and out-of-range values. */
function parseNumericFlag(
  flag: string,
  value: string | undefined,
  range: { integer?: boolean; min?: number; max?: number },
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    Number.isNaN(parsed) ||
    (range.integer === true && !Number.isInteger(parsed)) ||
    (range.min !== undefined && parsed < range.min) ||
    (range.max !== undefined && parsed > range.max)
  ) {
    const kind = range.integer === true ? "an integer" : "a number";
    const bounds = [
      range.min !== undefined ? `>= ${range.min}` : undefined,
      range.max !== undefined ? `<= ${range.max}` : undefined,
    ]
      .filter((b) => b !== undefined)
      .join(" and ");
    throw new Error(`${flag} requires ${kind}${bounds ? ` ${bounds}` : ""}, got: ${value}`);
  }
  return parsed;
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
  const resolvedRoots = [...new Set(colocatedRoots.map((root) => path.resolve(root)))];
  const rootUrls = new Map<string, string>();
  for (const value of values) {
    if (/^https?:\/\//i.test(value)) {
      if (resolvedRoots.length !== 1) {
        throw new Error(
          "--canonical-url without id= requires exactly one --colocated-bundles " +
            `root (found ${resolvedRoots.length}); use --canonical-url <root>=<url>`,
        );
      }
      rootUrls.set(resolvedRoots[0]!, value);
      continue;
    }
    const [id, url] = splitIdFlag("--canonical-url", "id=<url>", value);
    const config =
      configs.find((c) => c.id === id) ?? remotes.find((r) => r.id === id);
    if (config !== undefined) {
      config.canonicalUrl = url;
      continue;
    }
    const resolvedId = path.resolve(id);
    if (!resolvedRoots.includes(resolvedId)) {
      throw new Error(
        `--canonical-url names an unknown bundle or colocated root: ${id}`,
      );
    }
    rootUrls.set(resolvedId, url);
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

/** Bundle guide for the server instructions, warning on stderr when it
 * exceeds the injection budget and will be truncated. */
function bundleGuide(text: string, source: string): BundleGuide {
  if (text.length > BUNDLE_GUIDE_BUDGET) {
    console.error(
      `okf-mcp: ${source} is ${text.length} chars; instructions carry the first ` +
        `~${BUNDLE_GUIDE_BUDGET} and point at the full file — keep it a short bundle registry`,
    );
  }
  return { text, source };
}

/**
 * Read each colocated root's AGENTS.md (agent-facing bundle guide) for the
 * server instructions.
 */
async function collectBundleGuides(roots: string[]): Promise<BundleGuide[]> {
  const guides: BundleGuide[] = [];
  for (const root of [...new Set(roots)]) {
    const text = await readColocatedAgentsGuide(root);
    if (text === undefined) continue;
    guides.push(bundleGuide(text, path.resolve(root, "AGENTS.md")));
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
      "colocated-remote-bundles": { type: "string", multiple: true },
      "canonical-url": { type: "string", multiple: true },
      community: { type: "string" },
      out: { type: "string" },
      "include-external": { type: "boolean" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      write: { type: "boolean" },
      list: { type: "boolean" },
      writable: { type: "boolean" },
      watch: { type: "boolean" },
      config: { type: "string" },
      "no-config": { type: "boolean" },
      "search-limit": { type: "string" },
      "search-cutoff": { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  // Config files first, CLI flags on top: a flag replaces the config entry
  // with the same bundle id and adds anything the files did not declare.
  let resolved: ResolvedConfig;
  let configs: BundleConfig[];
  try {
    resolved = await loadOkfConfig({
      ...(values.config !== undefined
        ? { configPath: values.config }
        : process.env.OKF_CONFIG
          ? { configPath: process.env.OKF_CONFIG }
          : {}),
      noConfig: values["no-config"] === true || process.env.OKF_NO_CONFIG === "1",
      ...(process.env.OKF_CONFIG_HOME !== undefined && {
        configHome: process.env.OKF_CONFIG_HOME,
      }),
    });
    configs = [...resolved.bundles];
    for (const flagConfig of parseBundleFlags(values.bundle ?? [])) {
      const existing = configs.findIndex((c) => c.id === flagConfig.id);
      if (existing >= 0) configs[existing] = flagConfig;
      else configs.push(flagConfig);
    }
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  for (const warning of resolved.warnings) {
    console.error(`okf-mcp: ${warning}`);
  }
  const [command = "mcp", ...rest] = positionals;
  let searchLimit: number | undefined;
  let searchCutoff: number | undefined;
  try {
    searchLimit = parseNumericFlag("--search-limit", values["search-limit"], {
      integer: true,
      min: 1,
    });
    searchCutoff = parseNumericFlag("--search-cutoff", values["search-cutoff"], {
      min: 0,
      max: 1,
    });
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  searchLimit ??= resolved.searchLimit;
  searchCutoff ??= resolved.searchCutoff;
  // Colocated roots from config carry their own --only/--writable/canonical
  // URL; roots named on the command line share the global --only.
  const colocatedRootSpecs = new Map<string, ResolvedColocatedRoot>();
  for (const spec of resolved.colocatedRoots) colocatedRootSpecs.set(spec.path, spec);
  for (const root of values["colocated-bundles"] ?? []) {
    colocatedRootSpecs.set(path.resolve(root), { path: path.resolve(root) });
  }
  const colocatedRoots = [...colocatedRootSpecs.keys()];
  const remoteRootConfigs = new Map(
    resolved.colocatedRemoteRoots.map((config) => [config.url, config]),
  );
  const remoteRootUrls = values["colocated-remote-bundles"] ?? [];
  const only = values.only
    ?.split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  // For the repair command --only names fixers, not colocated subfolders.
  const fixerOnly = command === "repair" ? only : undefined;
  const folderOnly = command === "repair" ? undefined : only;
  if (only !== undefined) {
    if (
      command !== "repair" &&
      colocatedRoots.length === 0 &&
      remoteRootUrls.length === 0 &&
      remoteRootConfigs.size === 0
    ) {
      console.error(
        "error: --only requires --colocated-bundles or --colocated-remote-bundles",
      );
      return 2;
    }
    if (only.length === 0) {
      console.error(
        `error: --only requires at least one ${command === "repair" ? "fixer id" : "folder name"}`,
      );
      return 2;
    }
  }
  if (command === "repair") {
    try {
      const fixers = selectFixers(fixerOnly);
      if (values.list) {
        for (const fixer of fixers) {
          console.log(`${fixer.id}: ${fixer.description}`);
        }
        return 0;
      }
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      return 2;
    }
  }
  for (const spec of colocatedRootSpecs.values()) {
    const root = spec.path;
    const rootOnly = spec.only ?? folderOnly;
    let discovered: BundleConfig[];
    const skipped: string[] = [];
    try {
      discovered = await discoverColocatedBundles(root, {
        only: rootOnly,
        onSkip: (folder) => skipped.push(folder),
      });
    } catch (err) {
      console.error(`error: ${(err as Error).message}`);
      return 2;
    }
    if (skipped.length > 0) {
      console.error(
        `note: colocated root ${root}: skipped folders without markdown: ` +
          `${skipped.join(", ")} (add a .md file to a folder to mount it as a bundle)`,
      );
    }
    if (discovered.length === 0) {
      console.error(
        `error: --colocated-bundles found no bundle subdirectories under: ${root}`,
      );
      return 2;
    }
    // The long-lived server mounts colocated bundles lazily — discovered now,
    // parsed on first access. One-shot commands sweep every bundle anyway, so
    // laziness would only reorder the same work; they load eagerly.
    configs.push(
      ...discovered.map((config) => ({
        ...config,
        ...(command === "mcp" && { lazy: true }),
        ...(spec.writable !== undefined && { writable: spec.writable }),
        ...(spec.canonicalUrl !== undefined && {
          canonicalUrl: `${spec.canonicalUrl.replace(/\/+$/, "")}/${config.id}`,
        }),
      })),
    );
  }
  const remotes = [...resolved.remotes];
  for (const flagRemote of parseRemoteBundleFlags(values["remote-bundle"] ?? [])) {
    const existing = remotes.findIndex((r) => r.id === flagRemote.id);
    if (existing >= 0) remotes[existing] = flagRemote;
    else remotes.push(flagRemote);
  }
  try {
    applyCanonicalUrlFlags(values["canonical-url"] ?? [], configs, remotes, colocatedRoots);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 2;
  }
  for (const url of remoteRootUrls) {
    remoteRootConfigs.set(url, {
      url,
      ...(folderOnly !== undefined && { only: folderOnly }),
    });
  }
  const nothingToMount =
    configs.length === 0 && remotes.length === 0 && remoteRootConfigs.size === 0;
  // A globally declared server is launched in every directory the user opens,
  // most of which configure no bundles. Exiting there would show up as a failed
  // server in the harness, so `mcp` serves empty and says so; the one-shot
  // commands were typed deliberately and still get a usage error.
  if (nothingToMount && command !== "mcp") {
    console.error(
      `error: nothing to mount: declare bundles in an ${CONFIG_FILENAME}, or pass ` +
        "--bundle, --colocated-bundles, --remote-bundle, or " +
        "--colocated-remote-bundles\n",
    );
    console.error(USAGE);
    return 2;
  }

  const store = new OkfStore(configs, {
    remotes,
    colocatedRemoteRoots: [...remoteRootConfigs.values()],
  });
  await store.load();

  // A config file declaring any bundle writable enables authoring on its own;
  // --writable stays the server-wide switch for bundles that declare nothing.
  const writable = values.writable === true || configs.some((c) => c.writable === true);

  switch (command) {
    case "mcp": {
      const guides = await collectBundleGuides(colocatedRoots);
      // Remote colocated roots' AGENTS.md guides were fetched during load().
      for (const mount of store.colocatedRemoteRootMounts()) {
        if (mount.agentsGuide === undefined) continue;
        guides.push(bundleGuide(mount.agentsGuide, `${mount.url}/AGENTS.md`));
      }
      const server = createOkfServer(store, {
        writable,
        bundleGuides: guides,
        ...(searchLimit !== undefined && { searchLimit }),
        ...(searchCutoff !== undefined && { searchCutoff }),
      });
      await server.connect(new StdioServerTransport());
      // stdout carries the protocol; log to stderr only.
      const discovered = store.discoveredBundles();
      const loadedIds = store.bundles().map((b) => b.id).join(", ") || "(none loaded)";
      const served =
        discovered.length > 0
          ? `${loadedIds} + ${discovered.length} discovered colocated (loading on first access)`
          : loadedIds;
      // Name the writable bundles rather than a bare "(writable)": with
      // per-bundle permissions the server-wide word no longer says enough.
      const writableIds = writable
        ? configs.filter((c) => c.writable !== false).map((c) => c.id)
        : [];
      console.error(
        nothingToMount
          ? "okf-mcp serving no bundles over stdio: nothing is mounted for this " +
              `directory. Declare bundles in an ${CONFIG_FILENAME} here, or in ` +
              `${path.join(userConfigDir(), "config.json")} to mount them everywhere.`
          : `okf-mcp serving ${served} over stdio` +
              (writableIds.length > 0
                ? ` (writable: ${writableIds.join(", ")})`
                : " (read-only)"),
      );
      if (resolved.sources.length > 0) {
        console.error(`okf-mcp: config: ${resolved.sources.join(", ")}`);
      }
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
        } else if (discovered.length > 0) {
          console.error(
            "okf-mcp: --watch: watching starts when a discovered bundle loads",
          );
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
      console.log(
        JSON.stringify(
          searchConcepts(store.bundles(), {
            query,
            ...(searchLimit !== undefined && { limit: searchLimit }),
            ...(searchCutoff !== undefined && { cutoffRatio: searchCutoff }),
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    case "concept": {
      const id = rest[0];
      if (id === undefined) {
        console.error("error: concept requires an ID");
        return 2;
      }
      const concept = await store.getConcept(undefined, id);
      if (!concept) {
        console.error(`error: unknown concept: ${id}`);
        return 1;
      }
      console.log(JSON.stringify(concept, null, 2));
      return 0;
    }
    case "graph": {
      const format = rest[0] ?? "json";
      if (!["json", "dot", "mermaid", "html"].includes(format)) {
        console.error(`error: unknown graph format: ${format}`);
        return 2;
      }
      const bundleId = rest[1];
      // With several bundles mounted and none named, export them all as one
      // merged graph: bundle:concept node IDs plus derived cross-bundle
      // edges. A single mounted bundle keeps the unqualified single-bundle
      // output.
      const merged = bundleId === undefined && store.bundles().length > 1;
      const community = values.community;
      if (community !== undefined) {
        if (format !== "html") {
          console.error("error: --community requires the html graph format");
          return 2;
        }
        if (!["type", "folder", "tag"].includes(community)) {
          console.error(
            `error: unknown --community mode: ${community} (expected type, folder, or tag)`,
          );
          return 2;
        }
        if (merged) {
          console.error(
            "error: a merged multi-bundle graph always groups by bundle, so " +
              `--community does not apply; name a bundle to group it by ${community}`,
          );
          return 2;
        }
      }
      const options = { includeExternal: values["include-external"] ?? false };
      const graph = merged
        ? buildMultiGraph(store.bundles(), options)
        : buildGraph(await store.bundle(bundleId), options);
      let output: string;
      if (format === "html") {
        const mode: CommunityMode = merged
          ? "bundle"
          : ((community as CommunityMode | undefined) ?? "type");
        // Node source links come from each bundle's canonical location: the
        // blob (citation) prefix plus the concept's bundle-relative path.
        // Bundles without a canonical URL yield no link; external nodes link
        // to themselves when the target is already a web URL.
        const bundlesById = new Map(store.bundles().map((b) => [b.id, b]));
        output = exportGraphHtml(graph, {
          communityOf: communityAssigner(mode),
          urlOf: (node) => {
            if (node.external) {
              return /^https?:\/\//.test(node.id) ? node.id : undefined;
            }
            const prefixes = bundlesById.get(node.bundle)?.canonicalUrls;
            if (prefixes === undefined || prefixes.length === 0) return undefined;
            return `${citationPrefix(prefixes)}/${node.path}`;
          },
        });
      } else {
        output = exportGraph(graph, format as GraphFormat);
      }
      if (values.out !== undefined) {
        await fs.writeFile(values.out, output);
        return 0;
      }
      console.log(output);
      return 0;
    }
    case "index": {
      if (!writable) {
        console.error(
          `error: index regeneration requires --writable or a bundle declared ` +
            `"writable": true in an ${CONFIG_FILENAME}`,
        );
        return 2;
      }
      for (const bundle of store.bundles()) {
        if (bundle.readOnly) {
          console.error(`${bundle.id}: skipped (read-only bundle)`);
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
      const bundle = await store.bundle(rest[0]);
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
        allBundles: store.bundles(),
      });
      await fs.writeFile(out, result.bytes);
      console.log(`${bundle.id}: packed ${result.files.length} files to ${out}`);
      return 0;
    }
    case "repair": {
      const targets =
        rest[0] !== undefined ? [await store.bundle(rest[0])] : store.bundles();
      for (const bundle of targets) {
        if (bundle.readOnly) {
          console.error(`${bundle.id}: skipped (read-only remote bundle)`);
          continue;
        }
        const report = await repairBundle(bundle, {
          write: values.write ?? false,
          only: fixerOnly,
          allBundles: store.bundles(),
        });
        console.log(JSON.stringify(report, null, 2));
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
