/**
 * The derived reads over OKF v0.2's provenance, trust, lifecycle, and
 * computation families (spec §5, §7, §10).
 *
 * Everything here is *computed*, never stored. The spec is emphatic about this
 * for credibility (§5.1: signals, not scores) and trust tiers (§5.3: inferred
 * from `verified`, not written down), and the same discipline keeps staleness
 * a plain date comparison rather than a cached flag that goes wrong.
 *
 * This module is also the single home for the two v0.1 fallbacks §13.1
 * blesses — `timestamp` standing in for `generated.at`, and a body
 * `# Citations` list standing in for `sources`. Callers ask for provenance and
 * get it; whether the document is v0.1 or v0.2 shaped is this module's problem.
 */

import { extractCitations } from "./parser.js";
import type {
  Actor,
  Concept,
  ConceptFrontmatter,
  ConceptStatus,
  GeneratedRecord,
  SourceEntry,
  TrustTier,
  UsageWindow,
  VerifiedRecord,
} from "./types.js";
import { ATTESTED_COMPUTATION, CONCEPT_STATUSES } from "./types.js";

/** The producer half of this server's own actor id (spec §7). */
export const ACTOR_PRODUCER = "okf-mcp";

/** This server's default actor: `okf-mcp/<version>` (spec §7 `<producer>/<version>`). */
export function defaultActor(packageVersion: string): Actor {
  return `${ACTOR_PRODUCER}/${packageVersion}`;
}

/** How an actor string classifies under the §7 convention. */
export type ActorKind = "human" | "process" | "agent";

/**
 * Classify an actor (spec §7). `human:` and `process:` are explicit prefixes;
 * `<producer>/<version>` is the agent-or-tool form. Undefined when the value
 * matches none of the three — reported by the validator, never rejected.
 */
export function actorKind(actor: unknown): ActorKind | undefined {
  if (typeof actor !== "string" || actor.trim() === "") return undefined;
  if (actor.startsWith("human:")) return actor.length > 6 ? "human" : undefined;
  if (actor.startsWith("process:")) return actor.length > 8 ? "process" : undefined;
  // `<producer>/<version>`: both halves non-empty, exactly one separator.
  const parts = actor.split("/");
  if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") return "agent";
  return undefined;
}

/** The verification events on a concept — always a list (spec §5.2, §11). */
export function verifications(frontmatter: ConceptFrontmatter): VerifiedRecord[] {
  const verified = frontmatter.verified;
  if (!Array.isArray(verified)) return [];
  return verified.filter(
    (entry): entry is VerifiedRecord => entry !== null && typeof entry === "object",
  );
}

/**
 * Derive the trust tier from `verified` (spec §5.3), lowest to highest:
 * no `verified` is unverified, verification by non-`human:` actors only is
 * machine-confirmed, and any `human:<id>` verifier makes it human-reviewed.
 */
export function trustTier(frontmatter: ConceptFrontmatter): TrustTier {
  const events = verifications(frontmatter);
  if (events.length === 0) return "unverified";
  return events.some((event) => actorKind(event.by) === "human")
    ? "human-reviewed"
    : "machine-confirmed";
}

/** The most recent `verified[].at`, when any entry carries one (spec §5.2). */
export function lastVerifiedAt(frontmatter: ConceptFrontmatter): string | undefined {
  const stamps = verifications(frontmatter)
    .map((event) => event.at)
    .filter((at): at is string => typeof at === "string")
    .sort();
  return stamps[stamps.length - 1];
}

/** The `generated` record, when the document carries a well-formed one (§5.2). */
export function generated(
  frontmatter: ConceptFrontmatter,
): GeneratedRecord | undefined {
  const record = frontmatter.generated;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  return record as GeneratedRecord;
}

/**
 * When the content last meaningfully changed: `generated.at` (§5.2), falling
 * back to a v0.1 `timestamp` (§13.1). The one place the fallback is spelled out.
 */
export function generatedAt(frontmatter: ConceptFrontmatter): string | undefined {
  const at = generated(frontmatter)?.at;
  if (typeof at === "string") return at;
  return typeof frontmatter.timestamp === "string" ? frontmatter.timestamp : undefined;
}

/** Who produced the current content (spec §5.2). Absent on v0.1 documents. */
export function generatedBy(frontmatter: ConceptFrontmatter): Actor | undefined {
  const by = generated(frontmatter)?.by;
  return typeof by === "string" ? by : undefined;
}

