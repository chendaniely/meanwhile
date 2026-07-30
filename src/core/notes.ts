/**
 * Convert between a `Note` and a CSV row.
 *
 * A timestamp is written as five plain integers (year, month, day, hour,
 * minute) rather than one ISO string, because a spreadsheet reformats a cell
 * that merely LOOKS like a date or a number the moment you save — "2026-07-25"
 * becomes a serial, "15:45" becomes a fraction of a day, and a full ISO
 * instant is exactly the string most likely to get "corrected". Splitting
 * date from time only made corruption recoverable; five bare integers make it
 * impossible, because nothing about "25" or "45" looks like a date to Excel.
 *
 * A span (`duration`) is an ISO-8601 duration, matching `clockOffset`
 * elsewhere in the manifest, so the unit always travels with the value.
 *
 * `rowToNote` also reads two legacy shapes, so a file written before this
 * change — or hand-typed with a `date`/`time` pair — still loads: it is
 * repaired into the five-integer shape the next time it is written out.
 * `year` absent is what selects the legacy path; `date`+`time` is tried
 * before a bare `at`.
 *
 * Pure: only `./time.ts`, `./csv.ts`, `./schema.ts` (a type-only import, for
 * `Item`), and ECMAScript/WHATWG globals (`Intl`, `Date`, `Number`).
 * Row-at-a-time conversion (`rowToNote`, `noteToRow`)
 * knows nothing about CSV text — that's `csv.ts`'s job. `mergeNotes` is the
 * exception: it takes whole files and calls `parseCsv` on each before
 * reducing them to a deduplicated, time-sorted note list.
 */

import {
  formatDuration, hasZone, parseDuration, parseZonedInstant, zoneOffsetMinutes, zonedToInstant,
} from './time.ts';
import {
  CSV_SCHEMA, parseCsv, preservedHeaders, schemaCellProblem, type PreservedRow,
} from './csv.ts';
import type { Item } from './schema.ts';

export interface Note {
  id: string;
  /** ISO-8601 instant, resolved from the row's timestamp columns. */
  at: string;
  /** ISO-8601 duration, e.g. "PT3H40M". Absent means a moment, not a span. */
  duration?: string;
  /**
   * The IANA zone this note is written in.
   *
   * **Always written out** (`noteToRow` fills it with the event's zone when
   * the note carries none of its own), which reverses the original design.
   * Blanking it when it agreed with the event looked like it cost nothing:
   * the row would simply pick the event's zone up again on read. It does not.
   * Change `event.timezone` afterwards and every note silently MOVES, while
   * the zoned-EXIF photographs beside them stay exactly where they are — and
   * because nothing recorded which zone the row was written under, there is
   * no way to tell afterwards which instant was meant. Unfixable
   * retroactively is the whole reason this ships now rather than later.
   */
  tz?: string;
  people: string[];
  photo?: string;
  author: string[];
  text: string;
  /**
   * When someone TYPED this, in epoch seconds. Machine-written; blank is
   * allowed and normal for anything predating the column.
   *
   * `at` is when the thing happened, which is not the same fact: "written at
   * the time" and "remembered two years later" is the difference between a
   * log and a memoir, and it cannot be reconstructed afterwards from
   * anything. It also gives a merge a tiebreak it otherwise lacks.
   */
  written?: number;
  /**
   * A tombstone: this note was deliberately removed.
   *
   * Deleting a note used to only drop it from memory, so any other copy of
   * `notes.csv` resurrected it on the next merge with nothing anywhere
   * recording that the removal was intentional. A deleted row stays IN the
   * file (`deleted` = 1) and wins over a live row with the same id — see
   * `dedupeNotes`.
   */
  deleted?: boolean;
  /**
   * Columns the row carried that this module does not know the meaning of.
   * Kept and written straight back out so a round trip cannot silently drop
   * a column a spreadsheet-editing author added.
   */
  extra?: Record<string, string>;
}

export const NOTE_HEADERS: readonly string[] = [
  'id',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'duration',
  'tz',
  'utc_offset_min',
  'people',
  'photo',
  'author',
  'text',
  'written',
  'deleted',
  'schema',
];

/**
 * `NOTE_HEADERS` plus whatever `extra` columns the notes actually carry, in
 * the order first seen.
 *
 * `formatCsv` only ever emits the headers it is handed — it has no notion of
 * `Note` at all — so a caller that writes `formatCsv(NOTE_HEADERS, rows)`
 * silently drops any column this module doesn't know the meaning of, even
 * though `rowToNote`/`noteToRow` faithfully carry it through `extra`. That
 * is the same class of loss as dropping a note outright: the writer's
 * job is to preserve a column someone typed into, not just the ones this
 * app happens to use. Worse, a dropped `extra` changes the note's
 * fingerprint (see `dedupeNotes`), so the saved copy no longer matches the
 * original and gets re-minted as a second note on the next load.
 */
