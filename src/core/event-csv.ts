/**
 * `event.csv` — the event itself as a key/value CSV: its title, its timezone,
 * the crop, and how the course is supplied.
 *
 * **Two columns, `key` and `value`, one setting per row.** Every other file in
 * the set is row-bound — one note, one person, one marker per row — and this
 * one is not, because there is exactly one event. A wide single-row file would
 * put twenty-odd headers side by side and force a person editing it to scroll
 * horizontally to find `timezone`; a tall key/value file reads as a list of
 * settings, which is what it is. It also means adding a setting later appends a
 * ROW rather than a column, so a hand-added key lands somewhere obvious and
 * survives (see `extra`).
 *
 * **The crop uses the same seven timestamp columns `notes*.csv` uses**, twice,
 * prefixed `range_from_` and `range_to_`: `year, month, day, hour, minute, tz,
 * utc_offset_min`. Five bare integers because no other format survives a
 * spreadsheet (see CLAUDE.md, "the timestamp is five integers, not one
 * string"), and the `tz`/`utc_offset_min` pair because neither is sufficient
 * alone — a zone name cannot say which side of a fall-back hour a wall clock
 * means, and an offset cannot say which zone the writer meant. There is no
 * `second`: these are times a person types, and `wallClockToInstant` builds a
 * naive timestamp ending `:00`. The resolution goes through `resolveZoned` in
 * `./wallclock.ts`, the one implementation of that ladder, so the crop's 01:30
 * and a note's 01:30 cannot land an hour apart.
 *
 * **Nothing this build cannot interpret is ever dropped.** That is the point of
 * the module, not a nicety. A `range_from_day` of 32, a `range_to_` block
 * missing an integer, a `course_kind` that is not one of the three — each is
 * reported AND kept verbatim in `preserved`, and written straight back out by
 * `formatEventCsv`. `schema.ts` records what refusing exactly these fields cost
 * once: "the crop, every marker, the title, the timezone and every
 * `timeSource: 'manual'` placement". Refusing to READ a value is not permission
 * to DELETE it — see CLAUDE.md's section of that name.
 *
 * **There is deliberately no `media_base` key.** `manifest.media` is read
 * nowhere in `src/`, and a key that configures nothing is one somebody fills in
 * and then expects to work. Unknown keys round-trip (see `extra`), so it can be
 * added later with no migration.
 *
 * Pure: only relative core imports and ECMAScript globals.
 */

import { hostOf, embeddableHosts, embeddableSrc } from './course-url.ts';
import { CSV_SCHEMA, formatCsv, parseCsv, schemaCellProblem } from './csv.ts';
import type { CourseRef, EventInfo } from './schema.ts';
import { zoneOffsetMinutes } from './time.ts';
import { instantPartsInZone, nonEmpty, readCalendarParts, resolveZoned } from './wallclock.ts';

/**
 * The two column names. Not configurable and not sniffed — a file whose header
 * row says something else is reported and its first line read as data instead,
 * because in a two-column key/value file the header is the one row that can be
 * mistaken for one. See `parseEventCsv`.
 */
export const EVENT_HEADERS: readonly string[] = ['key', 'value'];

/** The seven timestamp columns, unprefixed. Shared by both ends of the crop. */
const RANGE_FIELDS = ['year', 'month', 'day', 'hour', 'minute', 'tz', 'utc_offset_min'] as const;

/** The five that must all be present and in range for an end to resolve. */
const CALENDAR_FIELDS = ['year', 'month', 'day', 'hour', 'minute'] as const;

const RANGE_KEYS: readonly string[] = [
  ...RANGE_FIELDS.map((f) => `range_from_${f}`),
  ...RANGE_FIELDS.map((f) => `range_to_${f}`),
];

const COURSE_KEYS: readonly string[] = [
  'course_kind',
  'course_src',
  'course_url',
  'course_person',
];

/**
 * Every key this build knows the meaning of, in the order `formatEventCsv`
 * writes them.
 *
 * `schema` is last, after any key somebody else added (see `extra`), so it is
 * genuinely the last row of the file rather than merely the last one this
 * module owns — the same rule `PEOPLE_HEADERS` and `NOTE_HEADERS` follow for
 * their own `schema` column.
 */
export const EVENT_KEYS: readonly string[] = [
  'title',
  'timezone',
  ...RANGE_KEYS,
  ...COURSE_KEYS,
  'schema',
];

