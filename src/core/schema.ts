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

import { embeddableHosts, embeddableSrc, hostOf } from './course-url.ts';

export const SCHEMA_VERSION = 1;

export type PersonId = string;
export type ItemId = string;

/**
 * What someone was at this event, in their own words.
 *
 * **Free text, and it carries NO behavior at all.** This was a four-value
 * enum (`'runner' | 'crew' | 'friend' | 'other'`) whose only measurable
 * effect was DESTROYING what the owner typed: a `people.csv` carrying `crew
 * chief`, `runner` and `pacer` parsed to `runner` plus two blanks, and one
 * Save then wrote those two cells empty.
 *
 * The enum survived as long as it did because `runner` was doing a second,
 * unrelated job — deciding whose lane pinned to the top. That job now belongs
 * to `Person.pinned`, which is why this can be free text safely: nothing reads
 * a role to decide anything. See `SUGGESTED_ROLES` below, and CLAUDE.md's "A
 * role says what someone WAS; `pinned` says whose lane goes on top".
 */
export type Role = string;

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
 * The order below is a logical grouping — satellite fix, then shutter time
 * (zoned, then naive), then filename, then the video-header fallback, then
 * manual, then none — NOT a trust ranking. In particular `gps` sits first
 * here but ranks below every shutter source (see its own comment for why).
 * The actual most-to-least-trustworthy order lives in `TIME_SOURCE_RANK`
 * below.
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
   *
   * This is a convention, not a checked constraint: `validateManifest` only
   * requires a string here, not that it names a real IANA zone. A bad value
   * is not rejected at load time — it surfaces later and per-item, as an
   * unplaceable `reason` from `resolveItemInstant` in `time.ts`.
   */
  timezone?: string;
  /**
   * The slice of time the views show, as ISO instants.
   *
   * A folder is rarely just the event: the real race folder spanned 46.6 days
   * for a two-day race, holding planning photos from six weeks earlier and
   * the morning after. Cropping is therefore authoring intent, not a view
   * preference, so it lives in the manifest and survives export.
   *
   * Absent means "work it out" — from the course when there is one, otherwise
   * from where the photos actually cluster.
   *
   * Named `range` rather than `window` on purpose: `window` shadows a host
   * global, and the core-purity test rightly refuses it.
   */
  range?: { from: string; to: string };
}

export interface MediaConfig {
  /** Prefix for relative `items[].src`. Absolute item srcs ignore it. */
  base?: string;
}

/**
 * How the course is supplied.
 *
 * Only `gpx` produces a spine — the time/distance mapping that powers the
 * elevation backdrop, the charts, and the map. (The map is a Leaflet raster
 * basemap, not the tile-free SVG polyline the original design called for;
 * and automatic clock alignment, once listed here, was never built — see
 * `TODO.md`.) The Strava variants are presentational fallbacks for when the
 * athlete has not exported a track yet.
 *
 * Strava's API cannot be used: its developer agreement bars third-party apps
 * from displaying an athlete's activity data to anyone but that athlete,
 * which is precisely what meanwhile does. A GPX the athlete exports himself
 * is his own file and carries no such restriction — and works identically
 * for Garmin, COROS, or any other watch.
 *
 * **`url` is checked, not merely required.** It must be a plain `https://`
 * address, and a `strava-embed` one must additionally be on strava.com —
 * `validateManifest` refuses the manifest otherwise, and `CourseFallback.tsx`
 * refuses to render it a second time for URLs that never went through the
 * validator. Both call `./course-url.ts`; see that file for what a bare
 * "non-empty string" let through.
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
  /**
   * What they were — free text, purely descriptive. See `Role`.
   *
   * Deliberately NOT what decides whose lane is pinned; that is `pinned`
   * below. Keeping the two apart is what lets this be anything a person
   * types.
   */
  role?: Role;
  /**
   * Whether this person's lane pins to the top of the swimlanes.
   *
   * The one field on a person that changes what the app DOES. It exists
   * because `role` was doing two jobs at once — saying what someone was, and
   * saying whose story the timeline tells — and only the second is something
   * the app can act on. An ultra pins the runner; a wedding pins two people;
   * a relay pins the whole team. None of that is expressible in a vocabulary
   * of roles, and every attempt to express it there deletes somebody's label.
   *
   * **Several pinned people are legal**, and that is the point rather than a
   * tolerated edge case: `orderPeople` (`./palette.ts`) moves all of them to
   * the front, in roster order.
   *
   * In `people.csv` this is a `pinned` column holding the integer `1`, blank
   * for everyone else — an integer because no other format survives a
   * spreadsheet, the same rule the five date integers follow (see
   * `./notes.ts`).
   */
  pinned?: boolean;
  /**
   * ISO-8601 duration to ADD to this person's device timestamps to reach true
   * time, e.g. "-PT47S" for a camera running 47 seconds fast. Applied only to
   * device-clock time sources.
   *
   * `validateManifest` only checks that this is a string, not that it parses
   * as a duration — `parseDuration` lives in `time.ts`, which already imports
   * types from this file, so validating it here would be circular. An
   * unparseable value is caught later, per item, by `resolveItemInstant`,
   * which ignores it and records why in `ResolvedTime.reason` rather than
   * rejecting the whole manifest.
   */
  clockOffset?: string;
  /** Optional lane color override. Omit to let the palette assign one. */
  color?: string;
  /**
   * Earlier names this person has answered to, oldest first — a device-slug
   * default ("Google Pixel 8 Pro") before the owner renamed it, or a name
   * spelled differently by a crew member's own copy of `notes.csv`.
   *
   * `notes*.csv` stores people by NAME, not id, so a note is not "moved"
   * when its author is renamed — the old name just stops resolving. This is
   * the join that lets it keep resolving: `resolvePersonNames` in
   * `people-csv.ts` matches a note's name against `name` OR any entry here,
   * case-insensitively, and `displayName` (also `people-csv.ts`) falls back
   * to the first entry when `name` itself is blank. See CLAUDE.md's "Clock
   * alignment is central" / notes-as-csv sections for why the join lives in
   * names rather than in `notes*.csv` gaining an id column.
   */
  alsoKnownAs?: string[];
}

