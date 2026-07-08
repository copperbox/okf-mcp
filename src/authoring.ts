import fs from "node:fs/promises";
import path from "node:path";

import { declaredOkfVersion } from "./bundle.js";
import { serializeDocument, splitFrontmatter } from "./frontmatter.js";
import { conceptIdFromPath, deriveTitle, extractLinks } from "./parser.js";
import type { Concept, ConceptFrontmatter, ConceptLink, LoadedBundle } from "./types.js";
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

/** Spec §4.1 keys in their recommended order; `timestamp` slots in after these. */
const SPEC_KEYS = ["type", "title", "description", "resource", "tags"] as const;

/**
 * Default `timestamp` to the current time (spec §4.1: ISO 8601 datetime of
 * last meaningful change) — the server knows when it writes. A caller-provided
 * value always wins, so producers may backdate deliberately. When defaulting,
 * spec keys are emitted in spec order with `timestamp` in its slot, followed
 * by extension keys in their original order.
 */
function withDefaultTimestamp(frontmatter: ConceptFrontmatter): ConceptFrontmatter {
  if (frontmatter.timestamp !== undefined) return frontmatter;
  const ordered: Record<string, unknown> = {};
  for (const key of SPEC_KEYS) {
    if (frontmatter[key] !== undefined) ordered[key] = frontmatter[key];
  }
  ordered.timestamp = new Date().toISOString();
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!(SPEC_KEYS as readonly string[]).includes(key)) ordered[key] = value;
  }
  return ordered as ConceptFrontmatter;
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
  await fs.writeFile(
    absolute,
    serializeDocument(withDefaultTimestamp(frontmatter), body),
    "utf8",
  );
  return { path: safePath, created: !exists };
}

/**
 * Look up an existing concept by ID or bundle-relative path, rejecting the
 * reserved index/log files up front (their IDs never appear in the concept
 * map, but the message should say "reserved", not "unknown").
 */
function requireConcept(bundle: LoadedBundle, idOrPath: string, action: string): Concept {
  if (/(^|\/)(index|log)(\.md)?$/i.test(idOrPath)) {
    throw new Error(`${idOrPath} is a reserved file and cannot be ${action} as a concept`);
  }
  const concept =
    bundle.concepts.get(idOrPath) ??
    bundle.concepts.get(idOrPath.replace(/\.md$/i, ""));
  if (!concept) throw new Error(`unknown concept: ${idOrPath}`);
  return concept;
}

