/**
 * Self-contained HTML export of a concept graph: one document embedding the
 * graph data and a small hand-rolled force simulation (repulsion + link
 * springs + centering + per-community cluster gravity) rendered to <canvas>.
 * Zero network access and zero runtime dependencies — the file is shareable
 * and diffable as-is. Backs the CLI's `graph html` format.
 */

import type { ConceptGraph, GraphEdge, GraphNode } from "./graph.js";

/**
 * How nodes are grouped into communities (color, legend entry, and cluster
 * gravity) in the html export: by owning bundle, by concept `type`, by first
 * path segment of the concept ID, or by first frontmatter tag.
 */
export type CommunityMode = "bundle" | "type" | "folder" | "tag";

/**
 * Community assignment for one mode. External link-target nodes always get
 * their own muted "(external)" community — a bundle/type/folder read off a
 * URL would be noise.
 */
export function communityAssigner(mode: CommunityMode): (node: GraphNode) => string {
  return (node) => {
    if (node.external) return "(external)";
    switch (mode) {
      case "bundle":
        return node.bundle;
      case "type":
        return node.type;
      case "folder": {
        const slash = node.id.indexOf("/");
        return slash === -1 ? "(root)" : node.id.slice(0, slash);
      }
      case "tag":
        return node.tags?.[0] ?? "(untagged)";
    }
  };
}

export interface ExportGraphHtmlOptions {
  /** Community label per node: color, legend entry, and cluster-gravity group. */
  communityOf: (node: GraphNode) => string;
  /**
   * Web URL where a node's source can be viewed (e.g. its GitHub blob URL,
   * built from the owning bundle's canonical location). Nodes without one
   * simply get no link in the details panel.
   */
  urlOf?: (node: GraphNode) => string | undefined;
}

interface EmbeddedNode {
  id: string;
  type: string;
  community: string;
  title?: string;
  description?: string;
  tags?: string[];
  external?: boolean;
  url?: string;
}

/**
 * Render the graph as one self-contained interactive HTML document. The data
 * travels in a JSON <script> tag with every `<` escaped as `\u003c`, so a
 * title or description containing `</script>` cannot break out of it.
 */
