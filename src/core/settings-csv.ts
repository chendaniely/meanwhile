/**
 * `settings.csv` — this copy of the site's own configuration: where the five
 * data files live, plus anything else somebody adds.
 *
 * **It is not one of the five.** `event.csv`, `people.csv`, `notes*.csv`,
 * `markers.csv` and `placements.csv` are the event's data; this file is a
 * pointer to them, and it is the one file that is about the SITE rather than
 * about the race. Two consequences follow:
 *
 *   1. **It is not in the Save zip.** Save writes the event's data; this
 *      describes where that data lives, and the URLs in it are link-shared
 *      addresses — bearer capabilities that let anyone holding them read the
 *      event. Bundling them into the same download as the event's own files
 *      would hand them out every time somebody shares a save.
 *   2. **Its `schema` is its own.** A settings file from a newer build is
 *      refused on its own terms, and says which file it was.
 *
 * **Why CSV, when a settings file is the one place TOML or YAML would be
 * ordinary.** The owner:
 *
 *   "main thing about csv for settings is that you can also dump that in a
 *   google drive"
 *
 * A TOML file cannot BE a Google Sheet. Every other file in this project has
 * three homes — a folder on a laptop, a shared drive, a spreadsheet somebody
 * edits in a browser — and a settings file that only had the first would be
 * the one thing the owner could not fix from a phone. So: `key,value`, the
 * same two columns `event.csv` uses, and every cell through `./csv.ts` so the
 * formula guard, the BOM, NFC and CRLF tolerance are the ones the rest of the
 * project already relies on.
 *
 * **`#` starts a comment row, and comments keep their place.** This is the
 * rule that makes the file worth organising by hand:
 *
 * ```
 * key,value
 * # --- the five data files ---
 * event_url,https://docs.google.com/spreadsheets/d/1JZ5.../edit?usp=sharing
 * ...
 * # --- where the written record is versioned ---
 * github_repo,chendaniely/meanwhile-cm100-g
 * ```
 *
 * `formatEventCsv` writes its keys in a canonical order and appends unknown
 * ones at the end, which is right for a file nobody groups by hand. Doing that
 * here would migrate every section heading away from the keys it labels and
 * hand back a scrambled version of a file somebody arranged on purpose. So
 * `parseSettingsCsv` returns the file's rows **in the order it read them**,
 * comments included, and `formatSettingsCsv` writes them back in that order,
 * appending only keys that are genuinely new.
 *
 * (A `#` key is not the hazard the notes-as-CSV design found. That finding was
 * about a comment row reaching a spreadsheet as a DATA row — a note whose text
 * began `#`. Here the reader skips it, so nothing downstream ever sees it.)
 *
 * **Unknown keys are preserved, and that is the whole growth plan.**
 * `github_repo` is read by nothing today — the GitHub sync is designed and not
 * built (see `docs/superpowers/specs/2026-07-30-github-metadata-sync-design.md`)
 * — so it exists only because a file the owner downloads, edits and uploads
 * again must come back carrying it. A key that vanished on the round trip
 * could not be filled in ahead of the build that reads it.
 *
 * **A Google Sheets `/edit` address is rewritten to `/export?format=csv` on
 * the way OUT of this module, never on the way in.** The owner pastes what the
 * Share dialog gives them; the app transforms it. The file keeps the `/edit`
 * URL, because that is the one a person can click. Anything that is not a
 * Sheets page — a gist, a bucket, a raw git URL, an address already in export
 * form — passes through untouched: see `fetchableCsvUrl`.
 *
 * **Nothing here contacts anything.** `src/core/` is pure — the purity test
 * bans `fetch` and `URL` outright — so this module turns text into addresses
 * and back, and a later task does the reading. That split is deliberate rather
 * than incidental: whether an address may be contacted at all (scheme, host)
 * is a decision for whatever does the contacting, and duplicating it here
 * would put a second, weaker copy of a security check in the codebase.
 *
 * **What a round trip does NOT keep byte-for-byte**, measured rather than
 * assumed, none of which loses a cell's content:
 *
 *   - **A comment row gains a trailing comma.** The file is two columns, so
 *     `# --- the five data files ---` is written as that cell plus an empty
 *     one. It re-reads identically, so the file is stable from the second write
 *     onward.
 *   - **A comment carrying more than one comma loses the tail.** `# a, b, c`
 *     parses as two cells and a surplus third that `parseCsv` has no column to
 *     file under. Quote it, or keep comments to one comma — the same
 *     limitation `csv.ts` already documents for any over-wide row.
 *   - **Blank lines are dropped**, and leading whitespace is trimmed off a key.
 *   - Everything `csv.ts` already does to every file: a BOM is added, CRLF
 *     becomes LF, cells are written in NFC, and a cell a spreadsheet would run
 *     as a formula is written with a leading apostrophe that `parseCsv` takes
 *     back off.
 *
 * Pure: only relative core imports and ECMAScript globals.
 */

