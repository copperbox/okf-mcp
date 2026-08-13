import { deriveTitle, sectionAt } from "./parser.js";
import type { Concept, LoadedBundle } from "./types.js";

export interface SearchFilters {
  /**
   * Case-insensitive text query over title, description, resource, tags, ID,
   * and body. Split on whitespace into keywords, each matched independently;
   * concepts matching every keyword are preferred, with a bonus when the whole
   * phrase appears verbatim.
   */
  query?: string;
  /** Match any of these `type` values (case-insensitive). */
  types?: string[];
  /** Exact frontmatter `resource` URI, for asset-URI → concept lookup. */
  resource?: string;
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
export type MatchField = "id" | "title" | "resource" | "description" | "tags" | "body";

export interface SearchHit {
  bundle: string;
  id: string;
  type: string;
  /** Frontmatter title, or a display title derived from the filename (spec §4.1). */
  title: string;
  /** True when `title` was derived — the concept has no authored frontmatter title. */
  titleDerived?: boolean;
  description?: string;
  /** Frontmatter `resource` URI: the asset this concept describes (spec §4.1). */
  resource?: string;
  tags?: string[];
  score: number;
  /** Which fields the query matched. Present only when a query was given. */
  matchedIn?: MatchField[];
  /** Body context around the first match. Present only when the body matched. */
  snippet?: string;
  /** Heading of the section enclosing the first body match, when inside one. */
  section?: string;
}

export interface TagHint {
  tag: string;
  count: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  /**
   * Present (as "any") only when no concept matched every query keyword and
   * the hits instead match at least one keyword each.
   */
  termMatching?: "any";
  /**
   * Present only when a text query matched nothing: existing tags related to
   * the query keywords, with usage counts, as a next step via tagsAny.
   */
  tagHints?: TagHint[];
}

function lower(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).map((v) => v.toLowerCase()));
}

const FIELD_ORDER: MatchField[] = ["id", "title", "resource", "description", "tags", "body"];

/** Points for one keyword (already lowercased) against one concept's fields. */
function scoreTerm(concept: Concept, term: string): { points: number; fields: MatchField[] } {
  const { title, description, resource, tags } = concept.frontmatter;
  const fields: MatchField[] = [];
  let points = 0;
  const hit = (p: number, field: MatchField) => {
    points += p;
    fields.push(field);
  };
  if (concept.id.toLowerCase().includes(term)) hit(5, "id");
  if (title?.toLowerCase().includes(term)) hit(5, "title");
  if (resource?.toLowerCase().includes(term)) hit(4, "resource");
  if (description?.toLowerCase().includes(term)) hit(3, "description");
  const tagList = tags ?? [];
  if (tagList.some((tag) => tag.toLowerCase() === term)) hit(4, "tags");
  else if (tagList.some((tag) => tag.toLowerCase().includes(term))) hit(3, "tags");
  if (concept.body.toLowerCase().includes(term)) hit(1, "body");
  return { points, fields };
}

interface ConceptScore {
  total: number;
  matchedIn: MatchField[];
  matchedTerms: string[];
}

/**
 * Score a concept against the query keywords. With `requireAll`, every
 * keyword must match at least one field; otherwise one matching keyword is
 * enough. Multi-keyword queries earn a bonus when the whole phrase appears
 * verbatim, so exact-phrase hits outrank scattered keyword hits.
 */
function score(
  concept: Concept,
  terms: string[],
  requireAll: boolean,
): ConceptScore | undefined {
  const fields = new Set<MatchField>();
  const matchedTerms: string[] = [];
  let total = 0;
  for (const term of terms) {
    const match = scoreTerm(concept, term);
    if (match.points === 0) {
      if (requireAll) return undefined;
      continue;
    }
    total += match.points;
    matchedTerms.push(term);
    for (const field of match.fields) fields.add(field);
  }
  if (matchedTerms.length === 0) return undefined;
  if (terms.length > 1) total += scoreTerm(concept, terms.join(" ")).points;
  return { total, matchedIn: FIELD_ORDER.filter((f) => fields.has(f)), matchedTerms };
}

const SNIPPET_MAX_LENGTH = 240;

/**
 * Whole lines of body context around the first match: the matched line, plus
 * the following line when the matched line alone gives little context. Long
 * lines are truncated to a window around the match without splitting
 * surrogate pairs; `…` marks truncation.
 */
