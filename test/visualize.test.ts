import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConceptGraph, GraphNode } from "../src/graph.js";
import { communityAssigner, exportGraphHtml } from "../src/visualize.js";
import { embeddedGraphData } from "./helpers.js";

function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    bundle: "brain",
    path: `${overrides.id}.md`,
    type: "Note",
    ...overrides,
  };
}

describe("communityAssigner", () => {
  it("groups by bundle, type, folder, and tag", () => {
    const nested = node({ id: "guides/setup", type: "Guide", tags: ["alpha", "beta"] });
    const root = node({ id: "readme", type: "Note" });
    assert.equal(communityAssigner("bundle")(nested), "brain");
    assert.equal(communityAssigner("type")(nested), "Guide");
    assert.equal(communityAssigner("folder")(nested), "guides");
    assert.equal(communityAssigner("folder")(root), "(root)");
    assert.equal(communityAssigner("tag")(nested), "alpha");
    assert.equal(communityAssigner("tag")(root), "(untagged)");
  });

  it("assigns external nodes their own community in every mode", () => {
    const external = node({
      id: "https://example.com/docs",
      type: "External",
      external: true,
    });
    for (const mode of ["bundle", "type", "folder", "tag"] as const) {
      assert.equal(communityAssigner(mode)(external), "(external)");
    }
  });
});