import { CSV_SCHEMA, formatCsv, parseCsv, schemaCellProblem } from './csv.ts';
import { EVENT_KEYS } from './event-csv.ts';

/**
 * The two column names. Not configurable and not sniffed — a file whose header
 * row says something else is reported and its first line read as data instead,
 * because in a two-column key/value file the header is the one row that can be
 * mistaken for one. Same call `parseEventCsv` makes, for the same reason.
 */
export const SETTINGS_HEADERS: readonly string[] = ['key', 'value'];

/** The five data files a settings file can name. */
export type DataFile = 'event' | 'people' | 'notes' | 'markers' | 'placements';

/**
 * In the order `formatSettingsCsv` appends them when it is writing a file from
 * scratch. An existing file's order is the author's and is never reordered —
 * see the module doc.
 */
export const DATA_FILES: readonly DataFile[] = [
  'event',
  'people',
  'notes',
  'markers',
  'placements',
];

/**
 * The key that names one of the five, so a caller never has to build
 * `` `${name}_url` `` itself and get the spelling subtly wrong.
 */
export function settingsKeyFor(file: DataFile): string {
  return `${file}_url`;
}

/**
 * Every key this build knows the meaning of.
 *
 * Deliberately short. `github_repo` is NOT here: it is read by nothing yet, and
 * a key that configures nothing is one somebody fills in and then expects to
 * work. It survives as an unknown key, which is exactly the mechanism that lets
 * it be in place before the build that reads it — see the module doc.
 */
export const SETTINGS_KEYS: readonly string[] = [
  ...DATA_FILES.map(settingsKeyFor),
  'schema',
];

const KNOWN_SETTINGS_KEYS = new Set<string>(SETTINGS_KEYS);

/**
 * `event.csv`'s own keys, imported rather than restated.
 *
 * Load-bearing for `keyValueCsvKind`: `event.csv` carries `course_url`, which
 * ends in `_url`, so "a settings file is one with a `*_url` key" would call
 * every event file with a Strava course ambiguous. Subtracting the real key
 * list means a key `event.csv` gains later cannot silently start confusing the
 * two.
 */
const EVENT_CSV_KEYS = new Set<string>(EVENT_KEYS);

/**
 * Appended to the problem that refuses the whole file, so the message says what
 * happened to the data as well as what was wrong with it. The rows are all
 * still in `rows`, so `formatSettingsCsv` writes every one of them back.
 */
const KEPT =
  ' The rows are kept exactly as they are and written back when you save, so nothing in ' +
  'them is lost.';

/**
 * One line of the file, in the order it was read.
 *
 * A row whose `key` starts with `#` is a COMMENT: it is never data, never
 * reaches `urls`, and is never counted when two rows are found to name the same
 * key. It is carried here for one reason — so that writing the file back puts
 * it where its author put it.
 *
 * `key` is trimmed; `value` is not, so a value written back is the one that was
 * read. (`parseEventCsv` makes the same split for the same reason.)
 */
export interface SettingsRow {
  key: string;
  value: string;
}