export function exportGraphHtml(
  graph: ConceptGraph,
  options: ExportGraphHtmlOptions,
): string {
  // Only what the page renders travels: nodes drop bundle/path, edges drop
  // label. JSON.stringify omits the fields left undefined here.
  const nodes: EmbeddedNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    community: options.communityOf(node),
    title: node.title,
    description: node.description,
    tags: node.tags,
    external: node.external,
    url: options.urlOf?.(node),
  }));
  const edges: GraphEdge[] = graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
  }));
  const json = JSON.stringify({ nodes, edges }).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OKF knowledge graph</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #11151c; color: #c9d1d9;
    font: 13px/1.45 system-ui, -apple-system, sans-serif; }
  #graph { display: block; }
  #panel { position: fixed; top: 12px; left: 12px; max-width: 260px; max-height: calc(100% - 24px);
    overflow-y: auto; background: rgba(22, 27, 34, 0.92); border: 1px solid #30363d;
    border-radius: 8px; padding: 10px 12px; user-select: none; }
  #panel h1 { margin: 0 0 2px; font-size: 13px; font-weight: 600; color: #f0f3f6; }
  #stats { color: #8b949e; font-size: 12px; margin-bottom: 8px; }
  #search { display: block; width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 4px 8px;
    background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
    font: inherit; user-select: text; }
  #search::placeholder { color: #8b949e; }
  .legend-item { display: flex; align-items: center; gap: 7px; padding: 2px 4px; margin: 0 -4px;
    border-radius: 4px; cursor: pointer; }
  .legend-item.active { background: rgba(88, 166, 255, 0.25); }
  .legend-count { margin-left: auto; padding-left: 8px; color: #8b949e; font-size: 11px; }
  /* The legend scrolls on its own so the controls below it stay reachable no
     matter how many communities the graph has. Capping its height also made
     it a scroll container in both axes; a long community name is clipped
     rather than buying a second, horizontal scrollbar. */
  #legend { max-height: 40vh; overflow-y: auto; overflow-x: hidden; }
  #controls { margin-top: 8px; padding-top: 8px; border-top: 1px solid #30363d; }
  #controls h2 { margin: 0 0 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: #8b949e; }
  .ctl { display: flex; align-items: center; gap: 7px; padding: 2px 0; cursor: pointer; }
  .ctl input { accent-color: #58a6ff; margin: 0; }
  .ctl-range { display: block; padding-top: 4px; color: #8b949e; font-size: 11px; cursor: pointer; }
  .ctl-range input { display: block; width: 100%; margin: 2px 0 0; accent-color: #f2b705; }
  #details { position: fixed; top: 12px; left: 310px; max-width: 300px;
    max-height: calc(100% - 24px); overflow-y: auto; display: none;
    background: rgba(22, 27, 34, 0.92); border: 1px solid #30363d;
    border-radius: 8px; padding: 10px 12px; }
  .dt-link { display: inline-block; margin-top: 6px; color: #58a6ff; font-size: 12px;
    text-decoration: none; }
  .dt-link:hover { text-decoration: underline; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  #tooltip { position: fixed; display: none; max-width: 300px; pointer-events: none; z-index: 2;
    background: rgba(22, 27, 34, 0.95); border: 1px solid #30363d; border-radius: 8px;
    padding: 8px 10px; }
  .tt-title { font-weight: 600; color: #f0f3f6; }
  .tt-id { color: #8b949e; font-size: 12px; margin-bottom: 4px; overflow-wrap: anywhere; }
  .tt-desc { margin-bottom: 4px; }
  .tt-tags { color: #79b8ff; font-size: 12px; }
  #hint { position: fixed; right: 12px; bottom: 10px; color: #8b949e; font-size: 11px; }
</style>
</head>
<body>
<canvas id="graph"></canvas>
<div id="panel">
  <h1>OKF knowledge graph</h1>
  <div id="stats"></div>
  <input type="search" id="search" placeholder="Filter concepts&hellip;" autocomplete="off">
  <div id="legend"></div>
  <div id="controls">
    <h2>Layers</h2>
    <label class="ctl"><input type="checkbox" id="opt-intra" checked>intra-bundle</label>
    <label class="ctl"><input type="checkbox" id="opt-cross" checked>cross-bundle</label>
    <label class="ctl"><input type="checkbox" id="opt-arrows" checked>arrows</label>
    <label class="ctl"><input type="checkbox" id="opt-labels" checked>labels</label>
    <label class="ctl-range">cross-bundle opacity
      <input type="range" id="opt-cross-alpha" min="0.02" max="0.9" step="0.02" value="0.16">
    </label>
  </div>
</div>
<div id="details"></div>
<div id="tooltip"></div>
<div id="hint">search filters &middot; drag nodes &middot; wheel zooms &middot; drag background pans &middot; click a node to highlight &amp; show details &middot; hover or select a node to light up its cross-bundle links &middot; zoom out for bundle-pair trunks &middot; click the legend to focus a community &middot; toggle layers in the panel</div>
<script type="application/json" id="graph-data">${json}</script>
<script>
(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("graph-data").textContent);
  const canvas = document.getElementById("graph");
  const ctx = canvas.getContext("2d");
  const tooltip = document.getElementById("tooltip");

  // crossDegree rides along with degree because the rim tick needs to know how
  // much of a node's connectivity leaves its bundle, and the edge loop below
  // is the only place that already visits every endpoint pair.
  const nodes = data.nodes.map((n) => Object.assign({ x: 0, y: 0, vx: 0, vy: 0, degree: 0, crossDegree: 0 }, n));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const e of data.edges) {
    const source = byId.get(e.from);
    const target = byId.get(e.to);
    if (!source || !target) continue;
    const cross = e.kind === "cross-bundle";
    edges.push({ source, target, cross });
    source.degree += 1;
    target.degree += 1;
    if (cross) { source.crossDegree += 1; target.crossDegree += 1; }
  }
  // Cross-bundle edges grouped by unordered community pair, once at startup:
  // at overview scale the fact worth carrying is which communities link to
  // each other and how much, not where each individual line lands. Pairs whose
  // two ends are the same community are skipped — a cross-bundle edge that
  // stays inside one community has no trunk to draw between two centroids.
  const crossPairs = [];
  const pairIndex = new Map();
  for (const e of edges) {
    if (!e.cross) continue;
    const ca = e.source.community;
    const cb = e.target.community;
    if (ca === cb) continue;
    const a = ca < cb ? ca : cb;
    const b = ca < cb ? cb : ca;
    const key = a + "\\u0000" + b;
    let pair = pairIndex.get(key);
    if (!pair) { pair = { a, b, count: 0 }; pairIndex.set(key, pair); crossPairs.push(pair); }
    pair.count += 1;
  }

  const neighbors = new Map(nodes.map((n) => [n, new Set([n])]));
  for (const e of edges) {
    neighbors.get(e.source).add(e.target);
    neighbors.get(e.target).add(e.source);
  }

  const communities = Array.from(new Set(nodes.map((n) => n.community))).sort();
  const colorOf = new Map();
  communities.forEach((c, i) => {
    colorOf.set(c, c === "(external)" ? "#8a8f98" : "hsl(" + ((i * 137.508) % 360).toFixed(1) + " 62% 58%)");
  });
  // Deterministic start: communities spaced on a ring, members on a golden-
  // angle spiral around theirs, so clusters begin apart and converge fast.
  communities.forEach((c, ci) => {
    const members = nodes.filter((n) => n.community === c);
    const angle = (2 * Math.PI * ci) / communities.length;
    const spread = communities.length > 1 ? 60 + 26 * Math.sqrt(nodes.length) : 0;
    members.forEach((n, i) => {
      const a = i * 2.399963;
      const r = 10 * Math.sqrt(i + 1);
      n.x = spread * Math.cos(angle) + r * Math.cos(a);
      n.y = spread * Math.sin(angle) + r * Math.sin(a);
    });
  });

  function radius(n) { return Math.min(4 + 1.6 * Math.sqrt(n.degree), 16); }

  // Force simulation: pairwise repulsion, springs along edges, gentle pull to
  // the origin, and cluster gravity toward each community's centroid, all
  // scaled by a decaying alpha with velocity damping.
  let alpha = 1;
  let dragging = null;
  function step() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 === 0) { dx = 0.1 * (i - j); d2 = dx * dx; }
        if (d2 > 250000) continue;
        const f = (900 * alpha) / d2;
        a.vx += dx * f; a.vy += dy * f;
        b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    for (const e of edges) {
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const rest = e.cross ? 170 : 60;
      const f = ((d - rest) / d) * 0.05 * alpha;
      e.source.vx += dx * f; e.source.vy += dy * f;
      e.target.vx -= dx * f; e.target.vy -= dy * f;
    }
    const centroids = new Map();
    for (const n of nodes) {
      let c = centroids.get(n.community);
      if (!c) { c = { x: 0, y: 0, count: 0 }; centroids.set(n.community, c); }
      c.x += n.x; c.y += n.y; c.count += 1;
    }
    for (const n of nodes) {
      const c = centroids.get(n.community);
      n.vx += (c.x / c.count - n.x) * 0.03 * alpha;
      n.vy += (c.y / c.count - n.y) * 0.03 * alpha;
      n.vx -= n.x * 0.006 * alpha;
      n.vy -= n.y * 0.006 * alpha;
    }
    for (const n of nodes) {
      if (n === dragging) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    }
    alpha *= 0.994;
  }

  const view = { x: 0, y: 0, k: 1 };
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
  }
  window.addEventListener("resize", resize);
  resize();
  view.x = window.innerWidth / 2;
  view.y = window.innerHeight / 2;

  function toWorld(px, py) { return { x: (px - view.x) / view.k, y: (py - view.y) / view.k }; }
  function nodeAt(px, py) {
    const p = toWorld(px, py);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const r = radius(n) + 2;
      const dx = p.x - n.x;
      const dy = p.y - n.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  let selected = null;
  let hovered = null;
  let focused = null;
  let query = "";
  function matchesQuery(n) {
    return (n.title || "").toLowerCase().includes(query) ||
      n.id.toLowerCase().includes(query) ||
      (n.tags || []).some((t) => t.toLowerCase().includes(query));
  }
  // Legend focus, selection, and the search query compose by taking the
  // minimum alpha; edges inherit the min of their endpoints for the query,
  // so an edge stays bright only when both ends match.
  function fade(n) {
    let a = 1;
    if (focused !== null && n.community !== focused) a = 0.12;
    if (selected && !neighbors.get(selected).has(n)) a = Math.min(a, 0.15);
    if (query && !matchesQuery(n)) a = Math.min(a, 0.13);
    return a;
  }
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
  });

  // Layer controls. The inputs are read straight out of the DOM each frame
  // rather than mirrored into state: the next frame is already coming, so
  // there is nothing to invalidate and no change listeners to keep in sync.
  const optIntra = document.getElementById("opt-intra");
  const optCross = document.getElementById("opt-cross");
  const optArrows = document.getElementById("opt-arrows");
  const optLabels = document.getElementById("opt-labels");
  const optCrossAlpha = document.getElementById("opt-cross-alpha");

  // Every per-edge visual decision lives here: whether the edge is drawn at
  // all, and its color, alpha, and width. Returns null for an edge whose
  // layer is switched off.
  function edgeStyle(e) {
    if (!(e.cross ? optCross : optIntra).checked) return null;
    // Unlike node fading, an edge survives a legend focus when EITHER
    // endpoint is in the focused community, so cross-community edges into
    // the focus stay visible. The search query, however, requires BOTH
    // endpoints to match — an edge is only bright when both ends do.
    let a = 1;
    if (focused !== null && e.source.community !== focused && e.target.community !== focused) a = 0.12;
    if (selected && e.source !== selected && e.target !== selected) a = Math.min(a, 0.1);
    if (query && (!matchesQuery(e.source) || !matchesQuery(e.target))) a = Math.min(a, 0.13);
    // Cross-bundle edges are the most numerous element in a colocated
    // multi-bundle export, so giving them the highest contrast buried
    // everything underneath at overview scale. They are the quietest layer
    // instead: desaturated gold, thin, and undashed — a 5px dash is invisible
    // once the graph is zoomed out and only adds ink. The slider IS that base
    // alpha rather than a multiplier on a hardcoded one, and it still
    // composes with the fade above instead of replacing it. What was lost by
    // going quiet comes back on demand: see the emphasis pass in draw().
    const base = e.cross ? Number(optCrossAlpha.value) : 0.55;
    return {
      color: e.cross ? "#8a7a45" : "#7d8590",
      alpha: base * a,
      width: (e.cross ? 1.1 : 1) / view.k,
    };
  }

  // The quiet default only works if the detail is one gesture away, so the
  // cross-bundle edges touching the node under the cursor — or the one held
  // by a click — come back at full emphasis. Hovering counts as well as
  // selecting: hover is the cheaper way to sweep a cluster looking for the
  // node whose links leave the bundle.
  function emphasized(e) {
    return e.cross && (e.source === hovered || e.target === hovered ||
      e.source === selected || e.target === selected);
  }

  // step() already accumulates centroids, but it stops running once alpha
  // decays and a dragged node moves its cluster afterwards, so the trunks get
  // their own pass rather than reading values that quietly go stale. It is
  // O(n) against a simulation that is O(n^2), and only runs on frames where a
  // trunk is actually visible.
  function centroids() {
    const acc = new Map();
    for (const n of nodes) {
      let c = acc.get(n.community);
      if (!c) { c = { x: 0, y: 0, count: 0 }; acc.set(n.community, c); }
      c.x += n.x; c.y += n.y; c.count += 1;
    }
    for (const c of acc.values()) { c.x /= c.count; c.y /= c.count; }
    return acc;
  }

  // A trunk answers the legend focus by the same rule its member edges do:
  // either endpoint community inside the focus keeps it bright.
  function pairFade(p) {
    return focused !== null && p.a !== focused && p.b !== focused ? 0.12 : 1;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    // Below 1:1 the nodes are a few pixels across and a filled triangle on
    // every edge reads as noise rather than direction, so arrowheads are off
    // at overview scale whatever the toggle says.
    const arrows = optArrows.checked && view.k >= 1;
    // Semantic zoom. Below roughly 1:1 the individual cross-bundle lines are a
    // mesh nobody can read, so they trade places with one trunk per community
    // pair: detail is the individual lines' share of the layer and
    // 1 - detail is the trunks', crossing over across a narrow band of zoom
    // so neither pops in.
    const detail = Math.min(Math.max((view.k - 0.85) / 0.5, 0), 1);
    for (const e of edges) {
      // Fully faded out means there is nothing to draw and nothing to compute,
      // including the arrowhead.
      if (e.cross && detail === 0) continue;
      const style = edgeStyle(e);
      if (!style) continue;
      // The cross-fade multiplies the styled alpha rather than living inside
      // edgeStyle: it is a property of the view, not of the edge.
      ctx.globalAlpha = e.cross ? style.alpha * detail : style.alpha;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
      if (!arrows) continue;
      // Direction arrowhead on every edge (cheap next to the O(n^2)
      // simulation; drop to cross-bundle-only if it ever hurts): a filled
      // triangle at the target end, backed off by the node radius so it is
      // not buried under the circle, sized in screen space.
      const dx = e.target.x - e.source.x;
      const dy = e.target.y - e.source.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const size = 6 / view.k;
      const back = radius(e.target) + 1 / view.k;
      if (d <= back + size) continue;
      const ux = dx / d;
      const uy = dy / d;
      const tipX = e.target.x - ux * back;
      const tipY = e.target.y - uy * back;
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - (ux - 0.45 * uy) * size, tipY - (uy + 0.45 * ux) * size);
      ctx.lineTo(tipX - (ux + 0.45 * uy) * size, tipY - (uy - 0.45 * ux) * size);
      ctx.closePath();
      ctx.fill();
    }
    // Trunk pass: the other half of the cross-fade. One gold line per
    // community pair between the two centroids, weighted by how many edges it
    // stands for, so an overview reads as "these communities are linked, this
    // much" instead of a mesh. It is still the cross-bundle layer, so the
    // checkbox governs it — but not the opacity slider: that value is a base
    // alpha tuned for hairlines, and 0.16 on a trunk several pixels wide would
    // erase the layer exactly where nothing else is left to carry it.
    if (optCross.checked && detail < 1 && crossPairs.length) {
      const centers = centroids();
      const labels = [];
      ctx.strokeStyle = "#f2b705";
      ctx.lineCap = "round";
      for (const p of crossPairs) {
        const a = centers.get(p.a);
        const b = centers.get(p.b);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        // Two centroids sitting on top of each other have no trunk to draw —
        // a round-capped zero-length line is just a blob with a number on it.
        if (dx * dx + dy * dy < 1) continue;
        // Weight has to stay legible when every pair exists: a fully
        // connected set of communities puts n*(n-1)/2 trunks through the same
        // few centroids, so the width ramp is deliberately shallow and the
        // alpha low enough to read the clusters underneath.
        const alpha = 0.34 * (1 - detail) * pairFade(p);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = (0.8 + 0.9 * Math.sqrt(p.count)) / view.k;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        labels.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: String(p.count), alpha });
      }
      ctx.lineCap = "butt";
      // The count is the entire payload of a trunk, so it is drawn at a fixed
      // screen size on its own dark disc: the trunk midpoint often lands over
      // a cluster, and bare text there is unreadable. Labels go after all the
      // lines so a later trunk cannot cross an earlier number.
      ctx.font = 11 / view.k + "px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1 / view.k;
      for (const l of labels) {
        ctx.globalAlpha = Math.min(1, l.alpha * 2.6);
        ctx.fillStyle = "#11151c";
        ctx.beginPath();
        ctx.arc(l.x, l.y, (7 + 3 * (l.text.length - 1)) / view.k, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#f2b705";
        ctx.fillText(l.text, l.x, l.y);
      }
      ctx.textBaseline = "alphabetic";
    }
    // Emphasis pass: a second, louder draw of just the edges leaving the
    // hovered or selected node, after the quiet pass so nothing overpaints
    // them, and before the nodes so they still tuck under the circles.
    if (optCross.checked && (hovered || selected)) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "#f2b705";
      ctx.lineWidth = 1.8 / view.k;
      ctx.beginPath();
      for (const e of edges) {
        if (!emphasized(e)) continue;
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
      }
      ctx.stroke();
    }
    for (const n of nodes) {
      ctx.globalAlpha = fade(n);
      ctx.fillStyle = colorOf.get(n.community);
      const r = radius(n);
      ctx.beginPath();
      if (n.external) ctx.rect(n.x - 0.9 * r, n.y - 0.9 * r, 1.8 * r, 1.8 * r);
      else ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fill();
      if (n === selected || n === hovered) {
        ctx.strokeStyle = "#f0f3f6";
        ctx.lineWidth = 1.5 / view.k;
        ctx.stroke();
      }
      // Quieting the cross-bundle edges would otherwise cost the one fact
      // worth keeping at overview scale: which nodes reach outside their
      // bundle at all. A gold tick on the rim carries it on the node itself,
      // swept by cross-degree and capped well short of a full ring so a hub
      // still reads as a tick rather than an outline. Its offset and weight
      // are world units like the radius, not screen units like the strokes
      // above, so it shrinks with the node instead of dominating when zoomed
      // out. It rides the node's own fade alpha, set at the top of the loop.
      if (n.crossDegree > 0 && optCross.checked) {
        const sweep = Math.min(0.4 + 0.5 * Math.sqrt(n.crossDegree), 2.4);
        ctx.strokeStyle = "#f2b705";
        ctx.lineWidth = Math.max(1.4, 0.3 * r);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 0.5, -Math.PI / 2 - sweep / 2, -Math.PI / 2 + sweep / 2);
        ctx.stroke();
      }
    }
    if (optLabels.checked && view.k > 1.4) {
      ctx.font = 11 / view.k + "px system-ui, sans-serif";
      ctx.fillStyle = "#c9d1d9";
      ctx.textAlign = "center";
      for (const n of nodes) {
        ctx.globalAlpha = fade(n);
        ctx.fillText(n.title || n.id, n.x, n.y + radius(n) + 12 / view.k);
      }
    }
    ctx.globalAlpha = 1;
  }

  function showTooltip(n, cx, cy) {
    tooltip.replaceChildren();
    const add = (cls, text) => {
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text;
      tooltip.append(div);
    };
    add("tt-title", n.title || n.id);
    add("tt-id", n.id + " \\u00b7 " + n.type);
    if (n.description) add("tt-desc", n.description);
    if (n.tags && n.tags.length) add("tt-tags", n.tags.map((t) => "#" + t).join(" "));
    tooltip.style.display = "block";
    tooltip.style.left = Math.min(cx + 14, window.innerWidth - 320) + "px";
    tooltip.style.top = Math.min(cy + 14, window.innerHeight - 120) + "px";
  }
  function hideTooltip() { tooltip.style.display = "none"; }

  // Node details panel: sits beside #panel, appears while a node is selected.
  // Rebuilt with textContent/setAttribute only, so titles and descriptions
  // stay inert text — same rule as the tooltip.
  const details = document.getElementById("details");
  function renderDetails() {
    details.replaceChildren();
    if (!selected) { details.style.display = "none"; return; }
    const n = selected;
    const add = (cls, text) => {
      const div = document.createElement("div");
      div.className = cls;
      div.textContent = text;
      details.append(div);
    };
    add("tt-title", n.title || n.id);
    add("tt-id", n.id + " \\u00b7 " + n.type);
    if (n.description) add("tt-desc", n.description);
    if (n.tags && n.tags.length) add("tt-tags", n.tags.map((t) => "#" + t).join(" "));
    if (n.url) {
      const link = document.createElement("a");
      link.className = "dt-link";
      link.href = n.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = (n.url.startsWith("https://github.com/") ? "View on GitHub" : "Open link") + " \\u2197";
      details.append(link);
    }
    details.style.display = "block";
  }

  let pressed = null;
  let panFrom = null;
  let moved = false;
  canvas.addEventListener("mousedown", (ev) => {
    moved = false;
    pressed = nodeAt(ev.offsetX, ev.offsetY);
    if (pressed) dragging = pressed;
    else panFrom = { x: ev.offsetX - view.x, y: ev.offsetY - view.y };
  });
  canvas.addEventListener("mousemove", (ev) => {
    if (dragging) {
      moved = true;
      const p = toWorld(ev.offsetX, ev.offsetY);
      dragging.x = p.x;
      dragging.y = p.y;
      alpha = Math.max(alpha, 0.3);
      hideTooltip();
      return;
    }
    if (panFrom) {
      moved = true;
      view.x = ev.offsetX - panFrom.x;
      view.y = ev.offsetY - panFrom.y;
      hideTooltip();
      return;
    }
    hovered = nodeAt(ev.offsetX, ev.offsetY);
    canvas.style.cursor = hovered ? "pointer" : "default";
    if (hovered) showTooltip(hovered, ev.clientX, ev.clientY);
    else hideTooltip();
  });
  window.addEventListener("mouseup", () => {
    // Only clicks that began on the canvas (pressed or panFrom set) may
    // rebuild the details panel: a mouseup elsewhere — notably on the
    // panel's own link — must not replaceChildren() mid-click, which would
    // detach the anchor before its click activation and swallow the
    // navigation.
    if (!moved && (pressed || panFrom)) {
      if (pressed) selected = selected === pressed ? null : pressed;
      else { selected = null; setFocus(null); }
      renderDetails();
    }
    dragging = null;
    pressed = null;
    panFrom = null;
  });
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const k = Math.min(Math.max(view.k * Math.exp(-ev.deltaY * 0.0015), 0.1), 8);
    view.x = ev.offsetX - ((ev.offsetX - view.x) / view.k) * k;
    view.y = ev.offsetY - ((ev.offsetY - view.y) / view.k) * k;
    view.k = k;
  }, { passive: false });

  document.getElementById("stats").textContent = nodes.length + " nodes \\u00b7 " + edges.length + " edges";
  const legend = document.getElementById("legend");
  const legendItems = new Map();
  function setFocus(community) {
    focused = community;
    for (const [name, el] of legendItems) el.classList.toggle("active", name === focused);
  }
  const communitySizes = new Map();
  for (const n of nodes) communitySizes.set(n.community, (communitySizes.get(n.community) || 0) + 1);
  for (const c of communities) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = colorOf.get(c);
    const label = document.createElement("span");
    label.textContent = c;
    const count = document.createElement("span");
    count.className = "legend-count";
    count.textContent = communitySizes.get(c);
    item.append(swatch, label, count);
    item.addEventListener("click", () => setFocus(focused === c ? null : c));
    legendItems.set(c, item);
    legend.append(item);
  }

  (function frame() {
    if (alpha > 0.005) step();
    draw();
    requestAnimationFrame(frame);
  })();
})();
</script>
</body>
</html>
`;
}
