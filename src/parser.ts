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
