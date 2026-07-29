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
 * Pure: only `./time.ts` and ECMAScript/WHATWG globals (`Intl`, `Date`,
 * `Number`). No CSV text is parsed or written here — that is `csv.ts`'s job.
 * This module only knows how to read and write ONE row.
 */

import { formatDuration, hasZone, parseDuration, parseZonedInstant, zonedToInstant } from './time.ts';

export interface Note {
  id: string;
  /** ISO-8601 instant, resolved from the row's timestamp columns. */
  at: string;
  /** ISO-8601 duration, e.g. "PT3H40M". Absent means a moment, not a span. */
  duration?: string;
  /**
   * The IANA zone THIS ROW carried explicitly. Absent means the row deferred
   * to the event's timezone — which is also why `noteToRow` leaves the
   * column blank rather than writing the event zone back out.
   */
  tz?: string;
  people: string[];
  photo?: string;
  author: string[];
  text: string;
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
  'people',
  'photo',
  'author',
  'text',
];

/** Legacy column names, tried in order when `year` is absent. */
const LEGACY_KEYS = ['date', 'time', 'at'];

const KNOWN_KEYS = new Set<string>([...NOTE_HEADERS, ...LEGACY_KEYS]);

// ---------------------------------------------------------------------------
// rowToNote
// ---------------------------------------------------------------------------

export function rowToNote(row: Record<string, string>, eventTimezone?: string): Note | { error: string } {
  const id = (row.id ?? '').trim();
  const label = id || '(no id)';

  const resolved = resolveInstant(row, eventTimezone, label);
  if ('error' in resolved) return resolved;
  const { instant, tz } = resolved;

  const text = (row.text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (text === '') return { error: `note "${label}" has no text` };

  const duration = readDuration(row.duration ?? '');
  if (duration === INVALID_DURATION) {
    return { error: `note "${label}" has an unreadable duration "${row.duration ?? ''}"` };
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
  const extra = extraFields(row);
  if (extra !== undefined) note.extra = extra;
  return note;
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
    const y = Number(String(row.year ?? '').trim());
    const mo = Number(String(row.month ?? '').trim());
    const d = Number(String(row.day ?? '').trim());
    const h = Number(String(row.hour ?? '').trim());
    const mi = Number(String(row.minute ?? '').trim());
    if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) {
      return { error: `note "${label}" has a non-numeric date/time field` };
    }
    const tz = nonEmpty(row.tz);
    const zone = tz ?? eventTimezone ?? 'UTC';
    const naive = `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}T${pad(h, 2)}:${pad(mi, 2)}:00`;
    const instant = zonedToInstant(naive, zone);
    if (instant === null) {
      return { error: `note "${label}" could not be resolved in timezone "${zone}"` };
    }
    return { instant, tz };
  }

  if (row.date !== undefined) {
    const date = parseLegacyDate(row.date ?? '');
    const time = parseLegacyTime(row.time ?? '');
    if (date === null || time === null) {
      return { error: `note "${label}" has an unreadable date or time` };
    }
    const tz = nonEmpty(row.tz);
    const zone = tz ?? eventTimezone ?? 'UTC';
    const naive = `${pad(date.y, 4)}-${pad(date.mo, 2)}-${pad(date.d, 2)}T${pad(time.h, 2)}:${pad(time.mi, 2)}:00`;
    const instant = zonedToInstant(naive, zone);
    if (instant === null) {
      return { error: `note "${label}" could not be resolved in timezone "${zone}"` };
    }
    return { instant, tz };
  }

  if (row.at !== undefined) {
    const raw = row.at.trim();
    const tz = nonEmpty(row.tz);
    const instant = hasZone(raw) ? parseZonedInstant(raw) : zonedToInstant(raw, tz ?? eventTimezone ?? 'UTC');
    if (instant === null) {
      return { error: `note "${label}" has an unreadable "at" value "${row.at}"` };
    }
    return { instant, tz };
  }

  return { error: `note "${label}" has no date/time columns` };
}

/** Zero-pad a calendar integer, e.g. pad(7, 2) -> "07". */
function pad(n: number, width: number): string {
  return String(Math.trunc(n)).padStart(width, '0');
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
  const parts = instantPartsInZone(new Date(note.at).getTime(), zone);

  const row: Record<string, string> = {
    id: note.id,
    year: String(parts.year),
    month: String(parts.month),
    day: String(parts.day),
    hour: String(parts.hour),
    minute: String(parts.minute),
    duration: note.duration ?? '',
    // Blank when the row's zone would resolve to the same one `rowToNote`
    // falls back to anyway — an explicit column only earns its keep when it
    // disagrees with the event.
    tz: note.tz !== undefined && note.tz !== eventTimezone ? note.tz : '',
    people: note.people.join(';'),
    photo: note.photo ?? '',
    author: note.author.join(';'),
    text: note.text,
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
