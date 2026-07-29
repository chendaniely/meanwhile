/**
 * Builds byte-exact MP4/MOV/HEIC fixtures for the ISOBMFF parser tests.
 *
 * See the note in ./jpeg.ts about what synthetic fixtures can and cannot
 * prove.
 */

const EPOCH_1904_OFFSET = 2_082_844_800;

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}
function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function u64(v: number): number[] {
  return [...u32(Math.floor(v / 2 ** 32)), ...u32(v >>> 0)];
}
function fourcc(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** A box: [size][type][payload]. */
export function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...fourcc(type), ...payload];
}

/** A box using the 64-bit largesize form, for the over-4GB path. */
export function largeBox(type: string, payload: number[]): number[] {
  return [...u32(1), ...fourcc(type), ...u64(payload.length + 16), ...payload];
}

export function ftyp(brand: string): number[] {
  return box('ftyp', [...fourcc(brand), ...u32(0), ...fourcc(brand)]);
}

export interface MvhdSpec {
  /** Unix epoch seconds; converted to the 1904 epoch on the way in. */
  createdUnix?: number;
  durationSeconds?: number;
  timescale?: number;
  version?: 0 | 1;
}

export function mvhd(spec: MvhdSpec = {}): number[] {
  const version = spec.version ?? 0;
  const timescale = spec.timescale ?? 600;
  const created = spec.createdUnix === undefined ? 0 : spec.createdUnix + EPOCH_1904_OFFSET;
  const duration = Math.round((spec.durationSeconds ?? 0) * timescale);

  const head = [version, 0, 0, 0];
  const body =
    version === 1
      ? [...u64(created), ...u64(created), ...u32(timescale), ...u64(duration)]
      : [...u32(created), ...u32(created), ...u32(timescale), ...u32(duration)];
  // The rest of mvhd (rate, volume, matrix, next_track_ID) is never read, but
  // real files have it and its presence keeps offsets honest.
  return box('mvhd', [...head, ...body, ...new Array(80).fill(0)]);
}

/**
 * Apple's `keys` + `ilst` pair. `keys` numbers the key names; `ilst` holds
 * values whose box type is the 1-based index into that list.
 */
export function appleMeta(entries: Record<string, string>, asFullBox = true): number[] {
  const names = Object.keys(entries);

  const keysPayload = [
    ...[0, 0, 0, 0], // version + flags
    ...u32(names.length),
    ...names.flatMap((n) => [...u32(n.length + 8), ...fourcc('mdta'), ...ascii(n)]),
  ];

  const ilstPayload = names.flatMap((name, i) => {
    const value = entries[name] as string;
    const data = box('data', [...u32(1), ...u32(0), ...ascii(value)]);
    // The container's "type" field is the index, written as a raw u32.
    return [...u32(data.length + 8), ...u32(i + 1), ...data];
  });

  const children = [...box('hdlr', new Array(24).fill(0)), ...box('keys', keysPayload), ...box('ilst', ilstPayload)];
  return box('meta', asFullBox ? [0, 0, 0, 0, ...children] : children);
}

/** The older QuickTime date atom, written directly under `udta`. */
export function dayAtom(text: string): number[] {
  return box('©day', [...u16(text.length), ...u16(0), ...ascii(text)]);
}

export interface MovSpec {
  brand?: string;
  mvhd?: MvhdSpec | null;
  apple?: Record<string, string>;
  day?: string;
  metaAsFullBox?: boolean;
  largeMoov?: boolean;
}

export function buildMov(spec: MovSpec = {}): Uint8Array {
  const udtaChildren: number[] = [];
  if (spec.apple) udtaChildren.push(...appleMeta(spec.apple, spec.metaAsFullBox ?? true));
  if (spec.day) udtaChildren.push(...dayAtom(spec.day));

  const moovChildren: number[] = [];
  if (spec.mvhd !== null) moovChildren.push(...mvhd(spec.mvhd ?? {}));
  if (udtaChildren.length) moovChildren.push(...box('udta', udtaChildren));

  const moov = spec.largeMoov ? largeBox('moov', moovChildren) : box('moov', moovChildren);
  return new Uint8Array([...ftyp(spec.brand ?? 'qt  '), ...moov, ...box('mdat', [1, 2, 3, 4])]);
}

// ---------------------------------------------------------------------------
// HEIC
// ---------------------------------------------------------------------------

/**
 * A HEIC carrying `tiff` as its EXIF item.
 *
 * Layout mirrors a real file: `meta` declares the item and where its bytes
 * live, and the bytes themselves sit in `mdat` further down. That separation
 * is the whole reason `iloc` exists and is what the parser has to follow.
 */
export function buildHeic(tiff: Uint8Array, opts: { ilocVersion?: 0 | 1 | 2 } = {}): Uint8Array {
  const ilocVersion = opts.ilocVersion ?? 1;
  const EXIF_ITEM_ID = 3;

  // The payload is a 4-byte "offset to TIFF header" followed by the block.
  const itemPayload = [...u32(0), ...tiff];

  const infe = box('infe', [
    2,
    0,
    0,
    0, // version 2
    ...u16(EXIF_ITEM_ID),
    ...u16(0), // protection index
    ...fourcc('Exif'),
    0, // item_name, empty and NUL-terminated
  ]);
  const iinf = box('iinf', [0, 0, 0, 0, ...u16(1), ...infe]);

  // Built twice: once to learn its own size, then again with the real offset,
  // because the extent offset is absolute within the file.
  const makeIloc = (extentOffset: number): number[] => {
    const payload: number[] = [
      ilocVersion,
      0,
      0,
      0,
      0x44, // offset_size = 4, length_size = 4
      ilocVersion >= 1 ? 0x00 : 0x00, // base_offset_size = 0, index_size = 0
    ];
    payload.push(...(ilocVersion < 2 ? u16(1) : u32(1))); // item_count
    payload.push(...(ilocVersion < 2 ? u16(EXIF_ITEM_ID) : u32(EXIF_ITEM_ID)));
    if (ilocVersion >= 1) payload.push(...u16(0)); // construction_method
    payload.push(...u16(0)); // data_reference_index
    // base_offset_size is 0, so no base offset bytes
    payload.push(...u16(1)); // extent_count
    payload.push(...u32(extentOffset), ...u32(itemPayload.length));
    return box('iloc', payload);
  };

  const ftypBytes = ftyp('heic');
  const ilocSize = makeIloc(0).length;
  const metaSize = 8 + 4 + box('hdlr', new Array(24).fill(0)).length + iinf.length + ilocSize;
  // mdat header is 8 bytes; the item payload starts right after it.
  const extentOffset = ftypBytes.length + metaSize + 8;

  const meta = box('meta', [
    0,
    0,
    0,
    0,
    ...box('hdlr', new Array(24).fill(0)),
    ...iinf,
    ...makeIloc(extentOffset),
  ]);

  return new Uint8Array([...ftypBytes, ...meta, ...box('mdat', itemPayload)]);
}
