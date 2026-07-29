/**
 * ISO base media file format: MP4, MOV, and HEIC.
 *
 * All three are the same box structure, which is why one walker covers the
 * video the crew shot and the HEIC photos an iPhone produces by default.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID:
 *
 *   `mvhd` creation_time is specified as seconds since 1904-01-01 UTC. Apple
 *   writes LOCAL time there instead, with no indication of the zone. Reading
 *   it as UTC silently shifts every clip by the camera's UTC offset — hours,
 *   with no error and nothing on screen to notice.
 *
 *   Apple also writes `com.apple.quicktime.creationdate`, which carries a
 *   real offset ("2026-08-22T06:12:04-0700"). That key is authoritative and
 *   `mvhd` is a last resort, flagged in the UI wherever it is used.
 */

import { Reader } from './bytes.ts';

/** Seconds between 1904-01-01 (the ISO-BMFF epoch) and 1970-01-01. */
const EPOCH_1904_OFFSET = 2_082_844_800;

export interface Box {
  type: string;
  /** Offset of the box header within the reader it was found in. */
  start: number;
  /** First byte of the box's payload. */
  contentStart: number;
  /** One past the last byte of the box's payload. */
  contentEnd: number;
}

/**
 * Walk the boxes in a byte range.
 *
 * Stops rather than throws on a malformed size. Real files from real phones
 * contain trailing padding and occasional garbage, and hitting some is not a
 * reason to lose the metadata already found.
 */
export function* boxes(r: Reader, start = 0, end: number = r.length): Generator<Box> {
  let off = start;
  while (off + 8 <= end) {
    const size32 = r.u32(off);
    const type = r.ascii(off + 4, 4);
    if (size32 === null || type === null) return;

    let contentStart = off + 8;
    let boxEnd: number;
    if (size32 === 1) {
      // 64-bit size, for boxes over 4GB. A 24-hour race produces these.
      const large = r.u64(off + 8);
      if (large === null || large < 16) return;
      contentStart = off + 16;
      boxEnd = off + large;
    } else if (size32 === 0) {
      boxEnd = end; // runs to the end of the enclosing box
    } else if (size32 < 8) {
      return; // impossible; the file is corrupt from here on
    } else {
      boxEnd = off + size32;
    }

    if (boxEnd > end || boxEnd <= off) return;
    yield { type, start: off, contentStart, contentEnd: boxEnd };
    off = boxEnd;
  }
}

/** The first child of `parent` with the given type. */
export function childBox(r: Reader, parent: Box, type: string): Box | null {
  for (const b of boxes(r, parent.contentStart, parent.contentEnd)) {
    if (b.type === type) return b;
  }
  return null;
}

/** Follow a path of box types from the top level, e.g. ['moov', 'udta']. */
export function findPath(r: Reader, path: readonly string[]): Box | null {
  let current: Box | null = null;
  for (const type of path) {
    const range: Box = current ?? { type: '', start: 0, contentStart: 0, contentEnd: r.length };
    current = childBox(r, range, type);
    if (!current) return null;
  }
  return current;
}

/**
 * Reads `length` bytes at `offset`, or null past the end.
 *
 * The viewer implements this over a File; a future CLI would implement it
 * over a file handle. Core never opens anything itself.
 */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array | null>;

/**
 * Find a top-level box without reading the whole file.
 *
 * This matters more than it looks. Phones commonly write `moov` at the END of
 * a recording, because its size is not known until the recording stops. A
 * "read the first megabyte and parse it" approach therefore finds metadata on
 * some clips and silently misses it on others — and with a 4GB file, reading
 * the whole thing into memory to be sure is not an option.
 *
 * Box headers carry their own size, so the top level can be walked by hopping
 * from header to header, reading 16 bytes per hop. Locating `moov` in a
 * multi-gigabyte file usually costs three range reads.
 */
