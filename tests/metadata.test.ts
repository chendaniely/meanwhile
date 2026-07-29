import { describe, expect, it } from 'vitest';
import type { ExifData } from '../src/core/exif.ts';
import type { VideoMeta } from '../src/core/isobmff.ts';
import { locateBox, type RangeReader } from '../src/core/isobmff.ts';
import {
  classify,
  extensionOf,
  parseFilenameTime,
  photoMetadata,
  resolvePhotoTime,
  resolveVideoTime,
  videoMetadata,
} from '../src/core/metadata.ts';
import { buildMov } from './fixtures/isobmff.ts';

describe('classify', () => {
  it('sorts files by extension, case-insensitively', () => {
    expect(classify('IMG_4417.JPG')).toBe('photo');
    expect(classify('sam/IMG_4417.heic')).toBe('photo');
    expect(classify('IMG_4417.MOV')).toBe('video');
    expect(classify('clip.mp4')).toBe('video');
    expect(classify('notes.txt')).toBeNull();
    expect(classify('README')).toBeNull();
  });

  it('is not fooled by dots in directory names', () => {
    expect(extensionOf('my.photos/IMG_4417')).toBe('');
    expect(extensionOf('my.photos/IMG_4417.jpg')).toBe('jpg');
  });
});

describe('parseFilenameTime', () => {
  it('reads the common Android and Samsung patterns', () => {
    expect(parseFilenameTime('IMG_20260822_131204.jpg')).toBe('2026-08-22T13:12:04');
    expect(parseFilenameTime('VID_20260822_131204.mp4')).toBe('2026-08-22T13:12:04');
    expect(parseFilenameTime('20260822_131204.jpg')).toBe('2026-08-22T13:12:04');
    expect(parseFilenameTime('Screenshot_20260822-131204.png')).toBe('2026-08-22T13:12:04');
  });

  it('refuses date-only names like WhatsApp writes', () => {
    // Midnight is not where that photo was taken. Better unplaced than wrong.
    expect(parseFilenameTime('IMG-20260822-WA0001.jpg')).toBeNull();
  });

  it('refuses Pixel names, whose timestamps are UTC not local', () => {
    // Treating these as local would shift them by the UTC offset. Pixel files
    // carry full EXIF anyway, so declining to guess costs nothing.
    expect(parseFilenameTime('PXL_20260822_131204123.jpg')).toBeNull();
  });

  it('rejects impossible dates and times', () => {
    expect(parseFilenameTime('IMG_20261322_131204.jpg')).toBeNull();
    expect(parseFilenameTime('IMG_20260822_251204.jpg')).toBeNull();
    expect(parseFilenameTime('IMG_18260822_131204.jpg')).toBeNull();
  });

  it('ignores names with no timestamp in them', () => {
    expect(parseFilenameTime('IMG_4417.jpg')).toBeNull();
    expect(parseFilenameTime('finish line.jpg')).toBeNull();
    expect(parseFilenameTime('DSC00123.jpg')).toBeNull();
  });
});

describe('resolvePhotoTime priority', () => {
  const full: ExifData = {
    gpsInstant: '2026-08-22T13:12:04Z',
    dateTimeOriginal: '2026-08-22T06:12:04',
    offsetTimeOriginal: '-07:00',
  };

  it('prefers satellite time above everything', () => {
    expect(resolvePhotoTime(full, 'IMG_20260822_131204.jpg')).toEqual({
      at: '2026-08-22T13:12:04Z',
      timeSource: 'gps',
    });
  });

  it('falls back to the camera clock plus its recorded zone', () => {
    const { gpsInstant: _drop, ...noGps } = full;
    expect(resolvePhotoTime(noGps, 'IMG_4417.jpg')).toEqual({
      at: '2026-08-22T06:12:04-07:00',
      timeSource: 'exif-offset',
    });
  });

  it('falls back to a naive camera clock', () => {
    expect(resolvePhotoTime({ dateTimeOriginal: '2026-08-22T06:12:04' }, 'IMG_4417.jpg')).toEqual({
      at: '2026-08-22T06:12:04',
      timeSource: 'exif-naive',
    });
  });

  it('falls back to the filename when EXIF was stripped in transit', () => {
    expect(resolvePhotoTime(null, 'IMG_20260822_131204.jpg')).toEqual({
      at: '2026-08-22T13:12:04',
      timeSource: 'filename',
    });
  });

  it('gives up rather than guessing', () => {
    expect(resolvePhotoTime(null, 'IMG_4417.jpg')).toEqual({ timeSource: 'none' });
    expect(resolvePhotoTime({}, 'photo.jpg')).toEqual({ timeSource: 'none' });
  });
});

