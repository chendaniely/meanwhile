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

import { formatDuration, hasZone, parseDuration, parseZonedInstant, zonedToInstant } from './time.ts';
import { parseCsv } from './csv.ts';
import type { Item } from './schema.ts';

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
export function noteHeadersFor(notes: readonly Note[]): string[] {
  const headers = [...NOTE_HEADERS];
  const seen = new Set(headers);
  for (const note of notes) {
    if (!note.extra) continue;
    for (const key of Object.keys(note.extra)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  return headers;
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
    const y = Number(yRaw);
    const mo = Number(moRaw);
    const d = Number(dRaw);
    const h = Number(hRaw);
    const mi = Number(miRaw);
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
 * - **`tz`.** `noteToRow` leaves the column blank when it matches the
 *   event's own zone (only an explicit disagreement earns the column), but
 *   `rowToNote` sets `note.tz` from whatever the cell literally says. A row
 *   that never had a `tz` column (`tz: undefined`) and a row that spelled out
 *   the event's own zone by hand (`tz: 'America/Denver'` where that IS the
 *   event zone) are the same note read two different ways, and must
 *   fingerprint identically or a Save-then-reload duplicates it.
 * - **`at`'s exact spelling.** `rowToNote` always produces
 *   `Date.toISOString()`'s canonical form, milliseconds included
 *   (`"...T09:00:00.000Z"`); `legacyNoteToNote` (see `viewer/media/ingest.ts`)
 *   passes an imported manifest's `at` straight through unchanged, and a
 *   hand-written or older one very often has no milliseconds
 *   (`"...T09:00:00Z"`). Same instant, different string — comparing the raw
 *   strings is exactly the bug that let a legacy manifest's note and its own
 *   migrated copy in `notes.csv` collide as two notes instead of deduping to
 *   one.
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

  const mintUnique = (): string => {
    let candidate = mintNoteId();
    while (seen.has(candidate)) candidate = mintNoteId();
    return candidate;
  };

  for (const note of notes) {
    const next = { ...note };
    const fingerprint = fingerprintNote(next, eventTimezone);

    if (!next.id) {
      const stable = priorIdentity?.get(fingerprint);
      // Reused only if nothing in THIS call has already claimed it — see
      // the note above about two rows sharing a fingerprint in one parse.
      next.id = stable !== undefined && !seen.has(stable) ? stable : mintUnique();
      rowIdentity?.set(fingerprint, next.id);
    } else if (seen.has(next.id)) {
      // The same row seen twice is one note. A different row wearing the
      // same id is a copy, and gets its own identity.
      if (seen.get(next.id) === fingerprint) continue;
      next.id = mintUnique();
    }
    seen.set(next.id, fingerprint);
    out.push(next);
  }

  return out;
}

/**
 * Row-bind every notes file into one list.
 *
 * **This is why no version control is needed.** Ids are globally unique in
 * practice, so merging is concatenate-and-dedupe with no conflict resolution,
 * no locking and no merge UI. Two people who edited a copy of the same note
 * produce two notes at the same time, which the timeline shows one after the
 * other — accepted, not an error.
 */
export function mergeNotes(
  files: ReadonlyArray<{ name: string; text: string }>,
  eventTimezone?: string,
  /** Forwarded to `dedupeNotes` unchanged — see its doc comment. */
  rowIdentity?: NoteRowIdentity,
): { notes: Note[]; problems: string[] } {
  const rows: Note[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const table = parseCsv(file.text);
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
        problems.push(`${file.name} row ${table.rowLines[i] ?? i + 2}: ${result.error}`);
        return;
      }
      rows.push(result);
    });
  }

  const notes = dedupeNotes(rows, eventTimezone, rowIdentity);
  notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { notes, problems };
}

/** Short, opaque and unique enough that two people never collide. */
export function mintNoteId(): string {
  return `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
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
    }
    return note;
  });

  return { notes: resolved, problems };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
