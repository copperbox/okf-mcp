/**
 * Compact rendering for hit-list tool responses (experimental, opt-in via
 * `format: "compact"` on search_concepts, list_concepts, and get_neighbors).
 *
 * Motivation: a JSON hit list repeats every key once per hit; a line-per-item
 * markdown-flavored rendering carries the same information in a fraction of
 * the bytes. `format` governs serialization only — whatever fields the
 * caller's `detail` level kept on each object are rendered, and fields absent
 * from the object are absent from the line.
 *
 * ## Hit-list grammar (search_concepts, list_concepts)
 *
 * This module is the single source of truth for the line grammar:
 *
 *     <returned> of <total> <noun>[, <omitted> omitted][, termMatching: any]
 *     [tagHints: <tag>(<count>), ...]
 *     - <bundle>:<id> [<type>] <title>[ — <description>][ (§<section>[, §<section>…])][ tags:<t1>,<t2>][ resource:<uri>][ score:<n>][ matchedIn:<f1>,<f2>][ status:<s>][ trust:<t>][ stale]
 *       > <snippet>
 *
 * - One hit per `- ` line; parts appear in the fixed order above, each
 *   omitted when its field is absent from the hit object.
 * - `<bundle>:<id>` reuses the qualified-ID grammar of cross-bundle
 *   get_neighbors / find_path, so the id is unambiguous to split.
 * - `(§…)` lists `matchedSections` when present, otherwise `section`; each
 *   heading feeds get_concept's `section` argument directly.
 * - The `  > <snippet>` continuation line appears only when the hit carries a
 *   snippet that adds signal beyond the description (i.e. the description
 *   does not already contain it).
 * - Newlines (and surrounding whitespace) inside any field collapse to a
 *   single space, so every hit is exactly one line plus at most one snippet
 *   line.
 * - `titleDerived` is not rendered — the derived title itself already is.
 *
 * ## Neighbors grammar (get_neighbors)
 *
 *     <center> (depth <depth>): <N> nodes, <E> edges[ — <note>]
 *     - <id> [<type>][ <title>][ — <description>][ tags:<t1>,<t2>][ external]
 *     edges:
 *     - <from> -> <to>[ "<label>"][ cross-bundle]
 *
 * - Node lines follow the hit-line field order. The full-detail `bundle` and
 *   `path` node fields are not rendered: both are derivable from the id.
 * - The `edges:` block is omitted when there are no edges.
 */

/** Collapse newlines and runs of surrounding whitespace to one space. */
function inline(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * A search/list hit as shaped for the wire: the concise fields, plus the
 * `detail: "full"` extras when the caller kept them. Types are structural
 * (plain strings) so this module stays decoupled from search.ts.
 */
export interface CompactHit {
  bundle: string;
  id: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags?: string[];
  snippet?: string;
  section?: string;
  matchedSections?: string[];
  score?: number;
  matchedIn?: string[];
  status?: string;
  trust?: string;
  stale?: boolean;
}

export interface CompactHitList {
  hits: CompactHit[];
  total: number;
  omitted?: number;
  termMatching?: string;
  tagHints?: { tag: string; count: number }[];
}

function hitLine(hit: CompactHit): string {
  const parts = [`- ${hit.bundle}:${hit.id} [${inline(hit.type)}] ${inline(hit.title)}`];
  if (hit.description !== undefined && hit.description !== "") {
    parts.push(`— ${inline(hit.description)}`);
  }
  const sections =
    hit.matchedSections ?? (hit.section !== undefined ? [hit.section] : []);
  if (sections.length > 0) {
    parts.push(`(${sections.map((s) => `§${inline(s)}`).join(", ")})`);
  }
  if (hit.tags !== undefined && hit.tags.length > 0) {
    parts.push(`tags:${hit.tags.map(inline).join(",")}`);
  }
  if (hit.resource !== undefined) parts.push(`resource:${inline(hit.resource)}`);
  if (hit.score !== undefined) parts.push(`score:${Number(hit.score.toFixed(2))}`);
  if (hit.matchedIn !== undefined && hit.matchedIn.length > 0) {
    parts.push(`matchedIn:${hit.matchedIn.join(",")}`);
  }
  if (hit.status !== undefined) parts.push(`status:${hit.status}`);
  if (hit.trust !== undefined) parts.push(`trust:${hit.trust}`);
  if (hit.stale === true) parts.push("stale");
  return parts.join(" ");
}

/** The snippet continuation line, or undefined when it adds no signal. */
function snippetLine(hit: CompactHit): string | undefined {
  if (hit.snippet === undefined) return undefined;
  const snippet = inline(hit.snippet);
  if (snippet === "") return undefined;
  if (hit.description !== undefined && inline(hit.description).includes(snippet)) {
    return undefined;
  }
  return `  > ${snippet}`;
}

/**
 * Render a hit list per the grammar above. `noun` names the items in the
 * header line ("hits" for search results, "concepts" for catalog pages).
 */
export function renderHitList(result: CompactHitList, noun = "hits"): string {
  const header = [`${result.hits.length} of ${result.total} ${noun}`];
  if (result.omitted !== undefined && result.omitted > 0) {
    header.push(`${result.omitted} omitted`);
  }
  if (result.termMatching !== undefined) {
    header.push(`termMatching: ${result.termMatching}`);
  }
  const lines = [header.join(", ")];
  if (result.tagHints !== undefined && result.tagHints.length > 0) {
    lines.push(
      `tagHints: ${result.tagHints.map((h) => `${h.tag}(${h.count})`).join(", ")}`,
    );
  }
  for (const hit of result.hits) {
    lines.push(hitLine(hit));
    const snippet = snippetLine(hit);
    if (snippet !== undefined) lines.push(snippet);
  }
  return lines.join("\n");
}

/** A get_neighbors node as shaped for the wire (concise or full detail). */
export interface CompactNode {
  id: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  external?: boolean;
}

export interface CompactNeighbors {
  center: string;
  depth: number;
  nodes: CompactNode[];
  edges: { from: string; to: string; label?: string; kind?: string }[];
  note?: string;
}

/** Render a neighbors expansion per the grammar above. */
export function renderNeighbors(result: CompactNeighbors): string {
  const note = result.note === undefined ? "" : ` — ${inline(result.note)}`;
  const lines = [
    `${result.center} (depth ${result.depth}): ${result.nodes.length} nodes, ${result.edges.length} edges${note}`,
  ];
  for (const node of result.nodes) {
    const parts = [`- ${node.id} [${inline(node.type)}]`];
    if (node.title !== undefined) parts.push(inline(node.title));
    if (node.description !== undefined && node.description !== "") {
      parts.push(`— ${inline(node.description)}`);
    }
    if (node.tags !== undefined && node.tags.length > 0) {
      parts.push(`tags:${node.tags.map(inline).join(",")}`);
    }
    if (node.external === true) parts.push("external");
    lines.push(parts.join(" "));
  }
  if (result.edges.length > 0) {
    lines.push("edges:");
    for (const edge of result.edges) {
      const label = edge.label === undefined ? "" : ` "${inline(edge.label)}"`;
      const kind = edge.kind === "cross-bundle" ? " cross-bundle" : "";
      lines.push(`- ${edge.from} -> ${edge.to}${label}${kind}`);
    }
  }
  return lines.join("\n");
}