describe("exportGraphHtml", () => {
  const graph: ConceptGraph = {
    nodes: [
      node({ id: "a", title: "Alpha", description: "First.", tags: ["x"] }),
      node({ id: "sub/b", type: "Guide" }),
      node({ id: "https://example.com", type: "External", external: true }),
    ],
    edges: [
      { from: "a", to: "sub/b" },
      { from: "a", to: "https://example.com", kind: "cross-bundle" },
    ],
    warnings: [],
  };

  it("embeds every node and edge with its community", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    assert.match(html, /^<!doctype html>/);
    const data = embeddedGraphData(html);
    assert.deepEqual(
      data.nodes.map((n) => [n.id, n.community]),
      [
        ["a", "Note"],
        ["sub/b", "Guide"],
        ["https://example.com", "(external)"],
      ],
    );
    assert.deepEqual(data.edges, [
      { from: "a", to: "sub/b" },
      { from: "a", to: "https://example.com", kind: "cross-bundle" },
    ]);
    assert.equal(data.nodes[0]!.title, "Alpha");
    assert.equal(data.nodes[2]!.external, true);
  });

  it("embeds a url per node via urlOf, omitting nodes without one", () => {
    const html = exportGraphHtml(graph, {
      communityOf: communityAssigner("type"),
      urlOf: (n) =>
        n.external ? n.id : n.id === "a" ? `https://github.com/o/r/blob/main/${n.path}` : undefined,
    });
    const data = embeddedGraphData(html);
    assert.equal(data.nodes[0]!.url, "https://github.com/o/r/blob/main/a.md");
    assert.ok(!("url" in data.nodes[1]!));
    assert.equal(data.nodes[2]!.url, "https://example.com");
  });

  it("shows a details panel beside #panel for the selected node, with a source link", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // The details panel is its own fixed element next to #panel, not inside it.
    assert.match(html, /<\/div>\s*<div id="details"><\/div>/);
    assert.match(html, /#details \{ position: fixed; top: 12px; left: 310px;/);
    // Hidden until a node is selected; rebuilt on every selection change.
    assert.match(html, /if \(!selected\) \{ details\.style\.display = "none"; return; \}/);
    assert.match(html, /renderDetails\(\);/);
    // The source link opens in a new tab without an opener, only when the
    // node has a url, and is labeled by destination.
    assert.match(html, /if \(n\.url\) \{/);
    assert.match(html, /link\.target = "_blank";/);
    assert.match(html, /link\.rel = "noopener";/);
    assert.match(html, /"View on GitHub" : "Open link"/);
    assert.match(html, /click a node to highlight &amp; show details/);
  });

  it("shows a node count next to each legend entry", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    assert.match(html, /communitySizes\.set\(n\.community, \(communitySizes\.get\(n\.community\) \|\| 0\) \+ 1\);/);
    assert.match(html, /count\.className = "legend-count";/);
    assert.match(html, /item\.append\(swatch, label, count\);/);
  });

  it("escapes < so a </script> in a title cannot break out of the document", () => {
    const hostile: ConceptGraph = {
      nodes: [node({ id: "a", title: "</script><script>alert(1)</script>" })],
      edges: [],
      warnings: [],
    };
    const html = exportGraphHtml(hostile, { communityOf: communityAssigner("type") });
    const data = embeddedGraphData(html);
    // The embedded JSON carries no raw < at all ...
    assert.doesNotMatch(data.raw, /</);
    // ... yet the title round-trips exactly.
    assert.equal(data.nodes[0]!.title, "</script><script>alert(1)</script>");
  });

  it("legend click focuses a single community; edges stay when either endpoint is inside", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Single-select: clicking the active entry clears the focus, clicking
    // another switches it.
    assert.match(html, /setFocus\(focused === c \? null : c\)/);
    // An edge fades only when NEITHER endpoint is in the focused community —
    // cross-community edges into the focus stay visible.
    assert.match(html, /e\.source\.community !== focused && e\.target\.community !== focused/);
    // The active legend entry is visibly highlighted; the old dim toggle and
    // its styling are gone entirely.
    assert.match(html, /\.legend-item\.active \{ background/);
    assert.doesNotMatch(html, /dimmed/);
    // Clicking the canvas background clears node selection AND legend focus.
    assert.match(html, /selected = null; setFocus\(null\);/);
    assert.match(html, /click the legend to focus a community/);
  });

  it("keeps cross-bundle edges quiet by default and draws direction arrowheads", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Cross-bundle edges are the quietest layer: desaturated gold, thin, and
    // with the slider value as their base alpha rather than a multiplier on a
    // hardcoded one.
    assert.match(html, /const base = e\.cross \? Number\(optCrossAlpha\.value\) : 0\.55;/);
    assert.match(html, /alpha: base \* a,/);
    assert.match(html, /color: e\.cross \? "#8a7a45" : "#7d8590",/);
    assert.match(html, /\(e\.cross \? 1\.1 : 1\) \/ view\.k/);
    // No dash anywhere: it is invisible at overview scale and only adds ink.
    assert.doesNotMatch(html, /setLineDash/);
    assert.doesNotMatch(html, /\[5 \/ view\.k, 4 \/ view\.k\]/);
    // Every edge ends in a filled triangle at the target, backed off by the
    // node radius so it is not buried under the circle, sized in screen
    // space, and sharing the edge's color and fade alpha.
    assert.match(html, /arrowhead/i);
    assert.match(html, /radius\(e\.target\)/);
    assert.match(html, /ctx\.closePath\(\);\s*ctx\.fill\(\);/);
  });

  it("offers layer controls with sane defaults below the legend", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // The controls sit in #panel directly below the legend.
    assert.match(html, /<div id="legend"><\/div>\s*<div id="controls">/);
    // Five checkboxes, every one of them on by default.
    for (const id of ["opt-intra", "opt-cross", "opt-trunks", "opt-arrows", "opt-labels"]) {
      assert.match(html, new RegExp(`<input type="checkbox" id="${id}" checked>`));
    }
    assert.match(html, /id="opt-intra" checked>intra-bundle</);
    assert.match(html, /id="opt-cross" checked>cross-bundle</);
    assert.match(html, /id="opt-trunks" checked>trunks</);
    assert.match(html, /id="opt-arrows" checked>arrows</);
    assert.match(html, /id="opt-labels" checked>labels</);
    // The opacity slider's range and default: it sets the quiet base alpha
    // directly, so the default is the quiet 0.16 and the top of the range
    // stops short of full opacity.
    assert.match(html, /cross-bundle opacity/);
    assert.match(
      html,
      /<input type="range" id="opt-cross-alpha" min="0\.02" max="0\.9" step="0\.02" value="0\.16">/,
    );
    // A switched-off layer is skipped entirely rather than drawn faintly.
    assert.match(html, /if \(!\(e\.cross \? optCross : optIntra\)\.checked\) return null;/);
    assert.match(html, /const style = edgeStyle\(e\);\s*if \(!style\) continue;/);
    // The slider still composes with the legend-focus / selection / search
    // fade rather than replacing it.
    assert.match(html, /alpha: base \* a,/);
    // Arrowheads are off below 1:1 regardless of the toggle; labels keep the
    // existing zoom threshold on top of theirs.
    assert.match(html, /const arrows = optArrows\.checked && view\.k >= 1;/);
    assert.match(html, /if \(optLabels\.checked && view\.k > 1\.4\) \{/);
    // Edges still draw strictly beneath the nodes.
    assert.ok(html.indexOf("const style = edgeStyle(e);") < html.indexOf("for (const n of nodes) {\n      ctx.globalAlpha = fade(n);"));
    // A long legend scrolls on its own so the controls stay reachable — but
    // only vertically; a long community name is clipped, not scrolled.
    assert.match(html, /#legend \{ max-height: 40vh; overflow-y: auto; overflow-x: hidden; \}/);
    assert.match(html, /toggle layers in the panel/);
  });

  it("brings back the cross-bundle edges of the hovered or selected node", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Hover counts alongside selection for edge emphasis.
    assert.match(
      html,
      /return e\.cross && \(e\.source === hovered \|\| e\.target === hovered \|\|\s*e\.source === selected \|\| e\.target === selected\);/,
    );
    // Bright gold, near-opaque, and wider than the quiet pass.
    assert.match(html, /ctx\.globalAlpha = 0\.95;\s*ctx\.strokeStyle = "#f2b705";\s*ctx\.lineWidth = 1\.8 \/ view\.k;/);
    // Skipped entirely when the cross-bundle layer is off or nothing is
    // hovered or selected.
    assert.match(html, /if \(optCross\.checked && \(hovered \|\| selected\)\) \{/);
    // Drawn after the quiet edge pass but before the nodes.
    const quiet = html.indexOf("const style = edgeStyle(e);");
    const loud = html.indexOf("if (!emphasized(e)) continue;");
    const nodePass = html.indexOf("for (const n of nodes) {\n      ctx.globalAlpha = fade(n);");
    assert.ok(quiet < loud && loud < nodePass);
  });

  it("marks nodes with outside links with a gold rim tick sized by cross-degree", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Cross-degree is counted where degree is counted.
    assert.match(html, /degree: 0, crossDegree: 0 \}/);
    assert.match(html, /if \(cross\) \{ source\.crossDegree \+= 1; target\.crossDegree \+= 1; \}/);
    // Drawn only for nodes with outside links, and only while the layer is on.
    assert.match(html, /if \(n\.crossDegree > 0 && optCross\.checked\) \{/);
    // Swept by cross-degree, capped short of a full ring.
    assert.match(html, /const sweep = Math\.min\(0\.4 \+ 0\.5 \* Math\.sqrt\(n\.crossDegree\), 2\.4\);/);
    // Offset and weight are world units like the radius, not screen units, so
    // the tick shrinks with the node at overview scale.
    assert.match(html, /ctx\.lineWidth = Math\.max\(1\.4, 0\.3 \* r\);/);
    assert.match(html, /ctx\.arc\(n\.x, n\.y, r \+ 0\.5, -Math\.PI \/ 2 - sweep \/ 2, -Math\.PI \/ 2 \+ sweep \/ 2\);/);
    // It inherits the node's fade alpha rather than setting its own.
    const tick = html.indexOf("if (n.crossDegree > 0 && optCross.checked) {");
    assert.equal(html.slice(tick, html.indexOf("}", tick)).includes("globalAlpha"), false);
  });

  it("groups cross-bundle edges into one trunk per community pair", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Grouped once at startup, by unordered community pair, counting members.
    assert.match(html, /const a = ca < cb \? ca : cb;\s*const b = ca < cb \? cb : ca;/);
    assert.match(html, /pair = \{ a, b, count: 0 \}/);
    assert.match(html, /pair\.count \+= 1;/);
    // A cross-bundle edge whose endpoints share a community has no pair.
    assert.match(html, /if \(ca === cb\) continue;/);
    // Centroids are recomputed per frame rather than read back out of step(),
    // which stops running once alpha decays.
    assert.match(html, /function centroids\(\) \{/);
    assert.match(html, /for \(const c of acc\.values\(\)\) \{ c\.x \/= c\.count; c\.y \/= c\.count; \}/);
    // Two centroids on the same point draw nothing.
    assert.match(html, /if \(dx \* dx \+ dy \* dy < 1\) continue;/);
  });

  it("cross-fades individual cross-bundle edges against the trunks on zoom", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // One threshold shared by both halves: 0 below k = 0.85, 1 at k = 1.35 —
    // unless trunks are switched off, which pins it to 1 at every zoom.
    assert.match(
      html,
      /const detail = optTrunks\.checked\s*\? Math\.min\(Math\.max\(\(view\.k - 0\.85\) \/ 0\.5, 0\), 1\)\s*: 1;/,
    );
    // Individual cross edges scale by detail and are skipped outright at zero.
    assert.match(html, /if \(e\.cross && detail === 0\) continue;/);
    assert.match(html, /ctx\.globalAlpha = e\.cross \? style\.alpha \* detail : style\.alpha;/);
    // Trunks scale by the complement. The tuned constant is free to move, the
    // shape of the expression is not.
    assert.match(html, /const alpha = [\d.]+ \* \(1 - detail\) \* pairFade\(p\);/);
    // Gold, round-capped, width by sqrt(count) in screen space.
    assert.match(html, /ctx\.strokeStyle = "#f2b705";\s*ctx\.lineCap = "round";/);
    assert.match(html, /ctx\.lineWidth = \([\d.]+ \+ [\d.]+ \* Math\.sqrt\(p\.count\)\) \/ view\.k;/);
    assert.match(html, /ctx\.lineCap = "butt";/);
    // The trunk layer rides the cross-bundle checkbox and vanishes once the
    // individual edges are at full strength.
    assert.match(html, /if \(optCross\.checked && detail < 1 && crossPairs\.length\) \{/);
    // Legend focus uses the same either-endpoint rule as the edges.
    assert.match(html, /focused !== null && p\.a !== focused && p\.b !== focused \? 0\.12 : 1/);
    // Trunks sit under the nodes, and the hover/select emphasis pass is not
    // gated behind the zoom so drill-down survives at overview scale.
    const trunks = html.indexOf("if (optCross.checked && detail < 1 && crossPairs.length) {");
    const loud = html.indexOf("if (optCross.checked && (hovered || selected)) {");
    const nodePass = html.indexOf("for (const n of nodes) {\n      ctx.globalAlpha = fade(n);");
    assert.ok(trunks < loud && loud < nodePass);
    assert.doesNotMatch(html, /if \(optCross\.checked && \(hovered \|\| selected\) && detail/);
  });

  it("explains the rim tick and every edge color in a key below the layers", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // The key sits below the layer controls, not above them.
    assert.ok(html.indexOf('<div id="controls">') < html.indexOf('<div id="key">'));
    assert.match(html, /<div id="key">\s*<h2>Key<\/h2>/);
    // Every swatch color is one the renderer actually draws with.
    assert.match(html, /class="key-line" style="background:#7d8590"/);
    assert.match(html, /class="key-line" style="background:#8a7a45"/);
    assert.match(html, /class="key-line" style="background:#f2b705"/);
    assert.match(html, /\.key-trunk \{[^}]*background: #f2b705;/);
    // The rim tick swatch is a gold cap on a round node, like the canvas arc.
    assert.match(html, /\.key-node \{[^}]*border-radius: 50%;[^}]*box-shadow: inset 0 3px 0 #f2b705;/);
    for (const label of [
      "has links outside its bundle",
      "link inside a bundle",
      "link between bundles",
      "links of the hovered or selected node",
      "one bundle pair, zoomed out",
    ]) {
      assert.ok(html.includes(label), label);
    }
  });

  it("lets the trunks be switched off without losing the cross-bundle layer", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Its own checkbox, independent of the cross-bundle layer it aggregates.
    assert.match(html, /id="opt-trunks" checked>trunks</);
    assert.match(html, /const optTrunks = document\.getElementById\("opt-trunks"\);/);
    // Off pins detail to 1, which is what restores the individual lines at
    // every zoom — and the trunk pass, gated on detail < 1, stops running.
    assert.match(html, /: 1;/);
    assert.match(html, /if \(optCross\.checked && detail < 1 && crossPairs\.length\) \{/);
    // The rim ticks and the hover emphasis answer to opt-cross, not opt-trunks,
    // so hiding the aggregate never hides a node's own outside links.
    assert.doesNotMatch(html, /optTrunks\.checked && \(hovered \|\| selected\)/);
    assert.doesNotMatch(html, /n\.crossDegree > 0 && optTrunks\.checked/);
  });

  it("labels each trunk with its edge count on a dark disc", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // The count is drawn at the trunk midpoint, at a fixed screen size.
    assert.match(html, /labels\.push\(\{ x: \(a\.x \+ b\.x\) \/ 2, y: \(a\.y \+ b\.y\) \/ 2, text: String\(p\.count\), alpha \}\);/);
    assert.match(html, /ctx\.font = 11 \/ view\.k \+ "px system-ui, sans-serif";/);
    assert.match(html, /ctx\.textBaseline = "middle";/);
    // On its own disc in the page background color, so it stays legible where
    // the midpoint lands over a cluster.
    assert.match(html, /ctx\.fillStyle = "#11151c";\s*ctx\.beginPath\(\);\s*ctx\.arc\(l\.x, l\.y, \(7 \+ 3 \* \(l\.text\.length - 1\)\) \/ view\.k, 0, 2 \* Math\.PI\);/);
    assert.match(html, /ctx\.fillText\(l\.text, l\.x, l\.y\);/);
    // The baseline is put back so the node label pass is unaffected.
    assert.match(html, /ctx\.textBaseline = "alphabetic";/);
    assert.match(html, /zoom out for bundle-pair trunks/);
  });

  it("draws no trunks for a graph with a single community", () => {
    const single: ConceptGraph = {
      nodes: [node({ id: "a" }), node({ id: "b" })],
      edges: [{ from: "a", to: "b", kind: "cross-bundle" }],
      warnings: [],
    };
    const html = exportGraphHtml(single, { communityOf: communityAssigner("bundle") });
    const data = embeddedGraphData(html);
    // Both endpoints land in one community, so the pair loop skips the only
    // cross edge and the trunk pass has nothing to iterate.
    assert.deepEqual(new Set(data.nodes.map((n) => n.community)), new Set(["brain"]));
    assert.match(html, /if \(ca === cb\) continue;/);
  });

  it("includes a search box that filters case-insensitively on id, title, and tags", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // The input lives in the panel, above the legend.
    assert.match(html, /<input type="search" id="search" placeholder="Filter concepts[^"]*"[^>]*>\s*<div id="legend">/);
    // Case-insensitive substring match against title, id, and tags.
    assert.match(html, /\(n\.title \|\| ""\)\.toLowerCase\(\)\.includes\(query\)/);
    assert.match(html, /n\.id\.toLowerCase\(\)\.includes\(query\)/);
    assert.match(html, /\(n\.tags \|\| \[\]\)\.some\(\(t\) => t\.toLowerCase\(\)\.includes\(query\)\)/);
    // Search composes with legend dimming and selection through fade().
    assert.match(html, /if \(query && !matchesQuery\(n\)\) a = Math\.min\(a, 0\.13\);/);
    // The hint mentions search.
    assert.match(html, /<div id="hint">[^<]*search[^<]*<\/div>/);
  });

  it("ships a self-contained document with no external resources", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    assert.doesNotMatch(html, /\bsrc=|\bhref=|https?:\/\/cdn/i);
    assert.match(html, /getContext\("2d"\)/);
  });
});
