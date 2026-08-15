/**
 * Config-file layer: bundle mounts declared in `okf.config.json` files instead
 * of CLI flags.
 *
 * MCP client config files (`.mcp.json`, `mcp.json`, ...) key servers by name
 * and have no merge semantics: two files declaring the same server name do not
 * union their arguments, the nearest scope replaces the other wholesale. That
 * makes "commit the project bundle, add personal bundles locally" impossible to
 * express there, in every client. Moving mount declarations into files this
 * server discovers itself sidesteps the whole problem — the client config
 * shrinks to `npx -y @copperbox/okf-mcp` with no arguments, and composition
 * happens here, identically for every harness.
 *
 * Layers apply lowest precedence first:
 *   1. the user config (`~/.config/okf/config.json`)
 *   2. `okf.config.json` then `okf.config.local.json` in each directory from
 *      the filesystem root down to the working directory
 *   3. CLI flags
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  BundleConfig,
  ColocatedRemoteRootConfig,
  RemoteBundleConfig,
} from "./types.js";

export const CONFIG_FILENAME = "okf.config.json";
export const LOCAL_CONFIG_FILENAME = "okf.config.local.json";

/** A bundle mount as written in a config file. The string form is the path. */
export type ConfigBundleEntry =
  | string
  | {
      path: string;
      writable?: boolean;
      canonicalUrl?: string;
    };

/** A colocated root as written in a config file. The string form is the path. */
export type ConfigColocatedRootEntry =
  | string
  | {
      path: string;
      only?: string[];
      writable?: boolean;
      canonicalUrl?: string;
    };

/** A remote bundle as written in a config file. The string form is the URL. */
export type ConfigRemoteEntry =
  | string
  | {
      url: string;
      include?: string[];
      exclude?: string[];
      canonicalUrl?: string;
    };

/** A colocated remote root as written in a config file. String form: the URL. */
export type ConfigColocatedRemoteEntry =
  | string
  | {
      url: string;
      only?: string[];
      include?: string[];
      exclude?: string[];
      canonicalUrl?: string;
    };

/** The shape of one `okf.config.json` document. */
export interface OkfConfigFile {
  /** Stop the upward search here: no ancestor directory is consulted. */
  root?: boolean;
  /** Default writability for this file's bundles; per-bundle `writable` wins. */
  writable?: boolean;
  bundles?: Record<string, ConfigBundleEntry>;
  colocatedRoots?: ConfigColocatedRootEntry[];
  remoteBundles?: Record<string, ConfigRemoteEntry>;
  colocatedRemoteRoots?: ConfigColocatedRemoteEntry[];
  searchLimit?: number;
  searchCutoff?: number;
  /**
   * Actor recorded as `generated.by` on every write (OKF spec §5.2, §7).
   * Defaults to `okf-mcp/<version>`. Set it to `human:<id>` only for a
   * single-human deployment: §5.3 derives the human-reviewed trust tier from
   * that prefix, so a shared server claiming it would inflate every write.
   */
  actor?: string;
}

/** A colocated root to mount, resolved from config files. */
export interface ResolvedColocatedRoot {
  /** Absolute path to the root directory. */
  path: string;
  only?: string[];
  /** Writability every bundle discovered under the root inherits. */
  writable?: boolean;
  canonicalUrl?: string;
}

/** The merged result of every config layer that applied. */
export interface ResolvedConfig {
  bundles: BundleConfig[];
  colocatedRoots: ResolvedColocatedRoot[];
  remotes: RemoteBundleConfig[];
  colocatedRemoteRoots: ColocatedRemoteRootConfig[];
  searchLimit?: number;
  searchCutoff?: number;
  actor?: string;
  /** Absolute paths of the config files that applied, lowest precedence first. */
  sources: string[];
  /** Non-fatal problems to report on stderr (unknown keys, writability downgrades). */
  warnings: string[];
}

