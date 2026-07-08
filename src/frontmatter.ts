import { isMap, isScalar, parse, parseDocument, stringify } from "yaml";
import type { Pair, YAMLMap } from "yaml";

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

export interface PatchFrontmatterOptions {
  /**
   * Placement anchors for keys the patch creates: when the patch adds a key
   * that did not exist and `insertAfter[key]` is given, the new key is
   * inserted after the last of those anchor keys present in the mapping (at
   * the top when none are) instead of appended at the end. Keys that already
   * exist are overwritten in place and never move.
   */
  insertAfter?: Record<string, readonly string[]>;
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
  options: PatchFrontmatterOptions = {},
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
      const anchors = doc.has(key) ? undefined : options.insertAfter?.[key];
      doc.set(key, value);
      set.push(key);
      if (anchors !== undefined && isMap(doc.contents)) {
        moveAfterAnchors(doc.contents, key, anchors);
      }
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

/**
 * Key of a mapping pair when it is scalar-like: a Scalar node when parsed,
 * a plain string when created by `doc.set` (frontmatter keys always are).
 */
function scalarKey(pair: Pair): string | undefined {
  if (isScalar(pair.key)) return String(pair.key.value);
  if (typeof pair.key === "string") return pair.key;
  return undefined;
}

/**
 * Move `key`'s pair to sit after the last of `anchors` present in the map,
 * or first when none are — slotting a newly created key into its canonical
 * position instead of the end of the mapping.
 */
function moveAfterAnchors(map: YAMLMap, key: string, anchors: readonly string[]): void {
  const items = map.items;
  const from = items.findIndex((pair) => scalarKey(pair) === key);
  if (from === -1) return;
  let to = 0;
  for (let i = 0; i < items.length; i++) {
    if (i === from) continue;
    const itemKey = scalarKey(items[i]!);
    if (itemKey !== undefined && anchors.includes(itemKey)) to = i + 1;
  }
  const [pair] = items.splice(from, 1);
  if (to > from) to -= 1;
  items.splice(to, 0, pair!);
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
