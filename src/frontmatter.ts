import { parse, stringify } from "yaml";

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

/** Serialize frontmatter and body back into a concept document. */
export function serializeDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yamlText = stringify(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\s+/, "").trimEnd();
  return `---\n${yamlText}\n---\n\n${trimmedBody}\n`;
}
