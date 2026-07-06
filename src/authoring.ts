import fs from "node:fs/promises";
import path from "node:path";

import { serializeDocument, splitFrontmatter } from "./frontmatter.js";
import type { ConceptFrontmatter, LoadedBundle } from "./types.js";
import { OKF_VERSION, RESERVED_FILENAMES } from "./types.js";

/**
 * Reject concept paths that are absolute, escape the bundle root, are not
 * markdown, or collide with reserved filenames. Returns the normalized
 * bundle-relative path.
 */
export function assertSafeConceptPath(relPath: string): string {
  const normalized = path.posix.normalize(relPath.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error(`concept path must stay inside the bundle: ${relPath}`);
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error(`concept path must end in .md: ${relPath}`);
  }
  const base = path.posix.basename(normalized).toLowerCase();
  if ((RESERVED_FILENAMES as readonly string[]).includes(base)) {
    throw new Error(`${base} is a reserved filename and cannot be a concept`);
  }
  if (normalized.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error(`concept path segments must not start with ".": ${relPath}`);
  }
  return normalized;
}

export interface WriteConceptOptions {
  /** Refuse to replace an existing document. Defaults to allowing updates. */
  failIfExists?: boolean;
}

/**
 * Write one concept document into a bundle directory. This is the only
 * concept write path; it validates the path and required frontmatter but
 * does not touch the in-memory index — reload the bundle afterwards.
 */
export async function writeConcept(
  bundleRoot: string,
  relPath: string,
  frontmatter: ConceptFrontmatter,
  body: string,
  options: WriteConceptOptions = {},
): Promise<{ path: string; created: boolean }> {
  const safePath = assertSafeConceptPath(relPath);
  if (typeof frontmatter.type !== "string" || frontmatter.type.trim() === "") {
    throw new Error("frontmatter requires a non-empty `type` (spec §4.1)");
  }
  const absolute = path.join(bundleRoot, safePath);
  const exists = await fileExists(absolute);
  if (exists && options.failIfExists) {
    throw new Error(`concept already exists: ${safePath}`);
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, serializeDocument(frontmatter, body), "utf8");
  return { path: safePath, created: !exists };
}

export interface DeleteConceptOptions {
  /** Refuse to delete when other concepts still link to the target. */
  failIfLinked?: boolean;
}

export interface DeleteConceptResult {
  id: string;
  path: string;
  /** Frontmatter title of the deleted concept, when it had one. */
  title?: string;
  /** IDs of concepts whose links resolved to the deleted concept. */
  inboundLinks: string[];
  /** Bundle-relative directories removed because the delete emptied them. */
  removedDirs: string[];
}

/**
 * Delete one concept from a bundle by ID or path. Broken inbound links are
 * spec-legal (§5.3), so linking concepts are reported rather than blocking —
 * unless `failIfLinked` asks for the strict behavior. Directories emptied by
 * the delete are removed along with their generated `index.md`. Does not
 * touch the in-memory index — reload the bundle afterwards.
 */
export async function deleteConcept(
  bundle: LoadedBundle,
  idOrPath: string,
  options: DeleteConceptOptions = {},
): Promise<DeleteConceptResult> {
  if (/(^|\/)(index|log)(\.md)?$/i.test(idOrPath)) {
    throw new Error(`${idOrPath} is a reserved file and cannot be deleted as a concept`);
  }
  const concept =
    bundle.concepts.get(idOrPath) ??
    bundle.concepts.get(idOrPath.replace(/\.md$/i, ""));
  if (!concept) throw new Error(`unknown concept: ${idOrPath}`);

  const inboundLinks = [...bundle.concepts.values()]
    .filter(
      (other) =>
        other.id !== concept.id &&
        other.links.some((link) => link.resolvedId === concept.id),
    )
    .map((other) => other.id)
    .sort();
  if (options.failIfLinked && inboundLinks.length > 0) {
    throw new Error(
      `concept ${concept.id} is still linked from: ${inboundLinks.join(", ")}`,
    );
  }

  await fs.rm(path.join(bundle.root, concept.path));
  const removedDirs = await removeEmptyDirectories(
    bundle.root,
    path.posix.dirname(concept.path),
  );

  const result: DeleteConceptResult = {
    id: concept.id,
    path: concept.path,
    inboundLinks,
    removedDirs,
  };
  if (concept.frontmatter.title !== undefined) result.title = concept.frontmatter.title;
  return result;
}

/**
 * Walk from `dir` up toward the bundle root, removing each directory that
 * holds nothing but its generated `index.md`. Returns the removed
 * bundle-relative directories, deepest first.
 */
