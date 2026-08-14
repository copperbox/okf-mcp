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

  it("emphasizes cross-bundle edges and draws direction arrowheads", () => {
    const html = exportGraphHtml(graph, { communityOf: communityAssigner("type") });
    // Cross-bundle edges get the d3 reference treatment: bright gold instead
    // of the old muted amber, more opaque and wider than intra-bundle links,
    // keeping the screen-space-constant dash pattern.
    assert.match(html, /#f2b705/);
    assert.doesNotMatch(html, /#e0b45c/);
    assert.match(html, /\(e\.cross \? 0\.9 : 0\.55\) \* a/);
    assert.match(html, /\(e\.cross \? 1\.6 : 1\) \/ view\.k/);
    assert.match(html, /\[5 \/ view\.k, 4 \/ view\.k\]/);
    // Every edge ends in a filled triangle at the target, backed off by the
    // node radius so it is not buried under the circle, sized in screen
    // space, and sharing the edge's color and fade alpha.
    assert.match(html, /arrowhead/i);
    assert.match(html, /radius\(e\.target\)/);
    assert.match(html, /ctx\.closePath\(\);\s*ctx\.fill\(\);/);
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
