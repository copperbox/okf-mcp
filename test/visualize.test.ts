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