function extractSnippet(body: string, query: string, idx: number): string {
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
 * Where to anchor the body snippet: the whole phrase when it appears
 * verbatim, otherwise the earliest occurrence of any matched keyword.
 */
function bodyAnchor(
  body: string,
  terms: string[],
  matchedTerms: string[],
): { index: number; match: string } | undefined {
  const bodyLower = body.toLowerCase();
  if (terms.length > 1) {
    const phrase = terms.join(" ");
    const idx = bodyLower.indexOf(phrase);
    if (idx !== -1) return { index: idx, match: phrase };
  }
  let best: { index: number; match: string } | undefined;
  for (const term of matchedTerms) {
    const idx = bodyLower.indexOf(term);
    if (idx !== -1 && (best === undefined || idx < best.index)) {
      best = { index: idx, match: term };
    }
  }
  return best;
}

const TAG_HINT_LIMIT = 10;

/**
 * Tags related to the query keywords (substring in either direction, so
 * "slacking" still surfaces the `slack` tag), with usage counts across the
 * concepts that passed the structural filters.
 */
function collectTagHints(concepts: Concept[], terms: string[]): TagHint[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const concept of concepts) {
    for (const tag of concept.frontmatter.tags ?? []) {
      const key = tag.toLowerCase();
      const entry = counts.get(key) ?? { tag, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.entries()]
    .filter(([key]) => terms.some((term) => key.includes(term) || term.includes(key)))
    .map(([, entry]) => entry)
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, TAG_HINT_LIMIT);
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
  const terms = query?.toLowerCase().split(/\s+/) ?? [];

  const candidates: { bundleId: string; concept: Concept }[] = [];
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
      if (filters.resource !== undefined && concept.frontmatter.resource !== filters.resource)
        continue;
      if (
        filters.linkedTo !== undefined &&
        !concept.links.some((l) => l.resolvedId === filters.linkedTo)
      )
        continue;
      if (linkedFrom !== null && !linkedFrom.has(concept.id)) continue;
      if (linkedIds !== null && linkedIds.has(concept.id)) continue;

      candidates.push({ bundleId: bundle.id, concept });
    }
  }

  const buildHits = (requireAll: boolean): { hit: SearchHit; matchedTermCount: number }[] => {
    const scored: { hit: SearchHit; matchedTermCount: number }[] = [];
    for (const { bundleId, concept } of candidates) {
      let relevance = 0;
      let matchedTermCount = 0;
      let matchedIn: MatchField[] | undefined;
      let snippet: string | undefined;
      let section: string | undefined;
      if (terms.length > 0) {
        const match = score(concept, terms, requireAll);
        if (match === undefined) continue;
        relevance = match.total;
        matchedTermCount = match.matchedTerms.length;
        matchedIn = match.matchedIn;
        if (matchedIn.includes("body")) {
          const anchor = bodyAnchor(concept.body, terms, match.matchedTerms);
          if (anchor !== undefined) {
            snippet = extractSnippet(concept.body, anchor.match, anchor.index);
            section = sectionAt(concept.body, anchor.index);
          }
        }
      }
      scored.push({
        matchedTermCount,
        hit: {
          bundle: bundleId,
          id: concept.id,
          type: concept.frontmatter.type,
          title: deriveTitle(concept),
          ...(concept.frontmatter.title === undefined && { titleDerived: true }),
          ...(concept.frontmatter.description !== undefined && {
            description: concept.frontmatter.description,
          }),
          ...(concept.frontmatter.resource !== undefined && {
            resource: concept.frontmatter.resource,
          }),
          ...(concept.frontmatter.tags !== undefined && { tags: concept.frontmatter.tags }),
          score: relevance,
          ...(matchedIn !== undefined && { matchedIn }),
          ...(snippet !== undefined && { snippet }),
          ...(section !== undefined && { section }),
        },
      });
    }
    return scored;
  };

  let scored = buildHits(true);
  let termMatching: "any" | undefined;
  if (scored.length === 0 && terms.length > 1) {
    scored = buildHits(false);
    if (scored.length > 0) termMatching = "any";
  }

  scored.sort(
    (a, b) =>
      b.matchedTermCount - a.matchedTermCount ||
      b.hit.score - a.hit.score ||
      a.hit.id.localeCompare(b.hit.id),
  );
  const hits = scored.map((s) => s.hit);
  const tagHints =
    terms.length > 0 && hits.length === 0
      ? collectTagHints(
          candidates.map((c) => c.concept),
          terms,
        )
      : [];
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  return {
    hits: hits.slice(offset, offset + limit),
    total: hits.length,
    ...(termMatching !== undefined && { termMatching }),
    ...(tagHints.length > 0 && { tagHints }),
  };
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