const KNOWN_EVENT_KEYS = new Set<string>(EVENT_KEYS);

const COURSE_KINDS: readonly string[] = ['gpx', 'strava-embed', 'strava-link'];

/**
 * Appended to every problem that quarantines a value, so the message says what
 * happened to the data as well as what was wrong with it. `parsePeopleCsv`'s
 * `keep()` carries the same promise for a whole row, and it is the sentence
 * that makes "reported" different from "lost".
 */
const KEPT =
  ' The rows are kept exactly as they are and written back when you save, so nothing in ' +
  'them is lost.';

export interface EventCsv {
  event: EventInfo;
  /** Absent when the file names no course, or when the course keys were refused. */
  course?: CourseRef;
  /**
   * Keys this module has no meaning for, verbatim and in the order first seen —
   * the analogue of `Note.extra` and `PeopleExtra`, and what makes the file
   * growable without a migration.
   *
   * Blank values are kept too. A key with no value still records that somebody
   * added the key, and dropping it is how a round trip stops being one.
   */
  extra: Record<string, string>;
  /**
   * Keys this module DOES know but could not interpret, verbatim.
   *
   * Distinct from `extra` and the distinction is load-bearing: these are
   * `range_from_day,32` and `course_kind,strv` — values whose meaning is known
   * to be broken, so nothing may act on them, and whose loss would take the
   * crop or the course off disk. Only non-blank cells are collected; a blank
   * one is indistinguishable from an absent key in a file shaped like this, so
   * there is nothing to preserve.
   */
  preserved: Record<string, string>;
  problems: string[];
}

// ---------------------------------------------------------------------------
// parseEventCsv
// ---------------------------------------------------------------------------

export function parseEventCsv(
  text: string,
  /** Named in every problem, so a caller can point at the file to repair. */
  file = 'event.csv',
): EventCsv {
  const problems: string[] = [];
  const cells = readPairs(text, file, problems);

  const preserved: Record<string, string> = {};
  const keep = (keys: readonly string[]): void => {
    for (const key of keys) {
      const value = cells.get(key);
      if (value !== undefined && value.trim() !== '') preserved[key] = value;
    }
  };
  const extraOf = (): Record<string, string> => {
    const extra: Record<string, string> = {};
    for (const [key, value] of cells) if (!KNOWN_EVENT_KEYS.has(key)) extra[key] = value;
    return extra;
  };

  // Checked before anything else is interpreted: a file written by a newer
  // build may mean something different by every other key in it, so reading
  // them anyway would be guessing. Mirrors `validateManifest` refusing an
  // unknown manifest `schema` outright, and `rowToNote`/`parsePeopleCsv`
  // refusing a row.
  //
  // **Per FILE here, not per row**, which is the one place this format departs
  // from `notes*.csv` and `people.csv`. Those merge by row-bind, so a row from
  // someone's older copy lands among newer rows and has to carry its own
  // version. There is exactly one event and exactly one `event.csv`, so a
  // single declaration governs the file. `schemaCellProblem` is reused rather
  // than reimplemented — its "this row" reads correctly here anyway, since the
  // schema declaration IS a row of this file.
  const schemaBad = schemaCellProblem(cells.get('schema'), file);
  if (schemaBad) {
    problems.push(`${file} ${schemaBad}.${KEPT}`);
    // Everything, including the `schema` cell itself. Writing `schema,1` back
    // over a file that declared 2 would both claim a version this build did
    // not read and destroy the only marker saying so.
    keep(EVENT_KEYS);
    return { event: { title: '' }, extra: extraOf(), preserved, problems };
  }

  // ---- title ----
  const title = nonEmpty(cells.get('title'));
  if (title === undefined) {
    // Reported, never defaulted. "Untitled event" would look like a title
    // somebody chose, and this one string names the event in the top bar and
    // in the filename a Save downloads.
    problems.push(
      `${file} has no title. Add a row reading "title,<the event's name>" — it is what ` +
        'meanwhile shows in the top bar and what names the file a Save downloads.',
    );
  }
  const event: EventInfo = { title: title ?? '' };

  // Not checked against `Intl`, on purpose: `EventInfo.timezone` is documented
  // as a convention rather than a checked constraint, and a bad value already
  // surfaces per item as an unplaceable `reason` from `resolveItemInstant`. A
  // zone this runtime cannot resolve DOES get refused where it decides an
  // instant — see `resolveZoned`, which the crop below goes through.
  const timezone = nonEmpty(cells.get('timezone'));
  if (timezone !== undefined) event.timezone = timezone;

  // ---- range ----
  const range = readRange(cells, file, timezone);
  if ('error' in range) {
    problems.push(range.error + KEPT);
    // Both ends, always. Preserving only the end that failed would leave the
    // other with nothing to write it from — `event.range` is a pair or it is
    // nothing — so half the crop would go off disk while the file still
    // reported a problem about the other half.
    keep(RANGE_KEYS);
  } else if (range.range !== undefined) {
    event.range = range.range;
  }

  // ---- course ----
  const course = readCourse(cells, file);
  if ('error' in course) {
    problems.push(course.error + KEPT);
    keep(COURSE_KEYS);
  }

  const result: EventCsv = { event, extra: extraOf(), preserved, problems };
  if ('course' in course && course.course !== undefined) {
    result.course = course.course;
    problems.push(...courseUrlProblems(course.course, file));
  }
  return result;
}

