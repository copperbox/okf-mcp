import zlib from "node:zlib";

import { isCuratedIndex, renderIndexes, withPreservedFrontmatter } from "./authoring.js";
import { readBundleDocument } from "./bundle.js";
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
 */
export async function packBundle(
  bundle: LoadedBundle,
  options: PackOptions = {},
): Promise<PackResult> {
  const { include, exclude } = options;
  const format = options.format ?? "tar.gz";

  const concepts = new Map(
    [...bundle.concepts].filter(([, c]) => matchesFilters(c.path, include, exclude)),
  );

  const documents = new Map<string, string>();
  for (const concept of concepts.values()) {
    documents.set(concept.path, await readBundleDocument(bundle, concept.path));
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
