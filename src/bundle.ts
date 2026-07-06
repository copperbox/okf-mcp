import fs from "node:fs/promises";
import path from "node:path";

import { conceptIdFromPath, parseConceptDocument } from "./parser.js";
import type {
  BundleConfig,
  BundleProblem,
  Concept,
  LoadedBundle,
  ReservedFile,
} from "./types.js";
import { RESERVED_FILENAMES } from "./types.js";

/**
 * Recursively list bundle-relative POSIX paths of markdown files. Dot
 * directories (`.obsidian`, `.git`, ...) and dot files are skipped so a
 * bundle can double as an Obsidian vault without Obsidian state leaking
 * into the index.
 */
async function walkMarkdownFiles(root: string, dir = ""): Promise<string[]> {
  const absolute = path.join(root, dir);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relPath = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(root, relPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(relPath);
    }
  }
  return files.sort();
}

function isReserved(relPath: string): ReservedFile | null {
  const base = path.posix.basename(relPath).toLowerCase();
  if (!(RESERVED_FILENAMES as readonly string[]).includes(base)) return null;
  return { path: relPath, kind: base === "index.md" ? "index" : "log" };
}

/**
 * Load an OKF bundle from a directory tree (spec §3). Loading is
 * permissive: malformed documents are reported as problems and skipped,
 * valid concepts keep working.
 */
export async function loadBundle(config: BundleConfig): Promise<LoadedBundle> {
  const root = path.resolve(config.root);
  const concepts = new Map<string, Concept>();
  const reserved: ReservedFile[] = [];
  const problems: BundleProblem[] = [];

  let files: string[];
  try {
    files = await walkMarkdownFiles(root);
  } catch (err) {
    problems.push({
      severity: "error",
      message: `cannot read bundle root ${root}: ${(err as Error).message}`,
    });
    return { id: config.id, root, concepts, reserved, problems };
  }

  for (const relPath of files) {
    const reservedFile = isReserved(relPath);
    if (reservedFile) {
      reserved.push(reservedFile);
      continue;
    }
    const source = await fs.readFile(path.join(root, relPath), "utf8");
    const parsed = parseConceptDocument(source, relPath);
    for (const problem of parsed.problems) {
      problems.push({ severity: "error", path: relPath, message: problem });
    }
    if (parsed.frontmatter === null) continue; // unusable document; problems already recorded
    concepts.set(conceptIdFromPath(relPath), {
      id: conceptIdFromPath(relPath),
      bundleId: config.id,
      path: relPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      links: parsed.links,
    });
  }

  resolveLinks(concepts, problems);
  return { id: config.id, root, concepts, reserved, problems };
}

/**
 * Resolve concept-kind links against the loaded concept set. A `.md`
 * suffix is optional in link targets (Obsidian-style extensionless links
 * resolve too). Unresolved links are warnings, never errors (spec §5.3).
 */
function resolveLinks(
  concepts: Map<string, Concept>,
  problems: BundleProblem[],
): void {
  for (const concept of concepts.values()) {
    for (const link of concept.links) {
      if (link.kind !== "concept" || link.path === undefined) continue;
      const id = conceptIdFromPath(link.path);
      if (concepts.has(id)) {
        link.resolvedId = id;
      } else if (link.path.toLowerCase().endsWith(".md")) {
        problems.push({
          severity: "warning",
          path: concept.path,
          message: `link to missing concept: ${link.target}`,
        });
      }
    }
  }
}