/** Concepts (other than the target itself) with a link resolving to `conceptId`. */
function conceptsLinkingTo(bundle: LoadedBundle, conceptId: string): Concept[] {
  return [...bundle.concepts.values()].filter(
    (other) =>
      other.id !== conceptId &&
      other.links.some((link) => link.resolvedId === conceptId),
  );
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
  const concept = requireConcept(bundle, idOrPath, "deleted");

  const inboundLinks = conceptsLinkingTo(bundle, concept.id)
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

export interface RenameConceptResult {
  /** New concept ID. */
  id: string;
  /** Old bundle-relative path. */
  from: string;
  /** New bundle-relative path. */
  to: string;
  /** Frontmatter title of the moved concept, when it had one. */
  title?: string;
  /** Bundle-relative paths of files whose link targets were rewritten. */
  rewrittenFiles: string[];
  /** Bundle-relative directories removed because the move emptied them. */
  removedDirs: string[];
}

/**
 * Move a concept to a new path, rewriting every link in the bundle that
 * resolved to it — each in its original form (absolute stays absolute,
 * relative is recomputed from the linking file's directory) — plus the moved
 * file's own relative links, which were written against its old directory.
 * Refuses to overwrite an existing concept. Does not touch the in-memory
 * index — reload the bundle afterwards.
 */
export async function renameConcept(
  bundle: LoadedBundle,
  fromIdOrPath: string,
  toRelPath: string,
): Promise<RenameConceptResult> {
  const concept = requireConcept(bundle, fromIdOrPath, "renamed");

  const toPath = assertSafeConceptPath(toRelPath);
  const toId = conceptIdFromPath(toPath);
  if (toId === concept.id) {
    throw new Error(`rename source and target are the same concept: ${toPath}`);
  }
  const toAbsolute = path.join(bundle.root, toPath);
  if (bundle.concepts.has(toId) || (await fileExists(toAbsolute))) {
    throw new Error(`concept already exists: ${toPath}`);
  }

  await fs.mkdir(path.dirname(toAbsolute), { recursive: true });
  await fs.rename(path.join(bundle.root, concept.path), toAbsolute);

  const rewrittenFiles: string[] = [];
  const linksToMoved = (link: ConceptLink) =>
    link.path !== undefined && conceptIdFromPath(link.path) === concept.id;

  // The moved file: links to itself now point at toPath; links to anything
  // else keep their destination but relative ones need recomputing.
  const movedChanged = await rewriteLinksInFile(bundle.root, toPath, concept.path, (link) =>
    linksToMoved(link) ? toPath : link.path ?? null,
  );
  if (movedChanged) rewrittenFiles.push(toPath);

  // Inbound linkers, selected from the in-memory link graph, then rewritten
  // from their raw source.
  for (const other of conceptsLinkingTo(bundle, concept.id)) {
    const changed = await rewriteLinksInFile(bundle.root, other.path, other.path, (link) =>
      linksToMoved(link) ? toPath : null,
    );
    if (changed) rewrittenFiles.push(other.path);
  }

  const removedDirs = await removeEmptyDirectories(
    bundle.root,
    path.posix.dirname(concept.path),
  );

  const result: RenameConceptResult = {
    id: toId,
    from: concept.path,
    to: toPath,
    rewrittenFiles: rewrittenFiles.sort(),
    removedDirs,
  };
  if (concept.frontmatter.title !== undefined) result.title = concept.frontmatter.title;
  return result;
}

/**
 * Rewrite concept-link targets in one file by splicing the original source,
 * preserving everything outside the rewritten spans byte-for-byte.
 *
 * `resolveAt` is the bundle-relative path whose directory the file's relative
 * links were written against (the old location for a just-moved file);
 * `fileAt` is where the file lives on disk now and the directory relative
 * targets are re-rendered from. `newDestFor` maps each concept link to the
 * bundle-relative path it should point at, or null to leave it alone.
 * Returns whether anything changed.
 */
async function rewriteLinksInFile(
  bundleRoot: string,
  fileAt: string,
  resolveAt: string,
  newDestFor: (link: ConceptLink) => string | null,
): Promise<boolean> {
  const absolute = path.join(bundleRoot, fileAt);
  const source = await fs.readFile(absolute, "utf8");
  const split = splitFrontmatter(source);
  // Link offsets are relative to the body; when the body is a literal suffix
  // of the source (always true for LF documents), shift them to source
  // offsets. Otherwise scan the whole source so offsets stay valid.
  const bodyStart = source.endsWith(split.body) ? source.length - split.body.length : 0;
  const fromDir = path.posix.dirname(fileAt);

  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const link of extractLinks(source.slice(bodyStart), resolveAt)) {
    if (link.kind !== "concept") continue;
    const dest = newDestFor(link);
    if (dest === null) continue;
    const replacement = renderTarget(link.target, dest, fromDir === "." ? "" : fromDir);
    if (replacement === link.target) continue;
    edits.push({
      start: bodyStart + link.targetStart,
      end: bodyStart + link.targetEnd,
      replacement,
    });
  }
  if (edits.length === 0) return false;

  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  }
  await fs.writeFile(absolute, updated, "utf8");
  return true;
}

/**
 * Re-render a link target to point at `destPath`, preserving the original's
 * form: absolute stays absolute, relative is recomputed from `fromDir`
 * (keeping a leading `./` when one was written), an extensionless target
 * stays extensionless, and any #fragment/?query suffix is carried over.
 */
