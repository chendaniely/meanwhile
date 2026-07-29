import { describe, expect, it } from 'vitest';
import { Reader } from '../src/core/bytes.ts';
import { parseTiffExif } from '../src/core/exif.ts';
import { boxes, findHeicExif, isHeic, majorBrand, parseVideoMeta } from '../src/core/isobmff.ts';
import { buildHeic, buildMov, largeBox, box } from './fixtures/isobmff.ts';
import { TYPE_ASCII, buildTiff } from './fixtures/jpeg.ts';

const TAG_DATETIME_ORIGINAL = 0x9003;

const read = (bytes: Uint8Array) => new Reader(bytes);

// 2026-08-22T13:12:04Z
const SHOT_AT_UNIX = Date.UTC(2026, 7, 22, 13, 12, 4) / 1000;

describe('box walking', () => {
  it('finds the top-level boxes of a MOV', () => {
    const types = [...boxes(read(buildMov()))].map((b) => b.type);
    expect(types).toEqual(['ftyp', 'moov', 'mdat']);
  });

  it('handles the 64-bit largesize form', () => {
    // A 24-hour race produces files over 4GB, which must use this form.
    const bytes = new Uint8Array([...largeBox('moov', box('mvhd', new Array(100).fill(0)))]);
    const found = [...boxes(read(bytes))];
    expect(found).toHaveLength(1);
    expect(found[0]?.type).toBe('moov');
  });

  it('stops at a corrupt size rather than looping or throwing', () => {
    // Size 3 is impossible: the header alone is 8 bytes.
    const bytes = new Uint8Array([0, 0, 0, 3, 0x6d, 0x6f, 0x6f, 0x76, 0, 0, 0, 0]);
    expect(() => [...boxes(read(bytes))]).not.toThrow();
    expect([...boxes(read(bytes))]).toHaveLength(0);
  });

  it('reads the major brand', () => {
    expect(majorBrand(read(buildMov({ brand: 'qt  ' })))).toBe('qt  ');
    expect(majorBrand(read(buildMov({ brand: 'isom' })))).toBe('isom');
  });
});

