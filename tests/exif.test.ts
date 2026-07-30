import { describe, expect, it } from 'vitest';
import { Reader } from '../src/core/bytes.ts';
import { parseJpegExif, parseTiffExif } from '../src/core/exif.ts';
import { parseZonedInstant, zonedToInstant } from '../src/core/time.ts';
import {
  TYPE_ASCII,
  TYPE_LONG,
  TYPE_RATIONAL,
  TYPE_SHORT,
  buildJpeg,
  buildTiff,
  decoySegment,
  dmsRational,
  type TiffSpec,
} from './fixtures/jpeg.ts';

const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_ORIENTATION = 0x0112;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TAG_GPS_LAT_REF = 0x0001;
const TAG_GPS_LAT = 0x0002;
const TAG_GPS_LON_REF = 0x0003;
const TAG_GPS_LON = 0x0004;
const TAG_GPS_TIMESTAMP = 0x0007;
const TAG_GPS_DATESTAMP = 0x001d;

/** A typical iPhone-shaped photo: shutter time, UTC offset, GPS, and a fix. */
function typicalPhoto(overrides: Partial<TiffSpec> = {}): TiffSpec {
  return {
    ifd0: [
      { tag: TAG_MAKE, type: TYPE_ASCII, values: 'Apple' },
      { tag: TAG_MODEL, type: TYPE_ASCII, values: 'iPhone 15 Pro' },
      { tag: TAG_ORIENTATION, type: TYPE_SHORT, values: [6] },
    ],
    exif: [
      { tag: TAG_DATETIME_ORIGINAL, type: TYPE_ASCII, values: '2026:08:22 06:12:04' },
      { tag: TAG_OFFSET_TIME_ORIGINAL, type: TYPE_ASCII, values: '-07:00' },
      { tag: TAG_PIXEL_X, type: TYPE_LONG, values: [4032] },
      { tag: TAG_PIXEL_Y, type: TYPE_LONG, values: [3024] },
    ],
    gps: [
      { tag: TAG_GPS_LAT_REF, type: TYPE_ASCII, values: 'N' },
      { tag: TAG_GPS_LAT, type: TYPE_RATIONAL, values: dmsRational(47.39) },
      { tag: TAG_GPS_LON_REF, type: TYPE_ASCII, values: 'W' },
      { tag: TAG_GPS_LON, type: TYPE_RATIONAL, values: dmsRational(121.39) },
      { tag: TAG_GPS_DATESTAMP, type: TYPE_ASCII, values: '2026:08:22' },
      { tag: TAG_GPS_TIMESTAMP, type: TYPE_RATIONAL, values: [13, 1, 12, 1, 4, 1] },
    ],
    ...overrides,
  };
}

function parse(spec: TiffSpec) {
  return parseJpegExif(new Reader(buildJpeg(buildTiff(spec))));
}

describe('parseJpegExif', () => {
  it('reads every field a timeline needs', () => {
    const exif = parse(typicalPhoto());
    expect(exif).not.toBeNull();
    expect(exif?.make).toBe('Apple');
    expect(exif?.model).toBe('iPhone 15 Pro');
    expect(exif?.orientation).toBe(6);
    expect(exif?.width).toBe(4032);
    expect(exif?.height).toBe(3024);
    expect(exif?.dateTimeOriginal).toBe('2026-08-22T06:12:04');
    expect(exif?.offsetTimeOriginal).toBe('-07:00');
    expect(exif?.gpsInstant).toBe('2026-08-22T13:12:04Z');
  });

  it('reads coordinates with the right signs', () => {
    const exif = parse(typicalPhoto());
    const [lat, lon] = exif?.gps as [number, number];
    expect(lat).toBeCloseTo(47.39, 5);
    // W and S refs must come out negative, or the map lands on the wrong
    // side of the planet.
    expect(lon).toBeCloseTo(-121.39, 5);
  });

  it('works in both byte orders', () => {
    const big = parse(typicalPhoto({ littleEndian: false }));
    const little = parse(typicalPhoto({ littleEndian: true }));
    expect(little).toEqual(big);
  });

  it('skips other marker segments to find the EXIF one', () => {
    // A JFIF segment before APP1 is the common real-world layout, and its
    // body could contain the bytes "Exif" without being EXIF.
    const jpeg = buildJpeg(buildTiff(typicalPhoto()), [decoySegment(0xe0, 'JFIF\0Exif\0\0junk')]);
    const exif = parseJpegExif(new Reader(jpeg));
    expect(exif?.dateTimeOriginal).toBe('2026-08-22T06:12:04');
  });

  it('returns null for things that are not JPEGs', () => {
    expect(parseJpegExif(new Reader(new Uint8Array([0x00, 0x01, 0x02])))).toBeNull();
    expect(parseJpegExif(new Reader(new Uint8Array(0)))).toBeNull();
  });

  it('returns null for a JPEG with no EXIF at all', () => {
    expect(parseJpegExif(new Reader(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])))).toBeNull();
  });

  it('survives truncation without throwing', () => {
    const jpeg = buildJpeg(buildTiff(typicalPhoto()));
    // Every prefix must either parse or return null. A file cut short by a
    // failed download should cost one item, not the whole ingest.
    for (let cut = 1; cut < jpeg.length; cut += 7) {
      expect(() => parseJpegExif(new Reader(jpeg.subarray(0, cut)))).not.toThrow();
    }
  });
});

