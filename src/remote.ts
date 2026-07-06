import fs from "node:fs/promises";
import zlib from "node:zlib";

import { buildBundle } from "./bundle.js";
import type { BundleDocument } from "./bundle.js";
import type { LoadedBundle, RemoteBundleConfig } from "./types.js";

/** Hard cap on markdown files fetched from one remote tree. */
export const MAX_REMOTE_FILES = 500;
/** Hard cap on the summed size (per GitHub's listing) of fetched files. */
export const MAX_REMOTE_BYTES = 10 * 1024 * 1024;
/** Hard cap on the (compressed) size of a downloaded archive. */
export const MAX_ARCHIVE_DOWNLOAD_BYTES = MAX_REMOTE_BYTES;
/** Decompression-bomb guard: cap on a gunzipped tar stream. */
const MAX_ARCHIVE_UNPACKED_BYTES = 8 * MAX_REMOTE_BYTES;

export interface GitHubTreeRef {
  owner: string;
  repo: string;
  ref: string;
  /** Repo-relative directory the bundle root maps to ("" for the repo root). */
  path: string;
}

const TREE_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/tree\/([^/\s]+)(?:\/(.+?))?\/?$/;

/**
 * Parse a public GitHub tree URL. Refs containing `/` (e.g. `feature/x`
 * branches) are not supported — the first path segment after `/tree/` is
 * taken as the ref.
 */
export function parseGitHubTreeUrl(url: string): GitHubTreeRef {
  const match = TREE_URL.exec(url.trim());
  if (!match) {
    throw new Error(
      `not a public GitHub tree URL (expected https://github.com/<owner>/<repo>/tree/<ref>[/<path>]): ${url}`,
    );
  }
  return { owner: match[1]!, repo: match[2]!, ref: match[3]!, path: match[4] ?? "" };
}

/** Convert a glob (`*`, `**`, `?`) into a regex over POSIX relative paths. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // NUL cannot appear in a path, so it safely shields `**` from the `*` pass.
  const pattern = escaped
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${pattern}$`);
}

function matchesFilters(
  relPath: string,
  include: string[] | undefined,
  exclude: string[] | undefined,
): boolean {
  if (include !== undefined && include.length > 0) {
    if (!include.some((glob) => globToRegExp(glob).test(relPath))) return false;
  }
  return !(exclude ?? []).some((glob) => globToRegExp(glob).test(relPath));
}

function tooManyFilesError(url: string): Error {
  return new Error(
    `remote bundle has too many files (limit ${MAX_REMOTE_FILES}): ${url}`,
  );
}

function bundleTooLargeError(url: string, totalBytes: number): Error {
  return new Error(
    `remote bundle is too large (${totalBytes} bytes, limit ${MAX_REMOTE_BYTES}): ${url}`,
  );
}

/** Shape of one GitHub contents-API directory entry (the fields we use). */
interface ContentsEntry {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  size?: unknown;
  download_url?: unknown;
}