/**
 * A labelled point on the course, given either as wall-clock (`at`) or as
 * metres along the course (`atDistance`).
 *
 * Only `at` is rendered today: the swimlanes draw a line at that clock time
 * (`markerLines` in `Swimlanes.tsx`), and a marker with no `at` — i.e. an
 * `atDistance`-only marker — is silently dropped there, because the app has
 * no distance axis to place it on. Nothing converts between the two fields;
 * that conversion is what `atDistance` is FOR, but the spine does not do it
 * yet. Give a marker an `at` for it to actually appear.
 */
export interface Marker {
  label: string;
  at?: string;
  atDistance?: number;
}

/**
 * Something that happened, written down — with or without a photograph.
 *
 * **Legacy shape, read-only.** Prose now lives in `notes*.csv` — a
 * spreadsheet, not a JSON blob — read and written via the differently-shaped
 * `Note` in `./notes.ts`. The manifest WRITER never emits `manifest.notes`
 * any more; this type and the validation below stay only so a manifest saved
 * before that change still loads, and its captions/notes get migrated into
 * the CSV shape on the next ingest (see `migrateLegacyNotes` in
 * `viewer/media/ingest.ts`). Do not add a code path that writes to
 * `manifest.notes` again.
 *
 * The gap this fills: every other annotation in the app hangs off a file, so
 * anything nobody photographed could not be recorded at all. An ultra is full
 * of exactly those things. In the owner's words: *"either because we forgot to
 * take a photo or it was something that we remembered happening during some
 * point of time."*
 *
 * **A note's time is AUTHORED, so `clockOffset` never applies to it.** The
 * same reasoning as `timeSource: 'manual'`: the offset exists to correct a
 * device's clock, and a person typing "3am" is not a device. Correcting it
 * would introduce the very error the offset removes.
 *
 * `person` is optional and does real work. With one, the note sits in that
 * person's lane, which is what lets a note EXPLAIN A GAP — six hours of empty
 * lane is the story of the night section, and "asleep in the car at Cottonwood"
 * is the caption that gap never had. Without one it belongs to the event.
 *
 * `until` makes it a span rather than a moment, because crewing is mostly
 * spans: waiting, driving, sleeping, boiling water.
 */
export interface Note {
  id: string;
  /** ISO-8601. When it happened. */
  at: string;
  /** ISO-8601. End of the span; omit for a moment. */
  until?: string;
  text: string;
  /** Whose lane it belongs in. Omit for an event-level note. */
  person?: PersonId;
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
  /**
   * Legacy caption, read-only. A caption is now a `notes.csv` row whose
   * `photo` column names this item's id — see `./notes.ts`. The writer never
   * sets this field again; it is kept only so a manifest saved before that
   * change still loads, and `migrateLegacyNotes` turns it into a real note.
   */
  note?: string;
  width?: number;
  height?: number;
  /**
   * EXIF orientation, 1-8. Not checked by `validateManifest` at all — neither
   * the type nor the range — so a hand-edited manifest can carry anything
   * here. The one consumer, `MediaTile.tsx`, only tests `>= 5` to decide
   * whether width/height are swapped for the tile's aspect ratio, so a bad
   * value degrades a thumbnail rather than crashing anything.
   */
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
  /**
   * Legacy note list, read-only — see the `Note` doc comment above. The
   * writer never emits this array; `notes*.csv` is the real store now.
   */
  notes?: Note[];
  items: Item[];
}

