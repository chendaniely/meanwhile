/**
 * `markers.csv` — the labelled points on the course: aid stations, a summit,
 * the finish line. One marker per row.
 *
 * **The seven timestamp columns are `notes*.csv`'s, unprefixed** — `year,
 * month, day, hour, minute, tz, utc_offset_min` — resolved through
 * `resolveZoned` in `./wallclock.ts`, the one implementation of that ladder, so
 * a marker's 01:30 and a note's 01:30 cannot land an hour apart. Five bare
 * integers because no other format survives a spreadsheet (see CLAUDE.md, "the
 * timestamp is five integers, not one string"), and the `tz`/`utc_offset_min`
 * pair because neither is sufficient alone. There is no `second`: these are
 * times a person types.
 *
 * **A marker has NO id, and that is deliberate rather than an omission.**
 * `Marker` in `./schema.ts` is `{ label, at?, atDistance? }` and nothing in
 * this project mints or carries an id for one, so a column here would be
 * invented on write and churned on every save. Two consequences follow, and
 * both are the point rather than a cost to be engineered around:
 *
 *   1. **`markers.csv` cannot be merged between two people.** `notes*.csv`
 *      row-binds because every note carries an opaque, stable id — that is
 *      what `mergeNotes` dedupes on. A marker has no identity at all, so two
 *      crew members' marker files cannot be reconciled: row-binding them would
 *      produce every aid station twice, and nothing could tell that from a
 *      genuine second pass through the same aid station on an out-and-back.
 *      **This file has one author.** It does not glob the way `notes*.csv`
 *      does, and there is no `markers-priya.csv`.
 *   2. **`schema` is per FILE, not per row** — the same call `event.csv` makes,
 *      for the same reason. The per-row argument in `csv.ts` is that row-bound
 *      files land a row from someone's older copy among newer rows, so each
 *      row has to carry its own version. Nothing lands here from anywhere
 *      else, so a version declared anywhere in the file is a statement about
 *      the file, and a file this build cannot read is refused whole. See
 *      `fileSchemaProblem`.
 *
 * **An `atDistance`-only marker is invisible in the app today, and this module
 * says so out loud.** `Marker`'s own doc records it: `markerLines` in
 * `Swimlanes.tsx` draws markers on the TIME axis and drops one with no `at`,
 * because nothing converts metres along the course into a time yet. A
 * hand-authorable file whose most obvious use silently does nothing is a trap,
 * so `parseMarkersCsv` reports it as a warning — the marker is returned and
 * written back either way. **Delete that warning when the spine learns to
 * convert distance to time**, and not before.
 *
 * **Nothing this build cannot interpret is ever dropped.** A row with a month
 * of 13, an unresolvable `tz`, a `distance_m` that is not a number, or no
 * label at all is reported AND kept verbatim in `preserved`, then written
 * straight back by `formatMarkersCsv`. Refusing to READ a row is not
 * permission to DELETE it — see CLAUDE.md's section of that name.
 *
 * **Preserved rows go at the END of the file**, which is where `people.csv`
 * puts them and NOT where `notes*.csv` does. `noteRowsForSave` slots a refused
 * note back into its place in time, because a notes file is read in
 * chronological order and a row quarantined at the bottom is one nobody
 * reconnects to the hour it belongs to. A marker has no identity to reconnect
 * and its file has no chronology worth defending — the order is the author's,
 * and a rename or a new marker reshuffles it anyway — so the bottom is simply
 * where somebody repairing the file will look.
 *
 * Pure: only relative core imports and ECMAScript globals.
 */

import {
  CSV_SCHEMA,
  formatCsv,
  parseCsv,
  preservedHeaders,
  schemaCellProblem,
  type PreservedRow,
} from './csv.ts';
import type { Marker } from './schema.ts';
import { zoneOffsetMinutes } from './time.ts';
import { instantPartsInZone, nonEmpty, readCalendarParts, resolveZoned } from './wallclock.ts';

/**
 * The columns, in the order `formatMarkersCsv` writes them.
 *
 * `schema` is last, after any column somebody else added, so it is genuinely
 * the last column of the file rather than merely the last one this module owns
 * — the same rule `NOTE_HEADERS` and `PEOPLE_HEADERS` follow.
 *
 * **There is no `id`.** See the module doc: adding one would mint an
 * identifier nothing else in the project carries, and churn it on every save.
 */