export function noteHeadersFor(
  notes: readonly Note[],
  /**
   * Rows this build refused to read, kept verbatim (see `PreservedRow`). Their
   * columns count exactly as much as a note's `extra` does: a row written by a
   * NEWER build is the case the `schema` column exists for, and a newer build
   * is precisely the thing likely to have added a column this one has no name
   * for.
   */
  preserved: readonly PreservedRow[] = [],
): string[] {
  // `schema` is appended last, AFTER the extras, so it is genuinely the last
  // column of the file rather than merely the last one this module owns.
  const headers = NOTE_HEADERS.filter((h) => h !== 'schema');
  const seen = new Set<string>(NOTE_HEADERS);
  for (const note of notes) {
    if (!note.extra) continue;
    for (const key of Object.keys(note.extra)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  headers.push(...preservedHeaders(headers.concat('schema'), preserved));
  headers.push('schema');
  return headers;
}

/**
 * A rough instant for a preserved row, used ONLY to decide where it sits in
 * the saved file.
 *
 * A preserved row is one this build refused to interpret, so nothing here may
 * be treated as a real timestamp — that is the whole reason the row was
 * refused. `Date.UTC` is used deliberately loosely: a `day` of 32 rolls into
 * the next month, which is wrong as a date and perfectly good as a sort key,
 * because the row still lands within a day of where its author meant it.
 * Nothing reads this value back; the row is written from `cells` untouched.
 *
 * Returns `NaN` when there is nothing to go on at all, which sorts the row to
 * the end rather than to 1970.
 */
function preservedRowInstant(cells: Record<string, string>): number {
  const int = (raw: string | undefined): number =>
    /^\d+$/.test((raw ?? '').trim()) ? Number(raw) : NaN;
  const y = int(cells['year']);
  const mo = int(cells['month']);
  const d = int(cells['day']);
  if (!Number.isNaN(y) && !Number.isNaN(mo) && !Number.isNaN(d)) {
    const h = int(cells['hour']);
    const mi = int(cells['minute']);
    return Date.UTC(y, mo - 1, d, Number.isNaN(h) ? 0 : h, Number.isNaN(mi) ? 0 : mi);
  }
  const at = (cells['at'] ?? '').trim();
  return at === '' ? NaN : Date.parse(at);
}

/**
 * Every row a Save writes to `notes.csv`: the notes, the tombstones, and the
 * rows this build could not read — one chronological list.
 *
 * **A preserved row keeps its place in time rather than being swept to the
 * bottom.** A file someone opens in a spreadsheet is read in order, and a row
 * that has been quarantined at the end of it is one nobody will connect to the
 * hour of the race it belongs to. Where the row says nothing about when it
 * happened, it goes last — after everything datable, which is the only honest
 * place left for it.
 *
 * Preserved rows are NOT notes and are counted nowhere: they never enter the
 * `Note[]` list, so nothing shows them, places them on a lane, or includes
 * them in the "N notes" digest. They exist between the reader that refused
 * them and the writer that puts them back.
 *
 * Throws — via `noteToRow` — if a note carries a timezone this build cannot
 * resolve. Callers must be ready to show that rather than dropping it, which
 * is why `App.tsx`'s Save is wrapped.
 */
export function noteRowsForSave(
  notes: readonly Note[],
  preserved: readonly PreservedRow[],
  eventTimezone?: string,
): Array<Record<string, string>> {
  const keyed = [
    ...notes.map((note, i) => ({
      at: Date.parse(note.at),
      order: i,
      row: noteToRow(note, eventTimezone),
    })),
    ...preserved.map((row, i) => ({
      at: preservedRowInstant(row.cells),
      order: notes.length + i,
      row: row.cells,
    })),
  ];
  keyed.sort((a, b) => {
    const aUndated = Number.isNaN(a.at);
    const bUndated = Number.isNaN(b.at);
    if (aUndated !== bUndated) return aUndated ? 1 : -1;
    if (!aUndated && a.at !== b.at) return a.at - b.at;
    // Ties hold their input order, so two rows at the same minute do not swap
    // places every time the file is saved and make a pointless diff.
    return a.order - b.order;
  });
  return keyed.map((k) => k.row);
}

/** Legacy column names, tried in order when `year` is absent. */
const LEGACY_KEYS = ['date', 'time', 'at'];

const KNOWN_KEYS = new Set<string>([...NOTE_HEADERS, ...LEGACY_KEYS]);

// ---------------------------------------------------------------------------
// rowToNote
// ---------------------------------------------------------------------------

export function rowToNote(row: Record<string, string>, eventTimezone?: string): Note | { error: string } {
  const id = (row.id ?? '').trim();
  const label = id || '(no id)';

  // Checked BEFORE anything else is interpreted: a row from a newer build may
  // mean something different by every other column in it, so reading them
  // first would be guessing.
  const schemaBad = schemaCellProblem(row.schema, 'notes.csv');
  if (schemaBad) return { error: `note "${label}" ${schemaBad}` };

  const resolved = resolveInstant(row, eventTimezone, label);
  if ('error' in resolved) return resolved;
  const { instant, tz } = resolved;

  const text = (row.text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (text === '') return { error: `note "${label}" has no text` };

  const duration = readDuration(row.duration ?? '');
  if (duration === INVALID_DURATION) {
    return { error: `note "${label}" has an unreadable duration "${row.duration ?? ''}"` };
  }

  const writtenRaw = (row.written ?? '').trim();
  if (writtenRaw !== '' && !/^\d+$/.test(writtenRaw)) {
    return {
      error:
        `note "${label}" has a written of "${writtenRaw}", which is not a whole number of ` +
        'seconds since 1970 — clear the cell if you did not mean to type in it',
    };
  }

  const deletedRaw = (row.deleted ?? '').trim();
  if (deletedRaw !== '' && deletedRaw !== '0' && deletedRaw !== '1') {
    return {
      error:
        `note "${label}" has a deleted of "${deletedRaw}"; that column is 1 for a note that ` +
        'was deleted and blank (or 0) for one that is still there',
    };
  }

  const note: Note = {
    id,
    at: new Date(instant).toISOString(),
    people: splitList(row.people),
    author: splitList(row.author),
    text,
  };
  if (duration !== undefined) note.duration = duration;
  if (tz !== undefined) note.tz = tz;
  const photo = nonEmpty(row.photo);
  if (photo !== undefined) note.photo = photo;
  if (writtenRaw !== '') note.written = Number(writtenRaw);
  if (deletedRaw === '1') note.deleted = true;
  const extra = extraFields(row);
  if (extra !== undefined) note.extra = extra;
  return note;
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
 */
function readCalendarInt(
  raw: string,
  field: string,
  min: number,
  max: number,
  label: string,
): number | { error: string } {
  if (!/^\d+$/.test(raw)) {
    return {
      error: `note "${label}" has a ${field} of "${raw}", which is not a whole number`,
    };
  }
  const value = Number(raw);
  if (value < min || value > max) {
    return { error: `note "${label}" has a ${field} of ${value}; ${field} runs ${min}–${max}` };
  }
  return value;
}

/** All five integers, range-checked, including day-against-month. */
function readCalendarParts(
  parts: { year: string; month: string; day: string; hour: string; minute: string },
  label: string,
): { y: number; mo: number; d: number; h: number; mi: number } | { error: string } {
  // Four digits as well as the range: `year` 26 is the single most likely
  // mistype, and `Date.UTC(26, …)` silently means 1926.
  if (!/^\d{4}$/.test(parts.year)) {
    return {
      error:
        `note "${label}" has a year of "${parts.year}" — write the full four-digit year, ` +
        'between 1900 and 2100',
    };
  }
  const y = readCalendarInt(parts.year, 'year', 1900, 2100, label);
  if (typeof y !== 'number') return y;
  const mo = readCalendarInt(parts.month, 'month', 1, 12, label);
  if (typeof mo !== 'number') return mo;
  const d = readCalendarInt(parts.day, 'day', 1, 31, label);
  if (typeof d !== 'number') return d;
  const h = readCalendarInt(parts.hour, 'hour', 0, 23, label);
  if (typeof h !== 'number') return h;
  const mi = readCalendarInt(parts.minute, 'minute', 0, 59, label);
  if (typeof mi !== 'number') return mi;

  const length = daysInMonth(y, mo);
  if (d > length) {
    return {
      error:
        `note "${label}" has a day of ${d}, but ${MONTH_NAMES[mo - 1]} ${y} has ${length} days`,
    };
  }
  return { y, mo, d, h, mi };
}

interface Resolved {
  instant: number;
  /** The row's own explicit zone, if it had one — undefined otherwise. */
  tz: string | undefined;
}

/**
 * Find the instant a row names, trying the current five-integer shape first
 * and falling back to the two legacy shapes a hand-written or older file
 * might carry.
 */
function resolveInstant(
  row: Record<string, string>,
  eventTimezone: string | undefined,
  label: string,
): Resolved | { error: string } {
  if (row.year !== undefined) {
    // `Number('')` is 0 — finite, and therefore invisible to an
    // isFinite-only guard. A blank cell must fail here, per field, before
    // Number() ever sees it, or a hand-edit slip (one blank minute) silently
    // resolves to :00 instead of being rejected.
    const yRaw = String(row.year ?? '').trim();
    const moRaw = String(row.month ?? '').trim();
    const dRaw = String(row.day ?? '').trim();
    const hRaw = String(row.hour ?? '').trim();
    const miRaw = String(row.minute ?? '').trim();
    if ([yRaw, moRaw, dRaw, hRaw, miRaw].some((s) => s === '')) {
      return { error: `note "${label}" has a blank date/time field` };
    }
    const parts = readCalendarParts(
      { year: yRaw, month: moRaw, day: dRaw, hour: hRaw, minute: miRaw },
      label,
    );
    if ('error' in parts) return parts;
    return resolveZoned(parts, row, eventTimezone, label);
  }

  if (row.date !== undefined) {
    const date = parseLegacyDate(row.date ?? '');
    const time = parseLegacyTime(row.time ?? '');
    if (date === null || time === null) {
      return { error: `note "${label}" has an unreadable date or time` };
    }
    // Through the SAME range check as the five-integer path: a legacy
    // `2026-02-30` would otherwise roll over to 2 March exactly as a bad
    // `day` cell does, and the two shapes must not disagree about what is
    // readable.
    const parts = readCalendarParts(
      {
        year: String(date.y), month: String(date.mo), day: String(date.d),
        hour: String(time.h), minute: String(time.mi),
      },
      label,
    );
    if ('error' in parts) return parts;
    return resolveZoned(parts, row, eventTimezone, label);
  }

  if (row.at !== undefined) {
    const raw = row.at.trim();
    const tz = nonEmpty(row.tz);
    const instant = hasZone(raw) ? parseZonedInstant(raw) : zonedToInstant(raw, tz ?? eventTimezone ?? 'UTC');
    if (instant === null) {
      return { error: `note "${label}" has an unreadable "at" value "${row.at}"` };
    }
    // The zone is checked even when the `at` value carried its own offset and
    // nothing here needed it. `noteToRow` writes the row back THROUGH `tz`,
    // so a zone this build cannot resolve is not a harmless spare cell: an
    // abbreviation like "MDT" — the obvious thing for a person to type — read
    // in cleanly here and then threw a raw `RangeError` out of the Save
    // button, producing no file and no message. The five-integer path has
    // always validated the zone; this one now does too, so the row is
    // refused, reported, and kept rather than breaking the save later.
    if (tz !== undefined && zoneOffsetMinutes(instant, tz) === null) {
      return {
        error:
          `note "${label}" has a timezone of "${tz}", which is not a name meanwhile ` +
          'recognises — write the full zone, like "America/Denver", not an abbreviation ' +
          'like "MDT"',
      };
    }
    return { instant, tz };
  }

  return { error: `note "${label}" has no date/time columns` };
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
 */
function resolveZoned(
  parts: { y: number; mo: number; d: number; h: number; mi: number },
  row: Record<string, string>,
  eventTimezone: string | undefined,
  label: string,
): Resolved | { error: string } {
  const tz = nonEmpty(row.tz);
  const offsetRaw = nonEmpty(row.utc_offset_min);

  if (offsetRaw !== undefined) {
    if (!/^[+-]?\d+$/.test(offsetRaw)) {
      return {
        error:
          `note "${label}" has a utc_offset_min of "${offsetRaw}", which is not a whole ` +
          'number of minutes — write -360 for UTC-06:00',
      };
    }
    const offset = Number(offsetRaw);
    if (Math.abs(offset) > 18 * 60) {
      return {
        error:
          `note "${label}" has a utc_offset_min of ${offset}; real UTC offsets run from ` +
          '-720 to 840 minutes',
      };
    }
    const naiveAsUtc = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi);
    const instant = naiveAsUtc - offset * 60_000;
    if (tz !== undefined) {
      const inZone = zoneOffsetMinutes(instant, tz);
      if (inZone === null) {
        return { error: `note "${label}" could not be resolved in timezone "${tz}"` };
      }
      if (inZone !== offset) {
        return {
          error:
            `note "${label}" says timezone "${tz}" and utc_offset_min ${offset} ` +
            `(UTC${formatOffset(offset)}), but "${tz}" is UTC${formatOffset(inZone)} at that ` +
            'moment — correct one of the two rather than have meanwhile pick',
        };
      }
    }
    return { instant, tz };
  }

  // No offset column: an older row, or one typed by hand. Resolved through
  // the zone exactly as before, which is what keeps every file written
  // before this change reading to the same instant it always did.
  const zone = tz ?? eventTimezone ?? 'UTC';
  const naive =
    `${pad(parts.y, 4)}-${pad(parts.mo, 2)}-${pad(parts.d, 2)}` +
    `T${pad(parts.h, 2)}:${pad(parts.mi, 2)}:00`;
  const instant = zonedToInstant(naive, zone);
  if (instant === null) {
    return { error: `note "${label}" could not be resolved in timezone "${zone}"` };
  }
  return { instant, tz };
}

/**
 * `date` accepts: "YYYY-MM-DD", "M/D/YY", "M/D/YYYY", and a bare Excel serial
 * (days since 1899-12-30, the epoch Excel itself uses for that column type).
 */
function parseLegacyDate(raw: string): { y: number; mo: number; d: number } | null {
  const s = raw.trim();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const yRaw = m[3] ?? '';
    const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    return { y, mo: Number(m[1]), d: Number(m[2]) };
  }

  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const serial = Number(s);
    const epoch = Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + Math.floor(serial) * 86_400_000);
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  return null;
}

/**
 * `time` accepts: "HH:MM", "HH:MM:SS" (seconds are read and dropped — a note
 * has no seconds column), "h:MM AM/PM", and a bare day fraction (0.65625 ==
 * 15:45), the other half of an Excel datetime serial.
 */
function parseLegacyTime(raw: string): { h: number; mi: number } | null {
  const s = raw.trim();

  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? { h, mi } : null;
  }

  m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(s);
  if (m) {
    const ampm = m[3] ?? '';
    let h = Number(m[1]) % 12;
    const mi = Number(m[2]);
    if (/^[Pp]/.test(ampm)) h += 12;
    return h <= 23 && mi <= 59 ? { h, mi } : null;
  }

  if (/^0?\.\d+$/.test(s)) {
    const frac = Number(s);
    if (frac >= 0 && frac < 1) {
      const totalMinutes = Math.round(frac * 1440);
      return { h: Math.floor(totalMinutes / 60) % 24, mi: totalMinutes % 60 };
    }
  }

  return null;
}

/** Sentinel distinguishing "no duration" (undefined) from "unreadable". */
const INVALID_DURATION = Symbol('invalid-duration');

/**
 * A valid ISO-8601 duration passes through `parseDuration`/`formatDuration`
 * to canonicalise it (so "PT180M" and "PT3H" read back identically); a bare
 * number is minutes, per the brief.
 */
function readDuration(raw: string): string | undefined | typeof INVALID_DURATION {
  const s = raw.trim();
  if (s === '') return undefined;

  const iso = parseDuration(s);
  if (iso !== null) return formatDuration(iso);

  if (/^-?\d+(?:\.\d+)?$/.test(s)) return formatDuration(Number(s) * 60_000);

  return INVALID_DURATION;
}

function nonEmpty(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  return s === '' ? undefined : s;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function extraFields(row: Record<string, string>): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  let has = false;
  for (const [key, value] of Object.entries(row)) {
    if (!KNOWN_KEYS.has(key)) {
      extra[key] = value;
      has = true;
    }
  }
  return has ? extra : undefined;
}

// ---------------------------------------------------------------------------
// noteToRow
// ---------------------------------------------------------------------------

export function noteToRow(note: Note, eventTimezone?: string): Record<string, string> {
  const zone = note.tz ?? eventTimezone ?? 'UTC';
  const instant = new Date(note.at).getTime();
  // Checked before `Intl` is asked to format anything. `instantPartsInZone`
  // throws a bare `RangeError: Invalid time zone specified: MDT` otherwise,
  // which escaped the Save click handler and left no file, no message, and a
  // whole session's writing unsaved. `rowToNote` refuses such a zone now, so
  // reaching this is a note built in memory rather than read from a file —
  // but a save must fail with words a person can act on, never a stack trace.
  if (zoneOffsetMinutes(instant, zone) === null) {
    throw new Error(
      `note "${note.id}" has a timezone of "${zone}", which is not a name meanwhile ` +
        'recognises, so it cannot be written to notes.csv. Write the full zone, like ' +
        '"America/Denver", not an abbreviation like "MDT".',
    );
  }
  const parts = instantPartsInZone(instant, zone);
  // Read from the INSTANT rather than remembered from the row it was parsed
  // from, which makes it exact across a DST transition without storing
  // anything extra: an instant has exactly one offset in a given zone, even
  // in the hour a wall clock repeats.
  const offset = zoneOffsetMinutes(instant, zone);

  const row: Record<string, string> = {
    id: note.id,
    year: String(parts.year),
    month: String(parts.month),
    day: String(parts.day),
    hour: String(parts.hour),
    minute: String(parts.minute),
    duration: note.duration ?? '',
    // ALWAYS written, even when it matches the event's own zone. See the doc
    // on `Note.tz`: blanking it made a later change to `event.timezone` move
    // every note silently, with nothing on the row to reconstruct what was
    // meant.
    tz: zone,
    utc_offset_min: offset === null ? '' : String(offset),
    people: note.people.join(';'),
    photo: note.photo ?? '',
    author: note.author.join(';'),
    text: note.text,
    written: note.written !== undefined ? String(note.written) : '',
    deleted: note.deleted ? '1' : '',
    schema: String(CSV_SCHEMA),
  };

  if (note.extra) Object.assign(row, note.extra);
  return row;
}

/**
 * Render an instant as calendar integers in `timeZone`, unpadded — the
 * inverse of the naive-string construction in `resolveInstant`.
 *
 * `hour: 'numeric'` (not `'2-digit'`) is what keeps these unpadded; `% 24`
 * folds away the "24" some ICU builds render for midnight under `h23`.
 */
function instantPartsInZone(
  instant: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(instant));

  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

// ---------------------------------------------------------------------------
// dedupeNotes / mergeNotes
// ---------------------------------------------------------------------------

/**
 * A content fingerprint used to tell "the same row seen twice" from "a
 * different row wearing the same id".
 *
 * Three things a naive `JSON.stringify` of the note would get wrong, all
 * found by hand-editing a real spreadsheet:
 *
 * - **Array order.** `people`/`author` are semantically sets — "Priya;Sam"
 *   and "Sam;Priya" name the same two people — but reordering names in a
 *   spreadsheet is a completely ordinary edit, e.g. sorting the column. An
 *   unsorted fingerprint would treat that as a content change and re-mint a
 *   second note for what is still the same row.
 * - **`tz`.** `noteToRow` now writes the zone into every row it produces,
 *   even when it agrees with the event's own (see the doc on `Note.tz` for
 *   why blank-when-matching turned out not to be free). But a row that
 *   predates that change, or one a person added by hand with no `tz` cell at
 *   all, leaves `note.tz` undefined on read; a row that carries the event's
 *   own zone explicitly (`tz: 'America/Denver'` where that IS the event
 *   zone — which is what every row gets once it has round-tripped through
 *   `noteToRow` once) carries it. Those are the same note read two different
 *   ways, and must fingerprint identically or a Save-then-reload duplicates
 *   it.
 * - **`at`'s exact spelling.** `rowToNote` always produces
 *   `Date.toISOString()`'s canonical form, milliseconds included
 *   (`"...T09:00:00.000Z"`); `legacyNoteToNote` (see `viewer/media/ingest.ts`)
 *   passes an imported manifest's `at` straight through unchanged, and a
 *   hand-written or older one very often has no milliseconds
 *   (`"...T09:00:00Z"`). Same instant, different string — comparing the raw
 *   strings is exactly the bug that let a legacy manifest's note and its own
 *   migrated copy in `notes.csv` collide as two notes instead of deduping to
 *   one.
 *
 * **`written` and `deleted` are deliberately excluded.** Both are facts about
 * the ROW rather than about what the note says, and including either would
 * break something real: a legacy manifest's note (no `written`) and its own
 * migrated `notes.csv` copy (with one) must still dedupe to a single note,
 * and a tombstone has to fingerprint the same as the live row it cancels, or
 * a hand-added blank-`id` copy of a deleted note could never be recognised as
 * that note again.
 */
export function fingerprintNote(note: Note, eventTimezone?: string): string {
  const tz = note.tz !== undefined && note.tz !== eventTimezone ? note.tz : undefined;
  return JSON.stringify([
    Date.parse(note.at),
    note.duration,
    tz,
    [...note.people].sort(),
    note.photo,
    [...note.author].sort(),
    note.text,
    note.extra,
  ]);
}

/**
 * `rowIdentity`'s type on its own: a session-scoped map from a blank-`id`
 * row's content fingerprint (as parsed — see the `rowIdentity` param doc on
 * `dedupeNotes`) to the id minted for it the first time it was seen. Mutated
 * in place by `dedupeNotes`, which is why it is a plain `Map` here rather
 * than the `Readonly*` shapes the rest of this module's session inputs use —
 * this one is a two-way channel, not a snapshot.
 */
export type NoteRowIdentity = Map<string, string>;

/**
 * Concatenate-and-dedupe a flat list of notes, minting an id for any that
 * lack one and re-minting one side of a genuine collision.
 *
 * Shared by `mergeNotes` (several `notes*.csv` files) and by ingest's
 * combination of a legacy manifest's migrated notes with `notes*.csv` (see
 * `viewer/media/ingest.ts`) — a folder can hold BOTH after an old-style
 * `manifest.json` and a `notes.csv` saved from it both land back in the same
 * folder, which produces exact id collisions without this.
 */
export function dedupeNotes(
  notes: readonly Note[],
  eventTimezone?: string,
  /**
   * A blank-`id` row has no identity of its own to key off — `rowToNote`
   * gives it `id: ''` and this function has always minted a fresh RANDOM id
   * for it. Without `rowIdentity`, that mint is gone the moment this
   * function returns: the identical, unsaved row in the file mints a
   * DIFFERENT random id on every re-parse, which is the root cause behind
   * three separate bugs found in review (a note duplicating across "Add
   * files", a deleted note resurrecting, and an edited-then-deleted note
   * resurrecting under its PRE-edit text) — every one of them a symptom of
   * the same thing: a blank-id row's id was never actually stable.
   *
   * When supplied, a blank-id row's content fingerprint is looked up here
   * first; a hit reuses that id instead of minting a new one, and a miss
   * mints one and records it for next time. The caller (`ingestFolder`,
   * `App.tsx`) owns this map for the lifetime of one open folder and resets
   * it when a genuinely different folder is opened — see the comment there.
   *
   * Looked up from a SNAPSHOT taken at the start of this call, not the live
   * map: a fingerprint recorded by one row earlier in this SAME parse must
   * not be "reused" by a second row that merely shares it, or two rows
   * someone typed once — a coincidence, not the same row re-read — would
   * silently collapse into one note. Only a fingerprint known from an
   * EARLIER call (a previous ingest of the same session) resolves to a
   * stable id; within one call, content alone still never merges two rows.
   */
  rowIdentity?: NoteRowIdentity,
): Note[] {
  const out: Note[] = [];
  const seen = new Map<string, string>(); // id -> a fingerprint of its content, within this call
  const priorIdentity = rowIdentity ? new Map(rowIdentity) : undefined;

  /**
   * Ids some row in this merge says were deliberately deleted.
   *
   * Collected up front rather than as the loop reaches them, because a
   * tombstone and the live row it cancels can arrive from different files in
   * either order — one crew member's `notes.csv` still has the note, another's
   * records that it went. A deletion wins whichever way round they land.
   */
  const tombstoned = new Set<string>();
  for (const note of notes) {
    if (note.deleted && note.id) tombstoned.add(note.id);
  }

  /**
   * Content that already carries an id somewhere in this merge, so a
   * blank-`id` row of the same content can ADOPT it instead of minting a
   * fresh one.
   *
   * This is what stops the count growing without bound when a SAVED copy of
   * `notes.csv` (ids filled in by the site) is merged with a pristine copy
   * whose rows are still blank-`id` — measured at 2 → 3 → 4 → 5 → 6 notes
   * over five rounds before this existed, because `rowIdentity` only
   * stabilises an id within one session and the ided row had already claimed
   * its slot. Adopting the id makes the pair collide on identical content
   * immediately below, which is where they collapse back to one note.
   *
   * It does NOT collapse two blank-id rows against each other — nothing here
   * has an id for that content, so the `rowIdentity` path and its
   * deliberately-not-reused rule (see the parameter doc above) still decide
   * those, and two rows someone typed once stay two notes.
   *
   * **Tombstones are excluded**, which is not an oversight. A blank-`id` row
   * has no identity for a tombstone to address, so letting one adopt a
   * DELETED note's id would silently swallow a row someone typed by hand
   * whose text happened to match something deleted earlier. Losing what a
   * person wrote is the worse of the two failures — the other is a deleted
   * note reappearing, which is visible and can be deleted again.
   */
  const identified = new Map<string, string>();
  for (const note of notes) {
    if (!note.id || note.deleted) continue;
    const fingerprint = fingerprintNote(note, eventTimezone);
    if (!identified.has(fingerprint)) identified.set(fingerprint, note.id);
  }

  const mintUnique = (): string => {
    let candidate = mintNoteId();
    while (seen.has(candidate)) candidate = mintNoteId();
    return candidate;
  };

  for (const note of notes) {
    const next = { ...note };
    const fingerprint = fingerprintNote(next, eventTimezone);

    if (!next.id) {
      const adopted = identified.get(fingerprint);
      if (adopted !== undefined) {
        // Falls through to the collision check below on purpose: the ided
        // copy either has been emitted already (same id, same fingerprint —
        // dropped as a repeat) or is still to come (and will be dropped when
        // it arrives). Either way one note, whichever file was read first.
        next.id = adopted;
      } else {
        const stable = priorIdentity?.get(fingerprint);
        // Reused only if nothing in THIS call has already claimed it — see
        // the note above about two rows sharing a fingerprint in one parse.
        next.id = stable !== undefined && !seen.has(stable) ? stable : mintUnique();
      }
      rowIdentity?.set(fingerprint, next.id);
    }

    // A deleted row wins over a live row with the same id — the point of the
    // tombstone. Checked after the id is settled so a blank-id row that
    // adopted a deleted note's id is cancelled by it too.
    if (!next.deleted && tombstoned.has(next.id)) continue;

    if (seen.has(next.id)) {
      // The same row seen twice is one note. A different row wearing the
      // same id is a copy, and gets its own identity.
      if (seen.get(next.id) === fingerprint) continue;
      // DERIVED from the copy's own content, not minted at random — see
      // `deriveNoteId`. A random re-mint made the count grow by one on every
      // save/merge cycle (measured 2 → 3 → 4 → 5 → 6 over five rounds with
      // the same two files), because the file that keeps re-introducing the
      // collision gets a different new id each time and so never matches the
      // copy already saved.
      next.id = deriveNoteId(fingerprint);
      const held = seen.get(next.id);
      // The derived id may already be in use: by this exact content (the copy
      // has been through here before in this same merge — one note), or, far
      // less likely, by different content that happens to hash to it.
      if (held === fingerprint) continue;
      if (held !== undefined) next.id = mintUnique();
    }
    seen.set(next.id, fingerprint);
    out.push(next);
  }

  return out;
}

/**
 * The id given to a row that turns up wearing an id another row already has.
 *
 * **Derived from the content, so repeated merges converge.** Reached by
 * copy-pasting a row in a spreadsheet and editing the text: the copy collides
 * with the original's id, and one side has to be re-identified. When that was
 * `mintNoteId()` the new id was different on every pass, so a folder holding
 * the saved file AND the still-uncorrected original grew by one note per
 * save/merge cycle forever. A content-derived id makes the second pass produce
 * the id the first pass already saved, which then dedupes as the same note.
 *
 * **This is not the rejected "mint a blank-id row's id from its content"**
 * (see `mergeSessionNotes` in `viewer/media/ingest.ts`, which explains why that
 * would break editing). A colliding copy has no stable identity to protect —
 * its id belongs to a different note — so deriving one is strictly better than
 * the random id it had before, which changed on *every* parse rather than only
 * when the text does.
 *
 * FNV-1a twice over, for 64 bits of spread from arithmetic that stays exact in
 * a double. **Ends in a letter**, for the same reason `mintNoteId` does:
 * Excel's fill handle increments a trailing digit when a cell is dragged.
 */
function deriveNoteId(fingerprint: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < fingerprint.length; i++) {
    const c = fingerprint.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + i), 0x85ebca6b) >>> 0;
  }
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return `n_${a.toString(36)}${b.toString(36)}${letters[a % 26] as string}`;
}

