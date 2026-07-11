import path from "node:path";

import { splitFrontmatter } from "./frontmatter.js";
import type { Concept, ConceptFrontmatter, ConceptLink } from "./types.js";

export interface ParsedConceptDocument {
  frontmatter: ConceptFrontmatter | null;
  body: string;
  /** Links extracted from the body; `resolvedId` is filled in by the bundle loader. */
  links: ConceptLink[];
  /** Conformance problems with this document (spec §9). */
  problems: string[];
}

/** Strip the `.md` suffix to turn a bundle-relative path into a concept ID. */
export function conceptIdFromPath(relPath: string): string {
  return relPath.replace(/\.md$/i, "");
}

/**
 * Display title for a concept: the frontmatter `title` when present,
 * otherwise derived from the filename (spec §4.1 allows this) — `.md`
 * stripped, `-`/`_` as spaces, title-cased. Falls back to the concept ID
 * when the filename contains no words.
 */
export function deriveTitle(concept: Pick<Concept, "id" | "path" | "frontmatter">): string {
  if (concept.frontmatter.title !== undefined) return concept.frontmatter.title;
  const derived = path.posix
    .basename(concept.path)
    .replace(/\.md$/i, "")
    .split(/[-_\s]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return derived === "" ? concept.id : derived;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Markdown links, excluding images. Captures [text](target "optional title").
// The `d` flag records group offsets so link targets can be rewritten in place.
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(<?([^)<>\s]+)>?(?:\s+"[^"]*")?\)/dg;

/**
 * Extract cross-links from a concept body (spec §5). Targets beginning with
 * `/` are bundle-relative; other non-URI targets are relative to the
 * document's directory. Broken links are tolerated, never an error.
 * Each link records the offsets of its raw target within `body`, so callers
 * can rewrite targets by slicing without regenerating the document.
 */
export function extractLinks(body: string, conceptPath: string): ConceptLink[] {
  const links: ConceptLink[] = [];
  const fromDir = path.posix.dirname(conceptPath);
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const text = match[1] ?? "";
    const rawTarget = match[2] ?? "";
    const [targetStart, targetEnd] = match.indices![2]!;
    const base = { text, target: rawTarget, targetStart, targetEnd };
    if (rawTarget.startsWith("#")) {
      links.push({ ...base, kind: "anchor" });
      continue;
    }
    if (SCHEME.test(rawTarget) || rawTarget.startsWith("//")) {
      links.push({ ...base, kind: "external" });
      continue;
    }
    const withoutFragment = rawTarget.split("#")[0]!.split("?")[0]!;
    if (withoutFragment === "") {
      links.push({ ...base, kind: "anchor" });
      continue;
    }
    const joined = withoutFragment.startsWith("/")
      ? withoutFragment.slice(1)
      : path.posix.join(fromDir === "." ? "" : fromDir, withoutFragment);
    const normalized = path.posix.normalize(joined);
    if (normalized.startsWith("..")) {
      links.push({ ...base, kind: "outside", path: normalized });
      continue;
    }
    links.push({ ...base, kind: "concept", path: normalized });
  }
  return links;
}

/** One heading-delimited slice of a concept body (spec §4.2 conventional sections). */
export interface BodySection {
  /** Heading text without the leading #s or an ATX closing sequence. */
  heading: string;
  /** Heading level, 1–6. */
  level: number;
  /** Section text (trimmed); for splitSections, up to the next heading of any level. */
  content: string;
}

// ATX heading: 1–6 #s followed by a space (or nothing), up to 3 spaces indent.
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
// Opening or closing code fence: ``` or ~~~ of length >= 3, up to 3 spaces indent.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface SectionBounds {
  heading: string;
  level: number;
  /** Offset of the heading line's first character within the body. */
  start: number;
  /** Offset just past the heading line, where the section's content begins. */
  contentStart: number;
}

interface FenceState {
  char: string;
  length: number;
}

/**
 * Advance fenced-code-block state by one line. `skip` is true when the line
 * is a fence delimiter or fenced content, i.e. not markdown structure.
 */
function stepFence(
  fence: FenceState | null,
  line: string,
): { fence: FenceState | null; skip: boolean } {
  const match = FENCE.exec(line);
  if (fence !== null) {
    const closes =
      match !== null &&
      match[1]![0] === fence.char &&
      match[1]!.length >= fence.length &&
      match[2]!.trim() === "";
    return { fence: closes ? null : fence, skip: true };
  }
  if (match !== null) {
    return { fence: { char: match[1]![0]!, length: match[1]!.length }, skip: true };
  }
  return { fence: null, skip: false };
}

