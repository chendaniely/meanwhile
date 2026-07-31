/**
 * The one implementation of meanwhile's spreadsheet-safe timestamp: five
 * plain integers plus a `tz` and a `utc_offset_min`, resolved to an instant
 * by a fixed three-rung ladder — **the row's own offset, else the row's own
 * zone, else the event's zone.**
 *
 * This lived inside `notes.ts` while `notes*.csv` was the only file with a
 * timestamp in it. It is lifted out here because it no longer is: `event.csv`,
 * `markers.csv` and `placements.csv` carry the same seven columns, and the
 * same wall clock has to mean the same instant in every one of them. A second
 * implementation of the ladder is how one file's 01:30 ends up an hour from
 * another file's, with nothing to notice it by. `markers.ts` importing
 * `resolveZoned` from `notes.ts` would have said the rule belongs to notes; it
 * belongs to the format.
 *
 * **The column names are NOT parameterised, deliberately.** Every file uses
 * `year, month, day, hour, minute, tz, utc_offset_min` verbatim — no prefix
 * and no `second`. A prefix would give `utc_offset_min` two spellings across
 * the file set, which is the one column a person hand-repairing a row has to
 * find; and `wallClockToInstant` builds a naive timestamp ending `:00`, so
 * there is nowhere for a `second` to go. These are times a person types, where
 * minute precision is the right precision. So `row.tz` and
 * `row.utc_offset_min` are literal lookups below, not parameters.
 *
 * **What IS parameterised is the noun in the error messages**, because a
 * `markers.csv` row reported to its author as a "note" sends them to the wrong
 * file. It defaults to `'note'`, so every caller that predates the split reads
 * exactly as it always did.
 *
 * Pure: only `./time.ts` and ECMAScript globals (`Date`, `Number`, `RegExp`).
 */

import { zonedToInstant, zoneOffsetMinutes } from './time.ts';

/**
 * A trimmed cell, or `undefined` when it is blank or absent.
 *
 * Shared rather than re-declared per reader because a blank cell and a missing
 * column must mean the same thing — "this row does not say" — in every file
 * that carries these columns. It lives here, with the ladder that consumes it,
 * for the same reason the ladder itself does.
 */
export function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  return s === '' ? undefined : s;
}

/** Zero-pad a calendar integer, e.g. pad(7, 2) -> "07". */
function pad(n: number, width: number): string {
  return String(Math.trunc(n)).padStart(width, '0');
}

/** "-06:00" from -360, for a message a person can compare against a cell. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

/** Days in a month, with a real leap-year rule rather than a lookup that lies. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Read one of the five timestamp integers, refusing anything a spreadsheet
 * would otherwise let roll over into a different moment.
 *
 * **Refused, never rolled over**, and that is the whole point. `Date.UTC`
 * happily turns month 13 into next January, day 32 into the 1st of the
 * following month, hour 24 into tomorrow, and `Number('45.7')` into 45 —
 * every one of which then REWRITES ITSELF on the next save, so the file no
 * longer says what its author typed and nothing ever reported a problem.
 * These are exactly what a drag-fill or a fat finger produces, and a
 * rolled-over value places a note confidently in the wrong place, which this
 * project holds to be worse than a visible gap.
 *
 * Private: every file's reader wants all five integers together, which is
 * `readCalendarParts`. A caller that reached for one of them alone would be
 * reading a timestamp column this format does not have.
 */
function readCalendarInt(
  raw: string,
  field: string,
  min: number,
  max: number,
  label: string,
  noun: string,
): number | { error: string } {
  if (!/^\d+$/.test(raw)) {
    return {
      error: `${noun} "${label}" has a ${field} of "${raw}", which is not a whole number`,
    };
  }
  const value = Number(raw);
  if (value < min || value > max) {
    return { error: `${noun} "${label}" has a ${field} of ${value}; ${field} runs ${min}–${max}` };
  }
  return value;
}

/**
 * All five integers, range-checked, including day-against-month.
 *
 * `noun` names the kind of row being read, so a `markers.csv` problem reads
 * `marker "Cottonwood" has a day of 32` rather than calling it a note. It
 * defaults to `'note'` because `notes*.csv` was the only caller when this was
 * written, and every message it produces must keep reading exactly as it did.
 */
export function readCalendarParts(
  parts: { year: string; month: string; day: string; hour: string; minute: string },
  label: string,
  noun: string = 'note',
): { y: number; mo: number; d: number; h: number; mi: number } | { error: string } {
  // Four digits as well as the range: `year` 26 is the single most likely
  // mistype, and `Date.UTC(26, …)` silently means 1926.
  if (!/^\d{4}$/.test(parts.year)) {
    return {
      error:
        `${noun} "${label}" has a year of "${parts.year}" — write the full four-digit year, ` +
        'between 1900 and 2100',
    };
  }
  const y = readCalendarInt(parts.year, 'year', 1900, 2100, label, noun);
  if (typeof y !== 'number') return y;
  const mo = readCalendarInt(parts.month, 'month', 1, 12, label, noun);
  if (typeof mo !== 'number') return mo;
  const d = readCalendarInt(parts.day, 'day', 1, 31, label, noun);
  if (typeof d !== 'number') return d;
  const h = readCalendarInt(parts.hour, 'hour', 0, 23, label, noun);
  if (typeof h !== 'number') return h;
  const mi = readCalendarInt(parts.minute, 'minute', 0, 59, label, noun);
  if (typeof mi !== 'number') return mi;

  const length = daysInMonth(y, mo);
  if (d > length) {
    return {
      error:
        `${noun} "${label}" has a day of ${d}, but ${MONTH_NAMES[mo - 1]} ${y} has ${length} days`,
    };
  }
  return { y, mo, d, h, mi };
}