/**
 * One file's notes, together with the file's name and — when the caller has
 * them — the line each note came from, so a problem can point at a row rather
 * than at a whole file.
 */
export interface NoteSource {
  /** As it should be named to a person: the path they will look for. */
  name: string;
  notes: readonly Note[];
  /** 1-indexed file lines, aligned by index with `notes`. */
  lines?: readonly number[];
}

/**
 * Report every note a `deleted` row cancels — LOUDLY, by name and by text.
 *
 * **Ids are not secret.** Everyone handed a `notes.csv` has every id in it, so
 * one row of `id,…,.,,1,1` in a file anybody contributes removes whichever
 * note that id names, from everyone's copy, on the next merge — and the next
 * Save writes only the tombstone, so the original text goes off disk. Before
 * this, `mergeNotes` reported nothing at all: the note was simply not there
 * any more.
 *
 * The deletion still happens. Propagating a deletion is the whole point of the
 * tombstone (a delete that another copy resurrects was itself a bug), so
 * refusing it here would trade one silent loss for another. What changes is
 * that it is now impossible to miss: the file, the row, the id, and the text
 * that went are all named, through the same `noteProblems` channel the ingest
 * report already shows.
 *
 * **Only tombstones that actually removed something are reported.** A note
 * deleted the ordinary way leaves a tombstone and no live row anywhere, so the
 * normal case stays quiet — this fires exactly when one file cancels a note
 * another file (or another row of the same file) still holds.
 */