/** Locate every markdown heading in a body, skipping fenced code blocks. */
function sectionBounds(body: string): SectionBounds[] {
  const bounds: SectionBounds[] = [];
  let fence: FenceState | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const step = stepFence(fence, line);
    fence = step.fence;
    if (step.skip) continue;
    const heading = ATX_HEADING.exec(line);
    if (heading === null) continue;
    bounds.push({
      heading: (heading[2] ?? "").replace(/[ \t]+#+$/, ""),
      level: heading[1]!.length,
      start,
      contentStart: Math.min(offset, body.length),
    });
  }
  return bounds;
}

/**
 * Split a concept body into its heading-delimited sections (spec §4.2), in
 * document order. Each section's content runs to the next heading of any
 * level; text before the first heading belongs to no section. Headings
 * inside fenced code blocks are body text, not section boundaries.
 */
export function splitSections(body: string): BodySection[] {
  const bounds = sectionBounds(body);
  return bounds.map((b, i) => ({
    heading: b.heading,
    level: b.level,
    content: body.slice(b.contentStart, bounds[i + 1]?.start ?? body.length).trim(),
  }));
}

/** Offsets of one section's subtree within a body, for in-place rewrites. */
export interface SectionSpan {
  /** Heading text without the leading #s or an ATX closing sequence. */
  heading: string;
  /** Heading level, 1–6. */
  level: number;
  /** Offset of the heading line's first character within the body. */
  start: number;
  /** Offset just past the heading line, where the section's content begins. */
  contentStart: number;
  /** Offset where the subtree ends: the next same-or-shallower heading, or body.length. */
  end: number;
}

/**
 * Locate every section in a body with the raw offsets of its whole subtree —
 * everything up to the next heading of the same or a shallower level — in
 * document order, so callers can splice several sections without regenerating
 * the body. Subtree spans of nested sections overlap their ancestors'.
 */
export function sectionSpans(body: string): SectionSpan[] {
  const bounds = sectionBounds(body);
  return bounds.map((b, i) => {
    const next = bounds.slice(i + 1).find((n) => n.level <= b.level);
    return {
      heading: b.heading,
      level: b.level,
      start: b.start,
      contentStart: b.contentStart,
      end: next?.start ?? body.length,
    };
  });
}

/**
 * Locate a section by heading name (case-insensitive, first match wins),
 * returning the raw offsets of its whole subtree — everything up to the next
 * heading of the same or a shallower level — so callers can splice the body
 * without regenerating it.
 */
export function sectionSpan(body: string, name: string): SectionSpan | undefined {
  const wanted = name.trim().toLowerCase();
  return sectionSpans(body).find((s) => s.heading.toLowerCase() === wanted);
}

/**
 * Find a section by heading name (case-insensitive, first match wins). The
 * returned content spans the section's whole subtree: everything up to the
 * next heading of the same or a shallower level.
 */
export function extractSection(body: string, name: string): BodySection | undefined {
  const span = sectionSpan(body, name);
  if (span === undefined) return undefined;
  return {
    heading: span.heading,
    level: span.level,
    content: body.slice(span.contentStart, span.end).trim(),
  };
}

/**
 * Heading of the section enclosing a body offset — the nearest heading at or
 * above the offset — or undefined before the first heading.
 */
export function sectionAt(body: string, offset: number): string | undefined {
  let enclosing: string | undefined;
  for (const b of sectionBounds(body)) {
    if (b.start > offset) break;
    enclosing = b.heading;
  }
  return enclosing;
}

/** One numbered entry under a concept's `# Citations` heading (spec §8). */
export interface Citation {
  /** Citation number as written, e.g. 1 for `[1]`. */
  index: number;
  /** Link text of the citation. */
  text: string;
  /** Raw link target as written. */
  target: string;
  /**
   * external: the target has a URI scheme; concept: it resolves to a
   * concept in the bundle (or, through `outsideResolves`, to a colocated
   * sibling bundle's concept); missing: bundle-relative but unresolved.
   */
  kind: "external" | "concept" | "missing";
}

export interface ExtractedCitations {
  citations: Citation[];
  /** Non-blank section lines that are not `[n] [text](target)` entries. */
  malformed: string[];
}

// The markdown-link part of a §8 entry, shared by the entry matchers.
const CITATION_LINK = String.raw`\[[^\]]*\]\(<?[^)<>\s]+>?(?:\s+"[^"]*")?\)`;
// A citation entry: `[n]` then a markdown link; trailing prose is allowed.
const CITATION_ENTRY = new RegExp(String.raw`^\[(\d+)\][ \t]+(${CITATION_LINK})`);
// The ordered-list form agents naturally write — `n. [text](target)` or
// `n) [text](target)` — normalized to `[n] ...` by the write paths.
const ORDERED_CITATION_ENTRY = new RegExp(
  String.raw`^ {0,3}(\d+)[.)][ \t]+(${CITATION_LINK}.*)$`,
);

