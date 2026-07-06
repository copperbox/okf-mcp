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

/** Fields the text query is matched against, in scoring order. */
export type MatchField = "id" | "title" | "description" | "tags" | "body";

export interface SearchHit {
  bundle: string;
  id: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  score: number;
  /** Which fields the query matched. Present only when a query was given. */
  matchedIn?: MatchField[];
  /** Body context around the first match. Present only when the body matched. */
  snippet?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
}

function lower(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.toLowerCase()));
}

function score(concept: Concept, query: string): { total: number; matchedIn: MatchField[] } {
  const q = query.toLowerCase();
  const { title, description, tags } = concept.frontmatter;
  const matchedIn: MatchField[] = [];
  let total = 0;
  const hit = (points: number, field: MatchField) => {
    total += points;
    matchedIn.push(field);
  };
  if (concept.id.toLowerCase().includes(q)) hit(5, "id");
  if (title?.toLowerCase().includes(q)) hit(5, "title");
  if (description?.toLowerCase().includes(q)) hit(3, "description");
  if ((tags ?? []).some((tag) => tag.toLowerCase().includes(q))) hit(3, "tags");
  if (concept.body.toLowerCase().includes(q)) hit(1, "body");
  return { total, matchedIn };
}

const SNIPPET_MAX_LENGTH = 240;

/**
 * Whole lines of body context around the first match: the matched line, plus
 * the following line when the matched line alone gives little context. Long
 * lines are truncated to a window around the match without splitting
 * surrogate pairs; `…` marks truncation.
 */
function extractSnippet(body: string, query: string): string | undefined {
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return undefined;
  const start = body.lastIndexOf("\n", idx) + 1;
  let end = body.indexOf("\n", idx + query.length);
  if (end === -1) end = body.length;
  if (end - start < SNIPPET_MAX_LENGTH / 2 && end < body.length) {
    const nextEnd = body.indexOf("\n", end + 1);
    const extendedEnd = nextEnd === -1 ? body.length : nextEnd;
    if (body.slice(end + 1, extendedEnd).trim() !== "") end = extendedEnd;
  }
  let from = start;
  let to = end;
  if (to - from > SNIPPET_MAX_LENGTH) {
    const lead = Math.floor((SNIPPET_MAX_LENGTH - query.length) / 2);
    from = Math.max(start, Math.min(idx - lead, end - SNIPPET_MAX_LENGTH));
    to = Math.min(end, from + SNIPPET_MAX_LENGTH);
    if (isLowSurrogate(body, from)) from += 1;
    if (isLowSurrogate(body, to)) to -= 1;
  }
  const prefix = from > start ? "…" : "";
  const suffix = to < end ? "…" : "";
  return prefix + body.slice(from, to).trim() + suffix;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
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
  const trimmedQuery = filters.query?.trim();
  const query = trimmedQuery === "" ? undefined : trimmedQuery;

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
      let matchedIn: MatchField[] | undefined;
      let snippet: string | undefined;
      if (query !== undefined) {
        const match = score(concept, query);
        if (match.total === 0) continue;
        relevance = match.total;
        matchedIn = match.matchedIn;
        if (matchedIn.includes("body")) snippet = extractSnippet(concept.body, query);
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
        ...(matchedIn !== undefined && { matchedIn }),
        ...(snippet !== undefined && { snippet }),
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
