import { loadBundle } from "./bundle.js";
import { loadRemoteBundle } from "./remote.js";
import type {
  BundleConfig,
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
  next: LoadedBundle,
): Pick<BundleReloadStats, "added" | "removed" | "changed"> {
  const before = previous?.concepts ?? new Map<string, Concept>();
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, concept] of next.concepts) {
    const old = before.get(id);
    if (!old) added.push(id);
    else if (conceptFingerprint(old) !== conceptFingerprint(concept)) changed.push(id);
  }
  const removed = [...before.keys()].filter((id) => !next.concepts.has(id));
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

export interface OkfStoreOptions {
  /** Read-only remote bundles (GitHub trees or archives) fetched on load(). */
  remotes?: RemoteBundleConfig[];
  /** Injectable fetch for remote bundles (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
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
  }

  async load(): Promise<void> {
    for (const config of this.configs) {
      this.loaded.set(config.id, await loadBundle(config));
    }
    for (const remote of this.remotes.values()) {
      this.loaded.set(remote.id, await loadRemoteBundle(remote, this.fetchImpl));
    }
  }

  async reloadBundle(id: string): Promise<LoadedBundle> {
    const remote = this.remotes.get(id);
    const config = this.configs.find((c) => c.id === id);
    let bundle: LoadedBundle;
    if (remote !== undefined) {
      bundle = await loadRemoteBundle(remote, this.fetchImpl);
    } else if (config !== undefined) {
      bundle = await loadBundle(config);
    } else {
      throw new Error(`unknown bundle: ${id}`);
    }
    this.loaded.set(id, bundle);
    return bundle;
  }

  /**
   * Fetch a read-only remote bundle and add it to the index. Nothing is
   * written to disk; the bundle lives in memory and reloads (refetches)
   * through the same reload_bundles path as local bundles.
   */
  async addRemoteBundle(config: RemoteBundleConfig): Promise<LoadedBundle> {
    const existing = this.configs.find((c) => c.id === config.id);
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
    for (const bundleId of ids) {
      const previous = this.loaded.get(bundleId);
      const next = await this.reloadBundle(bundleId);
      stats.push({
        bundle: bundleId,
        concepts: next.concepts.size,
        problems: next.problems.length,
        ...diffConcepts(previous, next),
      });
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
