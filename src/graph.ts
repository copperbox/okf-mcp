import { resolveUrlToConcept } from "./canonical.js";
import type { Concept, LoadedBundle } from "./types.js";

export interface GraphNode {
  id: string;
  bundle: string;
  path: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  /** Present on synthesized nodes for external link targets. */
  external?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Link text, when it carries meaning beyond the target title. */
  label?: string;
  /**
   * "cross-bundle" marks an edge derived from a citation/external-link/
   * resource URL matching another mounted bundle's canonical location.
   * Absent on ordinary in-bundle link edges.
   */
  kind?: "cross-bundle";
}

export interface ConceptGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Broken internal links and similar soft issues (spec §5.3). */
  warnings: string[];
}

export interface GraphOptions {
  /** Include external link targets (https:, repo:, ...) as opaque nodes. */
  includeExternal?: boolean;
}

function externalNode(bundleId: string, target: string): GraphNode {
  return {
    id: target,
    bundle: bundleId,
    path: target,
    type: "External",
    external: true,
  };
}

function nodeFromConcept(concept: Concept): GraphNode {
  const { type, title, description, tags } = concept.frontmatter;
  return {
    id: concept.id,
    bundle: concept.bundleId,
    path: concept.path,
    type,
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(tags !== undefined && { tags }),
  };
}

/**
 * Build the directed link graph of a bundle. Every markdown link between
 * concepts is one untyped edge (spec §5.3).
 */
export function buildGraph(
  bundle: LoadedBundle,
  options: GraphOptions = {},
): ConceptGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];
  const externalNodes = new Map<string, GraphNode>();

  for (const concept of bundle.concepts.values()) {
    nodes.push(nodeFromConcept(concept));
    for (const link of concept.links) {
      if (link.resolvedId !== undefined) {
        edges.push({ from: concept.id, to: link.resolvedId });
      } else if (link.kind === "concept" && link.path?.toLowerCase().endsWith(".md")) {
        warnings.push(`${concept.path}: broken link to ${link.target}`);
      } else if (link.kind === "external" && options.includeExternal) {
        if (!externalNodes.has(link.target)) {
          externalNodes.set(link.target, externalNode(bundle.id, link.target));
        }
        edges.push({ from: concept.id, to: link.target });
      }
    }
  }

  nodes.push(...externalNodes.values());
  return { nodes, edges, warnings };
}

/** Namespace a concept ID with its bundle ID for multi-bundle graphs. */
export function qualifyNodeId(bundleId: string, conceptId: string): string {
  return `${bundleId}:${conceptId}`;
}

interface DerivedCrossEdges {
  edges: GraphEdge[];
  /** `${qualifiedFrom}\0${url}` per matched link, to suppress external nodes. */
  matched: Set<string>;
}

/**
 * Derive cross-bundle edges: a citation target, external link, or frontmatter
 * `resource` URL that points under the canonical location of a *different*
 * mounted bundle becomes a `kind: "cross-bundle"` edge to that concept. OKF
 * §5 has no cross-bundle link syntax; these edges are read-only derivations
 * from spec-clean URLs, never new document semantics.
 */
function deriveCrossBundle(bundles: LoadedBundle[]): DerivedCrossEdges {
  const targets = bundles.filter((b) => (b.canonicalUrls?.length ?? 0) > 0);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const matched = new Set<string>();
  for (const source of bundles) {
    for (const concept of source.concepts.values()) {
      const from = qualifyNodeId(source.id, concept.id);
      const urls = concept.links
        .filter((link) => link.kind === "external")
        .map((link) => link.target);
      if (typeof concept.frontmatter.resource === "string") {
        urls.push(concept.frontmatter.resource);
      }
      for (const url of urls) {
        for (const target of targets) {
          if (target.id === source.id) continue;
          const id = resolveUrlToConcept(url, target.canonicalUrls!, (cid) =>
            target.concepts.has(cid),
          );
          if (id === undefined) continue;
          matched.add(`${from}\0${url}`);
          const to = qualifyNodeId(target.id, id);
          if (seen.has(`${from}\0${to}`)) continue;
          seen.add(`${from}\0${to}`);
          edges.push({ from, to, kind: "cross-bundle" });
        }
      }
    }
  }
  return { edges, matched };
}