export async function locateBox(
  read: RangeReader,
  fileSize: number,
  type: string,
): Promise<{ offset: number; length: number } | null> {
  let off = 0;
  // Bounded so a file whose sizes form a cycle cannot spin forever.
  for (let hop = 0; hop < 1024 && off + 8 <= fileSize; hop++) {
    const header = await read(off, 16);
    if (!header || header.byteLength < 8) return null;
    const r = new Reader(header);

    const size32 = r.u32(0);
    const boxType = r.ascii(4, 4);
    if (size32 === null || boxType === null) return null;

    let size: number;
    if (size32 === 1) {
      const large = r.u64(8);
      if (large === null || large < 16) return null;
      size = large;
    } else if (size32 === 0) {
      size = fileSize - off;
    } else if (size32 < 8) {
      return null;
    } else {
      size = size32;
    }

    if (boxType === type) return { offset: off, length: Math.min(size, fileSize - off) };
    off += size;
  }
  return null;
}

/** The `ftyp` major brand, e.g. "qt  ", "isom", "heic". */
export function majorBrand(r: Reader): string | null {
  for (const b of boxes(r)) {
    if (b.type === 'ftyp') return r.ascii(b.contentStart, 4);
  }
  return null;
}

/**
 * `meta` is a FullBox in ISO BMFF (four bytes of version and flags before its
 * children) but a plain container in some QuickTime writers. Guessing wrong
 * makes every child unreadable, so detect it by checking whether a plausible
 * box header sits at offset 0.
 */
function metaChildrenStart(r: Reader, meta: Box): number {
  const plausible = (at: number): boolean => {
    const size = r.u32(at);
    const type = r.ascii(at + 4, 4);
    if (size === null || type === null) return false;
    if (size < 8 || at + size > meta.contentEnd) return false;
    return /^[\x20-\x7e]{4}$/.test(type);
  };
  if (plausible(meta.contentStart)) return meta.contentStart;
  if (plausible(meta.contentStart + 4)) return meta.contentStart + 4;
  return meta.contentStart + 4; // the standard layout, as a last guess
}

// ---------------------------------------------------------------------------
// Video metadata
// ---------------------------------------------------------------------------

export interface VideoMeta {
  /**
   * Apple's `com.apple.quicktime.creationdate`, normalized to an ISO string
   * WITH its UTC offset. Trustworthy.
   */
  creationDate?: string;
  /**
   * `mvhd` creation_time as an ISO string. NOT trustworthy — see the note at
   * the top of this file. Only used when `creationDate` is absent, and always
   * flagged in the UI.
   */
  mvhdDate?: string;
  /** Seconds. A clip is a point on the timeline today, a span later. */
  duration?: number;
  /** From `com.apple.quicktime.location.ISO6709`, if the device recorded it. */
  gps?: [number, number];
}

export function parseVideoMeta(r: Reader): VideoMeta | null {
  const moov = findPath(r, ['moov']);
  if (!moov) return null;

  const out: VideoMeta = {};

  // ---- mvhd: duration, and the last-resort timestamp ----
  const mvhd = childBox(r, moov, 'mvhd');
  if (mvhd) {
    const version = r.u8(mvhd.contentStart);
    const at = mvhd.contentStart + 4; // past version and flags
    let created: number | null;
    let timescale: number | null;
    let duration: number | null;

    if (version === 1) {
      created = r.u64(at);
      timescale = r.u32(at + 16);
      duration = r.u64(at + 20);
    } else {
      created = r.u32(at);
      timescale = r.u32(at + 8);
      duration = r.u32(at + 12);
    }

    // Zero means "not set", and would otherwise place the clip in 1904.
    if (created !== null && created > 0) {
      const unix = (created - EPOCH_1904_OFFSET) * 1000;
      const iso = isoFromEpochMs(unix);
      if (iso) out.mvhdDate = iso;
    }
    if (timescale && duration !== null && duration > 0 && timescale > 0) {
      out.duration = duration / timescale;
    }
  }

  // ---- Apple metadata under moov/udta/meta ----
  const udta = childBox(r, moov, 'udta');
  if (udta) {
    const apple = readAppleKeys(r, udta);
    const created = normalizeQuickTimeDate(apple.get('com.apple.quicktime.creationdate'));
    if (created) out.creationDate = created;

    const gps = parseIso6709(apple.get('com.apple.quicktime.location.ISO6709'));
    if (gps) out.gps = gps;

    // Older QuickTime writers use a "\xA9day" atom directly under udta.
    if (!out.creationDate) {
      const day = childBox(r, udta, '©day');
      if (day) {
        // [length:u16][language:u16][text]
        const len = r.u16(day.contentStart);
        const text = len === null ? null : r.ascii(day.contentStart + 4, len);
        const parsed = normalizeQuickTimeDate(text);
        if (parsed) out.creationDate = parsed;
      }
    }
  }

  return out;
}

