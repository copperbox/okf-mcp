import type { Concept, LoadedBundle } from "./types.js";

export interface SearchFilters {
  /** Case-insensitive text query over title, description, tags, ID, and body. */
  query?: string;
  /** Match any of these `type` values (case-insensitive). */
  types?: string[];
  /** Concept must carry at least one of these tags. */
  tagsAny?: string[];
  /** Concept must carry all of these tags. */
  tagsAll?: string[];
  /** Concept ID prefix, e.g. `tables/`. */
  pathPrefix?: string;
  /** Only concepts that link to this concept ID. */
  linkedTo?: string;
  /** Only concepts linked from this concept ID. */
  linkedFrom?: string;
  /** Only concepts with no resolved links in either direction. */
  orphanOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  bundle: string;
  id: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

function lower(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.toLowerCase()));
}

function score(concept: Concept, query: string): number {
  const q = query.toLowerCase();
  const { title, description, tags } = concept.frontmatter;
  let total = 0;
  if (concept.id.toLowerCase().includes(q)) total += 5;
  if (title?.toLowerCase().includes(q)) total += 5;
  if (description?.toLowerCase().includes(q)) total += 3;
  if ((tags ?? []).some((tag) => tag.toLowerCase().includes(q))) total += 3;
  if (concept.body.toLowerCase().includes(q)) total += 1;
  return total;
}

/**
 * Structured search over the loaded bundles. Plain filtering plus a small
 * substring relevance score — no embeddings, no external index.
 */
export function searchConcepts(
  bundles: LoadedBundle[],
  filters: SearchFilters = {},
): SearchResult {
  const types = lower(filters.types);
  const tagsAny = lower(filters.tagsAny);
  const tagsAll = lower(filters.tagsAll);

  const hits: SearchHit[] = [];
  for (const bundle of bundles) {
    const linkedFrom =
      filters.linkedFrom !== undefined
        ? new Set(
            (bundle.concepts.get(filters.linkedFrom)?.links ?? [])
              .map((l) => l.resolvedId)
              .filter((id): id is string => id !== undefined),
          )
        : null;
    const linkedIds = filters.orphanOnly ? collectLinkedIds(bundle) : null;

    for (const concept of bundle.concepts.values()) {
      const tags = lower(concept.frontmatter.tags);
      if (types.size > 0 && !types.has(concept.frontmatter.type.toLowerCase())) continue;
      if (tagsAny.size > 0 && ![...tagsAny].some((t) => tags.has(t))) continue;
      if (tagsAll.size > 0 && ![...tagsAll].every((t) => tags.has(t))) continue;
      if (filters.pathPrefix !== undefined && !concept.id.startsWith(filters.pathPrefix)) continue;
      if (
        filters.linkedTo !== undefined &&
        !concept.links.some((l) => l.resolvedId === filters.linkedTo)
      )
        continue;
      if (linkedFrom !== null && !linkedFrom.has(concept.id)) continue;
      if (linkedIds !== null && linkedIds.has(concept.id)) continue;

      let relevance = 0;
      if (filters.query !== undefined && filters.query.trim() !== "") {
        relevance = score(concept, filters.query.trim());
        if (relevance === 0) continue;
      }
      hits.push({
        bundle: bundle.id,
        id: concept.id,
        type: concept.frontmatter.type,
        ...(concept.frontmatter.title !== undefined && { title: concept.frontmatter.title }),
        ...(concept.frontmatter.description !== undefined && {
          description: concept.frontmatter.description,
        }),
        ...(concept.frontmatter.tags !== undefined && { tags: concept.frontmatter.tags }),
        score: relevance,
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  return { hits: hits.slice(offset, offset + limit), total: hits.length };
}

function collectLinkedIds(bundle: LoadedBundle): Set<string> {
  const linked = new Set<string>();
  for (const concept of bundle.concepts.values()) {
    for (const link of concept.links) {
      if (link.resolvedId !== undefined) {
        linked.add(concept.id);
        linked.add(link.resolvedId);
      }
    }
  }
  return linked;
}
