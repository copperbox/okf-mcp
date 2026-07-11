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
}

interface EmbeddedNode {
  id: string;
  type: string;
  community: string;
  title?: string;
  description?: string;
  tags?: string[];
  external?: boolean;
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
  const nodes: EmbeddedNode[] = graph.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    community: options.communityOf(node),
    ...(node.title !== undefined && { title: node.title }),
    ...(node.description !== undefined && { description: node.description }),
    ...(node.tags !== undefined && { tags: node.tags }),
    ...(node.external !== undefined && { external: node.external }),
  }));
  const edges: GraphEdge[] = graph.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...(edge.kind !== undefined && { kind: edge.kind }),
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
  .legend-item { display: flex; align-items: center; gap: 7px; padding: 2px 4px; margin: 0 -4px;
    border-radius: 4px; cursor: pointer; }
  .legend-item.active { background: rgba(88, 166, 255, 0.25); }
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
  <div id="legend"></div>
</div>
<div id="tooltip"></div>
<div id="hint">drag nodes &middot; wheel zooms &middot; drag background pans &middot; click a node to highlight &middot; click the legend to focus a community</div>
<script type="application/json" id="graph-data">${json}</script>
<script>
(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("graph-data").textContent);
  const canvas = document.getElementById("graph");
  const ctx = canvas.getContext("2d");
  const tooltip = document.getElementById("tooltip");

  const nodes = data.nodes.map((n) => Object.assign({ x: 0, y: 0, vx: 0, vy: 0, degree: 0 }, n));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const e of data.edges) {
    const source = byId.get(e.from);
    const target = byId.get(e.to);
    if (!source || !target) continue;
    edges.push({ source, target, cross: e.kind === "cross-bundle" });
    source.degree += 1;
    target.degree += 1;
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
  function fade(n) {
    let a = 1;
    if (focused !== null && n.community !== focused) a = 0.12;
    if (selected && !neighbors.get(selected).has(n)) a = Math.min(a, 0.15);
    return a;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);
    for (const e of edges) {
      // Unlike node fading, an edge survives a legend focus when EITHER
      // endpoint is in the focused community, so cross-community edges into
      // the focus stay visible.
      let a = 1;
      if (focused !== null && e.source.community !== focused && e.target.community !== focused) a = 0.12;
      if (selected && e.source !== selected && e.target !== selected) a = Math.min(a, 0.1);
      ctx.globalAlpha = 0.55 * a;
      ctx.strokeStyle = e.cross ? "#e0b45c" : "#7d8590";
      ctx.lineWidth = 1 / view.k;
      ctx.setLineDash(e.cross ? [5 / view.k, 4 / view.k] : []);
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
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
    }
    if (view.k > 1.4) {
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
    if (!moved) {
      if (pressed) selected = selected === pressed ? null : pressed;
      else if (panFrom) { selected = null; setFocus(null); }
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
  for (const c of communities) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = colorOf.get(c);
    const label = document.createElement("span");
    label.textContent = c;
    item.append(swatch, label);
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
