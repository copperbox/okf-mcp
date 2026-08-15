import type { FSWatcher } from "node:fs";
import { statSync, watch } from "node:fs";
import path from "node:path";

import type { BundleReloadStats, OkfStore } from "./store.js";
import type { BundleConfig } from "./types.js";

/** Debounce window so an editor save burst triggers a single reload. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 250;

export interface WatchBundlesOptions {
  /** Quiet period after the last relevant event before reloading. */
  debounceMs?: number;
  /** Called after each debounced reload with the store's delta stats. */
  onReload?: (stats: BundleReloadStats[]) => void;
  /**
   * Called when a bundle cannot be watched (e.g. recursive fs.watch is
   * unsupported on this platform) or a reload fails. Watching continues
   * for the remaining bundles.
   */
  onError?: (bundleId: string, error: Error) => void;
}

export interface BundleWatcher {
  /** IDs of the bundles actually being watched (others failed via onError). */
  readonly watching: string[];
  /** Stop watching and cancel any pending debounced reloads. */
  close(): void;
}

/**
 * Only changes to markdown documents matter to the index; dot directories
 * (`.obsidian`, `.git`, ...) and dot files are never loaded, so events for
 * them are dropped. A null filename means the platform could not say what
 * changed — reload to be safe.
 */
function isRelevant(filename: string | null): boolean {
  if (filename === null) return true;
  const segments = filename.split(/[\\/]/);
  if (segments.some((segment) => segment.startsWith("."))) return false;
  return filename.toLowerCase().endsWith(".md");
}

/**
 * Watch local bundle directories and refresh the store's in-memory index
 * when `.md` files change, via the same reload path as the reload_bundles
 * tool. Remote bundles have no directory to watch and are unaffected.
 * Reloads are serialized so overlapping bundle refreshes cannot interleave.
 *
 * A discovered-but-unloaded lazy bundle has no index to keep fresh, so it is
 * not watched; watching starts the moment it hydrates (store.onHydrate), and
 * `watching` grows accordingly.
 */
export function watchBundles(
  store: OkfStore,
  configs: BundleConfig[],
  options: WatchBundlesOptions = {},
): BundleWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const watchersById = new Map<string, FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  const deferred = new Map<string, BundleConfig>();
  let reloadChain = Promise.resolve();
  let closed = false;

  const scheduleReload = (bundleId: string): void => {
    clearTimeout(timers.get(bundleId));
    timers.set(
      bundleId,
      setTimeout(() => {
        timers.delete(bundleId);
        reloadChain = reloadChain.then(async () => {
          if (closed) return;
          try {
            options.onReload?.(await store.reloadBundles(bundleId));
          } catch (err) {
            options.onError?.(bundleId, err as Error);
          }
        });
      }, debounceMs),
    );
  };

  const startWatching = (config: BundleConfig): void => {
    // Idempotent: rediscovery may re-announce a bundle already watched.
    if (watchersById.has(config.id)) return;
    try {
      const root = path.resolve(config.root);
      // fs.watch on a missing path no longer throws on newer Node (it
      // silently returns a watcher that never fires), so verify ourselves.
      if (!statSync(root).isDirectory()) {
        throw new Error(`bundle root is not a directory: ${root}`);
      }
      const watcher = watch(
        root,
        { recursive: true },
        (_event, filename) => {
          if (isRelevant(filename)) scheduleReload(config.id);
        },
      );
      watcher.on("error", (err) => options.onError?.(config.id, err as Error));
      watchersById.set(config.id, watcher);
    } catch (err) {
      options.onError?.(config.id, err as Error);
    }
  };

  // Stop watching a bundle a config change removed: close its watcher and
  // cancel any pending reload, so a vanished mount no longer fires reloads for
  // an id the store would reject as unknown.
  const stopWatching = (bundleId: string): void => {
    deferred.delete(bundleId);
    clearTimeout(timers.get(bundleId));
    timers.delete(bundleId);
    watchersById.get(bundleId)?.close();
    watchersById.delete(bundleId);
  };

  const discovered = new Set(store.discoveredBundles().map((d) => d.id));
  for (const config of configs) {
    if (discovered.has(config.id)) deferred.set(config.id, config);
    else startWatching(config);
  }
  const unsubscribeHydrate = store.onHydrate((bundle) => {
    if (closed) return;
    const config = deferred.get(bundle.id);
    if (config === undefined) return;
    deferred.delete(bundle.id);
    startWatching(config);
  });
  // Rediscovery (reload_bundles re-running config discovery) can mount, move,
  // or unmount local bundles after startup; keep the watched set in step.
  const unsubscribeMount = store.onMountChange((change) => {
    if (closed) return;
    for (const id of change.removed) stopWatching(id);
    for (const config of change.changed) {
      stopWatching(config.id);
      startWatching(config);
    }
    for (const config of change.added) startWatching(config);
  });

  return {
    get watching() {
      return [...watchersById.keys()];
    },
    close() {
      closed = true;
      unsubscribeHydrate();
      unsubscribeMount();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchersById.values()) watcher.close();
      watchersById.clear();
    },
  };
}
