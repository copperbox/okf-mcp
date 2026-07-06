import { loadBundle } from "./bundle.js";
import type { BundleConfig, Concept, LoadedBundle } from "./types.js";

/**
 * In-memory index over one or more OKF bundles. There is no file watcher;
 * callers reload after external changes (authoring reloads automatically).
 */
export class OkfStore {
  private loaded = new Map<string, LoadedBundle>();

  constructor(private readonly configs: BundleConfig[]) {
    const ids = new Set<string>();
    for (const config of configs) {
      if (ids.has(config.id)) {
        throw new Error(`duplicate bundle id: ${config.id}`);
      }
      ids.add(config.id);
    }
  }

  async load(): Promise<void> {
    for (const config of this.configs) {
      this.loaded.set(config.id, await loadBundle(config));
    }
  }

  async reloadBundle(id: string): Promise<LoadedBundle> {
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`unknown bundle: ${id}`);
    const bundle = await loadBundle(config);
    this.loaded.set(id, bundle);
    return bundle;
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