interface RemoteFile {
  relPath: string;
  size: number;
  downloadUrl: string;
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "okf-mcp",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token !== undefined && token !== "") {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchOk(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Response> {
  const response = await fetchImpl(url, { headers: apiHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status}: ${url}`);
  }
  return response;
}

/**
 * List markdown files under the tree via the GitHub contents API,
 * skipping dot files/directories like the local walker does.
 */
async function listMarkdownFiles(
  fetchImpl: typeof fetch,
  tree: GitHubTreeRef,
  config: RemoteBundleConfig,
): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  const prefix = tree.path === "" ? "" : `${tree.path}/`;
  const queue = [tree.path];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const encoded = dir.split("/").map(encodeURIComponent).join("/");
    const url =
      `https://api.github.com/repos/${encodeURIComponent(tree.owner)}/` +
      `${encodeURIComponent(tree.repo)}/contents/${encoded}` +
      `?ref=${encodeURIComponent(tree.ref)}`;
    const entries = (await (await fetchOk(fetchImpl, url)).json()) as unknown;
    if (!Array.isArray(entries)) {
      throw new Error(`expected a directory listing from GitHub at: ${url}`);
    }
    for (const entry of entries as ContentsEntry[]) {
      if (typeof entry.name !== "string" || typeof entry.path !== "string") continue;
      if (entry.name.startsWith(".")) continue;
      if (entry.type === "dir") {
        queue.push(entry.path);
        continue;
      }
      if (entry.type !== "file" || !entry.name.toLowerCase().endsWith(".md")) continue;
      const relPath = entry.path.slice(prefix.length);
      if (!matchesFilters(relPath, config.include, config.exclude)) continue;
      if (typeof entry.download_url !== "string") continue;
      files.push({
        relPath,
        size: typeof entry.size === "number" ? entry.size : 0,
        downloadUrl: entry.download_url,
      });
      if (files.length > MAX_REMOTE_FILES) throw tooManyFilesError(config.url);
    }
  }
  return files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
}

type ArchiveKind = "tar.gz" | "zip";

/** Detect an archive source by extension (query strings ignored for URLs). */
function archiveKind(url: string): ArchiveKind | null {
  let pathname = url;
  if (/^https?:\/\//i.test(url)) {
    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }
  }
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

/** One regular file inside an archive; `data` decodes lazily (zip inflate). */
interface ArchiveEntry {
  path: string;
  size: number;
  data: () => Buffer;
}

/**
 * Fetch archive bytes from an http(s) URL or read them from a local
 * path, enforcing the compressed-size cap before anything is unpacked.
 * No auth headers are ever sent — archives may live on arbitrary hosts.
 */
async function fetchArchiveBytes(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Buffer> {
  const tooLarge = (size: number) =>
    new Error(
      `archive exceeds the download size limit (${size} bytes, limit ${MAX_ARCHIVE_DOWNLOAD_BYTES}): ${url}`,
    );
  if (!/^https?:\/\//i.test(url)) {
    const stats = await fs.stat(url);
    if (stats.size > MAX_ARCHIVE_DOWNLOAD_BYTES) throw tooLarge(stats.size);
    return fs.readFile(url);
  }
  const response = await fetchImpl(url, {
    headers: { "user-agent": "okf-mcp" },
  });
  if (!response.ok) {
    throw new Error(`archive download failed with status ${response.status}: ${url}`);
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_DOWNLOAD_BYTES) {
    throw tooLarge(declared);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_DOWNLOAD_BYTES) throw tooLarge(bytes.length);
  return bytes;
}

/** Read a NUL-terminated string field out of a tar header block. */
function tarString(header: Buffer, start: number, length: number): string {
  const nul = header.indexOf(0, start);
  const end = nul === -1 || nul > start + length ? start + length : nul;
  return header.toString("utf8", start, end);
}

/** Extract the `path` record from a pax extended header body. */
function paxPath(body: Buffer): string | null {
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) return null;
    const length = Number(body.toString("ascii", offset, space));
    if (!Number.isInteger(length) || length <= 0) return null;
    const record = body.toString("utf8", space + 1, offset + length - 1);
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    offset += length;
  }
  return null;
}

/**
 * Minimal tar reader: regular-file entries only, with ustar prefixes,
 * GNU long names ("L"), and pax `path` overrides ("x") supported.
 */
function parseTarEntries(tar: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let overrideName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    const size = parseInt(tarString(header, 124, 12).trim(), 8);
    if (!Number.isInteger(size) || size < 0) {
      throw new Error("malformed tar archive: bad size field");
    }
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length < size) throw new Error("truncated tar archive");
    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === "L") {
      const nul = body.indexOf(0);
      overrideName = body.toString("utf8", 0, nul === -1 ? body.length : nul);
    } else if (typeflag === "x" || typeflag === "g") {
      if (typeflag === "x") overrideName = paxPath(body) ?? overrideName;
    } else {
      if (typeflag === "0" || typeflag === "\0") {
        let name = tarString(header, 0, 100);
        if (header.toString("ascii", 257, 262) === "ustar") {
          const prefix = tarString(header, 345, 155);
          if (prefix !== "") name = `${prefix}/${name}`;
        }
        entries.push({ path: overrideName ?? name, size, data: () => body });
      }
      overrideName = null; // consumed by this entry, whatever its type
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** Decode one zip entry's bytes from its local file header. */
function readZipEntry(
  buf: Buffer,
  localOffset: number,
  method: number,
  compressedSize: number,
  size: number,
  name: string,
): Buffer {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`malformed zip archive: bad local header for ${name}`);
  }
  const nameLength = buf.readUInt16LE(localOffset + 26);
  const extraLength = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + compressedSize);
  if (raw.length < compressedSize) throw new Error("truncated zip archive");
  let data: Buffer;
  if (method === 0) {
    data = raw;
  } else if (method === 8) {
    data = zlib.inflateRawSync(raw, { maxOutputLength: size });
  } else {
    throw new Error(`unsupported zip compression method ${method}: ${name}`);
  }
  if (data.length !== size) {
    throw new Error(`zip entry size mismatch for ${name}`);
  }
  return data;
}