export function reportTombstoneRemovals(sources: readonly NoteSource[]): string[] {
  const live = new Map<string, Array<{ note: Note; where: string }>>();
  for (const source of sources) {
    source.notes.forEach((note, i) => {
      if (note.deleted || !note.id) return;
      const list = live.get(note.id) ?? [];
      list.push({ note, where: sourceLabel(source, i) });
      live.set(note.id, list);
    });
  }

  const problems: string[] = [];
  for (const source of sources) {
    source.notes.forEach((note, i) => {
      if (!note.deleted || !note.id) return;
      for (const victim of live.get(note.id) ?? []) {
        problems.push(
          `${sourceLabel(source, i)} marks note "${note.id}" as deleted, so the note ` +
            `"${excerpt(victim.note.text)}" written in ${victim.where} has been removed and ` +
            'will not be saved. If that was not meant to happen, clear the 1 in the deleted ' +
            `column of ${sourceLabel(source, i)} and open the folder again.`,
        );
      }
    });
  }
  return problems;
}

/**
 * "notes-crew.csv row 2", or just the file name when no lines were given.
 *
 * Not called `at` — that is the name of a `Note`'s timestamp field, and this
 * is a place in a file.
 */
function sourceLabel(source: NoteSource, i: number): string {
  const line = source.lines?.[i];
  return line === undefined ? source.name : `${source.name} row ${line}`;
}

