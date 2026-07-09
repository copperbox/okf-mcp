import { loadBundle } from "./bundle.js";
import { loadColocatedRemoteBundles, loadRemoteBundle } from "./remote.js";
import type { ColocatedRemoteMount } from "./remote.js";
import type {
  BundleConfig,
  ColocatedRemoteRootConfig,
  Concept,
  LoadedBundle,
  RemoteBundleConfig,
} from "./types.js";

/** Per-bundle result of a reload: new counts plus a delta vs. the previous load. */
export interface BundleReloadStats {
  bundle: string;
  concepts: number;
  problems: number;
  added: string[];
  removed: string[];
  changed: string[];
}

/** A concept counts as changed when its own source differs, not when link
 * resolution shifted because a neighbor appeared or disappeared. */
function conceptFingerprint(concept: Concept): string {
  return JSON.stringify({ frontmatter: concept.frontmatter, body: concept.body });
}

function diffConcepts(
  previous: LoadedBundle | undefined,
  next: LoadedBundle | undefined,
): Pick<BundleReloadStats, "added" | "removed" | "changed"> {
  const before = previous?.concepts ?? new Map<string, Concept>();
  const after = next?.concepts ?? new Map<string, Concept>();
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, concept] of after) {
    const old = before.get(id);
    if (!old) added.push(id);
    else if (conceptFingerprint(old) !== conceptFingerprint(concept)) changed.push(id);
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Error for two mounts claiming the same bundle id. When either side was
 * discovered under a `--colocated-bundles` root, name that root — the
 * colliding id was derived from a folder name the user never typed.
 */
function duplicateBundleIdError(
  id: string,
  ...configs: (BundleConfig | RemoteBundleConfig | undefined)[]
): Error {
  let message = `duplicate bundle id: ${id}`;
  for (const config of configs) {
    if (config !== undefined && "colocatedRoot" in config && config.colocatedRoot !== undefined) {
      message += ` (discovered under --colocated-bundles ${config.colocatedRoot})`;
      break;
    }
  }
  return new Error(message);
}

/** Error for a bundle id colliding with one discovered under a colocated remote root. */
function duplicateColocatedRemoteIdError(id: string, rootUrl: string): Error {
  return new Error(
    `duplicate bundle id: ${id} (discovered under --colocated-remote-bundles ${rootUrl})`,
  );
}

export interface OkfStoreOptions {
  /** Read-only remote bundles (GitHub trees or archives) fetched on load(). */
  remotes?: RemoteBundleConfig[];
  /**
   * Remote colocated roots fetched on load(): each subdirectory of the tree
   * or archive mounts as its own read-only bundle (`--colocated-remote-bundles`).
   */
  colocatedRemoteRoots?: ColocatedRemoteRootConfig[];
  /** Injectable fetch for remote bundles (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A mounted colocated remote root: its bundle ids and root AGENTS.md guide. */
export interface ColocatedRemoteRootMount {
  url: string;
  bundleIds: string[];
  agentsGuide?: string;
}

/**
 * In-memory index over one or more OKF bundles. The store itself never
 * watches the filesystem; callers reload after external changes (authoring
 * reloads automatically, and watchBundles in watch.ts drives reloads for
 * `--watch`).
 */
export class OkfStore {
  private loaded = new Map<string, LoadedBundle>();
  private readonly remotes = new Map<string, RemoteBundleConfig>();
  private readonly colocatedRoots = new Map<string, ColocatedRemoteRootConfig>();
  private readonly colocatedMounts = new Map<
    string,
    { bundleIds: string[]; agentsGuide?: string }
  >();
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly configs: BundleConfig[],
    options: OkfStoreOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    const byId = new Map<string, BundleConfig | RemoteBundleConfig>();
    for (const config of [...configs, ...(options.remotes ?? [])]) {
      const existing = byId.get(config.id);
      if (existing !== undefined) {
        throw duplicateBundleIdError(config.id, config, existing);
      }
      byId.set(config.id, config);
    }
    for (const remote of options.remotes ?? []) {
      this.remotes.set(remote.id, remote);
    }
    for (const root of options.colocatedRemoteRoots ?? []) {
      if (this.colocatedRoots.has(root.url)) {
        throw new Error(`duplicate colocated remote root: ${root.url}`);
      }
      this.colocatedRoots.set(root.url, root);
    }
  }

  async load(): Promise<void> {
    for (const config of this.configs) {
      this.loaded.set(config.id, await loadBundle(config));
    }
    for (const remote of this.remotes.values()) {
      this.loaded.set(remote.id, await loadRemoteBundle(remote, this.fetchImpl));
    }
    for (const url of this.colocatedRoots.keys()) {
      await this.loadColocatedRoot(url);
    }
  }

  /**
   * (Re)fetch one colocated remote root and swap its bundles into the index:
   * the previous mount's bundles are removed first, so folders that appeared
   * or vanished upstream track the remote. Bundle ids (folder basenames) must
   * not collide with any other mount.
   */
  private async loadColocatedRoot(url: string): Promise<ColocatedRemoteMount> {
    const config = this.colocatedRoots.get(url)!;
    const mount = await loadColocatedRemoteBundles(config, this.fetchImpl);
    const previousIds = this.colocatedMounts.get(url)?.bundleIds ?? [];
    for (const bundle of mount.bundles) {
      if (previousIds.includes(bundle.id)) continue;
      const taken =
        this.loaded.has(bundle.id) ||
        this.remotes.has(bundle.id) ||
        this.configs.some((c) => c.id === bundle.id);
      if (taken) {
        throw duplicateColocatedRemoteIdError(bundle.id, url);
      }
    }
    for (const id of previousIds) this.loaded.delete(id);
    for (const bundle of mount.bundles) this.loaded.set(bundle.id, bundle);
    this.colocatedMounts.set(url, {
      bundleIds: mount.bundles.map((b) => b.id),
      ...(mount.agentsGuide !== undefined && { agentsGuide: mount.agentsGuide }),
    });
    return mount;
  }

  /** URL of the colocated remote root a bundle id was mounted from, if any. */
  private colocatedRootOf(id: string): string | undefined {
    for (const [url, mount] of this.colocatedMounts) {
      if (mount.bundleIds.includes(id)) return url;
    }
    return undefined;
  }

  /**
   * Mount a colocated remote root at runtime and add its bundles to the
   * index. Nothing is written to disk; the mount lives in memory and reloads
   * (refetches the whole root) through the same reload_bundles path.
   */
  async addColocatedRemoteBundles(
    config: ColocatedRemoteRootConfig,
  ): Promise<ColocatedRemoteMount> {
    if (this.colocatedRoots.has(config.url)) {
      throw new Error(`colocated remote root already mounted: ${config.url}`);
    }
    this.colocatedRoots.set(config.url, config);
    try {
      return await this.loadColocatedRoot(config.url);
    } catch (err) {
      this.colocatedRoots.delete(config.url);
      throw err;
    }
  }

  /** Mounted colocated remote roots: url, bundle ids, root AGENTS.md guide. */
  colocatedRemoteRootMounts(): ColocatedRemoteRootMount[] {
    return [...this.colocatedMounts].map(([url, mount]) => ({ url, ...mount }));
  }

  async reloadBundle(id: string): Promise<LoadedBundle> {
    const remote = this.remotes.get(id);
    const config = this.configs.find((c) => c.id === id);
    const rootUrl = this.colocatedRootOf(id);
    let bundle: LoadedBundle | undefined;
    if (remote !== undefined) {
      bundle = await loadRemoteBundle(remote, this.fetchImpl);
      this.loaded.set(id, bundle);
    } else if (config !== undefined) {
      bundle = await loadBundle(config);
      this.loaded.set(id, bundle);
    } else if (rootUrl !== undefined) {
      // The root is one remote source: refetch it whole (siblings update too).
      await this.loadColocatedRoot(rootUrl);
      bundle = this.loaded.get(id);
      if (bundle === undefined) {
        throw new Error(
          `bundle "${id}" no longer exists under colocated remote root ${rootUrl}`,
        );
      }
    } else {
      throw new Error(`unknown bundle: ${id}`);
    }
    return bundle;
  }

  /**
   * Fetch a read-only remote bundle and add it to the index. Nothing is
   * written to disk; the bundle lives in memory and reloads (refetches)
   * through the same reload_bundles path as local bundles.
   */
  async addRemoteBundle(config: RemoteBundleConfig): Promise<LoadedBundle> {
    const existing = this.configs.find((c) => c.id === config.id);
    const rootUrl = this.colocatedRootOf(config.id);
    if (rootUrl !== undefined) {
      throw duplicateColocatedRemoteIdError(config.id, rootUrl);
    }
    if (this.remotes.has(config.id) || existing !== undefined) {
      throw duplicateBundleIdError(config.id, existing);
    }
    const bundle = await loadRemoteBundle(config, this.fetchImpl);
    this.remotes.set(config.id, config);
    this.loaded.set(config.id, bundle);
    return bundle;
  }

  /** Configs of the remote bundles currently registered. */
  remoteBundleConfigs(): RemoteBundleConfig[] {
    return [...this.remotes.values()];
  }

  /**
   * Re-read bundles to pick up external edits: local bundles from disk,
   * remote bundles by refetching their tree or archive. With no id, all
   * bundles reload. Returns per-bundle stats including which concept IDs
   * were added, removed, or changed since the previous load.
   */
  async reloadBundles(id?: string): Promise<BundleReloadStats[]> {
    const ids =
      id !== undefined
        ? [id]
        : [...this.configs.map((c) => c.id), ...this.remotes.keys()];
    const stats: BundleReloadStats[] = [];
    const statFor = (
      bundleId: string,
      previous: LoadedBundle | undefined,
      next: LoadedBundle | undefined,
    ): BundleReloadStats => ({
      bundle: bundleId,
      concepts: next?.concepts.size ?? 0,
      problems: next?.problems.length ?? 0,
      ...diffConcepts(previous, next),
    });
    for (const bundleId of ids) {
      const previous = this.loaded.get(bundleId);
      stats.push(statFor(bundleId, previous, await this.reloadBundle(bundleId)));
    }
    if (id !== undefined) return stats;
    // Each colocated root refetches once; stats cover appeared/vanished
    // folders too (a vanished bundle reports all its concepts removed).
    for (const url of this.colocatedRoots.keys()) {
      const previousIds = this.colocatedMounts.get(url)?.bundleIds ?? [];
      const previous = new Map(
        previousIds.map((pid) => [pid, this.loaded.get(pid)]),
      );
      const mount = await this.loadColocatedRoot(url);
      const bundleIds = [
        ...new Set([...previousIds, ...mount.bundles.map((b) => b.id)]),
      ];
      for (const bundleId of bundleIds) {
        stats.push(
          statFor(bundleId, previous.get(bundleId), this.loaded.get(bundleId)),
        );
      }
    }
    return stats;
  }

  bundles(): LoadedBundle[] {
    return [...this.loaded.values()];
  }

  /**
   * Resolve a bundle by id. With no id, returns the only bundle when
   * exactly one is configured — so single-bundle setups can omit it.
   */
  bundle(id?: string): LoadedBundle {
    if (id !== undefined) {
      const bundle = this.loaded.get(id);
      if (!bundle) {
        throw new Error(
          `unknown bundle "${id}" (available: ${[...this.loaded.keys()].join(", ")})`,
        );
      }
      return bundle;
    }
    const all = this.bundles();
    if (all.length === 1) return all[0]!;
    throw new Error(
      `bundle id required when ${all.length} bundles are configured`,
    );
  }

  /** Look up a concept by ID, tolerating a trailing `.md`. */
  getConcept(bundleId: string | undefined, conceptId: string): Concept | undefined {
    const bundle = this.bundle(bundleId);
    return (
      bundle.concepts.get(conceptId) ??
      bundle.concepts.get(conceptId.replace(/\.md$/i, ""))
    );
  }
}
