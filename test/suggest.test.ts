import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";

import { loadBundle } from "../src/bundle.js";
import { suggestConceptPath } from "../src/suggest.js";
import type { LoadedBundle } from "../src/types.js";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "acme");

describe("suggestConceptPath", () => {
  let bundle: LoadedBundle;
  before(async () => {
    bundle = await loadBundle({ id: "acme", root: FIXTURE });
  });

  it("suggests the directory where existing concepts of the type live", () => {
    const suggestions = suggestConceptPath(bundle, {
      type: "Playbook",
      title: "Schema drift runbook",
    });
    assert.equal(suggestions[0]?.path, "playbooks/schema-drift-runbook.md");
    assert.match(suggestions[0]?.reason ?? "", /1 of 1 existing `Playbook` concept/);
  });

  it("matches types case-insensitively", () => {
    const suggestions = suggestConceptPath(bundle, {
      type: "bigquery table",
      title: "Shipments",
    });
    assert.equal(suggestions[0]?.path, "tables/shipments.md");
    assert.match(suggestions[0]?.reason ?? "", /2 of 2/);
  });

  it("ranks tag overlap as a secondary signal", () => {
    const suggestions = suggestConceptPath(bundle, {
      type: "BigQuery Table",
      title: "Shipments",
      tags: ["sales"],
    });
    assert.deepEqual(
      suggestions.map((s) => s.path),
      ["tables/shipments.md", "datasets/shipments.md"],
    );
    assert.match(suggestions[1]?.reason ?? "", /tag/);
  });

  it("falls back to a slugged root-level path for a new type", () => {
    const suggestions = suggestConceptPath(bundle, {
      type: "Dashboard",
      title: "Revenue Overview!",
    });
    assert.deepEqual(
      suggestions.map((s) => s.path),
      ["revenue-overview.md"],
    );
    assert.match(suggestions[0]?.reason ?? "", /no existing concepts/i);
  });

  it("slugs the type when no title is given", () => {
    const suggestions = suggestConceptPath(bundle, { type: "Playbook" });
    assert.equal(suggestions[0]?.path, "playbooks/playbook.md");
  });

  it("dedupes against existing concepts with a numeric suffix", () => {
    const suggestions = suggestConceptPath(bundle, {
      type: "BigQuery Table",
      title: "Orders",
    });
    assert.equal(suggestions[0]?.path, "tables/orders-2.md");
  });

  it("skips reserved filenames when slugging", () => {
    const suggestions = suggestConceptPath(bundle, {
      type: "Dashboard",
      title: "Index",
    });
    assert.equal(suggestions[0]?.path, "index-2.md");
  });
});