/**
 * The file as an ordered key → value map, with duplicates resolved and
 * reported.
 *
 * **Last wins, and it is said out loud.** Silently picking one of two rows
 * naming the same key is how an edit disappears: someone adds `timezone` near
 * the top of the file without noticing the one already there, and whichever
 * they did not mean takes effect with nothing to notice it by.
 *
 * Values are kept untrimmed — every reader below goes through `nonEmpty`, which
 * trims — so a preserved value is written back as it was read.
 */
function readPairs(text: string, file: string, problems: string[]): Map<string, string> {
  const { headers, rows } = parseCsv(text);
  const cells = new Map<string, string>();

  const rawKeyCol = headers[0];
  const rawValCol = headers[1];
  const keyCol = rawKeyCol ?? 'key';
  const valCol = rawValCol ?? 'value';

  const pairs: Array<[string, string]> = [];
  // A header row is the one row of a two-column key/value file that can be
  // mistaken for data, so a file that has lost it (hand-written, or a
  // spreadsheet export that dropped it) would otherwise have its FIRST setting
  // silently eaten as column names. Report, and read it as the pair it almost
  // certainly is. `rawKeyCol === undefined` is an empty file, which has no
  // header to complain about.
  if (rawKeyCol !== undefined && (rawKeyCol !== 'key' || rawValCol !== 'value')) {
    problems.push(
      `${file} should begin with a header row reading "key,value"; it begins with ` +
        `"${headers.join(',')}" instead, so that line was read as a setting rather than as a ` +
        'header.',
    );
    pairs.push([rawKeyCol, rawValCol ?? '']);
  }
  for (const row of rows) pairs.push([(row[keyCol] ?? '').trim(), row[valCol] ?? '']);

  for (const [key, value] of pairs) {
    if (key === '') {
      problems.push(
        `${file} has a row with a value but no key in the first column, so there is nothing ` +
          'to say what it configures; it was ignored.',
      );
      continue;
    }
    if (cells.has(key)) {
      problems.push(
        `${file} names "${key}" more than once. The last one wins, so "${key}" is ` +
          `"${value.trim()}" — delete the others so the file says one thing.`,
      );
    }
    cells.set(key, value);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// the crop
// ---------------------------------------------------------------------------

/**
 * The crop, or the one thing wrong with it.
 *
 * **Both ends or neither, and a half-present pair is reported rather than
 * repaired.** There is no honest way to invent the missing end: taking it from
 * the photographs would silently override the very authoring intent
 * `event.range` exists to record (see `EventInfo.range` — absent means "work it
 * out", and half-present must not quietly mean the same thing).
 *
 * `{ range: undefined }` is the ordinary "this file names no crop" answer, and
 * is distinct from an error.
 */
function readRange(
  cells: Map<string, string>,
  file: string,
  eventTimezone: string | undefined,
): { range: { from: string; to: string } | undefined } | { error: string } {
  const from = sideCells(cells, 'from');
  const to = sideCells(cells, 'to');
  const fromPresent = RANGE_FIELDS.some((f) => nonEmpty(from[f]) !== undefined);
  const toPresent = RANGE_FIELDS.some((f) => nonEmpty(to[f]) !== undefined);

  if (!fromPresent && !toPresent) return { range: undefined };
  if (!fromPresent || !toPresent) {
    const has = fromPresent ? 'range_from' : 'range_to';
    const missing = fromPresent ? 'range_to' : 'range_from';
    return {
      error:
        `${file} gives ${has} but no ${missing}. A time window has two ends and meanwhile ` +
        `will not invent one, so no crop was applied — fill in the ${missing}_* rows, or ` +
        `clear the ${has}_* rows to let meanwhile work the window out from the photographs.`,
    };
  }

  const a = readSide(from, 'range_from', eventTimezone);
  if (typeof a !== 'number') return a;
  const b = readSide(to, 'range_to', eventTimezone);
  if (typeof b !== 'number') return b;
  if (a >= b) {
    return {
      error:
        `${file}'s range_from is not before its range_to, so there is no window between ` +
        'them — swap the two, or correct whichever end is wrong.',
    };
  }
  return { range: { from: new Date(a).toISOString(), to: new Date(b).toISOString() } };
}

/** One end's seven cells, unprefixed, ready for `resolveZoned`'s literal lookups. */
function sideCells(cells: Map<string, string>, side: 'from' | 'to'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of RANGE_FIELDS) out[field] = cells.get(`range_${side}_${field}`) ?? '';
  return out;
}

/**
 * One end of the crop as an instant.
 *
 * The five integers go through `readCalendarParts` and the zone through
 * `resolveZoned` — the same two functions `notes*.csv` uses, with `noun:
 * 'event'` so a problem reads `event "range_from" has a day of 32` and sends
 * its author to this file rather than to `notes.csv`. `label` is the key
 * prefix, so the message names the exact rows to fix.
 *
 * The `row` handed to `resolveZoned` is synthesised because it reads `row.tz`
 * and `row.utc_offset_min` by literal name — deliberately not parameterised, so
 * that `utc_offset_min` has one spelling across every file in the set (see
 * `./wallclock.ts`). Mapping `range_from_tz` onto `tz` here is what keeps that
 * true while still letting the two ends live in one file.
 */
function readSide(
  side: Record<string, string>,
  label: string,
  eventTimezone: string | undefined,
): number | { error: string } {
  // Per field, before `Number` ever sees a blank: `Number('')` is 0, which is
  // finite and therefore invisible to a range check, so a blank `minute` would
  // resolve silently to :00 instead of being refused.
  const missing = CALENDAR_FIELDS.filter((f) => nonEmpty(side[f]) === undefined);
  if (missing.length > 0) {
    return {
      error:
        `event "${label}" is missing ${missing.map((f) => `${label}_${f}`).join(', ')} — a ` +
        'time window edge needs all five of year, month, day, hour and minute',
    };
  }
  // `nonEmpty` rather than the raw cell: it trims, and `readCalendarParts`
  // matches `/^\d{4}$/` against `year` — so a cell a spreadsheet left as
  // " 2026" would be refused as "not a whole number" for a value that is one.
  // The `as string` is safe because `missing` above is empty.
  const parts = readCalendarParts(
    {
      year: nonEmpty(side['year']) as string,
      month: nonEmpty(side['month']) as string,
      day: nonEmpty(side['day']) as string,
      hour: nonEmpty(side['hour']) as string,
      minute: nonEmpty(side['minute']) as string,
    },
    label,
    'event',
  );
  if ('error' in parts) return parts;

  const resolved = resolveZoned(
    parts,
    { tz: side['tz'] ?? '', utc_offset_min: side['utc_offset_min'] ?? '' },
    eventTimezone,
    label,
    'event',
  );
  if ('error' in resolved) return resolved;
  return resolved.instant;
}

// ---------------------------------------------------------------------------
// the course
// ---------------------------------------------------------------------------

/**
 * The course reference, or the one thing wrong with it.
 *
 * **`course_kind` plus exactly one of `course_src` or `course_url`.** A `gpx`
 * course is a file this app parses into a spine; a Strava course is an address
 * it can only link or frame. A row carrying both says two different things and
 * is refused rather than guessed at — picking one would silently discard the
 * other, and which one somebody meant is not recoverable from the file.
 *
 * An absent `course_kind` means no course, per the union in `schema.ts` where
 * `undefined` is a legal member. But `course_src` or `course_url` WITHOUT a
 * kind is a refusal, not a no-course: those are somebody's data, and inferring
 * the kind from which key they used would turn a typo into a decision.
 */
function readCourse(
  cells: Map<string, string>,
  file: string,
): { course: CourseRef | undefined } | { error: string } {
  const kind = nonEmpty(cells.get('course_kind'));
  const src = nonEmpty(cells.get('course_src'));
  const url = nonEmpty(cells.get('course_url'));
  const person = nonEmpty(cells.get('course_person'));

  if (kind === undefined) {
    const named = COURSE_KEYS.filter((k) => nonEmpty(cells.get(k)) !== undefined);
    if (named.length === 0) return { course: undefined };
    return {
      error:
        `${file} gives ${named.join(' and ')} but no course_kind, so no course was loaded. ` +
        `Add a row reading "course_kind,<${COURSE_KINDS.join(' | ')}>".`,
    };
  }
  if (!COURSE_KINDS.includes(kind)) {
    return {
      error:
        `${file} says course_kind is "${kind}", which is not one of ` +
        `${COURSE_KINDS.join(', ')}, so no course was loaded.`,
    };
  }

  const wants = kind === 'gpx' ? 'course_src' : 'course_url';
  const forbids = kind === 'gpx' ? 'course_url' : 'course_src';
  const wanted = kind === 'gpx' ? src : url;
  const forbidden = kind === 'gpx' ? url : src;
  if (wanted === undefined) {
    return {
      error: `${file} says course_kind is "${kind}", which needs a ${wants} row; there is none.`,
    };
  }
  if (forbidden !== undefined) {
    return {
      error:
        `${file} says course_kind is "${kind}" and gives both course_src and course_url. ` +
        `A "${kind}" course is described by ${wants} alone — clear ${forbids}, or change ` +
        'course_kind to match the one you meant.',
    };
  }

  // Built as its own const so `person` is assigned to a narrowed member rather
  // than to the union — `exactOptionalPropertyTypes` refuses an `undefined`
  // assignment, so the key is only ever added when there is one.
  const course: CourseRef =
    kind === 'gpx'
      ? { kind: 'gpx', src: wanted }
      : kind === 'strava-embed'
        ? { kind: 'strava-embed', url: wanted }
        : { kind: 'strava-link', url: wanted };
  if (person !== undefined) course.person = person;
  return { course };
}

/**
 * What is wrong with a course URL, as WARNINGS — the course itself is returned
 * either way and the URL is written back untouched.
 *
 * **Not errors, and `schema.ts` records what it cost when they were.** For one
 * commit `validateManifest` refused a manifest over this; executing that showed
 * the settings box accepting a scheme-less paste (`strava.com/activities/123`,
 * the ordinary thing to type), Save writing it, and the next open refusing the
 * WHOLE manifest — taking the crop, every marker, the title, the timezone and
 * every `timeSource: 'manual'` placement with it. The refusal belongs where the
 * damage would be: `CourseFallback` declines to render an unsafe URL, and this
 * says why. Do not re-promote these.
 *
 * Both checks come from `./course-url.ts`, so there is one implementation of
 * what may be linked and what may be framed rather than a second, weaker copy
 * here.
 */
function courseUrlProblems(course: CourseRef, file: string): string[] {
  if (course.kind === 'gpx') return [];
  const host = hostOf(course.url);
  if (host === null) {
    return [
      `${file}'s course_url is not a plain https:// address, so it will not be shown as a ` +
        'link. It is kept exactly as written — correct it here or in the event settings to ' +
        'turn the link back on. (A URL carrying a tab, a space, a backslash or a "@" does ' +
        'not resolve to the host it appears to name, which is why those are refused too.)',
    ];
  }
  if (course.kind === 'strava-embed' && embeddableSrc(course.url) === null) {
    return [
      `${file}'s course_url for course_kind "strava-embed" is on "${host}", but an embed is ` +
        `loaded inside meanwhile's own page, so only ${embeddableHosts().join(' and ')} are ` +
        'framed there. It is still offered as a link out.',
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// formatEventCsv
// ---------------------------------------------------------------------------

/**
 * Write the event back out.
 *
 * **The model wins; `preserved` fills the gaps it leaves.** A preserved value
 * exists precisely because this build could not turn it into part of the model,
 * so writing it over a value the model DOES carry would discard whatever the
 * author has since set — the opposite of what preservation is for. The crop and
 * the course are each all-or-nothing for this: `event.range` is a pair or it is
 * nothing, so a caller that sets one has replaced both preserved ends.
 *
 * `schema` is the one key where preserved wins outright. A file that declared a
 * version this build refused must not come back claiming the version this build
 * writes — that would both assert something untrue and erase the marker that
 * made the refusal legible.
 *
 * A blank value writes no row at all, except `title` (blank is the prompt to
 * fill it in, and the key must stay visible) and `schema`. Keys in `extra` are
 * always written, blank or not: a key with no value still records that somebody
 * added it, and dropping it would make the round trip lossy for exactly the
 * data this file has no other way to carry.
 *
 * **Throws, legibly, rather than writing a wrong crop.** A timezone `Intl`
 * cannot resolve (`MDT` is the obvious thing for a person to type) makes
 * `instantPartsInZone` throw a bare `RangeError`, and a save that dies inside a
 * click handler leaves no file, no message, and a whole session's work in a tab.
 * Callers must be ready to show the message — see `saveEvent` in `App.tsx`,
 * which does exactly that for `noteToRow`'s matching throw.
 */
export function formatEventCsv(
  event: EventInfo,
  course?: CourseRef,
  extra?: Readonly<Record<string, string>>,
  preserved?: Readonly<Record<string, string>>,
): string {
  const rows: Array<Record<string, string>> = [];
  const fallback = (key: string): string => preserved?.[key] ?? '';
  const put = (key: string, value: string): void => {
    if (value !== '') rows.push({ key, value });
  };

  rows.push({ key: 'title', value: event.title.trim() || fallback('title') });
  put('timezone', event.timezone?.trim() || fallback('timezone'));

  if (event.range) {
    // The zone the crop is WRITTEN in is the event's, not whatever `range_*_tz`
    // said when it was read: `EventInfo.range` is a pair of instants and has
    // nowhere to keep a zone name. The instant round-trips exactly either way —
    // `utc_offset_min` is computed from the instant in this zone, so reading it
    // back gives the same moment — but a hand-typed `range_from_tz` naming a
    // different zone is rewritten to the event's on the next save.
    const zone = event.timezone?.trim() || 'UTC';
    rows.push(...sideRows('range_from', event.range.from, zone));
    rows.push(...sideRows('range_to', event.range.to, zone));
  } else {
    for (const key of RANGE_KEYS) put(key, fallback(key));
  }

  if (course) {
    put('course_kind', course.kind);
    put('course_src', course.kind === 'gpx' ? course.src : '');
    put('course_url', course.kind === 'gpx' ? '' : course.url);
    put('course_person', course.person ?? '');
  } else {
    for (const key of COURSE_KEYS) put(key, fallback(key));
  }

  for (const [key, value] of Object.entries(extra ?? {})) {
    // A known key arriving through `extra` would write the row twice and let
    // the two disagree. `parseEventCsv` cannot produce one; a caller can.
    if (KNOWN_EVENT_KEYS.has(key)) continue;
    rows.push({ key, value });
  }

  rows.push({ key: 'schema', value: fallback('schema').trim() || String(CSV_SCHEMA) });

  return formatCsv(EVENT_HEADERS, rows);
}

/** One end of the crop as its seven rows. */
function sideRows(prefix: string, iso: string, zone: string): Array<Record<string, string>> {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) {
    throw new Error(
      `The time window's ${prefix} is "${iso}", which is not a date and time meanwhile can ` +
        'read, so it cannot be written to event.csv.',
    );
  }
  // Asked BEFORE `Intl` is told to format anything: `instantPartsInZone` throws
  // a bare `RangeError: Invalid time zone specified: MDT` otherwise. Same guard
  // `noteToRow` makes for the same reason.
  const offset = zoneOffsetMinutes(instant, zone);
  if (offset === null) {
    throw new Error(
      `The event's timezone is "${zone}", which is not a name meanwhile recognises, so the ` +
        'time window cannot be written to event.csv. Write the full zone, like ' +
        '"America/Denver", not an abbreviation like "MDT".',
    );
  }
  const parts = instantPartsInZone(instant, zone);
  return [
    { key: `${prefix}_year`, value: String(parts.year) },
    { key: `${prefix}_month`, value: String(parts.month) },
    { key: `${prefix}_day`, value: String(parts.day) },
    { key: `${prefix}_hour`, value: String(parts.hour) },
    { key: `${prefix}_minute`, value: String(parts.minute) },
    // Always written, even when it matches the event's own zone — the same rule
    // `noteToRow` follows. Blanking it made a later edit to `event.timezone`
    // move the value silently, with nothing left on the row to say what was
    // meant.
    { key: `${prefix}_tz`, value: zone },
    { key: `${prefix}_utc_offset_min`, value: String(offset) },
  ];
}
