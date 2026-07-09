import fs from "node:fs/promises";
import path from "node:path";

import { canonicalUrlPrefixes } from "./canonical.js";
import { splitFrontmatter } from "./frontmatter.js";
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

/**
 * Discover the bundles colocated under a shared root (`--colocated-bundles`):
 * each immediate subdirectory containing at least one markdown file becomes a
 * bundle config with `id` = the directory basename and `colocatedRoot` = the
 * shared root. Dot directories are skipped (same rule as walkMarkdownFiles),
 * and loose files at the root (README.md, AGENTS.md, ...) belong to no bundle.
 */
export async function discoverColocatedBundles(root: string): Promise<BundleConfig[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const configs: BundleConfig[] = [];
  // Codepoint order, matching walkMarkdownFiles' sorted output.
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const bundleRoot = path.join(root, entry.name);
    const markdown = await walkMarkdownFiles(bundleRoot);
    if (markdown.length === 0) continue;
    configs.push({ id: entry.name, root: bundleRoot, colocatedRoot: root });
  }
  return configs;
}

function isReserved(relPath: string): ReservedFile | null {
  const base = path.posix.basename(relPath).toLowerCase();
  if (!(RESERVED_FILENAMES as readonly string[]).includes(base)) return null;
  return { path: relPath, kind: base === "index.md" ? "index" : "log" };
}

/** The okf_version a bundle-root index.md declares in frontmatter (spec §11). */
export function declaredOkfVersion(source: string): string | undefined {
  const version = splitFrontmatter(source).data?.okf_version;
  return typeof version === "string" ? version : undefined;
}

/**
 * The one-line purpose a bundle-root index.md declares in its frontmatter
 * `description`, letting agents judge a bundle's relevance without reading
 * into it.
 */
export function declaredDescription(source: string): string | undefined {
  const description = splitFrontmatter(source).data?.description;
  return typeof description === "string" ? description : undefined;
}

/** One markdown document as raw text, addressed by its bundle-relative path. */
export interface BundleDocument {
  /** Bundle-relative POSIX path ending in `.md`. */
  path: string;
  source: string;
}

export interface BuildBundleOptions {
  /** Mark the bundle read-only: rejected by all authoring paths. */
  readOnly?: boolean;
  /** Keep raw sources in memory so documents can be served without files. */
  keepSources?: boolean;
  /** Expanded canonical URL prefixes of the bundle root (canonicalUrlPrefixes). */
  canonicalUrls?: string[];
  /** Shared colocated root the bundle was discovered under (LoadedBundle.colocatedRoot). */
  colocatedRoot?: string;
}

/**
 * Index a set of in-memory documents into a bundle (the parse/resolve
 * pipeline shared by local and remote loading). Permissive per spec §9:
 * malformed documents are reported as problems and skipped, valid
 * concepts keep working.
 */
export function buildBundle(
  id: string,
  root: string,
  documents: BundleDocument[],
  options: BuildBundleOptions = {},
): LoadedBundle {
  const concepts = new Map<string, Concept>();
  const reserved: ReservedFile[] = [];
  const problems: BundleProblem[] = [];
  let okfVersion: string | undefined;
  let description: string | undefined;

  for (const document of [...documents].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const relPath = document.path;
    const reservedFile = isReserved(relPath);
    if (reservedFile) {
      reserved.push(reservedFile);
      // Only the bundle-root index.md may declare okf_version (spec §11)
      // and the bundle description.
      if (reservedFile.kind === "index" && !relPath.includes("/")) {
        okfVersion = declaredOkfVersion(document.source);
        description = declaredDescription(document.source);
      }
      continue;
    }
    const parsed = parseConceptDocument(document.source, relPath);
    for (const problem of parsed.problems) {
      problems.push({ severity: "error", path: relPath, message: problem });
    }
    if (parsed.frontmatter === null) continue; // unusable document; problems already recorded
    concepts.set(conceptIdFromPath(relPath), {
      id: conceptIdFromPath(relPath),
      bundleId: id,
      path: relPath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      links: parsed.links,
    });
  }

  resolveLinks(concepts, reserved, problems);
  return {
    id,
    root,
    concepts,
    reserved,
    problems,
    readOnly: options.readOnly ?? false,
    okfVersion,
    description,
    ...(options.keepSources && {
      sources: new Map(documents.map((d) => [d.path, d.source])),
    }),
    ...(options.canonicalUrls !== undefined &&
      options.canonicalUrls.length > 0 && { canonicalUrls: options.canonicalUrls }),
    ...(options.colocatedRoot !== undefined && {
      colocatedRoot: options.colocatedRoot,
    }),
  };
}

