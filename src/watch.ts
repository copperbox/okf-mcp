import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
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
  const watchers: FSWatcher[] = [];
  const watching: string[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
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
    try {
      const watcher = watch(
        path.resolve(config.root),
        { recursive: true },
        (_event, filename) => {
          if (isRelevant(filename)) scheduleReload(config.id);
        },
      );
      watcher.on("error", (err) => options.onError?.(config.id, err as Error));
      watchers.push(watcher);
      watching.push(config.id);
    } catch (err) {
      options.onError?.(config.id, err as Error);
    }
  };

  const discovered = new Set(store.discoveredBundles().map((d) => d.id));
  const deferred = new Map<string, BundleConfig>();
  for (const config of configs) {
    if (discovered.has(config.id)) deferred.set(config.id, config);
    else startWatching(config);
  }
  const unsubscribe =
    deferred.size > 0
      ? store.onHydrate((bundle) => {
          if (closed) return;
          const config = deferred.get(bundle.id);
          if (config === undefined) return;
          deferred.delete(bundle.id);
          startWatching(config);
        })
      : undefined;

  return {
    watching,
    close() {
      closed = true;
      unsubscribe?.();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) watcher.close();
    },
  };
}