/**
 * Rewrite ordered-list citation entries (`n. [text](target)`, `n) ...`) in a
 * Citations section's content to the spec §8 `[n] [text](target)` form.
 * Lines that are not list-numbered markdown links — correct entries, prose,
 * fenced code — pass through untouched.
 */
export function normalizeCitationBlock(content: string): string {
  let fence: FenceState | null = null;
  return content
    .split("\n")
    .map((line) => {
      const step = stepFence(fence, line);
      fence = step.fence;
      if (step.skip) return line;
      const entry = ORDERED_CITATION_ENTRY.exec(line);
      return entry === null ? line : `[${entry[1]}] ${entry[2]}`;
    })
    .join("\n");
}

/**
 * Normalize the entries of every `# Citations` section in a body (spec §8)
 * via normalizeCitationBlock, leaving all other sections byte-for-byte
 * intact — ordered lists outside Citations are content, not citations.
 */
export function normalizeCitationEntries(body: string): string {
  const bounds = sectionBounds(body);
  let result = body;
  for (let i = bounds.length - 1; i >= 0; i--) {
    const b = bounds[i]!;
    if (b.heading.toLowerCase() !== "citations") continue;
    // Like splitSections, a section's entries end at the next heading.
    const end = bounds[i + 1]?.start ?? body.length;
    const content = body.slice(b.contentStart, end);
    result =
      result.slice(0, b.contentStart) +
      normalizeCitationBlock(content) +
      result.slice(end);
  }
  return result;
}

/**
 * Extract the numbered citation entries under a concept's `# Citations`
 * heading (spec §8). Targets are classified like body links, with
 * bundle-relative targets resolved through `conceptExists`; unresolved
 * ones are `missing`, never an error (consistent with §9 tolerance).
 * `outsideResolves` lets callers resolve `../` targets that leave the
 * bundle root (e.g. into a mounted colocated sibling — see
 * resolveOutsideLink); a resolving one classifies as `concept`.
 * Duplicate `# Citations` headings are merged — every same-named section
 * is read, so an accidental empty duplicate cannot mask the entries.
 */
export function extractCitations(
  body: string,
  conceptPath: string,
  conceptExists: (id: string) => boolean,
  outsideResolves: (linkPath: string) => boolean = () => false,
): ExtractedCitations {
  const citations: Citation[] = [];
  const malformed: string[] = [];
  const sections = splitSections(body).filter(
    (s) => s.heading.toLowerCase() === "citations",
  );

  for (const rawLine of sections.flatMap((s) => s.content.split("\n"))) {
    const line = rawLine.trim();
    if (line === "") continue;
    const entry = CITATION_ENTRY.exec(line);
    if (entry === null) {
      malformed.push(line);
      continue;
    }
    const link = extractLinks(entry[2]!, conceptPath)[0];
    if (link === undefined) {
      malformed.push(line);
      continue;
    }
    citations.push({
      index: Number(entry[1]),
      text: link.text,
      target: link.target,
      kind: citationKind(link, conceptExists, outsideResolves),
    });
  }
  return { citations, malformed };
}

function citationKind(
  link: ConceptLink,
  conceptExists: (id: string) => boolean,
  outsideResolves: (linkPath: string) => boolean,
): Citation["kind"] {
  if (link.kind === "external") return "external";
  if (
    link.kind === "concept" &&
    link.path !== undefined &&
    conceptExists(conceptIdFromPath(link.path))
  ) {
    return "concept";
  }
  if (
    link.kind === "outside" &&
    link.path !== undefined &&
    outsideResolves(link.path)
  ) {
    return "concept";
  }
  return "missing";
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((tag) => String(tag));
}

/**
 * Parse one concept document. Never throws: conformance problems are
 * reported alongside whatever could still be understood, because consumers
 * must keep serving valid content from partial bundles (spec §9).
 */
export function parseConceptDocument(
  source: string,
  relPath: string,
): ParsedConceptDocument {
  const problems: string[] = [];
  const split = splitFrontmatter(source);
  const links = extractLinks(split.body, relPath);

  if (!split.present) {
    problems.push("missing YAML frontmatter block");
    return { frontmatter: null, body: split.body, links, problems };
  }
  if (split.error || split.data === null) {
    problems.push(split.error ?? "unparseable frontmatter");
    return { frontmatter: null, body: split.body, links, problems };
  }

  const data = split.data;
  const type = data.type;
  if (typeof type !== "string" || type.trim() === "") {
    problems.push("frontmatter is missing a non-empty `type` field");
  }

  const frontmatter: ConceptFrontmatter = {
    ...data,
    type: typeof type === "string" ? type : "",
  };
  const tags = normalizeTags(data.tags);
  if (tags !== undefined) frontmatter.tags = tags;

  return { frontmatter, body: split.body, links, problems };
}
