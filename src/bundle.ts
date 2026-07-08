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

  for (const document of [...documents].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const relPath = document.path;
    const reservedFile = isReserved(relPath);
    if (reservedFile) {
      reserved.push(reservedFile);
      // Only the bundle-root index.md may declare okf_version (spec §11).
      if (reservedFile.kind === "index" && !relPath.includes("/")) {
        okfVersion = declaredOkfVersion(document.source);
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

  resolveLinks(concepts, problems);
  return {
    id,
    root,
    concepts,
    reserved,
    problems,
    readOnly: options.readOnly ?? false,
    okfVersion,
    ...(options.keepSources && {
      sources: new Map(documents.map((d) => [d.path, d.source])),
    }),
    ...(options.canonicalUrls !== undefined &&
      options.canonicalUrls.length > 0 && { canonicalUrls: options.canonicalUrls }),
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
