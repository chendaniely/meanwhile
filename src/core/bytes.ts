/**
 * A bounds-checked cursor over a byte range.
 *
 * Both parsers in this kernel walk untrusted binary written by cameras and
 * phones, much of it subtly malformed. Every read here returns null rather
 * than throwing when it would run off the end, so a truncated file yields
 * "no timestamp found" — which puts the item in the unplaced tray — instead
 * of taking down the whole ingest.
 *
 * Pure: Uint8Array and DataView are ECMAScript, present identically in Node
 * and the browser.
 */

export class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  /** Offset of byte 0 within the underlying buffer, for absolute seeks. */
  readonly base: number;

  constructor(bytes: Uint8Array, base = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.base = base;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  private ok(offset: number, size: number): boolean {
    return offset >= 0 && offset + size <= this.bytes.byteLength;
  }

  u8(offset: number): number | null {
    return this.ok(offset, 1) ? this.view.getUint8(offset) : null;
  }

  u16(offset: number, littleEndian = false): number | null {
    return this.ok(offset, 2) ? this.view.getUint16(offset, littleEndian) : null;
  }

  u32(offset: number, littleEndian = false): number | null {
    return this.ok(offset, 4) ? this.view.getUint32(offset, littleEndian) : null;
  }

  i32(offset: number, littleEndian = false): number | null {
    return this.ok(offset, 4) ? this.view.getInt32(offset, littleEndian) : null;
  }

  /**
   * 64-bit unsigned, as a JS number. Values above 2^53 lose precision, which
   * cannot happen for the fields we read (file offsets and 1904-epoch
   * seconds), so this is safe here and nowhere else.
   */
  u64(offset: number, littleEndian = false): number | null {
    if (!this.ok(offset, 8)) return null;
    return Number(this.view.getBigUint64(offset, littleEndian));
  }

  /** Latin-1 text. Used for four-character box types and EXIF ASCII fields. */
  ascii(offset: number, length: number): string | null {
    if (!this.ok(offset, length)) return null;
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.bytes[offset + i] as number);
    return out;
  }

  /**
   * A NUL-terminated ASCII field, with the NUL and surrounding whitespace
   * trimmed. `.trim()` strips both ends, not just the trailing padding EXIF
   * fields are usually written with — harmless for the fields this reads
   * (Make, Model, DateTimeOriginal, and friends), none of which carry a
   * meaningful leading space.
   */
  asciiZ(offset: number, maxLength: number): string | null {
    const raw = this.ascii(offset, maxLength);
    if (raw === null) return null;
    const end = raw.indexOf('\0');
    return (end === -1 ? raw : raw.slice(0, end)).trim();
  }

  /** A sub-range, carrying its absolute position so nested seeks stay right. */
  slice(offset: number, length: number): Reader | null {
    if (!this.ok(offset, length)) return null;
    return new Reader(this.bytes.subarray(offset, offset + length), this.base + offset);
  }
}

/** Convenience for callers holding an ArrayBuffer. */
export function readerOf(buffer: ArrayBuffer): Reader {
  return new Reader(new Uint8Array(buffer));
}