/**
 * The five data files' addresses, **already rewritten to something that
 * answers with CSV** — see `fetchableCsvUrl`. Always all five keys; an empty
 * array means the file named none.
 *
 * A list rather than a single address, for every one of the five and not just
 * for notes. `notes*.csv` is the one that genuinely globs — several crew
 * members' files row-bind into one set — and the point of the `;` convention
 * here is that the three transports (a folder, a drive, a spreadsheet) can all
 * hold that same set. Giving the other four the same shape costs nothing and
 * avoids two spellings of "the address of a data file"; what a caller does with
 * two `event_url`s is the caller's decision, and this module does not pretend
 * to make it.
 */
export type SettingsUrls = Record<DataFile, string[]>;

export interface SettingsCsv {
  urls: SettingsUrls;
  /**
   * Every row of the file, in file order, comments and unknown keys included.
   * Hand it straight back to `formatSettingsCsv` and the file comes back
   * organised the way its author organised it.
   */
  rows: SettingsRow[];
  problems: string[];
}

/** A row that documents rather than configures. See `SettingsRow`. */
function isComment(key: string): boolean {
  return key.startsWith('#');
}

/**
 * `;`-separated list convention, identical to `people`/`author` in
 * `notes*.csv` and `also_known_as` in `people.csv` — not shared code, since
 * each module stays a small, independently-readable file per this project's
 * "no CSV library" choice, but deliberately the same behavior: trimmed, blanks
 * dropped, so a trailing `;` or a doubled `;;` from a spreadsheet edit does not
 * produce a phantom empty address.
 *
 * The cost, stated because it is real: an address containing a literal `;`
 * cannot be written here. No Google Sheets URL does, and neither does any
 * ordinary bucket or gist address, so this is the same trade `people.csv`
 * already makes for names.
 */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

/**
 * A Google Sheets PAGE — the thing the Share dialog hands you — split into the
 * document id and whatever followed it.
 *
 * Deliberately narrow, and self-checking in the same way `normalizeCourseUrl`
 * is: it matches a spreadsheet URL whose path ends at the document id, or ends
 * with `/edit`, and nothing else. Every other Sheets address is already an
 * answer rather than a page — `/export?format=csv`, `/pub?output=csv`,
 * `/gviz/tq?tqx=out:csv` — and rewriting one of those would be second-guessing
 * somebody who had already done the work.
 *
 * `u/0/` appears when the pasting browser is signed into more than one Google
 * account. It names an account rather than a document, so it is dropped: the
 * same sheet pasted by two people would otherwise produce two different
 * addresses.
 *
 * `https:` only. An `http://docs.google.com/...` paste is left exactly as it
 * is, for whatever eventually reads it to refuse — silently upgrading a scheme
 * changes where somebody said to go, which is the rule `normalizeCourseUrl`
 * already follows.
 *
 * Hand-rolled rather than `new URL(...)` because `URL` is banned in
 * `src/core/` — same answer as XML in `course.ts` and CSV in `csv.ts`.
 */