/**
 * Read the `keys`/`ilst` pair Apple uses for QuickTime metadata.
 *
 * `keys` is a numbered list of key names; `ilst` holds values whose box type
 * is the 1-based index into that list. So the two must be read together.
 */
function readAppleKeys(r: Reader, udta: Box): Map<string, string> {
  const out = new Map<string, string>();
  const meta = childBox(r, udta, 'meta');
  if (!meta) return out;

  const childrenAt = metaChildrenStart(r, meta);
  let keysBox: Box | null = null;
  let ilstBox: Box | null = null;
  for (const b of boxes(r, childrenAt, meta.contentEnd)) {
    if (b.type === 'keys') keysBox = b;
    else if (b.type === 'ilst') ilstBox = b;
  }
  if (!keysBox || !ilstBox) return out;

  // keys: version+flags, entry_count, then [size][namespace][name] entries.
  const names: string[] = [];
  const count = r.u32(keysBox.contentStart + 4);
  if (count === null || count > 512) return out;
  let at = keysBox.contentStart + 8;
  for (let i = 0; i < count; i++) {
    const size = r.u32(at);
    if (size === null || size < 8 || at + size > keysBox.contentEnd) break;
    names.push(r.ascii(at + 8, size - 8) ?? '');
    at += size;
  }

  // ilst: each child's four "type" bytes are a 1-based index into `names`,
  // not a 4CC.
  for (const item of boxes(r, ilstBox.contentStart, ilstBox.contentEnd)) {
    const index = r.u32(item.start + 4);
    if (index === null || index < 1) continue;
    const key = names[index - 1];
    if (!key) continue;
    const data = childBox(r, item, 'data');
    if (!data) continue;
    // data: [type_indicator:u32][locale:u32][payload]
    const text = r.ascii(data.contentStart + 8, data.contentEnd - data.contentStart - 8);
    if (text) out.set(key, text.replace(/\0+$/, ''));
  }
  return out;
}

/** "2026-08-22T06:12:04-0700" and friends -> "2026-08-22T06:12:04-07:00". */
function normalizeQuickTimeDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(
    raw.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;

  const stamp = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (!zone) return stamp; // naive; the caller decides how to place it
  if (zone === 'Z') return `${stamp}Z`;
  const z = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  return `${stamp}${z}`;
}