/** Derived cross-bundle edges between the mounted bundles (see deriveCrossBundle). */
export function deriveCrossBundleEdges(bundles: LoadedBundle[]): GraphEdge[] {
  return deriveCrossBundle(bundles).edges;
}

/**
 * Build one graph over several mounted bundles: node IDs are namespaced as
 * `bundle:concept`, in-bundle links stay ordinary edges, and derived
 * cross-bundle edges carry `kind: "cross-bundle"`. A URL that derived an
 * edge is not duplicated as an external node.
 */
export function buildMultiGraph(
  bundles: LoadedBundle[],
  options: GraphOptions = {},
): ConceptGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: string[] = [];
  const externalNodes = new Map<string, GraphNode>();
  const derived = deriveCrossBundle(bundles);

  for (const bundle of bundles) {
    for (const concept of bundle.concepts.values()) {
      const from = qualifyNodeId(bundle.id, concept.id);
      nodes.push({ ...nodeFromConcept(concept), id: from });
      for (const link of concept.links) {
        if (link.resolvedId !== undefined) {
          edges.push({ from, to: qualifyNodeId(bundle.id, link.resolvedId) });
        } else if (link.kind === "concept" && link.path?.toLowerCase().endsWith(".md")) {
          warnings.push(`${bundle.id}/${concept.path}: broken link to ${link.target}`);
        } else if (
          link.kind === "external" &&
          options.includeExternal &&
          !derived.matched.has(`${from}\0${link.target}`)
        ) {
          if (!externalNodes.has(link.target)) {
            externalNodes.set(link.target, externalNode(bundle.id, link.target));
          }
          edges.push({ from, to: link.target });
        }
      }
    }
  }

  edges.push(...derived.edges);
  nodes.push(...externalNodes.values());
  return { nodes, edges, warnings };
}

export interface GraphSummary {
  bundle: string;
  /** OKF version the bundle-root index.md declares, when present (spec §11). */
  okfVersion?: string;
  concepts: number;
  edges: number;
  brokenLinks: number;
  /**
   * Derived cross-bundle edges touching this bundle, given the other mounted
   * bundles (0 when the summary is computed without them).
   */
  crossBundleEdges: number;
  types: Record<string, number>;
  tags: Record<string, number>;
  /** Concepts with no inbound or outbound resolved links. */
  orphans: string[];
}

export function graphSummary(
  bundle: LoadedBundle,
  allBundles: LoadedBundle[] = [],
): GraphSummary {
  const graph = buildGraph(bundle);
  const linked = new Set<string>();
  for (const edge of graph.edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  const context = allBundles.some((b) => b.id === bundle.id)
    ? allBundles
    : [bundle, ...allBundles];
  const prefix = `${bundle.id}:`;
  const crossBundleEdges = deriveCrossBundleEdges(context).filter(
    (edge) => edge.from.startsWith(prefix) || edge.to.startsWith(prefix),
  ).length;
  return {
    bundle: bundle.id,
    okfVersion: bundle.okfVersion,
    concepts: bundle.concepts.size,
    edges: graph.edges.length,
    brokenLinks: graph.warnings.length,
    crossBundleEdges,
    types: Object.fromEntries(listTypes([bundle]).map((t) => [t.type, t.count])),
    tags: Object.fromEntries(listTags([bundle]).map((t) => [t.tag, t.count])),
    orphans: [...bundle.concepts.keys()].filter((id) => !linked.has(id)),
  };
}

export interface TypeCount {
  type: string;
  count: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

/**
 * Count values case-insensitively (consistent with search filter matching),
 * preserving the first-seen casing. Sorted by count, then value.
 */
function countValues(values: Iterable<string>): { value: string; count: number }[] {
  const byKey = new Map<string, { value: string; count: number }>();
  for (const value of values) {
    const key = value.toLowerCase();
    const entry = byKey.get(key);
    if (entry) entry.count += 1;
    else byKey.set(key, { value, count: 1 });
  }
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value),
  );
}