async function removeEmptyDirectories(
  bundleRoot: string,
  dir: string,
): Promise<string[]> {
  const removed: string[] = [];
  let current = dir === "." ? "" : dir;
  while (current !== "") {
    const absolute = path.join(bundleRoot, current);
    const entries = await fs.readdir(absolute);
    if (entries.some((name) => name.toLowerCase() !== "index.md")) break;
    await fs.rm(absolute, { recursive: true });
    removed.push(current);
    current = path.posix.dirname(current);
    if (current === ".") current = "";
  }
  return removed;
}

/**
 * Prepend an entry to the bundle root `log.md`, newest-first under an ISO
 * date heading (spec §7). Creates the log when absent.
 */
export async function appendLogEntry(
  bundleRoot: string,
  message: string,
  date: Date = new Date(),
): Promise<void> {
  const logPath = path.join(bundleRoot, "log.md");
  const day = date.toISOString().slice(0, 10);
  const entry = `* ${message.trim()}`;

  let existing = "";
  if (await fileExists(logPath)) {
    existing = await fs.readFile(logPath, "utf8");
  }

  const heading = `## ${day}`;
  let updated: string;
  if (existing.includes(heading)) {
    updated = existing.replace(heading, `${heading}\n${entry}`);
  } else {
    const titleMatch = existing.match(/^# .*\r?\n/);
    const title = titleMatch?.[0] ?? "# Update Log\n";
    const rest = existing.slice(title.length).replace(/^\s+/, "");
    updated = `${title}\n${heading}\n${entry}\n${rest === "" ? "" : `\n${rest}`}`;
  }
  await fs.writeFile(logPath, updated.trimEnd() + "\n", "utf8");
}

/**
 * Regenerate `index.md` in every directory of the bundle for progressive
 * disclosure (spec §6). Existing index files are overwritten — they are
 * generated artifacts here. Entries use frontmatter titles/descriptions,
 * so the same files double as navigation pages in Obsidian.
 */
export async function generateIndexes(bundle: LoadedBundle): Promise<string[]> {
  const directories = new Map<string, { files: string[]; dirs: Set<string> }>();
  const entryFor = (dir: string) => {
    let entry = directories.get(dir);
    if (!entry) {
      entry = { files: [], dirs: new Set() };
      directories.set(dir, entry);
    }
    return entry;
  };

  entryFor("");
  for (const concept of bundle.concepts.values()) {
    const dir = path.posix.dirname(concept.path);
    const normalizedDir = dir === "." ? "" : dir;
    entryFor(normalizedDir).files.push(concept.path);
    // Register every ancestor directory so intermediate levels get indexes.
    const segments = normalizedDir === "" ? [] : normalizedDir.split("/");
    for (let i = 0; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      entryFor(parent).dirs.add(segments[i]!);
    }
  }

  const written: string[] = [];
  for (const [dir, { files, dirs }] of directories) {
    const lines: string[] = [];
    if (dir === "") {
      lines.push("---", `okf_version: "${OKF_VERSION}"`, "---", "");
    }
    lines.push(`# ${dir === "" ? "Bundle Index" : path.posix.basename(dir)}`, "");
    if (dirs.size > 0) {
      lines.push("# Directories", "");
      for (const sub of [...dirs].sort()) {
        lines.push(`* [${sub}](${sub}/)`);
      }
      lines.push("");
    }
    if (files.length > 0) {
      lines.push("# Concepts", "");
      for (const file of files.sort()) {
        const concept = bundle.concepts.get(file.replace(/\.md$/i, ""))!;
        const name = path.posix.basename(file);
        const title = concept.frontmatter.title ?? concept.id;
        const description = concept.frontmatter.description;
        lines.push(`* [${title}](${name})${description ? ` - ${description}` : ""}`);
      }
      lines.push("");
    }
    const indexPath = dir === "" ? "index.md" : `${dir}/index.md`;
    await fs.writeFile(
      path.join(bundle.root, indexPath),
      lines.join("\n").trimEnd() + "\n",
      "utf8",
    );
    written.push(indexPath);
  }
  return written.sort();
}

/** True when the bundle-root index declares a different major OKF version. */
export async function readDeclaredVersion(
  bundleRoot: string,
): Promise<string | undefined> {
  const indexPath = path.join(bundleRoot, "index.md");
  if (!(await fileExists(indexPath))) return undefined;
  const split = splitFrontmatter(await fs.readFile(indexPath, "utf8"));
  const version = split.data?.okf_version;
  return typeof version === "string" ? version : undefined;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