describe('resolveVideoTime priority', () => {
  it('prefers a zoned QuickTime creationdate', () => {
    const meta: VideoMeta = {
      creationDate: '2026-08-22T06:12:04-07:00',
      mvhdDate: '2026-08-22T13:12:04Z',
    };
    expect(resolveVideoTime(meta, 'IMG_0042.MOV')).toEqual({
      at: '2026-08-22T06:12:04-07:00',
      timeSource: 'qt-offset',
    });
  });

  it('marks an unzoned QuickTime date as naive', () => {
    expect(resolveVideoTime({ creationDate: '2026-08-22T06:12:04' }, 'clip.mov')).toEqual({
      at: '2026-08-22T06:12:04',
      timeSource: 'qt-naive',
    });
  });

  it('prefers a filename timestamp OVER mvhd', () => {
    // The load-bearing ordering. Apple writes local time into mvhd with no
    // zone, so reading it as UTC shifts the clip by hours; an Android
    // filename is honestly local and resolves correctly via event.timezone.
    const meta: VideoMeta = { mvhdDate: '2026-08-22T13:12:04Z' };
    expect(resolveVideoTime(meta, 'VID_20260822_061204.mp4')).toEqual({
      at: '2026-08-22T06:12:04',
      timeSource: 'filename',
    });
  });

  it('uses mvhd only as a last resort, and flags it', () => {
    const meta: VideoMeta = { mvhdDate: '2026-08-22T13:12:04Z' };
    expect(resolveVideoTime(meta, 'IMG_0042.MOV')).toEqual({
      at: '2026-08-22T13:12:04Z',
      timeSource: 'mvhd',
    });
  });

  it('gives up rather than guessing', () => {
    expect(resolveVideoTime(null, 'IMG_0042.MOV')).toEqual({ timeSource: 'none' });
  });
});

describe('metadata assembly', () => {
  it('carries EXIF extras onto the item', () => {
    const out = photoMetadata(
      {
        dateTimeOriginal: '2026-08-22T06:12:04',
        offsetTimeOriginal: '-07:00',
        gps: [47.39, -121.39],
        width: 4032,
        height: 3024,
        orientation: 6,
        make: 'Apple',
        model: 'iPhone 15 Pro',
      },
      'IMG_4417.jpg',
    );
    expect(out).toEqual({
      type: 'photo',
      at: '2026-08-22T06:12:04-07:00',
      timeSource: 'exif-offset',
      gps: [47.39, -121.39],
      width: 4032,
      height: 3024,
      orientation: 6,
      make: 'Apple',
      model: 'iPhone 15 Pro',
    });
  });

  it('carries duration and GPS onto a video item', () => {
    const out = videoMetadata(
      { creationDate: '2026-08-22T06:12:04-07:00', duration: 42.5, gps: [47.39, -121.39] },
      'IMG_0042.MOV',
    );
    expect(out).toEqual({
      type: 'video',
      at: '2026-08-22T06:12:04-07:00',
      timeSource: 'qt-offset',
      duration: 42.5,
      gps: [47.39, -121.39],
    });
  });

  it('omits absent fields rather than writing undefined into the manifest', () => {
    expect(Object.keys(photoMetadata(null, 'IMG_4417.jpg'))).toEqual(['type', 'timeSource']);
  });
});

describe('locateBox', () => {
  /** A RangeReader over an in-memory file, counting how much it reads. */
  function readerFor(bytes: Uint8Array) {
    const reads: Array<[number, number]> = [];
    const read: RangeReader = async (offset, length) => {
      reads.push([offset, length]);
      if (offset >= bytes.byteLength) return null;
      return bytes.subarray(offset, Math.min(offset + length, bytes.byteLength));
    };
    return { read, reads };
  }

  it('finds moov without reading the file body', async () => {
    // The point of this function: phones write moov at the END of a
    // recording, and a multi-gigabyte clip cannot be loaded into memory to
    // find it.
    const mov = buildMov({ mvhd: { createdUnix: 1_800_000_000 } });
    const { read, reads } = readerFor(mov);

    const found = await locateBox(read, mov.byteLength, 'moov');
    expect(found).not.toBeNull();
    expect(mov.subarray(found?.offset, (found?.offset ?? 0) + 8).subarray(4)).toEqual(
      new Uint8Array([0x6d, 0x6f, 0x6f, 0x76]),
    );
    // A handful of 16-byte header reads, not the whole file.
    expect(reads.every(([, length]) => length === 16)).toBe(true);
    expect(reads.length).toBeLessThan(5);
  });

  it('returns null when the box is not there', async () => {
    const mov = buildMov();
    const { read } = readerFor(mov);
    expect(await locateBox(read, mov.byteLength, 'trak')).toBeNull();
  });

  it('gives up on a corrupt size rather than spinning', async () => {
    const bytes = new Uint8Array([0, 0, 0, 3, 0x6d, 0x6f, 0x6f, 0x76, 0, 0, 0, 0, 0, 0, 0, 0]);
    const { read } = readerFor(bytes);
    expect(await locateBox(read, bytes.byteLength, 'moov')).toBeNull();
  });
});