/** Distinct concept `type` values across the bundles, with usage counts. */
export function listTypes(bundles: LoadedBundle[]): TypeCount[] {
  return countValues(
    bundles.flatMap((bundle) =>
      [...bundle.concepts.values()].map((c) => c.frontmatter.type),
    ),
  ).map(({ value, count }) => ({ type: value, count }));
}

/** Distinct tag values across the bundles, with usage counts. */
export function listTags(bundles: LoadedBundle[]): TagCount[] {
  return countValues(
    bundles.flatMap((bundle) =>
      [...bundle.concepts.values()].flatMap((c) => c.frontmatter.tags ?? []),
    ),
  ).map(({ value, count }) => ({ tag: value, count }));
}

export type Direction = "in" | "out" | "both";

export interface NeighborsResult {
  center: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Bounded BFS expansion around one concept of a single bundle's graph. */
export function getNeighbors(
  bundle: LoadedBundle,
  conceptId: string,
  direction: Direction = "both",
  depth = 1,
): NeighborsResult {
  return neighborsInGraph(buildGraph(bundle), conceptId, direction, depth);
}

/**
 * Bounded BFS expansion around one node of an already-built graph (use with
 * buildMultiGraph and a qualifyNodeId center for cross-bundle traversal).
 */
export function neighborsInGraph(
  graph: ConceptGraph,
  centerId: string,
  direction: Direction = "both",
  depth = 1,
): NeighborsResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodeById.has(centerId)) {
    throw new Error(`unknown concept: ${centerId}`);
  }

  const visited = new Set([centerId]);
  const keptEdges: GraphEdge[] = [];
  let frontier = [centerId];
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      const forward = direction !== "in" && frontier.includes(edge.from);
      const backward = direction !== "out" && frontier.includes(edge.to);
      if (!forward && !backward) continue;
      keptEdges.push(edge);
      for (const id of [edge.from, edge.to]) {
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  return {
    center: centerId,
    depth,
    nodes: [...visited].map((id) => nodeById.get(id)!).filter(Boolean),
    edges: dedupeEdges(keptEdges),
  };
}

/** Shortest directed path between two concepts, or null when unreachable. */
export function findPath(
  bundle: LoadedBundle,
  from: string,
  to: string,
): string[] | null {
  return pathInGraph(buildGraph(bundle), from, to);
}

/** Shortest directed path between two nodes of an already-built graph. */
export function pathInGraph(
  graph: ConceptGraph,
  from: string,
  to: string,
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) {
      const pathIds = [to];
      let cursor = to;
      while (cursor !== from) {
        cursor = previous.get(cursor)!;
        pathIds.unshift(cursor);
      }
      return pathIds;
    }
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}\x00${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type GraphFormat = "json" | "dot" | "mermaid";

export function exportGraph(graph: ConceptGraph, format: GraphFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(graph, null, 2);
    case "dot": {
      const lines = ["digraph okf {"];
      for (const node of graph.nodes) {
        const label = (node.title ?? node.id).replaceAll('"', '\\"');
        lines.push(`  "${node.id}" [label="${label}"];`);
      }
      for (const edge of graph.edges) {
        const style = edge.kind === "cross-bundle" ? " [style=dashed]" : "";
        lines.push(`  "${edge.from}" -> "${edge.to}"${style};`);
      }
      lines.push("}");
      return lines.join("\n");
    }
    case "mermaid": {
      const alias = new Map<string, string>();
      const nameOf = (id: string): string => {
        if (!alias.has(id)) alias.set(id, `n${alias.size}`);
        return alias.get(id)!;
      };
      const lines = ["graph TD"];
      for (const node of graph.nodes) {
        const label = (node.title ?? node.id).replaceAll('"', "'");
        lines.push(`  ${nameOf(node.id)}["${label}"]`);
      }
      for (const edge of graph.edges) {
        const arrow = edge.kind === "cross-bundle" ? "-.->" : "-->";
        lines.push(`  ${nameOf(edge.from)} ${arrow} ${nameOf(edge.to)}`);
      }
      return lines.join("\n");
    }
  }
}
