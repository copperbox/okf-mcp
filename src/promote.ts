/**
 * Promotion of a concept across bundles: knowledge that started out
 * project-scoped and turned out to be org-wide moves into the shared bundle,
 * and a citation stub stays behind so the source bundle's graph remains
 * navigable. OKF §5 has no cross-bundle link syntax, so the stub redirects
 * via its `resource` URL and a §8 citation on the promoted concept's
 * canonical location — which the graph tools already resolve back into a
 * derived cross-bundle edge when the target bundle has a canonical URL.
 *
 * Between colocated siblings the citation is a relative on-disk link into
 * the sibling folder instead — even when the target has a canonical URL —
 * because the vault UX is the point of colocation: Obsidian resolves the
 * link natively, and the graph derives the same cross-bundle edge from it.
 * Publishing rewrites relative links to canonical URLs at pack time. The
 * stub's `resource` stays the canonical/okf URI (spec §4.1 wants a
 * parseable URI there).
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  assertSafeConceptPath,
  conceptsLinkingTo,
  removeEmptyDirectories,
  requireConcept,
  writeConcept,
} from "./authoring.js";
import { citationPrefix } from "./canonical.js";
import { conceptIdFromPath } from "./parser.js";
import { suggestConceptPath } from "./suggest.js";
import type { Concept, LoadedBundle } from "./types.js";
import { okfUri } from "./types.js";

export interface PromoteConceptOptions {
  /**
   * Explicit target-bundle-relative path ending in .md. Defaults to
   * suggest_concept_path-style placement in the target bundle, keeping the
   * original filename.
   */
  toPath?: string;
  /**
   * Leave a citation stub at the old path (the default). `false` deletes the
   * source copy outright, leaving the reported inbound links dangling.
   */
  stub?: boolean;
}

export interface PromoteConceptResult {
  /** Concept ID in the target bundle. */
  id: string;
  fromBundle: string;
  toBundle: string;
  /** Old source-bundle-relative path. */
  from: string;
  /** New target-bundle-relative path. */
  to: string;
  /** Frontmatter title of the promoted concept, when it had one. */
  title?: string;
  /**
   * What the stub cites: a document-relative `../<bundle>/<path>` link when
   * the bundles are colocated siblings, the canonical location otherwise.
   */
  citation: string;
  /** Source-bundle path of the citation stub, when one was written. */
  stubPath?: string;
  /**
   * Source-bundle concept IDs that linked to the promoted concept — now
   * resolving to the stub, or dangling when `stub: false`.
   */
  inboundLinks: string[];
  /** Source-bundle directories removed by the delete (`stub: false` only). */
  removedDirs: string[];
}

/**
 * Canonical location of a concept file inside a bundle: under the bundle's
 * canonical URL when it has one (the citationPrefix — GitHub canonicals cite
 * files by their blob URL), otherwise the okf:// resource URI, which still
 * names the bundle and path.
 */
export function canonicalConceptUrl(bundle: LoadedBundle, relPath: string): string {
  const prefixes = bundle.canonicalUrls;
  if (prefixes !== undefined && prefixes.length > 0) {
    return `${citationPrefix(prefixes)}/${relPath}`;
  }
  return okfUri(bundle.id, relPath);
}

/**
 * Document-relative path from a stub at `stubPath` in `source` to the
 * promoted copy at `toPath` in `target`, when the two bundles declare the
 * same colocated root — one `../` per stub directory level plus one to step
 * from the source bundle root into the shared root, then into the sibling
 * folder (folder name = bundle id). Undefined when the bundles are not
 * colocated siblings. Colocation is declared, never inferred from disk.
 */
function colocatedCitation(
  source: LoadedBundle,
  target: LoadedBundle,
  stubPath: string,
  toPath: string,
): string | undefined {
  if (source.colocatedRoot === undefined) return undefined;
  if (source.colocatedRoot !== target.colocatedRoot) return undefined;
  const dir = path.posix.dirname(stubPath);
  const ups = dir === "." ? 1 : dir.split("/").length + 1;
  return `${"../".repeat(ups)}${target.id}/${toPath}`;
}

/** Top suggested directory for the concept's type/tags, keeping its filename. */
function defaultTargetPath(target: LoadedBundle, concept: Concept): string {
  const { type, title, tags } = concept.frontmatter;
  const [top] = suggestConceptPath(target, {
    type,
    ...(title !== undefined && { title }),
    ...(tags !== undefined && { tags }),
  });
  const dir = path.posix.dirname(top!.path);
  const base = path.posix.basename(concept.path);
  return dir === "." ? base : `${dir}/${base}`;
}

/**
 * Move a concept from one bundle to another: write it into the target bundle
 * (refusing to overwrite), then replace the source copy with a citation stub
 * pointing at the promoted copy (relative link between colocated siblings,
 * canonical location otherwise) — or delete it outright with `stub: false`. The target is written first so a failure leaves the source
 * untouched. Does not log, reindex, or touch the in-memory indexes — the
 * caller handles both bundles' log.md/index.md and reloads afterwards.
 */
export async function promoteConcept(
  source: LoadedBundle,
  target: LoadedBundle,
  idOrPath: string,
  options: PromoteConceptOptions = {},
): Promise<PromoteConceptResult> {
  if (source.id === target.id) {
    throw new Error(`source and target bundle are the same: ${source.id}`);
  }
  const concept = requireConcept(source, idOrPath, "promoted");
  const toPath = assertSafeConceptPath(
    options.toPath ?? defaultTargetPath(target, concept),
  );
  const toId = conceptIdFromPath(toPath);
  if (target.concepts.has(toId)) {
    throw new Error(`concept already exists in bundle "${target.id}": ${toPath}`);
  }
  await writeConcept(target.root, toPath, concept.frontmatter, concept.body, {
    failIfExists: true,
  });

  const canonical = canonicalConceptUrl(target, toPath);
  const citation = colocatedCitation(source, target, concept.path, toPath) ?? canonical;
  const inboundLinks = conceptsLinkingTo(source, concept.id)
    .map((other) => other.id)
    .sort();
  const title = concept.frontmatter.title;

  let stubPath: string | undefined;
  let removedDirs: string[] = [];
  if (options.stub === false) {
    await fs.rm(path.join(source.root, concept.path));
    removedDirs = await removeEmptyDirectories(
      source.root,
      path.posix.dirname(concept.path),
    );
  } else {
    const label = title ?? concept.id;
    await writeConcept(
      source.root,
      concept.path,
      {
        type: concept.frontmatter.type,
        ...(title !== undefined && { title }),
        description: `Promoted to bundle "${target.id}"; this stub cites the canonical copy.`,
        resource: canonical,
      },
      `Promoted to [${label}](${citation}) in bundle \`${target.id}\`.\n\n# Citations\n\n[1] [${label}](${citation})\n`,
    );
    stubPath = concept.path;
  }

  const result: PromoteConceptResult = {
    id: toId,
    fromBundle: source.id,
    toBundle: target.id,
    from: concept.path,
    to: toPath,
    citation,
    inboundLinks,
    removedDirs,
  };
  if (title !== undefined) result.title = title;
  if (stubPath !== undefined) result.stubPath = stubPath;
  return result;
}