export const MARKER_HEADERS: readonly string[] = [
  'label',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'tz',
  'utc_offset_min',
  'distance_m',
  'schema',
];

const KNOWN_MARKER_KEYS = new Set<string>(MARKER_HEADERS);

/** The five that must all be present and in range for a marker to have a time. */
const CALENDAR_FIELDS = ['year', 'month', 'day', 'hour', 'minute'] as const;

/**
 * Appended to every problem that quarantines a row, so the message says what
 * happened to the data as well as what was wrong with it. `parsePeopleCsv`'s
 * `keep()` carries the same promise, and it is the sentence that makes
 * "reported" different from "lost".
 */
const KEPT_ROW =
  '. The row is kept exactly as it is and written back when you save, so nothing in it is lost.';

const KEPT_ROWS =
  ' The rows are kept exactly as they are and written back when you save, so nothing in ' +
  'them is lost.';

/**
 * Columns of `markers.csv` this module has no meaning for, **aligned by index
 * with the `markers` array** — `extra[i]` belongs to `markers[i]`, and
 * `parseMarkersCsv` always returns exactly one entry per marker (an empty
 * object where a row carried nothing extra), so the two lengths agree.
 *
 * Indexed rather than keyed, unlike `PeopleExtra`, because there is no key: a
 * marker has no id (see the module doc) and a label is not unique — an
 * out-and-back passes the same aid station twice, under the same name.
 *
 * **A caller that reorders, inserts into or filters the marker list must do
 * the same to this array**, or a column somebody typed lands on the wrong
 * marker. Nothing in the app edits markers today; they are read from a file or
 * a manifest and carried, which is what makes index alignment honest here
 * rather than a hazard waiting to fire.
 */
export type MarkersExtra = Array<Record<string, string>>;

export interface MarkersCsv {
  markers: Marker[];
  /** One entry per marker, aligned by index. See `MarkersExtra`. */
  extra: MarkersExtra;
  /** Rows this build refused, kept verbatim. See `PreservedRow`. */
  preserved: PreservedRow[];
  problems: string[];
}

// ---------------------------------------------------------------------------
// parseMarkersCsv
// ---------------------------------------------------------------------------

/**
 * Read `markers.csv`.
 *
 * **`eventTimezone` is a required parameter that accepts `undefined`**, rather
 * than an optional one. It is the zone a row's wall clock falls back to when
 * the row names none of its own — every row written before this column existed,
 * and every row somebody adds by hand — so forgetting it does not fail, it
 * silently reads those rows as UTC and files a mountain race's aid stations up
 * to fourteen hours from where they belong. The type is what makes a caller
 * decide.
 *
 * **The header row is not checked**, which is a considered difference from
 * `parseEventCsv`. That check exists because `event.csv` is two columns of
 * key/value, where the header is the one row that can be mistaken for data.
 * This file is row-bound like `notes*.csv` and `people.csv`, neither of which
 * checks either: a file that has lost its header row has its first line read
 * as column names, and every row after it then reports a missing label.
 */