const SHEETS_PAGE =
  /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/(?:edit)?)?(?:\?([^#]*))?(?:#(.*))?$/i;

/**
 * Which sheet of a workbook, when the address names one.
 *
 * Preserved rather than dropped, and that is not a nicety: a workbook with a
 * tab per data file exports its FIRST tab when asked for `format=csv` alone, so
 * five `/edit#gid=...` addresses pointing at five tabs would all quietly return
 * the same one. Confidently wrong, which this project holds to be worse than a
 * visible gap.
 *
 * Sheets writes it into the fragment (`#gid=0`) and sometimes into the query as
 * well, so both are searched.
 */
const GID = /(?:^|[?&#])gid=(\d+)/;

/**
 * The address to read this file from: a Google Sheets page turned into its CSV
 * export, and anything else returned exactly as it was given.
 *
 * **This is a pure string transform and it happens on the way out of the file,
 * never on the way in.** `parseSettingsCsv` puts the transformed address in
 * `urls` and leaves `rows` — and therefore the file on disk — carrying what the
 * owner pasted. A settings file full of `/export?format=csv` addresses would be
 * a file whose links nobody can click.
 */
export function fetchableCsvUrl(raw: string): string {
  const match = SHEETS_PAGE.exec(raw.trim());
  if (!match) return raw;
  const id = match[1] as string;
  const gid = GID.exec(`${match[2] ?? ''}&${match[3] ?? ''}`)?.[1];
  return (
    `https://docs.google.com/spreadsheets/d/${id}/export?format=csv` +
    (gid === undefined ? '' : `&gid=${gid}`)
  );
}

// ---------------------------------------------------------------------------
// telling settings.csv from event.csv
// ---------------------------------------------------------------------------

/**
 * What a `key,value` CSV appears to be.
 *
 * `both` and `neither` are the two answers a caller has to act on: the file is
 * not one this build can place, and saying which way it is ambiguous is the
 * difference between a legible message and a shrug.
 */
export type KeyValueCsvKind = 'settings' | 'event' | 'both' | 'neither';

/**
 * **The header cannot tell these two apart, which is why this exists.**
 * `settings.csv` and `event.csv` are both `key,value`, and both preserve keys
 * they do not know — so pasting the settings file's own address into
 * `event_url` parses perfectly and reports nothing at all. The event would come
 * up blank with no explanation anywhere.
 *
 * So the answer comes from the KEYS. A settings file names at least one data
 * file (`*_url`, excluding `event.csv`'s own `course_url` — see
 * `EVENT_CSV_KEYS`); an event file carries `title` or `timezone`. A file
 * carrying both signals, or neither, is reported rather than guessed at.
 *
 * Comment rows are not consulted, so `# event_url,…` left in a file as a
 * reminder does not make it a settings file.
 *
 * A caller wanting a boolean asks `keyValueCsvKind(text) === 'settings'`.
 */
export function keyValueCsvKind(text: string): KeyValueCsvKind {
  return kindOfKeys(keysOf(readRows(text, '')));
}

function kindOfKeys(keys: readonly string[]): KeyValueCsvKind {
  const settings = keys.some((k) => k.endsWith('_url') && !EVENT_CSV_KEYS.has(k));
  const event = keys.includes('title') || keys.includes('timezone');
  if (settings && event) return 'both';
  if (settings) return 'settings';
  if (event) return 'event';
  return 'neither';
}

function kindProblem(kind: KeyValueCsvKind, file: string): string {
  if (kind === 'event') {
    return (
      `${file} looks like an event.csv rather than a settings file: it gives a title or a ` +
      'timezone and names none of the five data files. Both files are two columns of ' +
      'key/value, so nothing but the keys can tell them apart — check that the address you ' +
      'used points at the settings file.'
    );
  }
  if (kind === 'both') {
    return (
      `${file} reads as both a settings file and an event.csv: it names a data file AND gives ` +
      'a title or a timezone. Keep the two separate — a settings file says where the event ' +
      "is, and event.csv says what the event is."
    );
  }
  return (
    `${file} names none of the five data files (${DATA_FILES.map(settingsKeyFor).join(', ')}), ` +
    'so there is nothing in it to load an event from.'
  );
}

function unknownUrlProblem(key: string, file: string): string {
  return (
    `${file} gives "${key}", which is not a file this build of meanwhile knows how to read. ` +
    `It knows ${DATA_FILES.map(settingsKeyFor).join(', ')}. The row is kept and written back ` +
    'when you save, so a newer build can still use it.'
  );
}

// ---------------------------------------------------------------------------
// parseSettingsCsv
// ---------------------------------------------------------------------------

export function parseSettingsCsv(
  text: string,
  /** Named in every problem, so a caller can point at the file to repair. */
  file = 'settings.csv',
): SettingsCsv {
  const problems: string[] = [];
  const rows = readRows(text, file, problems);
  const cells = settingsOf(rows, file, problems);
  const urls: SettingsUrls = {
    event: [],
    people: [],
    notes: [],
    markers: [],
    placements: [],
  };

  // Checked before anything else is interpreted: a file written by a newer
  // build may mean something different by every other key in it, so reading
  // them anyway would be guessing. Mirrors `validateManifest` refusing an
  // unknown manifest `schema` outright.
  //
  // **Per FILE**, the call `event.csv` and `markers.csv` both make. The per-row
  // argument in `csv.ts` is about files that merge by row-bind, where a row
  // from someone's older copy lands among newer rows. Nothing row-binds into a
  // settings file: it describes one site's configuration, and a version
  // declared anywhere in it is a statement about the whole of it.
  const schemaBad = schemaCellProblem(cells.get('schema'), file);
  if (schemaBad) {
    problems.push(`${file} ${schemaBad}.${KEPT}`);
    return { urls, rows, problems };
  }

  const kind = kindOfKeys([...cells.keys()]);
  if (kind !== 'settings') problems.push(kindProblem(kind, file));

  for (const name of DATA_FILES) {
    urls[name] = splitList(cells.get(settingsKeyFor(name))).map(fetchableCsvUrl);
  }

  // Reported, never fatal: a `photos_url` is somebody configuring a build that
  // does not exist yet, which is the same thing `github_repo` is doing and is
  // the reason unknown keys survive at all. Saying so beats a key that looks
  // like it works.
  for (const key of cells.keys()) {
    if (key.endsWith('_url') && !KNOWN_SETTINGS_KEYS.has(key)) {
      problems.push(unknownUrlProblem(key, file));
    }
  }

  return { urls, rows, problems };
}

/**
 * The file's rows, in order, with the header handled and unusable rows dropped.
 *
 * `problems` is optional so `keyValueCsvKind` can ask the same question without
 * collecting messages nobody will read.
 *
 * **Blank lines do not survive.** `parseCsv` drops them rather than emitting
 * empty rows — a spreadsheet leaves them behind, and one at the end of a file
 * is just the trailing newline — so there is nothing here to carry. A `#`
 * comment row is what separates sections in a file meant to be organised by
 * hand.
 */
function readRows(text: string, file: string, problems?: string[]): SettingsRow[] {
  const { headers, rows } = parseCsv(text);
  const out: SettingsRow[] = [];

  const rawKeyCol = headers[0];
  const rawValCol = headers[1];
  const keyCol = rawKeyCol ?? 'key';
  const valCol = rawValCol ?? 'value';

  /**
   * One line, whether it came from the header row or from the body.
   *
   * **The eaten header line goes through this too, and that is the point.** It
   * used to be pushed straight into `out` without the blank-key check below, so
   * a file that had lost its header AND whose first cell was empty produced a
   * row with a blank key — the one shape `formatSettingsCsv` skips. The row
   * therefore survived the read, said nothing about itself, and was deleted by
   * the next Save with nothing to notice it by: "refusing to read a row is not
   * permission to delete it", one file over. Reported and dropped at READ time
   * is what every other keyless row already does, and it is the honest half of
   * that pair.
   */
  function take(rawKey: string, value: string): void {
    const key = rawKey.trim();
    if (key === '') {
      problems?.push(
        `${file} has a row with nothing in the first column, so there is nothing to say what ` +
          'it configures; it was ignored.',
      );
      return;
    }
    out.push({ key, value });
  }

  // A header row is the one row of a two-column key/value file that can be
  // mistaken for data, so a file that has lost it — hand-written, or a
  // spreadsheet export that dropped it — would otherwise have its FIRST
  // setting silently eaten as column names. Report, and read it as the pair it
  // almost certainly is. `rawKeyCol === undefined` is an empty file, which has
  // no header to complain about.
  if (rawKeyCol !== undefined && (rawKeyCol !== 'key' || rawValCol !== 'value')) {
    problems?.push(
      `${file} should begin with a header row reading "key,value"; it begins with ` +
        `"${headers.join(',')}" instead, so that line was read as a setting rather than as a ` +
        'header.',
    );
    take(rawKeyCol, rawValCol ?? '');
  }

  for (const row of rows) take(row[keyCol] ?? '', row[valCol] ?? '');
  return out;
}

/** Every non-comment key, in order. */
function keysOf(rows: readonly SettingsRow[]): string[] {
  return rows.filter((row) => !isComment(row.key)).map((row) => row.key);
}

/**
 * The settings as a key → value map, with duplicates resolved and reported.
 *
 * **Last wins, and it is said out loud.** Silently picking one of two rows
 * naming the same key is how an edit disappears: somebody adds `notes_url` near
 * the top of the file without noticing the one already there, and whichever
 * they did not mean takes effect with nothing to notice it by.
 */
function settingsOf(
  rows: readonly SettingsRow[],
  file: string,
  problems: string[],
): Map<string, string> {
  const cells = new Map<string, string>();
  for (const row of rows) {
    if (isComment(row.key)) continue;
    if (cells.has(row.key)) {
      problems.push(
        `${file} names "${row.key}" more than once. The last one wins, so "${row.key}" is ` +
          `"${row.value.trim()}" — delete the others so the file says one thing.`,
      );
    }
    cells.set(row.key, row.value);
  }
  return cells;
}

// ---------------------------------------------------------------------------
// formatSettingsCsv
// ---------------------------------------------------------------------------

/**
 * Write the settings back out.
 *
 * **Row order is the author's and is never rearranged.** Hand back the `rows`
 * `parseSettingsCsv` returned and every comment stays attached to the keys it
 * labels. `updates` changes values in place; only a key the file does not
 * already carry is appended, and it goes at the end where a reader will notice
 * it as new.
 *
 * `schema` is written last **when the file does not already carry one**. When
 * it does, it stays exactly where its author put it — even if that is the
 * middle of the file — because moving a row is precisely what this function
 * exists not to do. A file that declared a version this build refused therefore
 * comes back declaring that same version, rather than claiming the one this
 * build writes.
 *
 * A key set to `''` writes a row with a blank value rather than no row: a key
 * with nothing in it still records that somebody added the key, which is the
 * same call `formatEventCsv` makes for `extra`.
 *
 * **A comment row is never updated, and `updates` cannot write one.** A caller
 * building `updates` out of the rows it was handed — a table of the file, with
 * every row editable — would carry the comment rows' keys along with the rest,
 * and a comment is documentation rather than a setting. So an `updates` key
 * beginning `#` is dropped, which is also what keeps every comment row flowing
 * through the loop below untouched.
 *
 * Two other shapes of input are silently skipped, because both are unreadable
 * by construction and neither can be produced by `parseSettingsCsv`: a row with
 * a blank key (nothing would say what it configures), and an `updates` entry
 * whose key is blank.
 *
 * **The first half of that was untrue until the line standing in for a missing
 * header was made to go through the blank-key check as well** — see `take()` in
 * `readRows`. While it was untrue this function was the thing DELETING such a
 * row, in silence, which is the failure `tests/settings-csv.test.ts` now pins
 * from both ends.
 */
export function formatSettingsCsv(
  rows: readonly SettingsRow[],
  updates?: Readonly<Record<string, string>>,
): string {
  const changes = new Map(
    Object.entries(updates ?? {}).filter(([key]) => key.trim() !== '' && !isComment(key)),
  );
  const out: Array<Record<string, string>> = [];
  const written = new Set<string>();
  let hasSchema = false;

  for (const row of rows) {
    if (row.key.trim() === '') continue;
    if (row.key === 'schema') hasSchema = true;
    // Every occurrence, not just the last. A duplicated key is already reported
    // on read; leaving the earlier row holding a stale value would mean the
    // file says two different things about one setting, and which one takes
    // effect would rest on a rule ("last wins") that nothing in the file states.
    if (changes.has(row.key)) {
      out.push({ key: row.key, value: changes.get(row.key) as string });
      written.add(row.key);
      continue;
    }
    out.push({ key: row.key, value: row.value });
  }

  for (const [key, value] of changes) {
    if (written.has(key)) continue;
    out.push({ key, value });
    if (key === 'schema') hasSchema = true;
  }

  if (!hasSchema) out.push({ key: 'schema', value: String(CSV_SCHEMA) });

  return formatCsv(SETTINGS_HEADERS, out);
}