describe('timestamps that must be rejected', () => {
  const withDate = (value: string) =>
    parse(
      typicalPhoto({
        exif: [{ tag: TAG_DATETIME_ORIGINAL, type: TYPE_ASCII, values: value }],
        gps: [],
      }),
    )?.dateTimeOriginal;

  it('rejects the all-zero date a dead camera clock writes', () => {
    // Parsed naively this becomes a real date in the year zero, and the item
    // would sit at the far left of every timeline looking authoritative.
    expect(withDate('0000:00:00 00:00:00')).toBeUndefined();
  });

  it('rejects blank and malformed dates', () => {
    expect(withDate('    :  :     :  :  ')).toBeUndefined();
    expect(withDate('not a date')).toBeUndefined();
    expect(withDate('2026:13:01 00:00:00')).toBeUndefined();
    expect(withDate('2026:08:22 25:00:00')).toBeUndefined();
  });

  /**
   * "Accepted" used to be the end of this story, and it was the wrong end.
   * `parseZonedInstant` — and `new Date(…)` under it — is `Invalid Date` for
   * a ":60" second with or without an offset, so the item got an `at` that
   * nothing downstream could resolve: it failed to place, in silence, while
   * looking perfectly well timestamped. Neither a usable value nor a visible
   * gap. POSIX collapses a leap second onto the following second, so this does
   * too — at most one second of error, and a value that resolves.
   */
  it('normalizes a leap second to the following second, which is resolvable', () => {
    const at = withDate('2026:06:30 23:59:60');
    expect(at).toBe('2026-07-01T00:00:00');
    // The point of the change: the value can actually be placed.
    expect(parseZonedInstant(`${at as string}-07:00`)).not.toBeNull();
    expect(zonedToInstant(at as string, 'America/Denver')).not.toBeNull();
  });

  it('rolls only the minute when the leap second is not at midnight', () => {
    expect(withDate('2026:08:22 06:12:60')).toBe('2026-08-22T06:13:00');
    expect(withDate('2026:08:22 06:59:60')).toBe('2026-08-22T07:00:00');
  });

  it('still refuses a second of 61, which is a broken field and not a leap', () => {
    expect(withDate('2026:06:30 23:59:61')).toBeUndefined();
  });
});

describe('UTC offsets', () => {
  const withOffset = (value: string) =>
    parse(
      typicalPhoto({
        exif: [
          { tag: TAG_DATETIME_ORIGINAL, type: TYPE_ASCII, values: '2026:08:22 06:12:04' },
          { tag: TAG_OFFSET_TIME_ORIGINAL, type: TYPE_ASCII, values: value },
        ],
        gps: [],
      }),
    )?.offsetTimeOriginal;

  it('normalizes the forms cameras write', () => {
    expect(withOffset('-07:00')).toBe('-07:00');
    expect(withOffset('+0530')).toBe('+05:30');
    expect(withOffset('Z')).toBe('+00:00');
  });

  it('rejects nonsense rather than shifting the timeline by it', () => {
    expect(withOffset('-25:00')).toBeUndefined();
    expect(withOffset('lunchtime')).toBeUndefined();
  });
});