export type ValidationResult =
  | { ok: true; manifest: Manifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Roles this project's own vocabulary suggests — a SUGGESTION, never a gate.
 *
 * It was `ROLES`, and it was enforced: `validateManifest` refused a manifest
 * naming any other role, and `parsePeopleCsv` blanked the cell and reported a
 * problem. What that bought, measured across the whole repository, was
 * nothing — `crew`, `friend` and `other` had zero reads anywhere outside the
 * check itself, and the runner-toggle UI could only ever produce `runner` or
 * no role at all. What it cost was real: the owner typed `crew chief` and
 * `pacer` into `people.csv` and one Save wrote both cells blank.
 *
 * Renamed rather than repurposed in place, so no call site can keep treating
 * it as a permitted-values list by accident. **Nothing in `src/` reads it
 * today** — it is a documented vocabulary for the docs and for any future
 * suggestion UI, and if that never arrives it should be deleted rather than
 * quietly re-promoted into a check. Adding a value here does not make it
 * special; removing one does not make it refused.
 */
export const SUGGESTED_ROLES: readonly string[] = ['runner', 'crew', 'friend', 'other'];
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
    const r = event['range'];
    if (r !== undefined) {
      if (!isObject(r) || !isIsoDateTime(r['from']) || !isIsoDateTime(r['to'])) {
        errors.push('"event.range" must be { "from": <date-time>, "to": <date-time> }');
      } else if (Date.parse(r['from'] as string) >= Date.parse(r['to'] as string)) {
        errors.push('"event.range.from" must be before "event.range.to"');
      }
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
      /*
       * A role is any non-empty string — see `Role`. The only check left is
       * the type, because a role that is a number or an object would render
       * as garbage rather than as a label.
       *
       * A blank one is NORMALISED AWAY rather than reported, so "blank" and
       * "absent" stay one thing. This mutates `input`, which is also what
       * gets returned as `manifest` below, and that is the intent: the
       * alternative is `''` reaching `reportUnsavedRosterEdits`
       * (`viewer/media/ingest.ts`), which compares `mine.role !== p.role` and
       * would announce a roster edit nobody made.
       */
      if (p['role'] !== undefined) {
        if (typeof p['role'] !== 'string') {
          errors.push(`${at}.role must be a string, e.g. "runner" or "crew chief"`);
        } else if (p['role'].trim() === '') {
          delete p['role'];
        }
      }
      if (p['pinned'] !== undefined && typeof p['pinned'] !== 'boolean') {
        errors.push(`${at}.pinned must be true or false`);
      }
      if (p['clockOffset'] !== undefined && typeof p['clockOffset'] !== 'string') {
        errors.push(`${at}.clockOffset must be an ISO-8601 duration, e.g. "-PT47S"`);
      }
      if (p['alsoKnownAs'] !== undefined) {
        const aka = p['alsoKnownAs'];
        if (!Array.isArray(aka) || aka.some((a) => typeof a !== 'string')) {
          errors.push(`${at}.alsoKnownAs must be an array of strings`);
        }
      }
    });
    /*
     * There is deliberately NO warning about more than one pinned person.
     *
     * One used to fire for a second `role: "runner"`, because `orderPeople`
     * pinned only the first and silently ignored the rest — the warning was
     * describing a real loss. `pinned` does not lose anyone: every pinned
     * person moves to the front, in roster order. A wedding pins two people
     * and a relay pins the whole team, so this is the ordinary case now, and
     * a warning on an ordinary case trains people to ignore the channel.
     */
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
        const url = course['url'];
        if (typeof url !== 'string' || url === '') {
          errors.push(`"course.url" is required for kind "${kind}"`);
        } else if (hostOf(url) === null) {
          /*
           * A WARNING, not an error, and the difference is somebody's work.
           *
           * This was an error for one commit, and executing that showed what
           * it costs: `updateCourse` in App.tsx accepts a scheme-less paste
           * (`strava.com/activities/123` — the ordinary thing to type), Save
           * writes it to `manifest.json`, and the next "Open folder" then
           * refused the WHOLE manifest. `ingestFolder` leaves `imported` as
           * null, and on 'replace' nothing stands in for it — so the crop,
           * every marker, the title, the timezone and **every
           * `timeSource: 'manual'` placement** were gone, which is exactly
           * the list CLAUDE.md's "The manifest is the contract" names as NOT
           * regenerable from the photographs. It also broke files that
           * already loaded: an `http://` course URL was legal before.
           *
           * Warning instead loses nothing. The manifest loads with the URL
           * untouched, the problem is reported, and `CourseFallback` — which
           * checks independently, because App.tsx's own settings box never
           * goes through this function — declines to render it. The refusal
           * happens where the damage would be, not where the data is.
           *
           * The URL is NOT stripped on the way back out, either: preserving a
           * value this build will not act on is the same rule as CLAUDE.md's
           * "Refusing to READ a row is not permission to DELETE it".
           */
          warnings.push(
            `"course.url" is not a plain https:// address, so it will not be shown as ` +
              `a link. It is kept in the manifest exactly as written — correct it in ` +
              `the event settings, or in "course.url", to turn the link back on. ` +
              `(A URL carrying a tab, a space, a backslash or a "@" does not resolve ` +
              `to the host it appears to name, which is why those are refused too.)`,
          );
        } else if (kind === 'strava-embed' && embeddableSrc(url) === null) {
          // Same reasoning, one step stricter: an embed is loaded INTO this
          // page, which a link is not, so it needs the host allowlist on top
          // of the scheme check. Still a warning — the link out is fine, and
          // it is only the frame that is declined.
          warnings.push(
            `"course.url" for kind "strava-embed" is on "${hostOf(url)}", but an embed ` +
              `is loaded inside meanwhile's own page, so only ` +
              `${embeddableHosts().join(' and ')} are framed there. It is still ` +
              `offered as a link out.`,
          );
        }
        /*
         * There is deliberately NO warning here that a Strava kind carries no
         * time-and-distance data.
         *
         * One used to fire unconditionally for every `strava-link` and
         * `strava-embed`. That was harmless while nothing read `warnings` —
         * and stopped being harmless the moment they were routed into the
         * viewer's problems callout, because it made a perfectly correct
         * manifest report a problem. The commonest workflow there is (paste a
         * Strava link, Save, Open the folder again) raised "One thing needed a
         * closer look rather than being guessed at", a sentence about
         * unreadable rows and deleted notes, on a file with nothing wrong
         * with it.
         *
         * A warning that fires on an ordinary, correct configuration trains
         * people to ignore the channel, which costs the warnings that matter.
         * And the fact itself is not lost: `CourseFallback` states it in its
         * own callout, on the course view, which is the page where a missing
         * map and elevation profile need explaining.
         *
         * Everything `warnings` still carries describes something actually
         * wrong with the file, which is what makes routing them wholesale
         * correct by construction rather than by filtering on their wording.
         */
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

  // ---- notes ----
  const notes = input['notes'];
  if (notes !== undefined) {
    if (!Array.isArray(notes)) {
      errors.push('"notes" must be an array');
    } else {
      const noteIds = new Set<string>();
      notes.forEach((n, i) => {
        const at = `notes[${i}]`;
        if (!isObject(n)) return void errors.push(`${at} must be an object`);
        if (typeof n['id'] !== 'string' || n['id'] === '') {
          errors.push(`${at}.id must be a non-empty string`);
        } else if (noteIds.has(n['id'])) {
          // Ids address a note for editing and deleting; duplicates would
          // make both operations hit the wrong one.
          errors.push(`${at}.id "${n['id']}" is used more than once`);
        } else {
          noteIds.add(n['id']);
        }
        if (typeof n['text'] !== 'string' || n['text'] === '') {
          errors.push(`${at}.text must be a non-empty string`);
        }
        if (!isIsoDateTime(n['at'])) {
          errors.push(`${at}.at must be an ISO-8601 date-time`);
        }
        if (n['until'] !== undefined) {
          if (!isIsoDateTime(n['until'])) {
            errors.push(`${at}.until must be an ISO-8601 date-time`);
          } else if (isIsoDateTime(n['at']) && Date.parse(n['until']) < Date.parse(n['at'])) {
            errors.push(`${at}.until is before ${at}.at`);
          }
        }
        if (n['person'] !== undefined && typeof n['person'] !== 'string') {
          errors.push(`${at}.person must be a person id`);
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