export function parseMarkersCsv(
  text: string,
  eventTimezone: string | undefined,
  /** Named in every problem, so a caller can point at the file to repair. */
  file = 'markers.csv',
): MarkersCsv {
  const { rows, rowLines } = parseCsv(text);
  const markers: Marker[] = [];
  const extra: MarkersExtra = [];
  const preserved: PreservedRow[] = [];
  const problems: string[] = [];

  // The row's real file line, not `i + 2`: `parseCsv` drops blank lines rather
  // than emitting empty rows for them, so a blank line anywhere above this one
  // would make that arithmetic understate every message below it. `rowLines[i]`
  // is never actually missing — it is built in lockstep with `rows` — the
  // fallback only satisfies the type checker.
  const lineOf = (i: number): number => rowLines[i] ?? i + 2;

  const keep = (row: Record<string, string>, line: number, problem: string): void => {
    preserved.push({ file, line, cells: row });
    problems.push(problem + KEPT_ROW);
  };

  // Checked before any row is interpreted: a file written by a newer build may
  // mean something different by every column in it, so reading them anyway
  // would be guessing. Per FILE — see the module doc for why the per-row
  // argument that justifies `notes*.csv`'s column does not carry here.
  const schemaBad = fileSchemaProblem(rows, rowLines, file);
  if (schemaBad) {
    problems.push(schemaBad + KEPT_ROWS);
    // Every row, `schema` cells included. Writing `schema,1` back over a file
    // that declared 2 would both claim a version this build did not read and
    // destroy the only marker saying so.
    rows.forEach((row, i) => preserved.push({ file, line: lineOf(i), cells: row }));
    return { markers, extra, preserved, problems };
  }

  rows.forEach((row, i) => {
    const line = lineOf(i);
    const where = `${file} row ${line}`;

    // First, because everything below names the marker in its own message and
    // a row with nothing to call it by cannot produce a legible one. It is
    // also what `Marker.label` requires: `validateManifest` refuses the whole
    // manifest over a blank label, so letting one through here would take the
    // crop, the course and every hand-placed time down with it on the next
    // save.
    const label = (row['label'] ?? '').trim();
    if (label === '') {
      keep(row, line, `${where} has no label, so there is nothing to call the marker`);
      return;
    }

    const time = readTime(row, eventTimezone, label);
    if ('error' in time) {
      keep(row, line, `${where}: ${time.error}`);
      return;
    }

    const distance = readDistance(row['distance_m'], label);
    if (typeof distance === 'object') {
      keep(row, line, `${where}: ${distance.error}`);
      return;
    }

    // `validateManifest` requires one or the other, so a marker with neither
    // is not a marker this app can hold. **Both together are legal** and are
    // deliberately not tightened here: the validator permits it, and a marker
    // that knows both when it happened and where it sits on the course is
    // strictly more information than one that knows either.
    if (time.instant === undefined && distance === undefined) {
      keep(
        row,
        line,
        `${where}: marker "${label}" gives neither a time nor a distance_m, so there is ` +
          'nowhere on the timeline to put it',
      );
      return;
    }

    const marker: Marker = { label };
    if (time.instant !== undefined) marker.at = new Date(time.instant).toISOString();
    if (distance !== undefined) marker.atDistance = distance;

    markers.push(marker);
    extra.push(unknownColumns(row));
  });

  const invisible = markers.filter((m) => m.at === undefined).map((m) => m.label);
  if (invisible.length > 0) problems.push(distanceOnlyProblem(invisible, file));

  return { markers, extra, preserved, problems };
}

/**
 * What is wrong with the file's `schema` declaration, or null.
 *
 * Every row's cell is checked and the FIRST unreadable one decides, because a
 * newer build writes its own version into every row it writes — so a single
 * newer cell says the file came from that build, whatever the rows around it
 * say. A blank cell means "the version this reader knows" (see
 * `schemaCellProblem`), so a row somebody added by hand needs nothing typed
 * into it.
 */
function fileSchemaProblem(
  rows: ReadonlyArray<Record<string, string>>,
  rowLines: readonly number[],
  file: string,
): string | null {
  for (let i = 0; i < rows.length; i++) {
    const bad = schemaCellProblem(rows[i]?.['schema'], file);
    if (bad) {
      return (
        `${file} row ${rowLines[i] ?? i + 2} ${bad}. No markers were read from the file at ` +
        'all, because a version is a statement about the whole of it.'
      );
    }
  }
  return null;
}

/**
 * The instant a row names, `{ instant: undefined }` when it names none, or the
 * one thing wrong with it.
 *
 * **All five integers or none.** A row with three of them is a hand-edit that
 * went wrong, and there is no honest way to fill the rest in: defaulting an
 * absent `minute` to zero would place a marker confidently at a time nobody
 * typed, which this project holds to be worse than a visible gap.
 */
