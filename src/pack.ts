import zlib from "node:zlib";

import {
  bodyStartOffset,
  isCuratedIndex,
  renderIndexes,
  withPreservedFrontmatter,
} from "./authoring.js";
import { colocatedSiblings, readBundleDocument, resolveOutsideLink } from "./bundle.js";
import { citationPrefix } from "./canonical.js";
import { extractLinks } from "./parser.js";
import { matchesFilters } from "./remote.js";
import type { ArchiveKind } from "./remote.js";
import type { LoadedBundle } from "./types.js";

export type { ArchiveKind } from "./remote.js";

export interface PackOptions {
  /** Glob patterns over bundle-relative paths; when present, only matches pack. */
  include?: string[];
  /** Glob patterns over bundle-relative paths to skip. */
  exclude?: string[];
  /** Archive format to emit. Defaults to "tar.gz". */
  format?: ArchiveKind;
  /**
   * Every mounted bundle, so relative `../` links into colocated siblings can
   * be rewritten to the sibling's canonical concept URL in the archived copy.
   * Defaults to none: outside links then travel verbatim.
   */
  allBundles?: LoadedBundle[];
}

export interface PackResult {
  /** Archive bytes, ready to write to disk or upload. */
  bytes: Buffer;
  format: ArchiveKind;
  /** Bundle-relative paths packed into the archive, sorted. */
  files: string[];
}

/**
 * Pack a mounted bundle into a distributable archive (spec §1 exchange, §3
 * tarball/zip distribution) that loadRemoteBundle round-trips: concepts and
 * logs travel verbatim, while `index.md` files are regenerated in-memory from
 * the packed concept set so the archive is self-describing (§6) — curated
 * indexes (`generated: false`) travel verbatim instead, and the bundle root's
 * declared frontmatter is preserved with `okf_version` stamped when absent
 * (§11). Include/exclude globs use the same semantics loadRemoteBundle
 * applies, selecting concepts and logs; regenerated indexes are always
 * emitted, describing only what was packed. Read-only (remote) bundles pack
 * too — nothing is ever written to the source bundle.
 *
 * Relative `../<sibling>/...` links into colocated siblings (given
 * `allBundles`) only mean something while the on-disk layout holds, so the
 * archived copy carries the sibling's canonical concept URL instead (spec §8
 * citation form); a resolving link whose sibling has no canonical URL is an
 * error — silently packing it would ship a dead link.
 */
export async function packBundle(
  bundle: LoadedBundle,
  options: PackOptions = {},
): Promise<PackResult> {
  const { include, exclude } = options;
  const format = options.format ?? "tar.gz";
  const siblings = colocatedSiblings(bundle, options.allBundles ?? []);

  const concepts = new Map(
    [...bundle.concepts].filter(([, c]) => matchesFilters(c.path, include, exclude)),
  );

  const documents = new Map<string, string>();
  for (const concept of concepts.values()) {
    const source = await readBundleDocument(bundle, concept.path);
    documents.set(concept.path, rewriteColocatedLinks(source, concept.path, siblings));
  }
  for (const file of bundle.reserved) {
    if (file.kind !== "log") continue;
    if (!matchesFilters(file.path, include, exclude)) continue;
    documents.set(file.path, await readBundleDocument(bundle, file.path));
  }

  // Indexes for every directory of the packed subset; an existing index in a
  // directory left with no packed concepts is dropped (it would describe
  // excluded content).
  const existingIndexes = new Set(
    bundle.reserved.filter((f) => f.kind === "index").map((f) => f.path),
  );
  for (const [indexPath, rendered] of renderIndexes({ ...bundle, concepts })) {
    if (!existingIndexes.has(indexPath)) {
      documents.set(indexPath, rendered);
      continue;
    }
    const existing = await readBundleDocument(bundle, indexPath);
    if (isCuratedIndex(existing)) {
      documents.set(indexPath, existing);
    } else if (indexPath === "index.md") {
      documents.set(indexPath, withPreservedFrontmatter(existing, rendered));
    } else {
      documents.set(indexPath, rendered);
    }
  }

  // Wrap everything in a GitHub-style single top-level directory: the archive
  // reader strips it, so bundle-relative paths round-trip exactly even when
  // all packed files happen to share one subdirectory.
  const files = [...documents.keys()].sort();
  const entries = files.map((relPath) => ({
    path: `${bundle.id}/${relPath}`,
    data: Buffer.from(documents.get(relPath)!, "utf8"),
  }));
  const bytes =
    format === "zip" ? buildZip(entries) : zlib.gzipSync(buildTar(entries));
  return { bytes, format, files };
}

/**
 * Rewrite the `../` link targets in a concept document that resolve into a
 * mounted colocated sibling (resolveOutsideLink) to the sibling's canonical
 * concept URL — the citationPrefix (blob) form, with the `.md` path made
 * explicit and any #fragment/?query suffix carried over. Edits splice the
 * raw source at the parser's preserved target spans, so every byte outside
 * the rewritten targets is intact. Throws when a resolving link's sibling
 * has no canonical URL: the relative form is dead outside the layout and
 * there is nothing portable to rewrite it to.
 */
function rewriteColocatedLinks(
  source: string,
  conceptPath: string,
  siblings: LoadedBundle[],
): string {
  if (siblings.length === 0) return source;
  const bodyStart = bodyStartOffset(source);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const link of extractLinks(source.slice(bodyStart), conceptPath)) {
    if (link.kind !== "outside" || link.path === undefined) continue;
    const resolved = resolveOutsideLink(link.path, siblings);
    if (resolved === undefined) continue;
    const prefixes = resolved.bundle.canonicalUrls;
    if (prefixes === undefined || prefixes.length === 0) {
      throw new Error(
        `${conceptPath}: link "${link.target}" resolves into colocated sibling ` +
          `bundle "${resolved.bundle.id}", which has no canonical URL to rewrite ` +
          `it to — pass --canonical-url ${resolved.bundle.id}=<url> (or the ` +
          `colocated root's --canonical-url) before packing`,
      );
    }
    const targetPath = resolved.bundle.concepts.get(resolved.conceptId)!.path;
    const pathPart = link.target.split("#")[0]!.split("?")[0]!;
    const suffix = link.target.slice(pathPart.length);
    edits.push({
      start: bodyStart + link.targetStart,
      end: bodyStart + link.targetEnd,
      replacement: `${citationPrefix(prefixes)}/${targetPath}${suffix}`,
    });
  }
  let updated = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, edit.start) + edit.replacement + updated.slice(edit.end);
  }
  return updated;
}

interface PackEntry {
  path: string;
  data: Buffer;
}

function tarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii"); // mtime: epoch, deterministic
  header.write("        ", 148, 8, "ascii"); // checksum counts as spaces
  header.write(typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/** Zero padding to the next 512-byte tar block boundary. */
function tarPad(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

function buildTar(entries: PackEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (Buffer.byteLength(entry.path, "utf8") > 100) {
      // GNU long-name entry: the body carries the full NUL-terminated path,
      // overriding the (truncated) name field of the entry that follows.
      const name = Buffer.from(`${entry.path}\0`, "utf8");
      blocks.push(tarHeader("././@LongLink", name.length, "L"), name, tarPad(name.length));
    }
    blocks.push(
      tarHeader(entry.path, entry.data.length, "0"),
      entry.data,
      tarPad(entry.data.length),
    );
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
}

/** Table-driven CRC-32; node's zlib.crc32 needs 20.15+, this keeps engines honest. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a zip archive with deflated entries and a central directory. */
function buildZip(entries: PackEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const compressed = zlib.deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(8, 10); // method: deflate
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
