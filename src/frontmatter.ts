import { isMap, parse, parseDocument, stringify } from "yaml";

export interface FrontmatterSplit {
  /** Parsed frontmatter mapping, or null when absent or unparseable. */
  data: Record<string, unknown> | null;
  /** Document content after the frontmatter block. */
  body: string;
  /** Whether a frontmatter block was present at all. */
  present: boolean;
  /** YAML parse error message, when the block exists but cannot be parsed. */
  error?: string;
}

const OPEN_DELIMITER = /^---\r?\n/;
const CLOSE_DELIMITER = /^(?:---|\.\.\.)\s*$/;

/**
 * Split a markdown document into YAML frontmatter and body (spec §4).
 * Permissive by design: a missing or broken block never throws.
 */
export function splitFrontmatter(source: string): FrontmatterSplit {
  if (!OPEN_DELIMITER.test(source)) {
    return { data: null, body: source, present: false };
  }
  const lines = source.split(/\r?\n/);
  const closeIndex = lines.findIndex(
    (line, i) => i > 0 && CLOSE_DELIMITER.test(line),
  );
  if (closeIndex === -1) {
    return {
      data: null,
      body: source,
      present: true,
      error: "unterminated frontmatter block",
    };
  }
  const yamlText = lines.slice(1, closeIndex).join("\n");
  const body = lines.slice(closeIndex + 1).join("\n").replace(/^\r?\n/, "");
  try {
    const data = parse(yamlText);
    if (data === null || data === undefined) {
      return { data: {}, body, present: true };
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      return {
        data: null,
        body,
        present: true,
        error: "frontmatter is not a YAML mapping",
      };
    }
    return { data: data as Record<string, unknown>, body, present: true };
  } catch (err) {
    return {
      data: null,
      body,
      present: true,
      error: `invalid YAML frontmatter: ${(err as Error).message}`,
    };
  }
}

export interface FrontmatterPatchResult {
  /** The document with the patch applied; everything outside the YAML block is byte-for-byte intact. */
  source: string;
  /** Patch keys set or overwritten, in patch order. */
  set: string[];
  /** Patch keys deleted by an explicit null, in patch order (only keys that existed). */
  deleted: string[];
}

/**
 * Apply a shallow patch to a document's frontmatter block by editing the YAML
 * in place: provided keys are set/overwritten, an explicit null deletes a
 * key, and every other key — plus YAML comments and formatting — survives
 * (spec §4.1 round-trip preservation as a guarantee, not an echo). Unlike
 * splitFrontmatter this throws on a missing or unparseable block: a patch
 * needs a mapping to merge into.
 */
export function patchFrontmatter(
  source: string,
  patch: Record<string, unknown>,
): FrontmatterPatchResult {
  if (!OPEN_DELIMITER.test(source)) {
    throw new Error("document has no frontmatter block to patch");
  }
  // Split keeping line terminators so offsets splice back exactly.
  const lines = source.split(/(?<=\n)/);
  const yamlStart = lines[0]!.length;
  let yamlEnd = -1;
  let offset = yamlStart;
  for (const line of lines.slice(1)) {
    if (CLOSE_DELIMITER.test(line.replace(/\r?\n$/, ""))) {
      yamlEnd = offset;
      break;
    }
    offset += line.length;
  }
  if (yamlEnd === -1) throw new Error("unterminated frontmatter block");

  const doc = parseDocument(source.slice(yamlStart, yamlEnd));
  if (doc.errors.length > 0) {
    throw new Error(`invalid YAML frontmatter: ${doc.errors[0]!.message}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("frontmatter is not a YAML mapping");
  }

  const set: string[] = [];
  const deleted: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (doc.delete(key)) deleted.push(key);
    } else {
      doc.set(key, value);
      set.push(key);
    }
  }
  if (set.length === 0 && deleted.length === 0) {
    return { source, set, deleted };
  }
  return {
    source: source.slice(0, yamlStart) + doc.toString() + source.slice(yamlEnd),
    set,
    deleted,
  };
}

/** Serialize frontmatter and body back into a concept document. */
export function serializeDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlText = stringify(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\s+/, "").trimEnd();
  return `---\n${yamlText}\n---\n\n${trimmedBody}\n`;
}