function renderTarget(rawTarget: string, destPath: string, fromDir: string): string {
  const pathPart = rawTarget.split("#")[0]!.split("?")[0]!;
  const suffix = rawTarget.slice(pathPart.length);
  const dest = pathPart.toLowerCase().endsWith(".md")
    ? destPath
    : destPath.replace(/\.md$/i, "");
  if (pathPart.startsWith("/")) return `/${dest}${suffix}`;
  const relative = path.posix.relative(fromDir, dest);
  const dotted =
    pathPart.startsWith("./") && !relative.startsWith("../") ? `./${relative}` : relative;
  return dotted + suffix;
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

export interface AppendLogEntryOptions {
  /**
   * Bundle-relative directory whose `log.md` receives the entry (spec §7
   * allows a log at any level of the hierarchy). Defaults to the bundle root.
   */
  directory?: string;
  /** Timestamp for the entry's date heading. Defaults to now. */
  date?: Date;
}

/**
 * Reject log directories that are absolute, escape the bundle root, or hide
 * in dot-directories — the same rules concept writes follow, minus the ones
 * about the filename (that's always `log.md`). Returns the normalized
 * bundle-relative directory, "" for the bundle root.
 */
function assertSafeLogDirectory(dir: string): string {
  const normalized = path.posix.normalize(dir.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (normalized === "." || normalized === "") return "";
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error(`log directory must stay inside the bundle: ${dir}`);
  }
  if (normalized.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error(`log directory segments must not start with ".": ${dir}`);
  }
  return normalized;
}

/**
 * Prepend an entry to a `log.md`, newest-first under an ISO date heading
 * (spec §7) — the bundle root's by default, or a scoped one in any bundle
 * directory. Creates the log (and directory) when absent. Returns the
 * bundle-relative path of the log written.
 */
export async function appendLogEntry(
  bundleRoot: string,
  message: string,
  options: AppendLogEntryOptions = {},
): Promise<{ path: string }> {
  const directory = assertSafeLogDirectory(options.directory ?? "");
  const relPath = directory === "" ? "log.md" : `${directory}/log.md`;
  const logPath = path.join(bundleRoot, relPath);
  const day = (options.date ?? new Date()).toISOString().slice(0, 10);
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
    const title =
      titleMatch?.[0] ?? (directory === "" ? "# Update Log\n" : "# Directory Update Log\n");
    const rest = existing.slice(title.length).replace(/^\s+/, "");
    updated = `${title}\n${heading}\n${entry}\n${rest === "" ? "" : `\n${rest}`}`;
  }
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, updated.trimEnd() + "\n", "utf8");
  return { path: relPath };
}

/**
 * Render the `index.md` content for every directory of the bundle from
 * concept frontmatter (spec §6), keyed by bundle-relative index path
 * ("index.md", "tables/index.md", ...). Pure in-memory rendering — spec §6
 * lets consumers synthesize an index when none is present, so this also
 * serves read-only bundles where generateIndexes cannot write.
 */
export function renderIndexes(bundle: LoadedBundle): Map<string, string> {
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

  const rendered = new Map<string, string>();
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
        const title = deriveTitle(concept);
        const description = concept.frontmatter.description;
        lines.push(`* [${title}](${name})${description ? ` - ${description}` : ""}`);
      }
      lines.push("");
    }
    const indexPath = dir === "" ? "index.md" : `${dir}/index.md`;
    rendered.set(indexPath, lines.join("\n").trimEnd() + "\n");
  }
  return rendered;
}

/**
 * Regenerate `index.md` in every directory of the bundle for progressive
 * disclosure (spec §6). Existing index files are overwritten — they are
 * generated artifacts here. Entries use frontmatter titles/descriptions,
 * so the same files double as navigation pages in Obsidian.
 */
export async function generateIndexes(bundle: LoadedBundle): Promise<string[]> {
  const written: string[] = [];
  for (const [indexPath, content] of renderIndexes(bundle)) {
    await fs.writeFile(path.join(bundle.root, indexPath), content, "utf8");
    written.push(indexPath);
  }
  return written.sort();
}

/** The okf_version a bundle root's index.md declares on disk, if any (spec §11). */
export async function readDeclaredVersion(
  bundleRoot: string,
): Promise<string | undefined> {
  const indexPath = path.join(bundleRoot, "index.md");
  if (!(await fileExists(indexPath))) return undefined;
  return declaredOkfVersion(await fs.readFile(indexPath, "utf8"));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
