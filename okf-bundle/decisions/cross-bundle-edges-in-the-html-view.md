---
type: Design Decision
title: Cross-bundle edges in the html view are quiet, aggregated, and on demand
description: How the graph html export renders cross-bundle links at overview
  versus reading zoom, and why the loudest element stopped being the most
  numerous one.
tags:
  - graph
  - links
  - bundles
  - cli
status: stable
generated:
  by: okf-mcp/1.4.0
  at: 2026-08-25T17:12:46.783Z
---

A large colocated export is mostly cross-bundle edges. The original renderer gave
that layer the highest contrast on the canvas — bright gold, alpha 0.9, dashed,
arrowheaded, and `1.6 / view.k` wide — so zooming out *added* ink per screen
pixel while node radii shrank with the world. At overview scale the mesh hid the
clusters it was supposed to connect.

The fix is three cooperating layers in `src/visualize.ts`, not one tuning knob.

## Quiet by default

Cross-bundle edges are now the quietest layer: desaturated gold, `1.1 / view.k`,
base alpha off the panel's opacity slider (default 0.16), and **no dash** — a 5px
dash is invisible at overview scale and only adds ink. Nothing in the document
calls `setLineDash` any more.

The signal that fade would otherwise destroy moves to the nodes: a gold arc on
the rim of every node with `crossDegree > 0`, sized by that degree and drawn in
world units so it never dominates. You can still see *which concepts reach
outside their bundle* without drawing the lines that say where.

## Loud on demand

Cross-bundle edges incident to the hovered or selected node get a second pass at
full emphasis (bright gold, alpha 0.95, `1.8 / view.k`) drawn above the quiet
layer and below the nodes. This pass is deliberately **not** gated on zoom:
selecting a node at overview scale is exactly when drill-down matters most.

## Aggregated at overview scale

One `detail` scalar, `clamp((view.k - 0.85) / 0.5, 0, 1)`, cross-fades two
representations of the same layer. Individual edges scale by `detail` and are
skipped outright at zero; the complement drives one *trunk* per community pair,
drawn between the two centroids with width by `sqrt(count)` and the count on a
dark disc at the midpoint. The overview then answers the question people
actually zoom out to ask: which bundles talk to each other, and how much.

Two constraints that are easy to get wrong:

- Centroids must be recomputed in `draw()`. The simulation's own centroid map
  goes stale as soon as alpha decays or a node is dragged.
- The width ramp has to stay shallow. Communities that all link to each other
  put `n*(n-1)/2` trunks through a handful of nearby centroids, which recreates
  the original overlay problem in bolder form if trunks are drawn fat.

The trunk layer answers the `cross-bundle` checkbox but not the opacity slider:
that value is a base alpha tuned for hairlines, and applying 0.16 to a trunk
several pixels wide would erase the layer exactly where nothing else carries the
cross-bundle story.

## Escape hatches

A LAYERS block in the panel toggles `intra-bundle`, `cross-bundle`, `arrows`, and
`labels` independently and sets the cross-bundle opacity. Two fixes ride along
with it: edges always render beneath nodes, and arrowheads are suppressed below
`view.k < 1`, where a filled triangle reads as noise rather than direction.

Related: [Cross-bundle edges are derived, not written](./derived-cross-bundle-edges.md),
[CLI surface](../architecture/cli.md).