export interface Resolved {
  instant: number;
  /** The row's own explicit zone, if it had one — undefined otherwise. */
  tz: string | undefined;
}

/**
 * Turn five calendar integers into an instant, using the row's `tz` and
 * `utc_offset_min`.
 *
 * **The offset determines the instant; the zone is for display and date
 * math.** They are both carried because neither is sufficient on its own:
 *
 *   - A zone NAME alone cannot express the repeated hour at a fall-back
 *     transition. 01:30 MDT and 01:30 MST are the same five integers, an hour
 *     apart, and a zone-only read silently returns the first every time —
 *     which for a 33-hour race that crosses the transition is an hour of the
 *     night placed wrong with nothing to notice it by.
 *   - An OFFSET alone loses which zone the writer meant, so nothing can
 *     render another date in it or explain the number.
 *
 * With both, every row is exact on its own terms, because each row carries
 * the offset in force at ITS moment rather than inheriting one from the
 * event.
 *
 * **Disagreement is reported, never guessed through.** "Agreement" is
 * deliberately not `zoneOffsetMinutes(naive-read-in-zone)`: at a fall-back
 * hour the zone legitimately has two offsets, and both are correct answers.
 * The test is instead whether the instant the offset produces really IS that
 * wall-clock time in that zone — which accepts both sides of the repeated
 * hour and rejects an offset from a different continent.
 *
 * `noun` names the kind of row for the four problems this can report; see the
 * module doc. It defaults to `'note'`, so `notes.ts` calls this exactly as it
 * always did and every existing message is unchanged.
 */
export function resolveZoned(
  parts: { y: number; mo: number; d: number; h: number; mi: number },
  row: Record<string, string>,
  eventTimezone: string | undefined,
  label: string,
  noun: string = 'note',
): Resolved | { error: string } {
  const tz = nonEmpty(row.tz);
  const offsetRaw = nonEmpty(row.utc_offset_min);
  // The zone the wall clock falls back to when the row carries no offset of
  // its own: an older row, or one typed by hand. Resolving through it is what
  // keeps every file written before the offset column existed reading to the
  // same instant it always did.
  const zone = tz ?? eventTimezone ?? 'UTC';

  let offset: number | null = null;
  if (offsetRaw !== undefined) {
    if (!OFFSET_CELL.test(offsetRaw)) {
      return {
        error:
          `${noun} "${label}" has a utc_offset_min of "${offsetRaw}", which is not a whole ` +
          'number of minutes — write -360 for UTC-06:00',
      };
    }
    offset = Number(offsetRaw);
    if (Math.abs(offset) > MAX_UTC_OFFSET_MIN) {
      return {
        error:
          `${noun} "${label}" has a utc_offset_min of ${offset}; real UTC offsets run from ` +
          '-720 to 840 minutes',
      };
    }
  }

  const instant = wallClockToInstant(parts, offset, zone);
  if (instant === null) {
    return { error: `${noun} "${label}" could not be resolved in timezone "${zone}"` };
  }

  if (offset !== null && tz !== undefined) {
    const inZone = zoneOffsetMinutes(instant, tz);
    if (inZone === null) {
      return { error: `${noun} "${label}" could not be resolved in timezone "${tz}"` };
    }
    if (inZone !== offset) {
      return {
        error:
          `${noun} "${label}" says timezone "${tz}" and utc_offset_min ${offset} ` +
          `(UTC${formatOffset(offset)}), but "${tz}" is UTC${formatOffset(inZone)} at that ` +
          'moment — correct one of the two rather than have meanwhile pick',
      };
    }
  }
  return { instant, tz };
}

/** `utc_offset_min`'s shape and bound, shared so the two readers cannot drift. */
const OFFSET_CELL = /^[+-]?\d+$/;
const MAX_UTC_OFFSET_MIN = 18 * 60;

/**
 * `utc_offset_min` as a number, or null when the cell is absent or says
 * something no UTC offset could.
 *
 * The lenient half of the pair: `resolveZoned` REPORTS a bad offset cell,
 * because a note whose timestamp is wrong must not be shown as if it were
 * right. This is for `preservedRowInstant` (see `notes.ts`), which has no way
 * to report anything — its row has already been refused — and only needs to
 * know whether there is an offset worth trusting before falling back to the
 * zone.
 */
export function readOffsetCell(raw: string | undefined): number | null {
  const s = nonEmpty(raw);
  if (s === undefined || !OFFSET_CELL.test(s)) return null;
  const offset = Number(s);
  return Math.abs(offset) > MAX_UTC_OFFSET_MIN ? null : offset;
}

/**
 * The instant five wall-clock integers name — the one implementation of the
 * rule that the row's own offset wins and its zone is the fallback.
 *
 * Shared by `resolveZoned` (a row that reads cleanly) and by `notes.ts`'s
 * `preservedRowInstant` (one that does not, and only needs a sort key). They
 * differ in what they do with a problem, never in where a timestamp lands —
 * a second implementation here is how a preserved row ends up filed hours away
 * from the notes it was written between.
 *
 * Null only when `zone` is one this runtime cannot resolve, or when the
 * integers will not fit a naive timestamp at all; with an offset there is
 * nothing to look up and the answer is always a number.
 */
export function wallClockToInstant(
  parts: { y: number; mo: number; d: number; h: number; mi: number },
  offsetMinutes: number | null,
  zone: string,
): number | null {
  if (offsetMinutes !== null) {
    return Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi) - offsetMinutes * 60_000;
  }
  const naive =
    `${pad(parts.y, 4)}-${pad(parts.mo, 2)}-${pad(parts.d, 2)}` +
    `T${pad(parts.h, 2)}:${pad(parts.mi, 2)}:00`;
  return zonedToInstant(naive, zone);
}