/** One config file read off disk, with the context needed to resolve it. */
interface ConfigLayer {
  /** Absolute path of the file. */
  file: string;
  /** Absolute directory the file's relative paths resolve against. */
  dir: string;
  config: OkfConfigFile;
  /**
   * Trusted layers may grant write access to any path. Discovered project
   * files are untrusted: a repository you cloned must not be able to declare
   * `~/notes` writable just because you opened it.
   */
  trusted: boolean;
}

export interface DiscoverConfigOptions {
  /** Directory the upward search starts from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit config file, replacing discovery entirely (`--config`). */
  configPath?: string;
  /** Skip every config file (`--no-config`). */
  noConfig?: boolean;
  /** Override the user config directory (tests, `OKF_CONFIG_HOME`). */
  configHome?: string;
}

const KNOWN_KEYS = new Set<keyof OkfConfigFile>([
  "root",
  "writable",
  "bundles",
  "colocatedRoots",
  "remoteBundles",
  "colocatedRemoteRoots",
  "searchLimit",
  "searchCutoff",
  "actor",
]);

/** Expand a leading `~` so config files can name paths without hardcoding a home directory. */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** Resolve a config-file path against the file's own directory, not the cwd —
 * a config means the same thing however the server was launched. */
function resolvePath(dir: string, value: string): string {
  return path.resolve(dir, expandHome(value));
}