function readTime(
  row: Record<string, string>,
  eventTimezone: string | undefined,
  label: string,
): { instant: number | undefined } | { error: string } {
  // Per field, before `Number` ever sees a blank: `Number('')` is 0, which is
  // finite and therefore invisible to a range check, so a blank `minute` would
  // resolve silently to :00 instead of being refused.
  const missing = CALENDAR_FIELDS.filter((f) => nonEmpty(row[f]) === undefined);
  if (missing.length === CALENDAR_FIELDS.length) return { instant: undefined };
  if (missing.length > 0) {
    return {
      error:
        `marker "${label}" is missing ${missing.join(', ')} — a marker's time needs all five ` +
        'of year, month, day, hour and minute, or none of them',
    };
  }
  // `nonEmpty` rather than the raw cell: it trims, and `readCalendarParts`
  // matches `/^\d{4}$/` against `year` — so a cell a spreadsheet left as
  // " 2026" would be refused as "not a whole number" for a value that is one.
  // The `as string` is safe because `missing` above is empty.
  const parts = readCalendarParts(
    {
      year: nonEmpty(row['year']) as string,
      month: nonEmpty(row['month']) as string,
      day: nonEmpty(row['day']) as string,
      hour: nonEmpty(row['hour']) as string,
      minute: nonEmpty(row['minute']) as string,
    },
    label,
    'marker',
  );
  if ('error' in parts) return parts;

  // `resolveZoned` reads `row.tz` and `row.utc_offset_min` by literal name —
  // deliberately not parameterised, so `utc_offset_min` has one spelling
  // across every file in the set. This file uses those exact names, so the row
  // goes in as it was read.
  const resolved = resolveZoned(parts, row, eventTimezone, label, 'marker');
  if ('error' in resolved) return resolved;
  return { instant: resolved.instant };
}

/**
 * A number of metres, `undefined` when the cell is blank, or the one thing
 * wrong with it.
 *
 * **Blank means absent, and `0` means zero.** The start line is a real marker
 * at a real distance, so a falsy check here would silently drop it.
 *
 * **A cell that is not a number makes the row PRESERVED, never a zero.**
 * `Number('about 5k')` is `NaN`, which is `typeof 'number'` and therefore
 * passes `validateManifest`'s only check on this field — and `JSON.stringify`
 * writes it as `null`, which the SAME validator then refuses on the next open,
 * taking the whole manifest with it. `Number.isFinite` is what stops that; the
 * regex refuses `Infinity`, `0x10` and `1_000` before `Number` is asked, and
 * `Number.isFinite` catches `1e999`, which the regex accepts and the runtime
 * overflows.
 *
 * Negative values are ALLOWED. `Marker.atDistance` is validated as nothing more
 * than a number, and this format may not quietly tighten what the manifest
 * permits.
 */
const DISTANCE_CELL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function readDistance(
  raw: string | undefined,
  label: string,
): number | undefined | { error: string } {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  const value = Number(s);
  if (!DISTANCE_CELL.test(s) || !Number.isFinite(value)) {
    return {
      error:
        `marker "${label}" has a distance_m of "${s}", which is not a number of metres — ` +
        'write plain metres, like 42195',
    };
  }
  return value;
}

