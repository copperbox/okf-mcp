/**
 * Experimental feature-group toolset gating.
 *
 * Every MCP tool this server registers belongs to exactly one group, and the
 * `features` option (ServerOptions, okf.config.json, `--features`) gates
 * advertisement group by group: a tool whose group is off is registered but
 * immediately disabled, so its definition never reaches clients via
 * tools/list. Registration enforces membership — a tool missing from every
 * group throws at server construction — so new tools cannot dodge the gate.
 */
export const FEATURE_GROUPS = {
  /** Core reading: search, fetch, catalog, vocabulary, orientation. */
  read: [
    "search_concepts",
    "get_concept",
    "list_concepts",
    "read_document",
    "get_sources",
    "suggest_concept_path",
    "list_types",
    "list_tags",
    "list_bundles",
    "get_bundle_guide",
  ],
  /** Link-graph exploration. */
  graph: ["graph_summary", "get_neighbors", "find_path", "export_graph"],
  /**
   * Authoring. Composes with writability: write tools require BOTH this
   * group and `writable` — the group alone never enables writes.
   */
  write: [
    "write_concept",
    "update_concept",
    "delete_concept",
    "rename_concept",
    "promote_concept",
    "append_log_entry",
  ],
  /** Remote-bundle loading and bundle (re)discovery. */
  remote: [
    "list_remote_bundles",
    "load_remote_bundle",
    "load_colocated_remote_bundles",
    "reload_bundles",
  ],
  /** Bundle health and history. */
  maintenance: [
    "validate_bundle",
    "regenerate_indexes",
    "concept_history",
    "concept_diff",
  ],
} as const satisfies Record<string, readonly string[]>;

export type FeatureGroup = keyof typeof FEATURE_GROUPS;

export const ALL_FEATURE_GROUPS = Object.keys(FEATURE_GROUPS) as FeatureGroup[];

const GROUP_OF_TOOL = new Map<string, FeatureGroup>();
for (const group of ALL_FEATURE_GROUPS) {
  for (const tool of FEATURE_GROUPS[group]) GROUP_OF_TOOL.set(tool, group);
}

/** The feature group a tool belongs to, or undefined for an unknown tool. */
export function featureGroupOf(tool: string): FeatureGroup | undefined {
  return GROUP_OF_TOOL.get(tool);
}

/**
 * Validate a features list from a config file or CLI flag. `context` names
 * the source for the error message (e.g. a config file path or `--features`).
 */
export function parseFeatureList(values: string[], context: string): FeatureGroup[] {
  for (const value of values) {
    if (!Object.hasOwn(FEATURE_GROUPS, value)) {
      throw new Error(
        `${context}: unknown feature group "${value}" ` +
          `(known: ${ALL_FEATURE_GROUPS.join(", ")})`,
      );
    }
  }
  return values as FeatureGroup[];
}