/** Minimal zip central-directory reader (no zip64 support). */
function parseZipEntries(buf: Buffer): ArchiveEntry[] {
  let eocd = -1;
  const scanFloor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("not a zip archive (missing end-of-central-directory record)");
  }
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("malformed zip archive: bad central directory");
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue; // directory entry
    entries.push({
      path: name,
      size,
      data: () => readZipEntry(buf, localOffset, method, compressedSize, size, name),
    });
  }
  return entries;
}

/**
 * Turn raw archive entries into bundle documents: reject traversal,
 * skip dot files/dirs and mac zip junk, strip the single top-level
 * directory GitHub-style source archives wrap around the tree, keep
 * only `.md` files matching the configured globs, and enforce the
 * same count/byte limits as the GitHub tree path.
 */
function archiveDocuments(
  entries: ArchiveEntry[],
  config: RemoteBundleConfig,
): BundleDocument[] {
  const files: { relPath: string; entry: ArchiveEntry }[] = [];
  for (const entry of entries) {
    const raw = entry.path;
    if (raw === "") continue;
    if (
      raw.startsWith("/") ||
      raw.includes("\\") ||
      raw.split("/").includes("..")
    ) {
      throw new Error(`archive entry escapes the bundle root: ${raw}`);
    }
    const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) continue;
    if (segments[0] === "__MACOSX") continue; // mac zip resource forks
    if (segments.some((s) => s.startsWith("."))) continue;
    files.push({ relPath: segments.join("/"), entry });
  }

  const roots = new Set(files.map((file) => file.relPath.split("/", 1)[0]));
  const stripRoot =
    roots.size === 1 && files.every((file) => file.relPath.includes("/"));

  const selected: { relPath: string; entry: ArchiveEntry }[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const relPath = stripRoot
      ? file.relPath.slice(file.relPath.indexOf("/") + 1)
      : file.relPath;
    if (!relPath.toLowerCase().endsWith(".md")) continue;
    if (!matchesFilters(relPath, config.include, config.exclude)) continue;
    selected.push({ relPath, entry: file.entry });
    if (selected.length > MAX_REMOTE_FILES) throw tooManyFilesError(config.url);
    totalBytes += file.entry.size;
  }
  if (totalBytes > MAX_REMOTE_BYTES) {
    throw bundleTooLargeError(config.url, totalBytes);
  }
  return selected.map(({ relPath, entry }) => ({
    path: relPath,
    source: entry.data().toString("utf8"),
  }));
}

/** Load a read-only bundle from a tar.gz/tgz/zip archive (URL or local path). */
async function loadArchiveBundle(
  kind: ArchiveKind,
  config: RemoteBundleConfig,
  fetchImpl: typeof fetch,
): Promise<LoadedBundle> {
  const bytes = await fetchArchiveBytes(fetchImpl, config.url);
  let entries: ArchiveEntry[];
  if (kind === "tar.gz") {
    let tar: Buffer;
    try {
      tar = zlib.gunzipSync(bytes, {
        maxOutputLength: MAX_ARCHIVE_UNPACKED_BYTES,
      });
    } catch (err) {
      throw new Error(`cannot decompress ${config.url}: ${(err as Error).message}`);
    }
    entries = parseTarEntries(tar);
  } else {
    entries = parseZipEntries(bytes);
  }
  return buildBundle(config.id, config.url, archiveDocuments(entries, config), {
    readOnly: true,
    keepSources: true,
  });
}

/**
 * Fetch a read-only OKF bundle from a public GitHub tree, or from a
 * `.tar.gz`/`.tgz`/`.zip` archive (any https URL, or a local path),
 * detected by extension. Only `.md` files are indexed, size and count
 * limits are enforced up front, and remote content is only ever parsed
 * as markdown — never executed. The result lives purely in memory
 * (sources kept for resource serving).
 */
export async function loadRemoteBundle(
  config: RemoteBundleConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedBundle> {
  const kind = archiveKind(config.url);
  if (kind !== null) return loadArchiveBundle(kind, config, fetchImpl);
  const tree = parseGitHubTreeUrl(config.url);
  const files = await listMarkdownFiles(fetchImpl, tree, config);

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_REMOTE_BYTES) {
    throw bundleTooLargeError(config.url, totalBytes);
  }

  const documents: BundleDocument[] = [];
  for (const file of files) {
    const response = await fetchOk(fetchImpl, file.downloadUrl);
    documents.push({ path: file.relPath, source: await response.text() });
  }
  return buildBundle(config.id, config.url, documents, {
    readOnly: true,
    keepSources: true,
  });
}