/** Enough of a note to recognise it by, without pasting a paragraph. */
function excerpt(text: string): string {
  return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
}

/** Split a merged list into the notes to show and the tombstones to keep. */
export function partitionDeleted(notes: readonly Note[]): { live: Note[]; deleted: Note[] } {
  const live: Note[] = [];
  const deleted: Note[] = [];
  for (const note of notes) (note.deleted ? deleted : live).push(note);
  return { live, deleted };
}

/**
 * Row-bind every notes file into one list.
 *
 * **This is why no version control is needed.** Ids are globally unique in
 * practice, so merging is concatenate-and-dedupe with no conflict resolution,
 * no locking and no merge UI. Two people who edited a copy of the same note
 * produce two notes at the same time, which the timeline shows one after the
 * other — accepted, not an error.
 *
 * `problems` carries an unreadable row AND — since a security review found it
 * happening in complete silence — every note a `deleted` row in one file
 * cancelled in another. See `reportTombstoneRemovals`.
 *
 * `preserved` carries the unreadable rows THEMSELVES, so the writer can put
 * them back. Reporting a row and then deleting it on the next save is the
 * same silent loss under a different name — see `PreservedRow` in `csv.ts`.
 */
export function mergeNotes(
  files: ReadonlyArray<{ name: string; text: string }>,
  eventTimezone?: string,
  /** Forwarded to `dedupeNotes` unchanged — see its doc comment. */
  rowIdentity?: NoteRowIdentity,
): { notes: Note[]; problems: string[]; preserved: PreservedRow[] } {
  const rows: Note[] = [];
  const problems: string[] = [];
  const preserved: PreservedRow[] = [];
  // Kept per file, and only for this: a tombstone that cancels somebody else's
  // note has to be reported against the file and row it arrived in. See
  // `reportTombstoneRemovals`.
  const sources: NoteSource[] = [];

  for (const file of files) {
    const table = parseCsv(file.text);
    const fileNotes: Note[] = [];
    const fileLines: number[] = [];
    sources.push({ name: file.name, notes: fileNotes, lines: fileLines });
    table.rows.forEach((row, i) => {
      const result = rowToNote(row, eventTimezone);
      if ('error' in result) {
        // Reported, never dropped silently — the same rule as unplaced media.
        //
        // The line comes from `table.rowLines`, not from `i`: `parseCsv` drops
        // blank records, so arithmetic on the row index understates the real
        // line by however many blank lines sit above it. These numbers exist so
        // someone can open the file and go to the row, which a number that is
        // quietly off by two sends them away from.
        const line = table.rowLines[i] ?? i + 2;
        // KEPT, not just reported. Until this existed, "meanwhile could not
        // read this row" and "meanwhile deleted this row on the next save"
        // were the same event — see `PreservedRow`.
        preserved.push({ file: file.name, line, cells: row });
        problems.push(
          `${file.name} row ${line}: ${result.error}. The row is kept exactly as it is and ` +
            'written back when you save, so nothing in it is lost.',
        );
        return;
      }
      rows.push(result);
      fileNotes.push(result);
      fileLines.push(table.rowLines[i] ?? i + 2);
    });
  }

  // Before the dedupe, which is where a tombstone silently takes its victim
  // out — so this still has both sides to name.
  problems.push(...reportTombstoneRemovals(sources));

  const notes = dedupeNotes(rows, eventTimezone, rowIdentity);
  notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { notes, problems, preserved };
}

