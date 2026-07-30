/**
 * EXIF: a narrow TIFF/IFD walker.
 *
 * Deliberately not a general EXIF library. It reads seven things — when the
 * shutter fired, what UTC offset the camera thought it was in, where on earth
 * it was, what time the satellites said it was, which way is up, how big the
 * image is, and which device took it (make and model) — because those are
 * the only fields a timeline needs, plus make/model, which device-based
 * grouping depends on. That scope is what keeps `src/core/` dependency-free.
 *
 * Everything returns null rather than throwing. A camera that writes
 * malformed EXIF should cost you one item in the unplaced tray, not the
 * whole ingest.
 */

import { Reader } from './bytes.ts';

export interface ExifData {
  /** Naive local time, normalized to "2026-08-22T13:12:04". No zone. */
  dateTimeOriginal?: string;
  /** UTC offset the camera recorded alongside it, e.g. "-07:00". */
  offsetTimeOriginal?: string;
  /** [latitude, longitude] in signed degrees. */
  gps?: [number, number];
  /**
   * UTC instant from GPSDateStamp + GPSTimeStamp, as "2026-08-22T13:12:04Z".
   *
   * WARNING, because a future reader will be tempted to trust this the most:
   * it is NOT the shutter time. It timestamps the GPS FIX, and a fix goes
   * stale. Measured across 134 real photos from a 100-mile race: median 11s
   * behind the shutter, p90 76s, worst 919s (15 minutes) — and the lag is
   * NON-UNIFORM, so photos taken seconds apart can collapse onto one instant
   * and lose the relative order this app exists to show. See CLAUDE.md's
   * "GPS time is NOT the shutter time" and `TIME_SOURCE_RANK` in schema.ts,
   * which ranks `gps` BELOW every shutter-derived source for exactly this
   * reason. Do not re-promote it.
   *
   * Its real jobs: a fallback timestamp when a file has no EXIF date at all,
   * and raw material for a future clock-offset estimator (`min(shutter -
   * gps)` across many photos, since fix staleness is one-sided).
   *
   * It is still device-INDEPENDENT, though — a satellite fix, not the
   * camera's clock — so `clockOffset` must never be applied to it (see
   * `isDeviceClock` in schema.ts). Ranked low for ACCURACY; still not the
   * device clock for PROVENANCE. Keep those two questions separate.
   */
  gpsInstant?: string;
  /** EXIF orientation, 1-8. */
  orientation?: number;
  width?: number;
  height?: number;
  make?: string;
  model?: string;
}

// IFD0
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

// Exif IFD
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_OFFSET_TIME = 0x9010;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;

// GPS IFD
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;
const TAG_GPS_TIMESTAMP = 0x0007;
const TAG_GPS_DATESTAMP = 0x001d;

/** Bytes per component, indexed by TIFF type code. 0 marks an unknown type. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const TYPE_ASCII = 2;
const TYPE_RATIONAL = 5;
const TYPE_SRATIONAL = 10;

type Value = number[] | string;

/**
 * Locate the EXIF block in a JPEG and parse it.
 *
 * Walks the marker segments rather than scanning for the "Exif" magic, so a
 * thumbnail or a comment containing those bytes cannot send us to the wrong
 * place.
 */
export function parseJpegExif(file: Reader): ExifData | null {
  if (file.u16(0) !== 0xffd8) return null; // not a JPEG

  let off = 2;
  while (off + 4 <= file.length) {
    if (file.u8(off) !== 0xff) {
      // Every marker starts with 0xFF, so landing on anything else means a
      // previous segment's length was wrong and we've drifted off the
      // boundary. Advance one byte at a time to resync on the next 0xFF
      // landmark, rather than trying to guess a segment length from data
      // that isn't a marker at all. The while condition above bounds this,
      // so a file that never resyncs just falls out of the loop and returns
      // null instead of looping forever.
      off++;
      continue;
    }
    const marker = file.u8(off + 1);
    if (marker === null) return null;

    // Standalone markers: no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    // Start of scan or end of image: compressed data from here on.
    if (marker === 0xda || marker === 0xd9) return null;

    const segLength = file.u16(off + 2);
    if (segLength === null || segLength < 2) return null;

    if (marker === 0xe1 && file.ascii(off + 4, 6) === 'Exif\0\0') {
      // Segment length counts itself but not the marker, so the TIFF block is
      // segLength - 2 - 6 bytes long starting after "Exif\0\0".
      const tiff = file.slice(off + 10, segLength - 8);
      return tiff ? parseTiffExif(tiff) : null;
    }
    off += 2 + segLength;
  }
  return null;
}

/**
 * Parse a TIFF block: an "II"/"MM" byte-order mark followed by IFDs.
 *
 * Exported separately because HEIC stores its EXIF as a bare TIFF block
 * rather than inside a JPEG segment. All offsets inside are relative to the
 * start of this block, which is why it must be passed as its own Reader.
 */
