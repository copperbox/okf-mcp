import path from "node:path";

import { splitFrontmatter } from "./frontmatter.js";
import type { ConceptFrontmatter, ConceptLink } from "./types.js";

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

/** Locate every markdown heading in a body, skipping fenced code blocks. */
function sectionBounds(body: string): SectionBounds[] {
  const bounds: SectionBounds[] = [];
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const start = offset;
    offset += line.length + 1;
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      const closes =
        fenceMatch !== null &&
        fenceMatch[1]![0] === fence.char &&
        fenceMatch[1]!.length >= fence.length &&
        fenceMatch[2]!.trim() === "";
      if (closes) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
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

/**
 * Find a section by heading name (case-insensitive, first match wins). The
 * returned content spans the section's whole subtree: everything up to the
 * next heading of the same or a shallower level.
 */
export function extractSection(body: string, name: string): BodySection | undefined {
  const bounds = sectionBounds(body);
  const wanted = name.trim().toLowerCase();
  const index = bounds.findIndex((b) => b.heading.toLowerCase() === wanted);
  if (index === -1) return undefined;
  const target = bounds[index]!;
  const next = bounds.slice(index + 1).find((b) => b.level <= target.level);
  return {
    heading: target.heading,
    level: target.level,
    content: body.slice(target.contentStart, next?.start ?? body.length).trim(),
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
   * concept in the bundle; missing: bundle-relative but unresolved.
   */
  kind: "external" | "concept" | "missing";
}

export interface ExtractedCitations {
  citations: Citation[];
  /** Non-blank section lines that are not `[n] [text](target)` entries. */
  malformed: string[];
}

// A citation entry: `[n]` then a markdown link; trailing prose is allowed.
const CITATION_ENTRY = /^\[(\d+)\][ \t]+(\[[^\]]*\]\(<?[^)<>\s]+>?(?:\s+"[^"]*")?\))/;

/**
 * Extract the numbered citation entries under a concept's `# Citations`
 * heading (spec §8). Targets are classified like body links, with
 * bundle-relative targets resolved through `conceptExists`; unresolved
 * ones are `missing`, never an error (consistent with §9 tolerance).
 */
export function extractCitations(
  body: string,
  conceptPath: string,
  conceptExists: (id: string) => boolean,
): ExtractedCitations {
  const citations: Citation[] = [];
  const malformed: string[] = [];
  const section = splitSections(body).find(
    (s) => s.heading.toLowerCase() === "citations",
  );
  if (section === undefined) return { citations, malformed };

  for (const rawLine of section.content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const entry = CITATION_ENTRY.exec(line);
    const link = entry === null ? undefined : extractLinks(entry[2]!, conceptPath)[0];
    if (entry === null || link === undefined) {
      malformed.push(line);
      continue;
    }
    citations.push({
      index: Number(entry[1]),
      text: link.text,
      target: link.target,
      kind: citationKind(link, conceptExists),
    });
  }
  return { citations, malformed };
}

function citationKind(
  link: ConceptLink,
  conceptExists: (id: string) => boolean,
): Citation["kind"] {
  if (link.kind === "external") return "external";
  if (
    link.kind === "concept" &&
    link.path !== undefined &&
    conceptExists(conceptIdFromPath(link.path))
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