/**
 * Short, opaque and unique enough that two people never collide.
 *
 * **The last character is always a letter**, which is not cosmetic. Excel's
 * fill handle increments a trailing NUMBER when a cell is dragged, so
 * `n_abc12` dragged down a column becomes `n_abc13`, `n_abc14` — silently
 * inventing ids for notes that do not exist and detaching the rows it touched
 * from their own identity. The base-36 mint ended in a digit 27.8% of the
 * time (10 of 36 base-36 characters are digits); a letter is left alone by
 * the fill handle.
 */
export function mintNoteId(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const last = letters[Math.floor(Math.random() * letters.length)] as string;
  return `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${last}`;
}

// ---------------------------------------------------------------------------
// Save-time and load-time reconciliation
// ---------------------------------------------------------------------------

/**
 * Stamp every note with a blank `author` as written by `author`, asked once
 * at save time rather than once per note.
 *
 * A note written before the "you are" setting is touched — or one authored
 * by someone who never set it — is saved with `author: []`, per the rule
 * that a note must never be blocked on it. This is the one place that offers
 * to fix that in bulk. It must never run unprompted: a laptop passed around
 * a crew could otherwise attribute someone else's note to whoever is signed
 * in when Save happens to be clicked. `author.length === 0` is a no-op,
 * consistent with "must never block a save" — there is nobody to stamp with.
 */