/**
 * Load an OKF bundle from a directory tree (spec §3). Loading is
 * permissive: malformed documents are reported as problems and skipped,
 * valid concepts keep working.
 */
export async function loadBundle(config: BundleConfig): Promise<LoadedBundle> {
  const root = path.resolve(config.root);

  let files: string[];
  try {
    files = await walkMarkdownFiles(root);
  } catch (err) {
    return {
      id: config.id,
      root,
      concepts: new Map(),
      reserved: [],
      problems: [
        {
          severity: "error",
          message: `cannot read bundle root ${root}: ${(err as Error).message}`,
        },
      ],
      readOnly: false,
    };
  }

  const documents: BundleDocument[] = [];
  for (const relPath of files) {
    documents.push({
      path: relPath,
      source: await fs.readFile(path.join(root, relPath), "utf8"),
    });
  }
  return buildBundle(config.id, root, documents, {
    ...(config.canonicalUrl !== undefined && {
      canonicalUrls: canonicalUrlPrefixes(config.canonicalUrl),
    }),
    ...(config.colocatedRoot !== undefined && {
      colocatedRoot: path.resolve(config.colocatedRoot),
    }),
  });
}

/**
 * Read a document's raw text: from the in-memory sources for bundles
 * without local files (remote), otherwise from disk under the root.
 */
export async function readBundleDocument(
  bundle: LoadedBundle,
  relPath: string,
): Promise<string> {
  if (bundle.sources !== undefined) {
    const source = bundle.sources.get(relPath);
    if (source === undefined) {
      throw new Error(`unknown document in bundle ${bundle.id}: ${relPath}`);
    }
    return source;
  }
  return fs.readFile(path.join(bundle.root, relPath), "utf8");
}

/**
 * Resolve concept-kind links against the loaded concept set. A `.md`
 * suffix is optional in link targets (Obsidian-style extensionless links
 * resolve too). Unresolved links are warnings, never errors (spec §5.3):
 * each one that plausibly targets a concept is marked `broken` and
 * reported as a missing-concept warning.
 */
function resolveLinks(
  concepts: Map<string, Concept>,
  reserved: ReservedFile[],
  problems: BundleProblem[],
): void {
  const directories = knownDirectories(concepts, reserved);
  const reservedPaths = new Set(reserved.map((file) => file.path));
  for (const concept of concepts.values()) {
    for (const link of concept.links) {
      if (link.kind !== "concept" || link.path === undefined) continue;
      const id = conceptIdFromPath(link.path);
      if (concepts.has(id)) {
        link.resolvedId = id;
      } else if (targetsMissingConcept(link.path, directories, reservedPaths)) {
        link.broken = true;
        problems.push({
          severity: "warning",
          path: concept.path,
          message: `link to missing concept: ${link.target}`,
        });
      }
    }
  }
}