export function parseTiffExif(tiff: Reader): ExifData | null {
  const order = tiff.ascii(0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  if (tiff.u16(2, le) !== 42) return null;

  const ifd0Offset = tiff.u32(4, le);
  if (ifd0Offset === null) return null;

  const ifd0 = readIfd(tiff, ifd0Offset, le);
  if (!ifd0) return null;

  const out: ExifData = {};

  const make = asString(ifd0.get(TAG_MAKE));
  if (make) out.make = make;
  const model = asString(ifd0.get(TAG_MODEL));
  if (model) out.model = model;
  const orientation = asNumber(ifd0.get(TAG_ORIENTATION));
  if (orientation !== null && orientation >= 1 && orientation <= 8) {
    out.orientation = orientation;
  }

  // ---- Exif sub-IFD ----
  const exifOffset = asNumber(ifd0.get(TAG_EXIF_IFD));
  if (exifOffset !== null) {
    const exif = readIfd(tiff, exifOffset, le);
    if (exif) {
      const shot =
        normalizeExifDate(asString(exif.get(TAG_DATETIME_ORIGINAL))) ??
        normalizeExifDate(asString(exif.get(TAG_DATETIME_DIGITIZED)));
      if (shot) out.dateTimeOriginal = shot;

      const offset =
        normalizeOffset(asString(exif.get(TAG_OFFSET_TIME_ORIGINAL))) ??
        normalizeOffset(asString(exif.get(TAG_OFFSET_TIME)));
      if (offset) out.offsetTimeOriginal = offset;

      const w = asNumber(exif.get(TAG_PIXEL_X));
      const h = asNumber(exif.get(TAG_PIXEL_Y));
      if (w !== null && w > 0) out.width = w;
      if (h !== null && h > 0) out.height = h;
    }
  }

  // ---- GPS sub-IFD ----
  const gpsOffset = asNumber(ifd0.get(TAG_GPS_IFD));
  if (gpsOffset !== null) {
    const gps = readIfd(tiff, gpsOffset, le);
    if (gps) {
      const lat = dms(gps.get(TAG_GPS_LAT), asString(gps.get(TAG_GPS_LAT_REF)), 'S', 90);
      const lon = dms(gps.get(TAG_GPS_LON), asString(gps.get(TAG_GPS_LON_REF)), 'W', 180);
      // Exactly 0,0 is Null Island, off the coast of Ghana. Devices that
      // never got a fix write it, and honoring it would drag the map there.
      if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) {
        out.gps = [lat, lon];
      }

      const instant = gpsInstant(
        asString(gps.get(TAG_GPS_DATESTAMP)),
        asNumbers(gps.get(TAG_GPS_TIMESTAMP)),
      );
      if (instant) out.gpsInstant = instant;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// IFD walking
// ---------------------------------------------------------------------------

function readIfd(tiff: Reader, offset: number, le: boolean): Map<number, Value> | null {
  const count = tiff.u16(offset, le);
  if (count === null) return null;
  // A corrupt offset can claim tens of thousands of entries. Cap it: no real
  // IFD is anywhere near this large, and the cap bounds the work we do on
  // deliberately malformed input.
  if (count > 512) return null;

  const out = new Map<number, Value>();
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    const tag = tiff.u16(entry, le);
    const type = tiff.u16(entry + 2, le);
    const n = tiff.u32(entry + 4, le);
    if (tag === null || type === null || n === null) break;

    const size = TYPE_SIZE[type];
    if (!size) continue; // unknown type: skip the entry, keep the rest
    const total = size * n;
    if (total > tiff.length) continue;

    // Values of four bytes or fewer live inline in the entry; anything larger
    // is stored elsewhere in the block and the entry holds its offset.
    let valueAt: number;
    if (total <= 4) {
      valueAt = entry + 8;
    } else {
      const pointer = tiff.u32(entry + 8, le);
      if (pointer === null) continue;
      valueAt = pointer;
    }

    const value = readValue(tiff, valueAt, type, n, le);
    if (value !== null) out.set(tag, value);
  }
  return out;
}

function readValue(
  tiff: Reader,
  at: number,
  type: number,
  count: number,
  le: boolean,
): Value | null {
  if (type === TYPE_ASCII) return tiff.asciiZ(at, count);

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let v: number | null;
    switch (type) {
      case 1:
      case 7:
        v = tiff.u8(at + i);
        break;
      case 3:
        v = tiff.u16(at + i * 2, le);
        break;
      case 4:
        v = tiff.u32(at + i * 4, le);
        break;
      case 9:
        v = tiff.i32(at + i * 4, le);
        break;
      case TYPE_RATIONAL:
      case TYPE_SRATIONAL: {
        const read = type === TYPE_RATIONAL ? tiff.u32.bind(tiff) : tiff.i32.bind(tiff);
        const num = read(at + i * 8, le);
        const den = read(at + i * 8 + 4, le);
        // A zero denominator appears in the wild; treat the component as
        // absent rather than producing Infinity or NaN downstream.
        v = num === null || den === null || den === 0 ? null : num / den;
        break;
      }
      default:
        return null;
    }
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field normalisation
// ---------------------------------------------------------------------------

function asString(v: Value | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: Value | undefined): number | null {
  return Array.isArray(v) && v.length > 0 ? (v[0] as number) : null;
}

function asNumbers(v: Value | undefined): number[] | null {
  return Array.isArray(v) ? v : null;
}

/**
 * The naive timestamp one second after `HH:MM:59`, rolling the minute, hour,
 * day, month and year as the calendar requires.
 *
 * `Date` is used here purely as calendar arithmetic: the value is naive
 * wall-clock going in and naive wall-clock coming out, and no zone is applied
 * to it at any point. `setUTCFullYear` rather than `Date.UTC(y, …)` because
 * the latter maps a year of 0–99 to 1900–1999, which would silently move a
 * (admittedly absurd) year-0050 photograph by nineteen centuries.
 */
function nextSecondOf(y: number, mo: number, d: number, h: number, mi: number): string {
  const at = new Date(0);
  at.setUTCFullYear(y, mo - 1, d);
  at.setUTCHours(h, mi, 60, 0);
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${p(at.getUTCFullYear(), 4)}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}` +
    `T${p(at.getUTCHours())}:${p(at.getUTCMinutes())}:${p(at.getUTCSeconds())}`
  );
}

/**
 * EXIF writes "2026:08:22 13:12:04". Convert to "2026-08-22T13:12:04".
 *
 * Rejects the all-zero and blank forms that cameras with a dead clock write,
 * because "0000:00:00 00:00:00" parsed naively becomes a real date in the
 * year zero and would place the item at the far left of every timeline.
 *
 * A seconds field of 60 — a leap second, or far more often a camera rounding
 * artifact — is NORMALIZED to the following second rather than passed through.
 * `new Date("2026-06-30T23:59:60")` is `Invalid Date` in V8 with or without an
 * offset, so `parseZonedInstant` returns null for it: accepting the string as
 * written gave the item an `at` that nothing downstream could resolve, and it
 * failed to place in silence while looking perfectly well timestamped. That is
 * the worst of both outcomes this project chooses between — neither a usable
 * value nor a visible gap. POSIX collapses a leap second onto the following
 * second and so does this: at most one second of error, and a value that
 * works. A 61 is still refused; that is not a leap second, it is a broken
 * field.
 */
function normalizeExifDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (y === '0000' || mo === '00' || d === '00') return null;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 60) return null;
  if (Number(s) === 60) return nextSecondOf(Number(y), month, day, Number(h), Number(mi));
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** Accepts "+09:00", "-0700", "Z"; returns a canonical "+09:00" form. */
function normalizeOffset(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === 'Z') return '+00:00';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return null;
  const [, sign, h, mi] = m;
  if (Number(h) > 14 || Number(mi) > 59) return null;
  return `${sign}${h}:${mi}`;
}

/** GPSLatitude/GPSLongitude are three rationals: degrees, minutes, seconds. */
function dms(
  v: Value | undefined,
  ref: string | null,
  negativeRef: string,
  limit: number,
): number | null {
  const parts = asNumbers(v);
  if (!parts || parts.length < 3) return null;
  const [deg, min, sec] = parts as [number, number, number];
  if (![deg, min, sec].every(Number.isFinite)) return null;

  let value = deg + min / 60 + sec / 3600;
  if (ref && ref.toUpperCase().startsWith(negativeRef)) value = -value;
  if (!Number.isFinite(value) || Math.abs(value) > limit) return null;
  return value;
}

/**
 * Combine GPSDateStamp ("2026:08:22") and GPSTimeStamp (h, m, s rationals)
 * into a UTC instant. Both are always UTC by specification.
 */
function gpsInstant(dateStamp: string | null, time: number[] | null): string | null {
  if (!dateStamp || !time || time.length < 3) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})$/.exec(dateStamp.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  if (y === '0000' || mo === '00' || d === '00') return null;

  const [h, mi, s] = time as [number, number, number];
  if (![h, mi, s].every(Number.isFinite)) return null;
  if (h > 23 || mi > 59 || s >= 61) return null;

  // Same leap second, same dead end — see `normalizeExifDate`. A GPS receiver
  // is in fact the one thing on a phone that knows about leap seconds, so this
  // branch is likelier here than there.
  if (Math.floor(s) === 60) {
    return `${nextSecondOf(Number(y), Number(mo), Number(d), Math.floor(h), Math.floor(mi))}Z`;
  }

  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  return `${y}-${mo}-${d}T${pad(h)}:${pad(mi)}:${pad(s)}Z`;
}
