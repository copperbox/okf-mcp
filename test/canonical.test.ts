import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalUrlPrefixes, resolveUrlToConcept } from "../src/canonical.js";

describe("canonicalUrlPrefixes", () => {
  it("expands a GitHub tree URL into tree, blob, and raw prefixes", () => {
    assert.deepEqual(
      canonicalUrlPrefixes("https://github.com/acme/kb/tree/main/okf/bundle"),
      [
        "https://github.com/acme/kb/tree/main/okf/bundle",
        "https://github.com/acme/kb/blob/main/okf/bundle",
        "https://raw.githubusercontent.com/acme/kb/main/okf/bundle",
      ],
    );
  });

  it("expands a repo-root tree URL without a trailing path segment", () => {
    assert.deepEqual(canonicalUrlPrefixes("https://github.com/acme/kb/tree/v1.0"), [
      "https://github.com/acme/kb/tree/v1.0",
      "https://github.com/acme/kb/blob/v1.0",
      "https://raw.githubusercontent.com/acme/kb/v1.0",
    ]);
  });

  it("keeps a non-GitHub URL as a single prefix, trimming trailing slashes", () => {
    assert.deepEqual(canonicalUrlPrefixes("https://kb.example.com/brain/"), [
      "https://kb.example.com/brain",
    ]);
  });
});

describe("resolveUrlToConcept", () => {
  const prefixes = canonicalUrlPrefixes("https://github.com/acme/kb/tree/main/okf");
  const has = (id: string) => id === "tables/orders";

  it("resolves a blob URL with .md to the concept ID", () => {
    assert.equal(
      resolveUrlToConcept(
        "https://github.com/acme/kb/blob/main/okf/tables/orders.md",
        prefixes,
        has,
      ),
      "tables/orders",
    );
  });

  it("resolves extensionless, fragment, and query variants", () => {
    for (const url of [
      "https://github.com/acme/kb/tree/main/okf/tables/orders",
      "https://github.com/acme/kb/blob/main/okf/tables/orders.md#schema",
      "https://raw.githubusercontent.com/acme/kb/main/okf/tables/orders.md?plain=1",
    ]) {
      assert.equal(resolveUrlToConcept(url, prefixes, has), "tables/orders", url);
    }
  });

  it("returns undefined for unknown concepts, other prefixes, and the bare prefix", () => {
    for (const url of [
      "https://github.com/acme/kb/blob/main/okf/tables/missing.md",
      "https://github.com/other/repo/blob/main/okf/tables/orders.md",
      "https://github.com/acme/kb/tree/main/okf",
      "https://github.com/acme/kb/tree/main/okf-other/tables/orders.md",
    ]) {
      assert.equal(resolveUrlToConcept(url, prefixes, has), undefined, url);
    }
  });

  it("decodes percent-encoded path segments", () => {
    assert.equal(
      resolveUrlToConcept(
        "https://github.com/acme/kb/blob/main/okf/tables%2Forders.md",
        prefixes,
        has,
      ),
      "tables/orders",
    );
  });
});
