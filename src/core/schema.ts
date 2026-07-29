/**
 * The manifest is the contract.
 *
 * It is the entire interface between the viewer and any future ingest tool,
 * and it is the unit of sharing. It is hand-editable JSON so a name or a
 * caption can be fixed in a text editor with no build step.
 *
 * This file is the single source of truth for its shape. Nothing else may
 * define its own notion of what a manifest is.
 */

export const SCHEMA_VERSION = 1;

export type PersonId = string;
export type ItemId = string;

/**
 * Roles carry behavior, not just labeling: the runner's lane is pinned to
 * the top of the swimlanes and owns the course spine.
 */
export type Role = 'runner' | 'crew' | 'friend' | 'other';

export type MediaKind = 'photo' | 'video';

/**
 * Where an item's timestamp came from.
 *
 * This is recorded per item because the sources are not equally trustworthy,
 * and a timeline that is confidently wrong is worse than one with visible
 * gaps. Two consequences fall out of it:
 *
 *   1. The UI can show how much to trust a placement.
 *   2. Only DEVICE-CLOCK sources get the person's clockOffset applied. A GPS
 *      timestamp came from satellites and a manual placement came from the
 *      author; neither is affected by a camera's clock being wrong. See
 *      `appliesClockOffset` in ./time.ts.
 *
 * Ordered most to least trustworthy.
 */
export type TimeSource =
  /**
   * EXIF GPSDateStamp + GPSTimeStamp. UTC, from satellites — so it is immune
   * to the device clock being wrong.
   *
   * BUT it is the time of the GPS FIX, not of the shutter, and a fix goes
   * stale. Measured against 134 real photos from a 100-mile race: median 11s
   * behind the shutter, p90 76s, worst 919s. Worse, the error is not uniform,
   * so photos seconds apart collapse onto one instant and their relative
   * order is destroyed — which is exactly what this app exists to show.
   *
   * Therefore ranked BELOW the shutter sources. Its real jobs are as a
   * fallback when a file has no EXIF date, and as the clock-offset estimator
   * (see TIME_SOURCE_RANK).
   */
  | 'gps'
  /** EXIF DateTimeOriginal + OffsetTimeOriginal. Carries a real UTC offset. */
  | 'exif-offset'
  /** QuickTime com.apple.quicktime.creationdate. Carries a real UTC offset. */
  | 'qt-offset'
  /** EXIF DateTimeOriginal alone. Naive local time; needs `event.timezone`. */
  | 'exif-naive'
  /** A QuickTime date atom with no zone. Naive local; needs `event.timezone`. */
  | 'qt-naive'
  /** Android-style filename, e.g. IMG_20260822_131204. Naive local time. */
  | 'filename'
  /**
   * MP4 `mvhd` creation_time. Nominally UTC, but Apple writes LOCAL time here
   * with no zone, so this silently shifts clips by hours. Last resort, and
   * always surfaced in the UI.
   */
  | 'mvhd'
  /** Placed by hand from the unplaced tray. Author intent; trusted as given. */
  | 'manual'
  /** No usable timestamp. The item goes to the unplaced tray. */
  | 'none';

/**
 * Most to least trustworthy. Index 0 is best.
 *
 * The ordering was corrected against 231 real files from a 100-mile race, and
 * two of its choices are counter-intuitive enough to be worth stating:
 *
 * **Shutter time beats GPS time.** GPS looks authoritative — it comes from
 * satellites — but it timestamps the FIX, not the shutter, and lags by a
 * median 11 seconds. Crucially that lag is not uniform, so it scrambles the
 * relative order of photos taken close together. A timezone that is wrong
 * shifts everything by the same amount and preserves order; a stale fix does
 * not. For an app about simultaneity, uniform error is far cheaper than
 * non-uniform error.
 *
 * **Filename beats mvhd.** Every Android video checked wrote `mvhd` at the
 * END of recording (start + duration + ~2s), while the filename records the
 * start. Apple additionally writes local time into `mvhd` with no zone. So
 * `mvhd` is both biased late and possibly hours off.
 */
export const TIME_SOURCE_RANK: readonly TimeSource[] = [
  'manual',
  'exif-offset',
  'qt-offset',
  'exif-naive',
  'qt-naive',
  'gps',
  'filename',
  'mvhd',
  'none',
];

