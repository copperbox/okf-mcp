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
          externalNodes.set(link.target, {
            id: link.target,
            bundle: bundle.id,
            path: link.target,
            type: "External",
            external: true,
          });
        }
        edges.push({ from: concept.id, to: link.target });
      }
    }
  }

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
  types: Record<string, number>;
  tags: Record<string, number>;
  /** Concepts with no inbound or outbound resolved links. */
  orphans: string[];
}

export function graphSummary(bundle: LoadedBundle): GraphSummary {
  const graph = buildGraph(bundle);
  const linked = new Set<string>();
  for (const edge of graph.edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  return {
    bundle: bundle.id,
    okfVersion: bundle.okfVersion,
    concepts: bundle.concepts.size,
    edges: graph.edges.length,
    brokenLinks: graph.warnings.length,
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

/** Bounded BFS expansion around one concept. */
export function getNeighbors(
  bundle: LoadedBundle,
  conceptId: string,
  direction: Direction = "both",
  depth = 1,
): NeighborsResult {
  const graph = buildGraph(bundle);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodeById.has(conceptId)) {
    throw new Error(`unknown concept: ${conceptId}`);
  }

  const visited = new Set([conceptId]);
  const keptEdges: GraphEdge[] = [];
  let frontier = [conceptId];
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
    center: conceptId,
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
  const graph = buildGraph(bundle);
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
        lines.push(`  "${edge.from}" -> "${edge.to}";`);
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
        lines.push(`  ${nameOf(edge.from)} --> ${nameOf(edge.to)}`);
      }
      return lines.join("\n");
    }
  }
}
