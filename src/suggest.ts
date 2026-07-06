import path from "node:path";

import { assertSafeConceptPath } from "./authoring.js";
import type { LoadedBundle } from "./types.js";

export interface SuggestPathInput {
  /** Frontmatter `type` the new concept will carry. */
  type: string;
  /** Planned title; slugged into the filename. Falls back to the type. */
  title?: string;
  /** Planned tags; overlap with existing concepts is a secondary signal. */
  tags?: string[];
}

export interface PathSuggestion {
  /** Safe bundle-relative path, e.g. `playbooks/schema-drift.md`. */
  path: string;
  /** Why this directory was suggested. */
  reason: string;
}

const MAX_SUGGESTIONS = 3;

/** Lowercase-hyphenate a string into a filename slug. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface DirStats {
  /** Concepts in this directory with the requested type. */
  typeCount: number;
  /** Concepts in this directory sharing at least one requested tag. */
  tagCount: number;
}

/**
 * Suggest where a new concept should live, ranked by where existing concepts
 * of the same type (and secondarily, with overlapping tags) already live.
 * Falls back to a slugged root-level path when nothing matches. Pure read
 * over the loaded bundle — nothing is written.
 */
export function suggestConceptPath(
  bundle: LoadedBundle,
  input: SuggestPathInput,
): PathSuggestion[] {
  const type = input.type.trim().toLowerCase();
  const tags = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()));

  const dirs = new Map<string, DirStats>();
  let typeTotal = 0;
  for (const concept of bundle.concepts.values()) {
    const parent = path.posix.dirname(concept.path);
    const dir = parent === "." ? "" : parent;
    let stats = dirs.get(dir);
    if (!stats) {
      stats = { typeCount: 0, tagCount: 0 };
      dirs.set(dir, stats);
    }
    if (concept.frontmatter.type.trim().toLowerCase() === type) {
      stats.typeCount += 1;
      typeTotal += 1;
    }
    if ((concept.frontmatter.tags ?? []).some((tag) => tags.has(tag.toLowerCase()))) {
      stats.tagCount += 1;
    }
  }

  const slug = slugify(input.title ?? input.type) || "concept";
  const ranked = [...dirs.entries()]
    .filter(([, stats]) => stats.typeCount > 0 || stats.tagCount > 0)
    .sort(
      ([dirA, a], [dirB, b]) =>
        b.typeCount - a.typeCount || b.tagCount - a.tagCount || dirA.localeCompare(dirB),
    )
    .slice(0, MAX_SUGGESTIONS);

  if (ranked.length === 0) {
    return [
      {
        path: dedupedPath(bundle, "", slug),
        reason: `no existing concepts share type \`${input.type}\`${tags.size > 0 ? " or the given tags" : ""}; defaulting to a new file at the bundle root`,
      },
    ];
  }

  return ranked.map(([dir, stats]) => ({
    path: dedupedPath(bundle, dir, slug),
    reason: describeStats(dir, stats, input.type, typeTotal),
  }));
}

function describeDir(dir: string): string {
  return dir === "" ? "the bundle root" : `\`${dir}/\``;
}

function describeStats(
  dir: string,
  stats: DirStats,
  type: string,
  typeTotal: number,
): string {
  const where = describeDir(dir);
  const parts: string[] = [];
  if (stats.typeCount > 0) {
    parts.push(
      `${stats.typeCount} of ${typeTotal} existing \`${type}\` concept${typeTotal === 1 ? "" : "s"} live${stats.typeCount === 1 ? "s" : ""} in ${where}`,
    );
  }
  if (stats.tagCount > 0) {
    parts.push(
      `${stats.tagCount} concept${stats.tagCount === 1 ? "" : "s"} with overlapping tags live${stats.tagCount === 1 ? "s" : ""} in ${where}`,
    );
  }
  return parts.join("; ");
}

/**
 * Join dir + slug into a safe `.md` path that does not collide with an
 * existing concept or a reserved filename, appending `-2`, `-3`, ... as
 * needed.
 */
function dedupedPath(bundle: LoadedBundle, dir: string, slug: string): string {
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? slug : `${slug}-${attempt}`;
    const relPath = dir === "" ? `${name}.md` : `${dir}/${name}.md`;
    try {
      assertSafeConceptPath(relPath);
    } catch {
      continue; // slug collides with a reserved filename (index/log)
    }
    if (!bundle.concepts.has(relPath.replace(/\.md$/, ""))) return relPath;
  }
}