/** Columns this module has no meaning for, verbatim. Empty when there are none. */
function unknownColumns(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!KNOWN_MARKER_KEYS.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The warning that a marker given by distance alone will not appear anywhere.
 *
 * **Said once for the whole file, not once per row.** The reason it is
 * invisible is a fact about this BUILD — there is no distance axis — rather
 * than about any one row, so repeating it per marker would be the same
 * sentence twelve times for a twelve-aid-station course.
 */
function distanceOnlyProblem(labels: readonly string[], file: string): string {
  const one = labels.length === 1;
  return (
    `${file} gives ${one ? 'a marker' : `${labels.length} markers`} by distance alone ` +
    `(${labels.join(', ')}). meanwhile draws markers on the time axis and has nothing that ` +
    `turns metres along the course into a time, so ${one ? 'it' : 'they'} will not appear ` +
    `anywhere in the app. Fill in year, month, day, hour and minute to place ` +
    `${one ? 'it' : 'them'}. The ${one ? 'row is' : 'rows are'} kept and written back either way.`
  );
}

// ---------------------------------------------------------------------------
// formatMarkersCsv
// ---------------------------------------------------------------------------

/**
 * Write the markers back out.
 *
 * **The zone written is the EVENT's**, not whatever `tz` a row was read with:
 * `Marker` is `{ label, at?, atDistance? }` and has nowhere to keep a zone
 * name. The instant round-trips exactly either way — `utc_offset_min` is
 * computed from the instant in this zone, so reading it back gives the same
 * moment — but a hand-typed `tz` naming a different zone is rewritten to the
 * event's on the next save, and the five integers with it. `formatEventCsv`
 * makes the same trade for the same reason.
 *
 * `tz` and `utc_offset_min` are ALWAYS written for a marker that has a time,
 * even when the zone matches the event's. Blanking it looked free and is not:
 * change `event.timezone` afterwards and every marker silently MOVES, with
 * nothing on the row to say which zone was meant. See CLAUDE.md, "The format
 * hardening".
 *
 * `preserved` holds the rows `parseMarkersCsv` refused, written back verbatim
 * AFTER the markers — see the module doc for why the end of the file is the
 * right place here and the wrong one in `notes*.csv`.
 *
 * **Throws, legibly, rather than writing a wrong marker.** A timezone `Intl`
 * cannot resolve (`MDT` is the obvious thing for a person to type), an `at`
 * that is not a date, or an `atDistance` that is not a finite number each stop
 * the save with words instead of writing something false. A save that dies
 * inside a click handler leaves no file, no message, and a whole session's work
 * in a tab — so callers must be ready to show the message, exactly as
 * `saveEvent` in `App.tsx` already does for `noteToRow`'s matching throw.
 */
export function formatMarkersCsv(
  markers: readonly Marker[],
  /** Required, and accepts `undefined` — see `parseMarkersCsv` for why. */
  eventTimezone: string | undefined,
  /** Aligned by index with `markers`. See `MarkersExtra`. */
  extra?: ReadonlyArray<Record<string, string>>,
  preserved: readonly PreservedRow[] = [],
): string {
  const headers = MARKER_HEADERS.filter((h) => h !== 'schema');
  const seen = new Set<string>(MARKER_HEADERS);
  for (const columns of extra ?? []) {
    for (const key of Object.keys(columns)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  headers.push(...preservedHeaders(headers.concat('schema'), preserved));
  headers.push('schema');

  const rows: Array<Record<string, string>> = markers.map((marker, i) => ({
    // Spread first so a known column always wins over a stray one wearing the
    // same name. `parseMarkersCsv` cannot produce one; a caller can.
    ...(extra?.[i] ?? {}),
    label: marker.label,
    ...timeCells(marker, eventTimezone),
    distance_m: distanceCell(marker),
    schema: String(CSV_SCHEMA),
  }));
  for (const row of preserved) rows.push(row.cells);

  return formatCsv(headers, rows);
}

/** The seven timestamp cells, all blank for a marker given by distance alone. */
function timeCells(marker: Marker, eventTimezone: string | undefined): Record<string, string> {
  const blank = {
    year: '', month: '', day: '', hour: '', minute: '', tz: '', utc_offset_min: '',
  };
  if (marker.at === undefined) return blank;

  const instant = Date.parse(marker.at);
  if (Number.isNaN(instant)) {
    throw new Error(
      `The marker "${marker.label}" happens at "${marker.at}", which is not a date and time ` +
        'meanwhile can read, so it cannot be written to markers.csv.',
    );
  }
  const zone = eventTimezone?.trim() || 'UTC';
  // Asked BEFORE `Intl` is told to format anything: `instantPartsInZone` throws
  // a bare `RangeError: Invalid time zone specified: MDT` otherwise. Same guard
  // `noteToRow` and `formatEventCsv` make for the same reason.
  const offset = zoneOffsetMinutes(instant, zone);
  if (offset === null) {
    throw new Error(
      `The event's timezone is "${zone}", which is not a name meanwhile recognises, so the ` +
        `marker "${marker.label}" cannot be written to markers.csv. Write the full zone, like ` +
        '"America/Denver", not an abbreviation like "MDT".',
    );
  }
  const parts = instantPartsInZone(instant, zone);
  return {
    // `String()` over the numbers is what writes `7` rather than `07` — the
    // format options do not control padding, see `instantPartsInZone`. Unpadded
    // is what a spreadsheet leaves alone.
    year: String(parts.year),
    month: String(parts.month),
    day: String(parts.day),
    hour: String(parts.hour),
    minute: String(parts.minute),
    tz: zone,
    utc_offset_min: String(offset),
  };
}

/** `atDistance` as a cell: blank when absent, `0` when zero, never `NaN`. */
function distanceCell(marker: Marker): string {
  if (marker.atDistance === undefined) return '';
  if (!Number.isFinite(marker.atDistance)) {
    throw new Error(
      `The marker "${marker.label}" is ${marker.atDistance} metres along the course, which is ` +
        'not a distance meanwhile can write to markers.csv.',
    );
  }
  return String(marker.atDistance);
}
