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
  /** Slug of make+model, e.g. "google-pixel-8-pro". Absent if unknown. */
  device?: string;
}

/**
 * A stable id for the device that took a file.
 *
 * The main way media arrives is a Google Photos album download, which is a
 * FLAT folder of everyone's photos mixed together — so "the folder name is
 * the person" has nothing to work with. The device is the next best signal,
 * and it is usually one device per person.
 */
export function deviceIdOf(make?: string, model?: string): string | undefined {
  const raw = [make, model].filter(Boolean).join(' ').trim();
  if (!raw) return undefined;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
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

/**
 * A GPS track exported from a watch: the course spine.
 *
 * Not media, so it is deliberately not part of `classify` — but the folder
 * walker must pick it up, because dropping the file in with the photos is far
 * kinder than asking for it separately.
 */
export function isTrackFile(filename: string): boolean {
  const ext = extensionOf(filename);
  return ext === 'gpx' || ext === 'tcx';
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

export interface FilenameTime {
  at: string;
  /** True when the encoded time is UTC rather than naive local. */
  zoned: boolean;
}

/**
 * A timestamp encoded in a filename.
 *
 * Deliberately conservative about which patterns it trusts:
 *
 *   - **`PXL_` (Pixel) names are UTC, not local.** Confirmed three ways
 *     against real files: against a duplicate whose naive EXIF read six hours
 *     earlier in a UTC-6 zone, against `mvhd` minus clip duration, and
 *     against a zoned shutter time that matched to the second. Reading them
 *     as local would shift every one by the UTC offset.
 *   - **Everything else is naive local**, which is what Samsung, Android, and
 *     screenshot names encode.
 *   - **Date-only names are refused**, as WhatsApp writes
 *     (`IMG-20260822-WA0001`). Midnight is not where that photo was taken,
 *     and putting it there would be a confident lie.
 */
export function parseFilenameTime(filename: string): FilenameTime | null {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const isPixel = /^PXL_/i.test(base);

  // IMG_20260822_131204 / VID_20260822_131204 / 20260822_131204 /
  // Screenshot_20260822-131204 / PXL_20260822_131204123
  //
  // The optional trailing three digits are milliseconds, which Pixel appends.
  // Without them the trailing-digit guard rejects every Pixel name outright —
  // that is exactly how 15 real videos ended up on the untrustworthy `mvhd`
  // fallback instead of their own filename.
  const m = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})[-_ T]?(\d{2})(\d{2})(\d{2})(?:\d{3})?(?![0-9])/.exec(
    base,
  );
  if (!m) return null;

  const [, y, mo, d, h, mi, s] = m as unknown as [string, string, string, string, string, string, string];
  if (Number(y) < 1990 || Number(y) > 2100) return null;
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  if (Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;

  const stamp = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  return isPixel ? { at: `${stamp}Z`, zoned: true } : { at: stamp, zoned: false };
}

/**
 * Why a file has no usable time, in terms of what to DO about it.
 *
 * "No timestamp found" is true but useless. What the author needs to know is
 * whether to chase the person for the original, or whether the file was
 * always going to be like this.
 */
export function diagnoseMissingTime(filename: string): string {
  const base = filename.slice(filename.lastIndexOf('/') + 1);

  if (/^IMG[-_]\d{8}[-_]WA/i.test(base)) {
    return 'Came through WhatsApp, which strips the metadata. The filename gives the date but not the time. Ask for the original.';
  }
  if (/^(image|photo|IMG)[-_ ]?\d{1,4}\.\w+$/i.test(base) || /^FullSizeRender/i.test(base)) {
    return 'Named like a re-saved copy. Messaging apps and screenshots-of-photos lose the original metadata. Ask for the original.';
  }
  if (/^(Screenshot|Screen Shot)/i.test(base)) {
    return 'A screenshot, which has no capture time of its own.';
  }
  if (/\.(png|webp|gif)$/i.test(base)) {
    return 'This format carries no capture time. Place it by hand, or find the original photo.';
  }
  return 'No date in the file and none in the filename. Usually means it was re-saved or sent through an app that strips metadata.';
}

export interface ResolveContext {
  /**
   * Whether `event.timezone` is set. Without it, a naive timestamp cannot
   * become an instant, so a lower-ranked but self-contained source wins.
   */
  hasTimezone: boolean;
}

interface Candidate extends ResolvedCapture {
  /** True when this candidate is unplaceable without `event.timezone`. */
  needsTimezone: boolean;
}

/**
 * Take the best candidate that can actually be placed.
 *
 * If none can be placed, keep the best one anyway rather than discarding the
 * data: the item shows in the unplaced tray, and setting `event.timezone`
 * later moves it onto the timeline without a re-ingest.
 */
function pick(candidates: Candidate[], ctx: ResolveContext): ResolvedCapture {
  const usable = candidates.find((c) => !c.needsTimezone || ctx.hasTimezone) ?? candidates[0];
  if (!usable) return { timeSource: 'none' };
  const { needsTimezone: _drop, ...chosen } = usable;
  return chosen;
}

/** Pick the most trustworthy timestamp available for a still image. */
export function resolvePhotoTime(
  exif: ExifData | null,
  filename: string,
  ctx: ResolveContext,
): ResolvedCapture {
  const candidates: Candidate[] = [];

  // 1. The shutter, with the zone the camera believed it was in. Exact.
  if (exif?.dateTimeOriginal && exif.offsetTimeOriginal) {
    candidates.push({
      at: `${exif.dateTimeOriginal}${exif.offsetTimeOriginal}`,
      timeSource: 'exif-offset',
      needsTimezone: false,
    });
  }

  // 2. The shutter alone. Exact once event.timezone resolves it.
  if (exif?.dateTimeOriginal) {
    candidates.push({ at: exif.dateTimeOriginal, timeSource: 'exif-naive', needsTimezone: true });
  }

  // 3. GPS. Ranked BELOW the shutter despite coming from satellites, because
  //    it timestamps the fix rather than the shutter — median 11s stale, p90
  //    76s, worst 919s on real race photos. That error is non-uniform, so it
  //    scrambles the order of photos taken seconds apart, which is precisely
  //    what this app exists to show. A wrong timezone at least shifts
  //    everything equally and keeps the order intact.
  if (exif?.gpsInstant) {
    candidates.push({ at: exif.gpsInstant, timeSource: 'gps', needsTimezone: false });
  }

  // 4. The filename, for files whose metadata was stripped in transit.
  const fromName = parseFilenameTime(filename);
  if (fromName) {
    candidates.push({ at: fromName.at, timeSource: 'filename', needsTimezone: !fromName.zoned });
  }

  return pick(candidates, ctx);
}

/** Pick the most trustworthy timestamp available for a video. */
export function resolveVideoTime(
  meta: VideoMeta | null,
  filename: string,
  ctx: ResolveContext,
): ResolvedCapture {
  const candidates: Candidate[] = [];

  if (meta?.creationDate) {
    const zoned = /(Z|[+-]\d{2}:\d{2})$/.test(meta.creationDate);
    candidates.push({
      at: meta.creationDate,
      timeSource: zoned ? 'qt-offset' : 'qt-naive',
      needsTimezone: !zoned,
    });
  }

  // The filename outranks mvhd. Every Android video checked wrote mvhd at the
  // END of recording — start plus duration plus about two seconds — while the
  // filename records the start. Apple additionally writes LOCAL time into
  // mvhd with no zone. So mvhd is both biased late and possibly hours off.
  const fromName = parseFilenameTime(filename);
  if (fromName) {
    candidates.push({ at: fromName.at, timeSource: 'filename', needsTimezone: !fromName.zoned });
  }

  if (meta?.mvhdDate) {
    candidates.push({ at: meta.mvhdDate, timeSource: 'mvhd', needsTimezone: false });
  }

  return pick(candidates, ctx);
}

/** Assemble the item fields for a photo from its parsed EXIF. */
export function photoMetadata(
  exif: ExifData | null,
  filename: string,
  ctx: ResolveContext = { hasTimezone: true },
): ExtractedMetadata {
  const out: ExtractedMetadata = { type: 'photo', ...resolvePhotoTime(exif, filename, ctx) };
  if (exif?.gps) out.gps = exif.gps;
  if (exif?.width) out.width = exif.width;
  if (exif?.height) out.height = exif.height;
  if (exif?.orientation) out.orientation = exif.orientation;
  if (exif?.make) out.make = exif.make;
  if (exif?.model) out.model = exif.model;
  const device = deviceIdOf(exif?.make, exif?.model);
  if (device) out.device = device;
  return out;
}

/** Assemble the item fields for a video from its parsed container metadata. */
export function videoMetadata(
  meta: VideoMeta | null,
  filename: string,
  ctx: ResolveContext = { hasTimezone: true },
): ExtractedMetadata {
  const out: ExtractedMetadata = { type: 'video', ...resolveVideoTime(meta, filename, ctx) };
  if (meta?.gps) out.gps = meta.gps;
  if (meta?.duration !== undefined) out.duration = meta.duration;
  if (meta?.make) out.make = meta.make;
  if (meta?.model) out.model = meta.model;
  // Often absent: Apple videos carry make/model, but Android ones carry no
  // device metadata at all. Those get grouped by proximity instead — see
  // `groupByDevice` in ./assemble.ts.
  const device = deviceIdOf(meta?.make, meta?.model);
  if (device) out.device = device;
  return out;
}