/**
 * Whether this timestamp came from the device's own clock.
 *
 * This is about PROVENANCE, not accuracy, and is deliberately separate from
 * the ranking above. GPS time is ranked low because it is stale, but it still
 * comes from satellites rather than the camera — so a `clockOffset` that
 * corrects a wrong camera clock must not be applied to it. Same for a manual
 * placement, which came from the author.
 */
export function isDeviceClock(source: TimeSource): boolean {
  return source !== 'gps' && source !== 'manual' && source !== 'none';
}

export interface EventInfo {
  title: string;
  /**
   * IANA zone, e.g. "America/Los_Angeles". Required to resolve naive
   * timestamps (`exif-naive`, `filename`) into real instants. Without it
   * those items cannot be placed.
   */
  timezone?: string;
}

export interface MediaConfig {
  /** Prefix for relative `items[].src`. Absolute item srcs ignore it. */
  base?: string;
}

/**
 * How the course is supplied.
 *
 * Only `gpx` produces a spine — the time/distance mapping that powers the
 * elevation backdrop, the distance axis, the tile-free map, and automatic
 * clock alignment. The Strava variants are presentational fallbacks for when
 * the athlete has not exported a track yet.
 *
 * Strava's API cannot be used: its developer agreement bars third-party apps
 * from displaying an athlete's activity data to anyone but that athlete,
 * which is precisely what meanwhile does. A GPX the athlete exports himself
 * is his own file and carries no such restriction — and works identically
 * for Garmin, COROS, or any other watch.
 */
export type CourseRef =
  | { kind: 'gpx'; src: string; person?: PersonId }
  /**
   * An opaque Strava iframe. Note the embed URL is
   * `.../activities/{ID}/embed/{CODE}` and `{CODE}` comes from Strava's share
   * dialog — it cannot be derived from a plain activity URL. The iframe
   * cannot sync to our cursor.
   */
  | { kind: 'strava-embed'; url: string; person?: PersonId }
  /** A plain activity URL. Renders as a link out and nothing more. */
  | { kind: 'strava-link'; url: string; person?: PersonId };

export interface Person {
  id: PersonId;
  name: string;
  role?: Role;
  /**
   * ISO-8601 duration to ADD to this person's device timestamps to reach true
   * time, e.g. "-PT47S" for a camera running 47 seconds fast. Applied only to
   * device-clock time sources.
   */
  clockOffset?: string;
  /** Optional lane color override. Omit to let the palette assign one. */
  color?: string;
}

/**
 * A labelled point on the course. Given either as wall-clock (`at`) or as
 * metres along the course (`atDistance`); the spine converts between them so
 * markers land correctly on both the time and distance axes.
 */
export interface Marker {
  label: string;
  at?: string;
  atDistance?: number;
}

export interface Item {
  id: ItemId;
  person: PersonId;
  type: MediaKind;
  /**
   * Absolute URL, used as-is, or a relative path resolved against
   * `media.base` OR against a locally granted folder — decided at render
   * time. This late resolution is what makes a Drive folder, a bucket, and a
   * folder on the laptop indistinguishable to the viewer.
   */
  src: string;
  /**
   * The timestamp AS RECORDED, not corrected.
   *
   * An ISO-8601 string that may carry a zone ("2026-08-22T13:12:04Z",
   * "...-07:00") or may be naive ("2026-08-22T13:12:04"), depending on
   * `timeSource`. Corrections live in `person.clockOffset` and are applied at
   * render time, so adjusting one person's clock does not mean rewriting
   * every one of their items.
   *
   * Absent when `timeSource` is 'none'.
   */
  at?: string;
  timeSource: TimeSource;
  /** Seconds. Video only. A long clip is a span on the timeline, not a point. */
  duration?: number;
  /** [latitude, longitude] in degrees. */
  gps?: [number, number];
  note?: string;
  width?: number;
  height?: number;
  /** EXIF orientation, 1-8. */
  orientation?: number;
  /** Bytes. Used to warn before decoding something enormous. */
  bytes?: number;
}

