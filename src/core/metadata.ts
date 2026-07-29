/**
 * Deciding when a file was taken.
 *
 * The parsers in ./exif.ts and ./isobmff.ts report what a file SAYS. This
 * module decides what to believe, and records that decision as a `timeSource`
 * so the viewer can show it and so ./time.ts knows whether the person's clock
 * offset applies.
 *
 * The ordering is the whole design. Satellite time beats a device clock that
 * knows its own zone, which beats a device clock that does not, which beats a
 * filename, which beats `mvhd`. Anything left goes to the unplaced tray
 * rather than being guessed at.
 */

import type { ExifData } from './exif.ts';
import type { VideoMeta } from './isobmff.ts';
import type { MediaKind, TimeSource } from './schema.ts';

export interface ResolvedCapture {
  /** ISO-8601, zoned or naive depending on `timeSource`. Absent if unplaced. */
  at?: string;
  timeSource: TimeSource;
}

export interface ExtractedMetadata extends ResolvedCapture {
  type: MediaKind;
  gps?: [number, number];
  /** Seconds; video only. */
  duration?: number;
  width?: number;
  height?: number;
  orientation?: number;
  make?: string;
  model?: string;
}

const PHOTO_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'heic',
  'heif',
  'png',
  'webp',
  'avif',
  'tif',
  'tiff',
  'gif',
  'dng',
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp', 'mts']);

/** Formats whose bytes this kernel can read metadata out of. */
const EXIF_EXTENSIONS = new Set(['jpg', 'jpeg', 'jpe', 'tif', 'tiff', 'dng']);
const ISOBMFF_EXTENSIONS = new Set(['heic', 'heif', 'avif', 'mp4', 'mov', 'm4v', '3gp']);

export function extensionOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

export function classify(filename: string): MediaKind | null {
  const ext = extensionOf(filename);
  if (PHOTO_EXTENSIONS.has(ext)) return 'photo';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return null;
}

export function hasExifContainer(filename: string): boolean {
  return EXIF_EXTENSIONS.has(extensionOf(filename));
}

export function hasIsobmffContainer(filename: string): boolean {
  return ISOBMFF_EXTENSIONS.has(extensionOf(filename));
}

/**
 * A naive local timestamp encoded in a filename, e.g. `IMG_20260822_131204`.
 *
 * Deliberately conservative. Two patterns are excluded on purpose:
 *
 *   - Date-only names, as WhatsApp writes (`IMG-20260822-WA0001`). Midnight
 *     is not where that photo was taken, and putting it there would be a
 *     confident lie.
 *   - Pixel's `PXL_` names, whose timestamps are UTC rather than local.
 *     Treating them as local would shift them by the UTC offset. Pixel photos
 *     carry full EXIF anyway, so nothing is lost by declining to guess.
 */
export function parseFilenameTime(filename: string): string | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  if (/^PXL_/i.test(base)) return null;

  // IMG_20260822_131204 / VID_20260822_131204 / 20260822_131204 /
  // Screenshot_20260822-131204
  const m = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[-_ T]?(\d{2})(\d{2})(\d{2})(?![0-9])/.exec(base);
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  const year = Number(y);
  if (year < 1990 || year > 2100) return null;
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  if (Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;

  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

/** Pick the most trustworthy timestamp available for a still image. */
export function resolvePhotoTime(exif: ExifData | null, filename: string): ResolvedCapture {
  // 1. Satellites. Immune to the camera's clock being wrong.
  if (exif?.gpsInstant) return { at: exif.gpsInstant, timeSource: 'gps' };

  // 2. The camera's clock, plus the zone it believed it was in.
  if (exif?.dateTimeOriginal && exif.offsetTimeOriginal) {
    return { at: `${exif.dateTimeOriginal}${exif.offsetTimeOriginal}`, timeSource: 'exif-offset' };
  }

  // 3. The camera's clock alone. Needs event.timezone to become an instant.
  if (exif?.dateTimeOriginal) {
    return { at: exif.dateTimeOriginal, timeSource: 'exif-naive' };
  }

  // 4. The filename, for files whose EXIF was stripped in transit.
  const fromName = parseFilenameTime(filename);
  if (fromName) return { at: fromName, timeSource: 'filename' };

  return { timeSource: 'none' };
}

/** Pick the most trustworthy timestamp available for a video. */
export function resolveVideoTime(meta: VideoMeta | null, filename: string): ResolvedCapture {
  // 1. Apple's creationdate, when it carries a real UTC offset.
  if (meta?.creationDate) {
    const zoned = /(Z|[+-]\d{2}:\d{2})$/.test(meta.creationDate);
    return { at: meta.creationDate, timeSource: zoned ? 'qt-offset' : 'qt-naive' };
  }

  // 2. The filename, BEFORE mvhd. Android writes local wall-clock there,
  //    which resolves correctly through event.timezone — whereas mvhd may be
  //    local time mislabelled as UTC, which resolves to the wrong hour.
  const fromName = parseFilenameTime(filename);
  if (fromName) return { at: fromName, timeSource: 'filename' };

  // 3. mvhd. Nominally UTC; Apple writes local time here with no zone, so
  //    this is the last resort and is always flagged in the UI.
  if (meta?.mvhdDate) return { at: meta.mvhdDate, timeSource: 'mvhd' };

  return { timeSource: 'none' };
}

/** Assemble the item fields for a photo from its parsed EXIF. */
export function photoMetadata(exif: ExifData | null, filename: string): ExtractedMetadata {
  const out: ExtractedMetadata = { type: 'photo', ...resolvePhotoTime(exif, filename) };
  if (exif?.gps) out.gps = exif.gps;
  if (exif?.width) out.width = exif.width;
  if (exif?.height) out.height = exif.height;
  if (exif?.orientation) out.orientation = exif.orientation;
  if (exif?.make) out.make = exif.make;
  if (exif?.model) out.model = exif.model;
  return out;
}

/** Assemble the item fields for a video from its parsed container metadata. */
export function videoMetadata(meta: VideoMeta | null, filename: string): ExtractedMetadata {
  const out: ExtractedMetadata = { type: 'video', ...resolveVideoTime(meta, filename) };
  if (meta?.gps) out.gps = meta.gps;
  if (meta?.duration !== undefined) out.duration = meta.duration;
  return out;
}