/** Lifecycle status, defaulting to `stable` when absent (spec §5.4). */
export function conceptStatus(frontmatter: ConceptFrontmatter): ConceptStatus {
  const status = frontmatter.status;
  return typeof status === "string" &&
    (CONCEPT_STATUSES as readonly string[]).includes(status)
    ? (status as ConceptStatus)
    : "stable";
}

/** Today as `YYYY-MM-DD`, the granularity `stale_after` compares at (§5.5). */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether a concept is past its `stale_after` (spec §5.5): stale when
 * `today >= stale_after`. A plain lexicographic date comparison, which is
 * exactly why the spec chose an absolute date over a relative TTL. Documents
 * without the key are never stale.
 */
export function isStale(frontmatter: ConceptFrontmatter, on = today()): boolean {
  const after = frontmatter.stale_after;
  if (typeof after !== "string" || after === "") return false;
  return on >= after;
}

/** True for a concept carrying the §10 computation contract. */
export function isAttestedComputation(frontmatter: ConceptFrontmatter): boolean {
  return frontmatter.type.trim().toLowerCase() === ATTESTED_COMPUTATION.toLowerCase();
}

/** The frontmatter-level `usage_window`, or an entry's own override (§5.1). */
export function usageWindowFor(
  frontmatter: ConceptFrontmatter,
  entry: SourceEntry,
): UsageWindow | undefined {
  const own = entry.usage_window;
  if (own !== null && typeof own === "object") return own as UsageWindow;
  const shared = frontmatter.usage_window;
  if (shared !== null && typeof shared === "object") return shared as UsageWindow;
  return undefined;
}

/** A concept's `sources`, with where they were read from (see conceptSources). */
export interface ResolvedSources {
  sources: SourceEntry[];
  /**
   * "frontmatter" for a v0.2 `sources` list; "citations" when the entries were
   * synthesized from a legacy `# Citations` body list; "none" when neither.
   */
  origin: "frontmatter" | "citations" | "none";
}

/**
 * A concept's provenance entries (spec §5.1), falling back to a legacy
 * `# Citations` body list for v0.1 documents (§13.1). Frontmatter wins
 * outright when present — a document carrying both is mid-migration, and the
 * validator warns about it rather than merging two sources of truth here.
 *
 * Synthesized entries carry a slugged `id` so callers can treat them like real
 * ones, but `origin` tells an honest caller (the `get_sources` tool, the
 * migration fixer) that they were derived rather than written.
 */
export function conceptSources(concept: Concept): ResolvedSources {
  const declared = concept.frontmatter.sources;
  if (Array.isArray(declared)) {
    const sources = declared.filter(
      (entry): entry is SourceEntry =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry),
    );
    return { sources, origin: "frontmatter" };
  }
  const { citations } = extractCitations(concept.body, concept.path, () => false);
  if (citations.length === 0) return { sources: [], origin: "none" };
  const used = new Set<string>();
  const sources = citations.map((citation) => ({
    id: uniqueSourceId(citation.text || citation.target, used),
    resource: citation.target,
    ...(citation.text !== "" && { title: citation.text }),
  }));
  return { sources, origin: "citations" };
}

// A footnote reference or definition label: `[^label]`, `[^label]:`.
const FOOTNOTE = /\[\^([^\]\s]+)\]/g;

/**
 * The footnote labels a body uses, split into definitions (`[^id]: prose`) and
 * references (`[^id]` inline). Per §5.1 a label is the join key into
 * `sources[].id`, so the validator checks both directions against it.
 */
export function footnoteLabels(body: string): {
  defined: Set<string>;
  referenced: Set<string>;
} {
  const defined = new Set<string>();
  const referenced = new Set<string>();
  for (const line of body.split("\n")) {
    const definition = /^ {0,3}\[\^([^\]\s]+)\]:/.exec(line);
    if (definition !== null) {
      defined.add(definition[1]!);
      continue;
    }
    for (const match of line.matchAll(FOOTNOTE)) referenced.add(match[1]!);
  }
  return { defined, referenced };
}

/**
 * Slug for a synthesized `sources[].id`. Keyed rather than positional because
 * §5.1 is explicit that agents reorder these lists constantly and a positional
 * index misattributes silently the moment they do.
 */
export function slugifySourceId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-");
  return slug === "" ? "source" : slug;
}

/** Slug a label into an id not already in `used`, recording the result. */
export function uniqueSourceId(label: string, used: Set<string>): string {
  const base = slugifySourceId(label);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