/** True when `target` is inside `dir` (or is `dir` itself). */
function isInside(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The user-level config directory: `$OKF_CONFIG_HOME`, else `$XDG_CONFIG_HOME/okf`, else `~/.config/okf`. */
export function userConfigDir(override?: string): string {
  if (override !== undefined && override !== "") return path.resolve(expandHome(override));
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "") return path.join(path.resolve(expandHome(xdg)), "okf");
  return path.join(os.homedir(), ".config", "okf");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and shape-check one config file. Returns undefined when it does not exist. */
async function readConfigFile(file: string): Promise<OkfConfigFile | undefined> {
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return parsed as OkfConfigFile;
}

/**
 * Collect the config files that apply, lowest precedence first: the user
 * config, then every ancestor directory of `cwd` from the filesystem root
 * down, each contributing `okf.config.json` before `okf.config.local.json`.
 * A file with `"root": true` stops the search above its directory.
 */
async function collectLayers(options: DiscoverConfigOptions): Promise<ConfigLayer[]> {
  if (options.noConfig === true) return [];

  if (options.configPath !== undefined) {
    const file = path.resolve(expandHome(options.configPath));
    const config = await readConfigFile(file);
    if (config === undefined) throw new Error(`--config file not found: ${file}`);
    // Named explicitly by whoever launched the server, so trusted like the
    // command line itself.
    return [{ file, dir: path.dirname(file), config, trusted: true }];
  }

  const layers: ConfigLayer[] = [];
  const userDir = userConfigDir(options.configHome);
  const userFile = path.join(userDir, "config.json");
  const userConfig = await readConfigFile(userFile);
  if (userConfig !== undefined) {
    layers.push({ file: userFile, dir: userDir, config: userConfig, trusted: true });
  }

  // Walk up collecting directories, then apply them root-first so the nearest
  // config wins. `"root": true` truncates the walk at that directory.
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const chain: ConfigLayer[] = [];
  let dir = cwd;
  for (;;) {
    let stop = false;
    const dirLayers: ConfigLayer[] = [];
    for (const name of [CONFIG_FILENAME, LOCAL_CONFIG_FILENAME]) {
      const file = path.join(dir, name);
      const config = await readConfigFile(file);
      if (config === undefined) continue;
      dirLayers.push({ file, dir, config, trusted: false });
      if (config.root === true) stop = true;
    }
    chain.unshift(...dirLayers);
    const parent = path.dirname(dir);
    if (stop || parent === dir) break;
    dir = parent;
  }
  layers.push(...chain);
  return layers;
}

/** Reject a config value that is not a string, naming the file and key. */
function requireString(file: string, key: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${file}: ${key} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(file: string, key: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${file}: ${key} must be an array of strings`);
  }
  return value as string[];
}

function optionalBoolean(file: string, key: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${file}: ${key} must be true or false`);
  return value;
}

function optionalNumber(file: string, key: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${file}: ${key} must be a number`);
  }
  return value;
}

/**
 * Fold one config layer into the accumulating result. Bundles and remote
 * bundles are keyed by id and replaced wholesale by a higher layer; colocated
 * roots are keyed by resolved path/url. Scalars are last-wins.
 */
function applyLayer(
  layer: ConfigLayer,
  bundles: Map<string, BundleConfig>,
  colocatedRoots: Map<string, ResolvedColocatedRoot>,
  remotes: Map<string, RemoteBundleConfig>,
  colocatedRemoteRoots: Map<string, ColocatedRemoteRootConfig>,
  scalars: { searchLimit?: number; searchCutoff?: number; actor?: string },
  warnings: string[],
): void {
  const { file, dir, config, trusted } = layer;
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key as keyof OkfConfigFile)) {
      warnings.push(`${file}: unknown key "${key}" ignored`);
    }
  }
  const fileWritable = optionalBoolean(file, "writable", config.writable) ?? false;

  /**
   * Resolve declared writability, downgrading a grant an untrusted config file
   * is not entitled to make. Reading a bundle from anywhere is harmless;
   * granting writes to a path outside the config's own directory is not.
   */
  const resolveWritable = (declared: boolean | undefined, root: string, label: string): boolean => {
    const writable = declared ?? fileWritable;
    if (!writable || trusted || isInside(dir, root)) return writable;
    warnings.push(
      `${file}: ${label} is outside ${dir}, so this config cannot grant it write access — ` +
        `mounted read-only (declare it in ${path.join(userConfigDir(), "config.json")} ` +
        `or pass --writable to allow writes)`,
    );
    return false;
  };

  if (config.bundles !== undefined) {
    if (!isRecord(config.bundles)) throw new Error(`${file}: bundles must be an object`);
    for (const [id, entry] of Object.entries(config.bundles)) {
      const spec = typeof entry === "string" ? { path: entry } : entry;
      if (!isRecord(spec)) throw new Error(`${file}: bundles.${id} must be a string or object`);
      const root = resolvePath(dir, requireString(file, `bundles.${id}.path`, spec.path));
      const writable = resolveWritable(
        optionalBoolean(file, `bundles.${id}.writable`, spec.writable),
        root,
        `bundle "${id}" (${root})`,
      );
      bundles.set(id, {
        id,
        root,
        writable,
        ...(spec.canonicalUrl !== undefined && {
          canonicalUrl: requireString(file, `bundles.${id}.canonicalUrl`, spec.canonicalUrl),
        }),
      });
    }
  }

  if (config.colocatedRoots !== undefined) {
    if (!Array.isArray(config.colocatedRoots)) {
      throw new Error(`${file}: colocatedRoots must be an array`);
    }
    for (const entry of config.colocatedRoots) {
      const spec = typeof entry === "string" ? { path: entry } : entry;
      if (!isRecord(spec)) {
        throw new Error(`${file}: colocatedRoots entries must be strings or objects`);
      }
      const root = resolvePath(dir, requireString(file, "colocatedRoots[].path", spec.path));
      colocatedRoots.set(root, {
        path: root,
        writable: resolveWritable(
          optionalBoolean(file, "colocatedRoots[].writable", spec.writable),
          root,
          `colocated root ${root}`,
        ),
        ...(spec.only !== undefined && {
          only: requireStringArray(file, "colocatedRoots[].only", spec.only),
        }),
        ...(spec.canonicalUrl !== undefined && {
          canonicalUrl: requireString(file, "colocatedRoots[].canonicalUrl", spec.canonicalUrl),
        }),
      });
    }
  }

  if (config.remoteBundles !== undefined) {
    if (!isRecord(config.remoteBundles)) {
      throw new Error(`${file}: remoteBundles must be an object`);
    }
    for (const [id, entry] of Object.entries(config.remoteBundles)) {
      const spec = typeof entry === "string" ? { url: entry } : entry;
      if (!isRecord(spec)) {
        throw new Error(`${file}: remoteBundles.${id} must be a string or object`);
      }
      remotes.set(id, {
        id,
        url: requireString(file, `remoteBundles.${id}.url`, spec.url),
        ...(spec.include !== undefined && {
          include: requireStringArray(file, `remoteBundles.${id}.include`, spec.include),
        }),
        ...(spec.exclude !== undefined && {
          exclude: requireStringArray(file, `remoteBundles.${id}.exclude`, spec.exclude),
        }),
        ...(spec.canonicalUrl !== undefined && {
          canonicalUrl: requireString(
            file,
            `remoteBundles.${id}.canonicalUrl`,
            spec.canonicalUrl,
          ),
        }),
      });
    }
  }

  if (config.colocatedRemoteRoots !== undefined) {
    if (!Array.isArray(config.colocatedRemoteRoots)) {
      throw new Error(`${file}: colocatedRemoteRoots must be an array`);
    }
    for (const entry of config.colocatedRemoteRoots) {
      const spec = typeof entry === "string" ? { url: entry } : entry;
      if (!isRecord(spec)) {
        throw new Error(`${file}: colocatedRemoteRoots entries must be strings or objects`);
      }
      const url = requireString(file, "colocatedRemoteRoots[].url", spec.url);
      colocatedRemoteRoots.set(url, {
        url,
        ...(spec.only !== undefined && {
          only: requireStringArray(file, "colocatedRemoteRoots[].only", spec.only),
        }),
        ...(spec.include !== undefined && {
          include: requireStringArray(file, "colocatedRemoteRoots[].include", spec.include),
        }),
        ...(spec.exclude !== undefined && {
          exclude: requireStringArray(file, "colocatedRemoteRoots[].exclude", spec.exclude),
        }),
        ...(spec.canonicalUrl !== undefined && {
          canonicalUrl: requireString(
            file,
            "colocatedRemoteRoots[].canonicalUrl",
            spec.canonicalUrl,
          ),
        }),
      });
    }
  }

  const searchLimit = optionalNumber(file, "searchLimit", config.searchLimit);
  if (searchLimit !== undefined) scalars.searchLimit = searchLimit;
  const searchCutoff = optionalNumber(file, "searchCutoff", config.searchCutoff);
  if (searchCutoff !== undefined) scalars.searchCutoff = searchCutoff;
  if (config.actor !== undefined) {
    scalars.actor = requireString(file, "actor", config.actor);
  }
}

/**
 * Discover and merge every applicable config file. Later layers replace
 * earlier entries with the same bundle id / root path, so a project config
 * can override a bundle the user config mounted while everything else from
 * both layers stays mounted.
 */
export async function loadOkfConfig(
  options: DiscoverConfigOptions = {},
): Promise<ResolvedConfig> {
  const layers = await collectLayers(options);
  const bundles = new Map<string, BundleConfig>();
  const colocatedRoots = new Map<string, ResolvedColocatedRoot>();
  const remotes = new Map<string, RemoteBundleConfig>();
  const colocatedRemoteRoots = new Map<string, ColocatedRemoteRootConfig>();
  const scalars: { searchLimit?: number; searchCutoff?: number; actor?: string } = {};
  const warnings: string[] = [];
  for (const layer of layers) {
    applyLayer(
      layer,
      bundles,
      colocatedRoots,
      remotes,
      colocatedRemoteRoots,
      scalars,
      warnings,
    );
  }
  return {
    bundles: [...bundles.values()],
    colocatedRoots: [...colocatedRoots.values()],
    remotes: [...remotes.values()],
    colocatedRemoteRoots: [...colocatedRemoteRoots.values()],
    ...(scalars.searchLimit !== undefined && { searchLimit: scalars.searchLimit }),
    ...(scalars.searchCutoff !== undefined && { searchCutoff: scalars.searchCutoff }),
    ...(scalars.actor !== undefined && { actor: scalars.actor }),
    sources: layers.map((l) => l.file),
    warnings,
  };
}
