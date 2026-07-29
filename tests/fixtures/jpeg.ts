/**
 * Builds byte-exact JPEG/TIFF fixtures for the EXIF parser tests.
 *
 * Synthetic rather than checked-in camera files: these are a few hundred
 * bytes, they exercise both byte orders and the inline/out-of-line value
 * split deliberately, and the expected values are known by construction
 * rather than by trusting some other tool's reading.
 *
 * The risk of a builder-plus-parser pair is that both could share the same
 * misunderstanding of the format and agree with each other while being wrong.
 * That is what verification against real camera files is for; it is not
 * something a synthetic fixture can prove on its own.
 */

export const TYPE_BYTE = 1;
export const TYPE_ASCII = 2;
export const TYPE_SHORT = 3;
export const TYPE_LONG = 4;
export const TYPE_RATIONAL = 5;

export interface Tag {
  tag: number;
  type: number;
  /** Numbers for numeric types; a string for ASCII. Rationals are [n, d] pairs. */
  values: number[] | string;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

function componentCount(t: Tag): number {
  if (typeof t.values === 'string') return t.values.length + 1; // + NUL
  return t.type === TYPE_RATIONAL ? t.values.length / 2 : t.values.length;
}

function byteLength(t: Tag): number {
  const per = { [TYPE_BYTE]: 1, [TYPE_ASCII]: 1, [TYPE_SHORT]: 2, [TYPE_LONG]: 4, [TYPE_RATIONAL]: 8 }[
    t.type
  ];
  if (per === undefined) throw new Error(`fixture builder: unsupported TIFF type ${t.type}`);
  return componentCount(t) * per;
}

class Writer {
  bytes: number[] = [];
  readonly le: boolean;

  // Written out longhand rather than as a parameter property: Node's
  // type-stripping cannot handle those, and these fixtures are loaded by
  // `node scripts/inspect-media.ts` as well as by vitest.
  constructor(le: boolean) {
    this.le = le;
  }

  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    const b = [(v >> 8) & 0xff, v & 0xff];
    this.bytes.push(...(this.le ? b.reverse() : b));
  }
  u32(v: number) {
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    this.bytes.push(...(this.le ? b.reverse() : b));
  }
  /** Overwrite four bytes already emitted, once a forward offset is known. */
  patch32(offset: number, v: number) {
    const tmp = new Writer(this.le);
    tmp.u32(v);
    for (let i = 0; i < 4; i++) this.bytes[offset + i] = tmp.bytes[i] as number;
  }
}

function writeTagValue(w: Writer, t: Tag): void {
  if (typeof t.values === 'string') {
    for (const ch of t.values) w.u8(ch.charCodeAt(0));
    w.u8(0);
    return;
  }
  for (const v of t.values) {
    if (t.type === TYPE_BYTE) w.u8(v);
    else if (t.type === TYPE_SHORT) w.u16(v);
    else w.u32(v); // LONG, and both halves of each RATIONAL
  }
}

export interface TiffSpec {
  littleEndian?: boolean;
  ifd0?: Tag[];
  exif?: Tag[];
  gps?: Tag[];
}

/** A complete TIFF block: byte-order mark, IFD0, and any sub-IFDs. */
export function buildTiff(spec: TiffSpec): Uint8Array {
  const le = spec.littleEndian ?? false;
  const ifd0 = [...(spec.ifd0 ?? [])];
  const exif = spec.exif;
  const gps = spec.gps;

  // Sub-IFD pointers are ordinary IFD0 entries; add them so the counts and
  // the layout below agree.
  if (exif) ifd0.push({ tag: TAG_EXIF_IFD, type: TYPE_LONG, values: [0] });
  if (gps) ifd0.push({ tag: TAG_GPS_IFD, type: TYPE_LONG, values: [0] });

  const ifdSize = (n: number) => 2 + 12 * n + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0.length);
  const gpsAt = exifAt + (exif ? ifdSize(exif.length) : 0);
  const heapAt = gpsAt + (gps ? ifdSize(gps.length) : 0);

  const w = new Writer(le);
  // --- header ---
  w.u8(le ? 0x49 : 0x4d);
  w.u8(le ? 0x49 : 0x4d);
  w.u16(42);
  w.u32(ifd0At);

  const heap = new Writer(le);
  const patches: Array<{ at: number; value: number }> = [];

  const writeIfd = (tags: Tag[], nextOffset: number) => {
    w.u16(tags.length);
    for (const t of tags) {
      w.u16(t.tag);
      w.u16(t.type);
      w.u32(componentCount(t));
      const size = byteLength(t);
      if (size <= 4) {
        // Inline: the value sits in the entry, left-aligned and zero-padded.
        const start = w.bytes.length;
        writeTagValue(w, t);
        while (w.bytes.length < start + 4) w.u8(0);
      } else {
        const entryValueAt = w.bytes.length;
        w.u32(0); // placeholder, patched once the heap position is known
        patches.push({ at: entryValueAt, value: heapAt + heap.bytes.length });
        writeTagValue(heap, t);
        if (heap.bytes.length % 2 === 1) heap.u8(0); // TIFF wants word alignment
      }
    }
    w.u32(nextOffset);
  };

  writeIfd(ifd0, 0);
  if (exif) writeIfd(exif, 0);
  if (gps) writeIfd(gps, 0);

  for (const p of patches) w.patch32(p.at, p.value);

  // Point the sub-IFD entries at the sub-IFDs now that offsets are settled.
  const pointerValueAt = (index: number) => ifd0At + 2 + index * 12 + 8;
  let idx = ifd0.length - (exif ? 1 : 0) - (gps ? 1 : 0);
  if (exif) w.patch32(pointerValueAt(idx++), exifAt);
  if (gps) w.patch32(pointerValueAt(idx), gpsAt);

  return new Uint8Array([...w.bytes, ...heap.bytes]);
}

/** A minimal but structurally valid JPEG carrying the given TIFF block. */
export function buildJpeg(tiff: Uint8Array, extraSegments: Uint8Array[] = []): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI

  for (const seg of extraSegments) out.push(...seg);

  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
  const segLength = payload.length + 2;
  out.push(0xff, 0xe1, (segLength >> 8) & 0xff, segLength & 0xff, ...payload);

  out.push(0xff, 0xd9); // EOI
  return new Uint8Array(out);
}

/** An APP0/JFIF-style segment, for testing that the marker walk skips it. */
export function decoySegment(marker: number, body: string): Uint8Array {
  const bytes = [...body].map((c) => c.charCodeAt(0));
  const len = bytes.length + 2;
  return new Uint8Array([0xff, marker, (len >> 8) & 0xff, len & 0xff, ...bytes]);
}

/** Degrees as the three RATIONAL pairs EXIF stores for a coordinate. */
export function dmsRational(degrees: number): number[] {
  const abs = Math.abs(degrees);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  // Kept as an exact rational so the fixture's expected value is not itself
  // subject to floating-point rounding.
  const secondsTimes100 = Math.round((abs - d - m / 60) * 3600 * 100);
  return [d, 1, m, 1, secondsTimes100, 100];
}