/** ISO 6709: "+47.3900-121.3900+150.000/" */
function parseIso6709(raw: string | null | undefined): [number, number] | null {
  if (!raw) return null;
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(raw.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null; // Null Island; see exif.ts
  return [lat, lon];
}

function isoFromEpochMs(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  // Anything outside this window is a misread field, not a real recording.
  if (year < 1990 || year > 2100) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// HEIC
// ---------------------------------------------------------------------------

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

export function isHeic(r: Reader): boolean {
  const brand = majorBrand(r);
  return brand !== null && HEIC_BRANDS.has(brand);
}

/**
 * Locate the EXIF item inside a HEIC and return it as a TIFF block ready for
 * `parseTiffExif`.
 *
 * iPhones shoot HEIC by default and no browser but Safari can decode the
 * image — but the metadata is perfectly readable, so the photo still lands at
 * the right place on the timeline even when its tile shows a placeholder.
 *
 * Requires two boxes: `iinf` says which item ID holds the EXIF, and `iloc`
 * says where in the file that item's bytes are.
 */
export function findHeicExif(r: Reader): Reader | null {
  const meta = findPath(r, ['meta']);
  if (!meta) return null;
  const childrenAt = metaChildrenStart(r, meta);

  let iinf: Box | null = null;
  let iloc: Box | null = null;
  for (const b of boxes(r, childrenAt, meta.contentEnd)) {
    if (b.type === 'iinf') iinf = b;
    else if (b.type === 'iloc') iloc = b;
  }
  if (!iinf || !iloc) return null;

  const exifItemId = findExifItemId(r, iinf);
  if (exifItemId === null) return null;

  const extent = findItemExtent(r, iloc, exifItemId);
  if (!extent) return null;

  // The item payload begins with a 4-byte offset to the TIFF header, which is
  // almost always 0 but is not guaranteed to be.
  const skip = r.u32(extent.offset);
  if (skip === null) return null;
  const tiffAt = extent.offset + 4 + skip;
  const tiffLength = extent.length - 4 - skip;
  if (tiffLength <= 8) return null;
  return r.slice(tiffAt, tiffLength);
}

function findExifItemId(r: Reader, iinf: Box): number | null {
  const version = r.u8(iinf.contentStart);
  if (version === null) return null;
  // entry_count is 16-bit in version 0 and 32-bit thereafter.
  const entriesAt = iinf.contentStart + 4 + (version === 0 ? 2 : 4);

  for (const infe of boxes(r, entriesAt, iinf.contentEnd)) {
    if (infe.type !== 'infe') continue;
    const v = r.u8(infe.contentStart);
    if (v === null || v < 2) continue; // versions 0 and 1 carry no item_type
    const at = infe.contentStart + 4;
    const idSize = v === 2 ? 2 : 4;
    const id = v === 2 ? r.u16(at) : r.u32(at);
    const itemType = r.ascii(at + idSize + 2, 4);
    if (id !== null && itemType === 'Exif') return id;
  }
  return null;
}

function findItemExtent(r: Reader, iloc: Box, itemId: number): { offset: number; length: number } | null {
  const version = r.u8(iloc.contentStart);
  if (version === null) return null;
  let at = iloc.contentStart + 4;

  const sizes = r.u8(at);
  const baseAndIndex = r.u8(at + 1);
  if (sizes === null || baseAndIndex === null) return null;
  const offsetSize = sizes >> 4;
  const lengthSize = sizes & 0x0f;
  const baseOffsetSize = baseAndIndex >> 4;
  const indexSize = version >= 1 ? baseAndIndex & 0x0f : 0;
  at += 2;

  const itemCount = version < 2 ? r.u16(at) : r.u32(at);
  at += version < 2 ? 2 : 4;
  if (itemCount === null || itemCount > 4096) return null;

  const readSized = (offset: number, size: number): number | null => {
    if (size === 0) return 0;
    if (size === 4) return r.u32(offset);
    if (size === 8) return r.u64(offset);
    return null; // sizes other than 0, 4, 8 are legal but vanishingly rare
  };

  for (let i = 0; i < itemCount; i++) {
    const id = version < 2 ? r.u16(at) : r.u32(at);
    at += version < 2 ? 2 : 4;
    if (version >= 1) at += 2; // construction_method
    at += 2; // data_reference_index

    const baseOffset = readSized(at, baseOffsetSize);
    at += baseOffsetSize;
    const extentCount = r.u16(at);
    at += 2;
    if (id === null || baseOffset === null || extentCount === null) return null;

    for (let e = 0; e < extentCount; e++) {
      at += indexSize;
      const offset = readSized(at, offsetSize);
      at += offsetSize;
      const length = readSized(at, lengthSize);
      at += lengthSize;
      if (offset === null || length === null) return null;
      // Only the first extent is used: EXIF is never split across extents in
      // practice, and stitching them would mean copying bytes.
      if (id === itemId && e === 0) return { offset: baseOffset + offset, length };
    }
  }
  return null;
}