describe('GPS edge cases', () => {
  it('ignores exactly 0,0', () => {
    // Null Island. Devices that never got a fix write it, and honoring it
    // would drag the map to the Gulf of Guinea.
    const exif = parse(
      typicalPhoto({
        gps: [
          { tag: TAG_GPS_LAT_REF, type: TYPE_ASCII, values: 'N' },
          { tag: TAG_GPS_LAT, type: TYPE_RATIONAL, values: [0, 1, 0, 1, 0, 1] },
          { tag: TAG_GPS_LON_REF, type: TYPE_ASCII, values: 'E' },
          { tag: TAG_GPS_LON, type: TYPE_RATIONAL, values: [0, 1, 0, 1, 0, 1] },
        ],
      }),
    );
    expect(exif?.gps).toBeUndefined();
  });

  it('ignores a zero denominator instead of producing Infinity', () => {
    const exif = parse(
      typicalPhoto({
        gps: [
          { tag: TAG_GPS_LAT_REF, type: TYPE_ASCII, values: 'N' },
          { tag: TAG_GPS_LAT, type: TYPE_RATIONAL, values: [47, 0, 23, 1, 24, 1] },
          { tag: TAG_GPS_LON_REF, type: TYPE_ASCII, values: 'W' },
          { tag: TAG_GPS_LON, type: TYPE_RATIONAL, values: dmsRational(121.39) },
        ],
      }),
    );
    expect(exif?.gps).toBeUndefined();
  });

  it('ignores a GPS timestamp with no date to go with it', () => {
    const exif = parse(
      typicalPhoto({
        gps: [{ tag: TAG_GPS_TIMESTAMP, type: TYPE_RATIONAL, values: [13, 1, 12, 1, 4, 1] }],
      }),
    );
    expect(exif?.gpsInstant).toBeUndefined();
  });

  it('normalizes a leap second in the GPS fix too', () => {
    // A receiver is the one thing on a phone that genuinely knows about leap
    // seconds, and "…T23:59:60Z" is as unresolvable here as it is for the
    // shutter time.
    const exif = parse(
      typicalPhoto({
        gps: [
          { tag: TAG_GPS_DATESTAMP, type: TYPE_ASCII, values: '2026:06:30' },
          { tag: TAG_GPS_TIMESTAMP, type: TYPE_RATIONAL, values: [23, 1, 59, 1, 60, 1] },
        ],
      }),
    );
    expect(exif?.gpsInstant).toBe('2026-07-01T00:00:00Z');
    expect(parseZonedInstant(exif?.gpsInstant as string)).not.toBeNull();
  });

  it('reads a GPS time with a fractional second', () => {
    const exif = parse(
      typicalPhoto({
        gps: [
          { tag: TAG_GPS_DATESTAMP, type: TYPE_ASCII, values: '2026:08:22' },
          // 04.5 seconds, stored as 9/2.
          { tag: TAG_GPS_TIMESTAMP, type: TYPE_RATIONAL, values: [13, 1, 12, 1, 9, 2] },
        ],
      }),
    );
    expect(exif?.gpsInstant).toBe('2026-08-22T13:12:04Z');
  });
});

describe('parseTiffExif', () => {
  it('reads a bare TIFF block, as HEIC stores it', () => {
    const tiff = buildTiff(typicalPhoto());
    expect(parseTiffExif(new Reader(tiff))?.dateTimeOriginal).toBe('2026-08-22T06:12:04');
  });

  it('rejects a block with no byte-order mark', () => {
    expect(parseTiffExif(new Reader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))).toBeNull();
  });

  it('refuses an absurd entry count rather than grinding through it', () => {
    // 0xFFFF entries would be 780KB of reads on a file that is 8 bytes long.
    const bad = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0xff, 0xff]);
    expect(parseTiffExif(new Reader(bad))).toBeNull();
  });
});