export interface Manifest {
  schema: number;
  event: EventInfo;
  media?: MediaConfig;
  course?: CourseRef;
  people: Person[];
  markers?: Marker[];
  items: Item[];
}

export type ValidationResult =
  | { ok: true; manifest: Manifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const ROLES: readonly string[] = ['runner', 'crew', 'friend', 'other'];
const KINDS: readonly string[] = ['photo', 'video'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Accepts both zoned and naive ISO-8601; rejects anything unparseable. */
function isIsoDateTime(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) {
    return false;
  }
  return !Number.isNaN(Date.parse(v.replace(' ', 'T')));
}

/**
 * Validate an untrusted parsed-JSON value.
 *
 * Collects every problem rather than throwing on the first, so a hand-edited
 * manifest reports all its typos at once. Refuses unknown schema versions
 * outright: a legible error beats a render that is subtly wrong.
 */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(input)) {
    return { ok: false, errors: ['manifest must be a JSON object'], warnings };
  }

  // Version first. Everything below assumes version 1 semantics, so there is
  // no point reporting field errors against a schema we do not know.
  if (typeof input['schema'] !== 'number') {
    return {
      ok: false,
      errors: [`manifest is missing "schema". Expected "schema": ${SCHEMA_VERSION}.`],
      warnings,
    };
  }
  if (input['schema'] !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `manifest uses schema version ${String(input['schema'])}, but this ` +
          `version of meanwhile only understands version ${SCHEMA_VERSION}. ` +
          `Update meanwhile, or re-export the manifest.`,
      ],
      warnings,
    };
  }

  // ---- event ----
  const event = input['event'];
  if (!isObject(event)) {
    errors.push('"event" must be an object with a "title"');
  } else {
    if (typeof event['title'] !== 'string' || event['title'].trim() === '') {
      errors.push('"event.title" must be a non-empty string');
    }
    if (event['timezone'] !== undefined && typeof event['timezone'] !== 'string') {
      errors.push('"event.timezone" must be an IANA zone string, e.g. "America/Los_Angeles"');
    }
  }

  // ---- people ----
  const peopleRaw = input['people'];
  const ids = new Set<string>();
  if (!Array.isArray(peopleRaw)) {
    errors.push('"people" must be an array');
  } else {
    peopleRaw.forEach((p, i) => {
      const at = `people[${i}]`;
      if (!isObject(p)) return void errors.push(`${at} must be an object`);
      if (typeof p['id'] !== 'string' || p['id'] === '') {
        errors.push(`${at}.id must be a non-empty string`);
      } else if (ids.has(p['id'])) {
        errors.push(`${at}.id "${p['id']}" is used more than once`);
      } else {
        ids.add(p['id']);
      }
      if (typeof p['name'] !== 'string' || p['name'] === '') {
        errors.push(`${at}.name must be a non-empty string`);
      }
      if (p['role'] !== undefined && !ROLES.includes(p['role'] as string)) {
        errors.push(`${at}.role must be one of ${ROLES.join(', ')}`);
      }
      if (p['clockOffset'] !== undefined && typeof p['clockOffset'] !== 'string') {
        errors.push(`${at}.clockOffset must be an ISO-8601 duration, e.g. "-PT47S"`);
      }
    });
    const runners = peopleRaw.filter((p) => isObject(p) && p['role'] === 'runner');
    if (runners.length > 1) {
      warnings.push(
        `${runners.length} people have role "runner"; only the first will be pinned to the top lane`,
      );
    }
  }

  // ---- course ----
  const course = input['course'];
  if (course !== undefined) {
    if (!isObject(course)) {
      errors.push('"course" must be an object');
    } else {
      const kind = course['kind'];
      if (kind === 'gpx') {
        if (typeof course['src'] !== 'string' || course['src'] === '') {
          errors.push('"course.src" must be a path or URL to a GPX or TCX file');
        }
      } else if (kind === 'strava-embed' || kind === 'strava-link') {
        if (typeof course['url'] !== 'string' || course['url'] === '') {
          errors.push(`"course.url" is required for kind "${kind}"`);
        }
        warnings.push(
          `course kind "${kind}" has no time-and-distance data, so the elevation ` +
            `backdrop, distance axis, map, and automatic clock alignment stay off. ` +
            `Ask for a GPX export to turn them on.`,
        );
      } else {
        errors.push('"course.kind" must be one of gpx, strava-embed, strava-link');
      }
      if (
        course['person'] !== undefined &&
        typeof course['person'] === 'string' &&
        ids.size > 0 &&
        !ids.has(course['person'])
      ) {
        errors.push(`"course.person" refers to unknown person "${course['person']}"`);
      }
    }
  }

  // ---- media ----
  const media = input['media'];
  if (media !== undefined) {
    if (!isObject(media)) errors.push('"media" must be an object');
    else if (media['base'] !== undefined && typeof media['base'] !== 'string') {
      errors.push('"media.base" must be a string');
    }
  }

  // ---- markers ----
  const markers = input['markers'];
  if (markers !== undefined) {
    if (!Array.isArray(markers)) {
      errors.push('"markers" must be an array');
    } else {
      markers.forEach((m, i) => {
        const at = `markers[${i}]`;
        if (!isObject(m)) return void errors.push(`${at} must be an object`);
        if (typeof m['label'] !== 'string' || m['label'] === '') {
          errors.push(`${at}.label must be a non-empty string`);
        }
        const hasAt = m['at'] !== undefined;
        const hasDist = m['atDistance'] !== undefined;
        if (!hasAt && !hasDist) {
          errors.push(`${at} needs either "at" (a timestamp) or "atDistance" (metres)`);
        }
        if (hasAt && !isIsoDateTime(m['at'])) {
          errors.push(`${at}.at must be an ISO-8601 date-time`);
        }
        if (hasDist && typeof m['atDistance'] !== 'number') {
          errors.push(`${at}.atDistance must be a number of metres`);
        }
      });
    }
  }

  // ---- items ----
  const itemsRaw = input['items'];
  const itemIds = new Set<string>();
  if (!Array.isArray(itemsRaw)) {
    errors.push('"items" must be an array');
  } else {
    itemsRaw.forEach((it, i) => {
      const at = `items[${i}]`;
      if (!isObject(it)) return void errors.push(`${at} must be an object`);

      if (typeof it['id'] !== 'string' || it['id'] === '') {
        errors.push(`${at}.id must be a non-empty string`);
      } else if (itemIds.has(it['id'])) {
        errors.push(`${at}.id "${it['id']}" is used more than once`);
      } else {
        itemIds.add(it['id']);
      }

      if (typeof it['person'] !== 'string') {
        errors.push(`${at}.person must be a person id`);
      } else if (ids.size > 0 && !ids.has(it['person'])) {
        errors.push(`${at}.person refers to unknown person "${it['person']}"`);
      }

      if (!KINDS.includes(it['type'] as string)) {
        errors.push(`${at}.type must be "photo" or "video"`);
      }
      if (typeof it['src'] !== 'string' || it['src'] === '') {
        errors.push(`${at}.src must be a non-empty path or URL`);
      }

      const source = it['timeSource'];
      if (!TIME_SOURCE_RANK.includes(source as TimeSource)) {
        errors.push(`${at}.timeSource must be one of ${TIME_SOURCE_RANK.join(', ')}`);
      } else if (source === 'none') {
        if (it['at'] !== undefined) {
          errors.push(`${at} has timeSource "none" but also an "at"; use "manual" if it was placed by hand`);
        }
      } else if (!isIsoDateTime(it['at'])) {
        errors.push(`${at}.at must be an ISO-8601 date-time when timeSource is "${String(source)}"`);
      }

      if (it['gps'] !== undefined) {
        const g = it['gps'];
        const ok =
          Array.isArray(g) &&
          g.length === 2 &&
          typeof g[0] === 'number' &&
          typeof g[1] === 'number' &&
          Math.abs(g[0]) <= 90 &&
          Math.abs(g[1]) <= 180;
        if (!ok) errors.push(`${at}.gps must be [latitude, longitude] in degrees`);
      }
      if (it['duration'] !== undefined && typeof it['duration'] !== 'number') {
        errors.push(`${at}.duration must be a number of seconds`);
      }
      if (it['note'] !== undefined && typeof it['note'] !== 'string') {
        errors.push(`${at}.note must be a string`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, manifest: input as unknown as Manifest, warnings };
}