/** Every directory (at any depth) holding a concept or reserved file. */
function knownDirectories(
  concepts: Map<string, Concept>,
  reserved: ReservedFile[],
): Set<string> {
  const directories = new Set<string>();
  const paths = [...concepts.values()].map((c) => c.path);
  paths.push(...reserved.map((file) => file.path));
  for (const relPath of paths) {
    let dir = path.posix.dirname(relPath);
    while (dir !== ".") {
      directories.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return directories;
}

/**
 * Whether an unresolved concept-kind link plausibly targets a concept the
 * bundle does not have: any `.md` target, and an extensionless target that
 * names neither an existing directory nor a reserved file. Trailing-slash
 * directory links and targets with another extension (assets) are exempt.
 */
function targetsMissingConcept(
  linkPath: string,
  directories: Set<string>,
  reservedPaths: Set<string>,
): boolean {
  if (linkPath.endsWith("/")) return false;
  if (linkPath.toLowerCase().endsWith(".md")) return true;
  if (path.posix.basename(linkPath).includes(".")) return false;
  if (reservedPaths.has(`${linkPath}.md`)) return false;
  return !directories.has(linkPath);
}

/**
 * The colocated siblings of a bundle: the other mounted bundles declaring
 * the same colocated root. Colocation is declared (`--colocated-bundles`),
 * never inferred from disk paths, so bundles without a colocatedRoot have
 * no siblings.
 */
export function colocatedSiblings(
  bundle: LoadedBundle,
  all: LoadedBundle[],
): LoadedBundle[] {
  if (bundle.colocatedRoot === undefined) return [];
  return all.filter(
    (b) => b.id !== bundle.id && b.colocatedRoot === bundle.colocatedRoot,
  );
}

/** Sibling concept an outside link resolves to (resolveOutsideLink). */
export interface OutsideLinkTarget {
  bundle: LoadedBundle;
  conceptId: string;
}

/**
 * Split an outside link's normalized `../…` path into the mounted sibling
 * its first segment names (folder name = bundle id) and the remaining path
 * inside that sibling. A bundle root is an immediate subdirectory of its
 * colocated root, so exactly one leading `../` lands in the root; any
 * further `..` escapes it. Undefined when the path escapes the root, stops
 * at the root level, or names no mounted sibling.
 */
function splitSiblingLink(
  linkPath: string,
  siblings: LoadedBundle[],
): { sibling: LoadedBundle; rest: string } | undefined {
  if (!linkPath.startsWith("../")) return undefined;
  const inside = linkPath.slice(3);
  if (inside === ".." || inside.startsWith("../")) return undefined;
  const slash = inside.indexOf("/");
  if (slash <= 0) return undefined;
  const sibling = siblings.find((b) => b.id === inside.slice(0, slash));
  if (sibling === undefined) return undefined;
  return { sibling, rest: inside.slice(slash + 1) };
}

/**
 * Resolve an `outside` link (a normalized `../…` path) from a colocated
 * bundle into a sibling concept: the first segment under the colocated root
 * names the sibling bundle, the remainder maps to a concept id with the
 * `.md` suffix optional, like body links. Undefined when the path escapes
 * the colocated root, names no mounted sibling, or the sibling has no such
 * concept.
 */
export function resolveOutsideLink(
  linkPath: string,
  siblings: LoadedBundle[],
): OutsideLinkTarget | undefined {
  const split = splitSiblingLink(linkPath, siblings);
  if (split === undefined) return undefined;
  const conceptId = conceptIdFromPath(split.rest);
  if (conceptId === "" || !split.sibling.concepts.has(conceptId)) return undefined;
  return { bundle: split.sibling, conceptId };
}

/**
 * Whether an outside link from a colocated bundle dangles: it points into a
 * mounted sibling at a concept the sibling does not have. Judged only inside
 * mounted siblings — loose files at the colocated root, unmounted folders,
 * and paths escaping the root are unjudgeable and stay silent — with the
 * same exemptions as in-bundle broken links (trailing-slash directory links,
 * non-md extensions, extensionless targets naming a sibling directory or
 * reserved file).
 */
export function outsideLinkDangles(
  linkPath: string,
  siblings: LoadedBundle[],
): boolean {
  const split = splitSiblingLink(linkPath, siblings);
  if (split === undefined) return false;
  const { sibling, rest } = split;
  if (rest === "" || sibling.concepts.has(conceptIdFromPath(rest))) return false;
  return targetsMissingConcept(
    rest,
    knownDirectories(sibling.concepts, sibling.reserved),
    new Set(sibling.reserved.map((file) => file.path)),
  );
}
