import { Inflate } from 'fflate';

/**
 * Bounded reading of a zip archive (an .xlsx). Entries are located through the central
 * directory, checked against their local headers, and inflated here with a running count
 * of the bytes really produced: declared sizes are never trusted to bound memory.
 */

/** The archive is not a zip we accept (corrupt, encrypted, inconsistent headers, ...). */
export class ZipInvalidError extends Error {
  constructor(reason: string) {
    super(`invalid zip: ${reason}`);
    this.name = 'ZipInvalidError';
  }
}

/** The kept entries would inflate past the limit. */
export class ZipTooLargeError extends Error {
  constructor() {
    super('zip inflates past the limit');
    this.name = 'ZipTooLargeError';
  }
}

interface Entry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_END64_LOCATOR = 0x07064b50;
const MAX32 = 0xffffffff;
/** Compressed bytes fed to the inflater at once: one push yields at most ~16 MB. */
const INFLATE_STEP = 16 * 1024;

function reader(bytes: Uint8Array) {
  const fail = () => {
    throw new ZipInvalidError('truncated');
  };
  const u16 = (at: number): number => {
    if (at < 0 || at + 2 > bytes.length) fail();
    return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  };
  const u32 = (at: number): number => u16(at) + u16(at + 2) * 0x10000;
  const u64 = (at: number): number => {
    const value = u32(at) + u32(at + 4) * 0x100000000;
    if (!Number.isSafeInteger(value)) throw new ZipInvalidError('size');
    return value;
  };
  return { u16, u32, u64 };
}

function findEnd(bytes: Uint8Array, u32: (at: number) => number): number {
  // The end record is 22 bytes plus a comment of at most 65,535 bytes.
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && u32(at) === SIG_END) return at;
  }
  throw new ZipInvalidError('no end record');
}

const decodeName = (raw: Uint8Array, utf8: boolean): string =>
  new TextDecoder(utf8 ? 'utf-8' : 'latin1').decode(raw);

function centralDirectory(bytes: Uint8Array): Entry[] {
  const { u16, u32, u64 } = reader(bytes);
  const end = findEnd(bytes, u32);
  let count = u16(end + 10);
  let at = u32(end + 16);
  if (count === 0xffff || at === MAX32) {
    const locator = end - 20;
    if (u32(locator) !== SIG_END64_LOCATOR) throw new ZipInvalidError('zip64 locator');
    const end64 = u64(locator + 8);
    if (u32(end64) !== SIG_END64) throw new ZipInvalidError('zip64 end record');
    count = u64(end64 + 32);
    at = u64(end64 + 48);
  }
  const entries: Entry[] = [];
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (u32(at) !== SIG_CENTRAL) throw new ZipInvalidError('central directory');
    const flags = u16(at + 8);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    let compressedSize = u32(at + 20);
    let size = u32(at + 24);
    let offset = u32(at + 42);
    const nameAt = at + 46;
    if (nameAt + nameLength > bytes.length) throw new ZipInvalidError('truncated');
    const nameBytes = bytes.subarray(nameAt, nameAt + nameLength);
    // Zip64: the 64-bit values replace the 32-bit fields set to 0xFFFFFFFF, in this order.
    const extraEnd = nameAt + nameLength + extraLength;
    for (let x = nameAt + nameLength; x + 4 <= extraEnd; x += 4 + u16(x + 2)) {
      if (u16(x) !== 0x0001) continue;
      let field = x + 4;
      if (size === MAX32) {
        size = u64(field);
        field += 8;
      }
      if (compressedSize === MAX32) {
        compressedSize = u64(field);
        field += 8;
      }
      if (offset === MAX32) offset = u64(field);
    }
    const name = decodeName(nameBytes, (flags & 0x0800) !== 0);
    if (names.has(name)) throw new ZipInvalidError('duplicate entry');
    names.add(name);
    entries.push({
      name,
      nameBytes,
      flags,
      method: u16(at + 10),
      compressedSize,
      size,
      offset,
    });
    at = extraEnd + commentLength;
  }
  return entries;
}

/** The entry's compressed bytes, after checking its local header agrees with the directory. */
function entryData(bytes: Uint8Array, entry: Entry): Uint8Array {
  const { u16, u32 } = reader(bytes);
  const at = entry.offset;
  if (u32(at) !== SIG_LOCAL) throw new ZipInvalidError('local header');
  const flags = u16(at + 6);
  const nameLength = u16(at + 26);
  const dataAt = at + 30 + nameLength + u16(at + 28);
  const name = bytes.subarray(at + 30, at + 30 + nameLength);
  if (
    u16(at + 8) !== entry.method ||
    name.length !== entry.nameBytes.length ||
    name.some((b, i) => b !== entry.nameBytes[i])
  ) {
    throw new ZipInvalidError('local header disagrees with the directory');
  }
  // Without a data descriptor (flag bit 3) the local sizes are real and must match the
  // directory (zip64 aside). Readers that trust local headers are not given this archive
  // anyway: the inflated entries are zipped again before parsing.
  const localCompressed = u32(at + 18);
  const localSize = u32(at + 22);
  if (
    (flags & 0x0008) === 0 &&
    localCompressed !== MAX32 &&
    localSize !== MAX32 &&
    (localCompressed !== entry.compressedSize || localSize !== entry.size)
  ) {
    throw new ZipInvalidError('local sizes disagree with the directory');
  }
  if (dataAt + entry.compressedSize > bytes.length) throw new ZipInvalidError('truncated');
  return bytes.subarray(dataAt, dataAt + entry.compressedSize);
}

/** Inflates `data`, failing as soon as the output passes the entry's declared size. */
function inflateEntry(data: Uint8Array, entry: Entry): Uint8Array {
  if (entry.method === 0) {
    if (data.length !== entry.size) throw new ZipInvalidError('stored size');
    return data;
  }
  const out = new Uint8Array(entry.size);
  let written = 0;
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > entry.size) throw new ZipInvalidError('inflates past its size');
    out.set(chunk, written);
    written += chunk.length;
  });
  try {
    for (let i = 0; i < data.length || i === 0; i += INFLATE_STEP) {
      inflater.push(data.subarray(i, i + INFLATE_STEP), i + INFLATE_STEP >= data.length);
    }
  } catch (err) {
    if (err instanceof ZipInvalidError) throw err;
    throw new ZipInvalidError('deflate stream');
  }
  if (written !== entry.size) throw new ZipInvalidError('inflates short of its size');
  return out;
}

/**
 * The entries whose names pass `keep`, inflated. Throws ZipTooLargeError when they would
 * produce more than `maxBytes`, ZipInvalidError for anything malformed or inconsistent.
 */
export function unzipBounded(
  bytes: Uint8Array,
  keep: (name: string) => boolean,
  maxBytes: number,
): Record<string, Uint8Array> {
  const entries = centralDirectory(bytes).filter((e) => !e.name.endsWith('/') && keep(e.name));
  let total = 0;
  for (const entry of entries) {
    if ((entry.flags & 0x0001) !== 0) throw new ZipInvalidError('encrypted');
    if (entry.method !== 0 && entry.method !== 8) throw new ZipInvalidError('compression method');
    total += entry.size;
  }
  // Declared sizes are checked first (cheap); inflating then never writes past them.
  if (total > maxBytes) throw new ZipTooLargeError();
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) files[entry.name] = inflateEntry(entryData(bytes, entry), entry);
  return files;
}