export function stampBlankAuthors(notes: readonly Note[], author: readonly string[]): Note[] {
  if (author.length === 0) return [...notes];
  return notes.map((n) => (n.author.length === 0 ? { ...n, author: [...author] } : n));
}

/**
 * Resolve each note's `photo` against the manifest's items, falling back to
 * a filename match when the id doesn't.
 *
 * `photo` is meant to hold an item id — the path relative to the folder
 * root, e.g. `"priya/PXL_20260822_131204.jpg"` when photos sit in
 * per-person subfolders, which `README.md` instructs. But both the README's
 * own table and a person editing the spreadsheet by hand call it "the
 * filename", and a bare filename typed into that column does not match an
 * id at all — the row silently attaches to nothing.
 *
 * The fallback is safe exactly when it is UNAMBIGUOUS: two different phones
 * can easily produce the same filename (two `PXL_...jpg` from two different
 * Pixels), and guessing wrong would attach a caption to the wrong person's
 * photo, which is worse than leaving it unattached. An ambiguous match is
 * reported as a problem instead of guessed at — the same rule this app
 * applies to everything else it cannot place with confidence.
 */
export function resolveNotePhotos(
  notes: readonly Note[],
  items: readonly Item[],
): { notes: Note[]; problems: string[] } {
  const ids = new Set(items.map((it) => it.id));
  const byBasename = new Map<string, string[]>();
  for (const it of items) {
    const base = basename(it.id);
    const list = byBasename.get(base);
    if (list) list.push(it.id);
    else byBasename.set(base, [it.id]);
  }

  const problems: string[] = [];
  const resolved = notes.map((note) => {
    if (note.photo === undefined || ids.has(note.photo)) return note;
    const candidates = byBasename.get(basename(note.photo)) ?? [];
    if (candidates.length === 1) {
      return { ...note, photo: candidates[0] as string };
    }
    if (candidates.length > 1) {
      problems.push(
        `note "${note.id}": photo "${note.photo}" matches ${candidates.length} photos by ` +
          `filename (${candidates.join(', ')}); use the full path to say which one`,
      );
    } else {
      // Distinct from the ambiguous case above: nothing matches at all,
      // typically a hand-typed filename with a typo, or a photo that was
      // renamed or deleted after the note was written. Silent before this
      // fix — the note just sat there with a `photo` value naming nothing,
      // never shown as broken anywhere. An alias table (or a filename join,
      // which this is) is only safe if a broken join is loud.
      problems.push(
        `note "${note.id}": photo "${note.photo}" does not match any file in this folder; ` +
          'the note is kept but not linked to a photo',
      );
    }
    return note;
  });

  return { notes: resolved, problems };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