describe('parseVideoMeta', () => {
  it('prefers Apple creationdate, which carries a real UTC offset', () => {
    const meta = parseVideoMeta(
      read(
        buildMov({
          mvhd: { createdUnix: SHOT_AT_UNIX },
          apple: { 'com.apple.quicktime.creationdate': '2026-08-22T06:12:04-0700' },
        }),
      ),
    );
    expect(meta?.creationDate).toBe('2026-08-22T06:12:04-07:00');
    // mvhd is still reported so the resolver can see both and choose.
    expect(meta?.mvhdDate).toBe('2026-08-22T13:12:04Z');
  });

  it('falls back to mvhd when Apple metadata is absent', () => {
    const meta = parseVideoMeta(read(buildMov({ mvhd: { createdUnix: SHOT_AT_UNIX } })));
    expect(meta?.creationDate).toBeUndefined();
    expect(meta?.mvhdDate).toBe('2026-08-22T13:12:04Z');
  });

  it('ignores an unset mvhd creation time instead of placing the clip in 1904', () => {
    const meta = parseVideoMeta(read(buildMov({ mvhd: {} })));
    expect(meta?.mvhdDate).toBeUndefined();
  });

  it('reads duration in seconds', () => {
    const meta = parseVideoMeta(
      read(buildMov({ mvhd: { createdUnix: SHOT_AT_UNIX, durationSeconds: 42.5, timescale: 600 } })),
    );
    expect(meta?.duration).toBeCloseTo(42.5, 3);
  });

  it('reads the 64-bit mvhd version', () => {
    const meta = parseVideoMeta(
      read(
        buildMov({ mvhd: { createdUnix: SHOT_AT_UNIX, durationSeconds: 10, version: 1 } }),
      ),
    );
    expect(meta?.mvhdDate).toBe('2026-08-22T13:12:04Z');
    expect(meta?.duration).toBeCloseTo(10, 3);
  });

  it('reads GPS from the Apple ISO 6709 key', () => {
    const meta = parseVideoMeta(
      read(
        buildMov({
          apple: { 'com.apple.quicktime.location.ISO6709': '+47.3900-121.3900+150.000/' },
        }),
      ),
    );
    expect(meta?.gps?.[0]).toBeCloseTo(47.39, 4);
    expect(meta?.gps?.[1]).toBeCloseTo(-121.39, 4);
  });

  it('ignores a 0,0 location', () => {
    const meta = parseVideoMeta(
      read(buildMov({ apple: { 'com.apple.quicktime.location.ISO6709': '+00.0000+000.0000/' } })),
    );
    expect(meta?.gps).toBeUndefined();
  });

  it('reads the older ©day atom when there is no keys/ilst', () => {
    const meta = parseVideoMeta(read(buildMov({ day: '2026-08-22T06:12:04-0700' })));
    expect(meta?.creationDate).toBe('2026-08-22T06:12:04-07:00');
  });

  it('reads Apple metadata whether or not meta is a FullBox', () => {
    // ISO BMFF says `meta` is a FullBox; some QuickTime writers emit it as a
    // plain container. Guessing wrong makes every child unreadable.
    const entries = { 'com.apple.quicktime.creationdate': '2026-08-22T06:12:04-0700' };
    const asFull = parseVideoMeta(read(buildMov({ apple: entries, metaAsFullBox: true })));
    const asPlain = parseVideoMeta(read(buildMov({ apple: entries, metaAsFullBox: false })));
    expect(asFull?.creationDate).toBe('2026-08-22T06:12:04-07:00');
    expect(asPlain?.creationDate).toBe('2026-08-22T06:12:04-07:00');
  });

  it('returns null when there is no moov at all', () => {
    expect(parseVideoMeta(read(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70])))).toBeNull();
  });

  it('survives truncation without throwing', () => {
    const mov = buildMov({
      mvhd: { createdUnix: SHOT_AT_UNIX, durationSeconds: 10 },
      apple: { 'com.apple.quicktime.creationdate': '2026-08-22T06:12:04-0700' },
    });
    for (let cut = 1; cut < mov.length; cut += 5) {
      expect(() => parseVideoMeta(read(mov.subarray(0, cut)))).not.toThrow();
    }
  });
});

describe('HEIC', () => {
  const tiff = buildTiff({
    exif: [{ tag: TAG_DATETIME_ORIGINAL, type: TYPE_ASCII, values: '2026:08:22 06:12:04' }],
  });

  it('recognises the brand', () => {
    expect(isHeic(read(buildHeic(tiff)))).toBe(true);
    expect(isHeic(read(buildMov()))).toBe(false);
  });

  it('follows iinf and iloc to the EXIF block', () => {
    // The whole point: an iPhone HEIC cannot be displayed outside Safari, but
    // its timestamp is readable, so the photo still lands in the right place.
    const block = findHeicExif(read(buildHeic(tiff)));
    expect(block).not.toBeNull();
    expect(parseTiffExif(block as Reader)?.dateTimeOriginal).toBe('2026-08-22T06:12:04');
  });

  it('handles every iloc version', () => {
    for (const ilocVersion of [0, 1, 2] as const) {
      const block = findHeicExif(read(buildHeic(tiff, { ilocVersion })));
      expect(parseTiffExif(block as Reader)?.dateTimeOriginal, `iloc v${ilocVersion}`).toBe(
        '2026-08-22T06:12:04',
      );
    }
  });

  it('returns null for a file with no EXIF item', () => {
    expect(findHeicExif(read(buildMov()))).toBeNull();
  });

  it('survives truncation without throwing', () => {
    const heic = buildHeic(tiff);
    for (let cut = 1; cut < heic.length; cut += 5) {
      expect(() => findHeicExif(read(heic.subarray(0, cut)))).not.toThrow();
    }
  });
});
