/**
 * A CSV codec, RFC 4180, with the two concessions a file that people open in
 * a spreadsheet actually needs — and a third departure, NFC, that is nothing
 * to do with spreadsheets and is kept named separately for that reason: BOM
 * and the formula guard are both there because of what Excel and Sheets do to
 * this file, and NFC is there so that two spellings of one name compare equal
 * anywhere in this app.
 *
 * BOM: Excel on Windows misreads UTF-8 without one, and notes are exactly
 * where apostrophes, em dashes and emoji turn up.
 *
 * FORMULA GUARD: a cell whose first non-whitespace character is `=`, `+`, `-`
 * or `@` is executed when the file is opened. These files are meant to be
 * passed between people, so that is a live risk rather than a theoretical one.
 * A leading apostrophe disarms it; spreadsheets hide the apostrophe, and
 * `parseCsv` removes it — but only when it is one this module wrote, or a
 * name someone typed as `'Bama` loses its apostrophe on the first read. See
 * `FORMULA_LEAD` for why the whitespace matters and `unguard` for how the
 * two cases are told apart.
 *
 * NFC: every cell is written in Unicode Normalization Form C. `José` typed on
 * a Mac (which composes to NFD in some input paths) and `José` typed on
 * Windows are visually identical and compare UNEQUAL as JavaScript strings,
 * so a name written one way silently stopped matching the same name written
 * the other — verified in both directions against `resolvePersonNames`.
 * Normalising here fixes it for everything this app writes; the name
 * comparisons in `people-csv.ts` normalise both sides so a file written
 * elsewhere matches too.
 *
 * Knows nothing about notes or people — it moves strings.
 */

export interface CsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  /**
   * The 1-indexed file line each entry in `rows` started on, aligned by
   * index with `rows`.
   *
   * NOT the same as `rows`'s own index plus a fixed offset: `parseCsv` drops
   * blank lines rather than emitting empty rows for them (see below), and a
   * blank line can sit anywhere — above the first data row, between two
   * others — so the number of blank lines already skipped varies row to
   * row. A caller reporting "Row N" to someone about to open the file in a
   * spreadsheet needs the real line this array carries, not `i + 2`.
   */
  rowLines: number[];
}

const BOM = '﻿';

/**
 * A cell a spreadsheet would run instead of showing.
 *
 * **Not `/^[=+\-@]/`.** Excel and LibreOffice STRIP leading whitespace before
 * deciding whether a cell is a formula, and a CSV field can carry a TAB or a
 * CR quite legally — so `\t=cmd|'/c calc'!A0` is a live DDE payload that an
 * anchored guard never sees. Verified before this fix: such a cell
 * round-tripped through an unknown `notes.csv` column completely unguarded,
 * which meant the owner could merge a crew member's file, save it, open the
 * result in Excel, and run whatever that cell said. `text` happened to be safe
 * only because `rowToNote` trims it; every other column is written back
 * verbatim.
 *
 * The apostrophe branch stays ANCHORED, deliberately: `'` is this module's own
 * guard character and `unguard` only strips one from position 0, so guarding a
 * cell whose apostrophe sits after a space would not round-trip.
 */
const FORMULA_LEAD = /^(?:'|[\s\u0000-\u001f]*[=+\-@])/;

/**
 * The version of the on-disk CSV layout this build reads and writes.
 *
 * Carried in a `schema` column in BOTH `notes*.csv` and `people.csv`, and
 * **per row, not per file** — these files merge by row-bind (see `mergeNotes`
 * in `notes.ts`), so a row from someone's older copy lands among newer rows
 * and has to carry its own version with it. A file-level marker would claim
 * one version for rows that came from several files. `tz` already sets that
 * precedent.
 *
 * A blank cell means "the version this reader knows", so a row someone adds
 * by hand needs nothing typed into it.
 */
export const CSV_SCHEMA = 1;

/**
 * Whether a `schema` cell can be read by this build — the check, not just the
 * column.
 *
 * A marker older builds ignore buys nothing retroactively; the part that
 * expires is refusing a row written by something newer, which is why this
 * ships with the column rather than after it. Mirrors `validateManifest`
 * refusing an unknown manifest `schema` outright rather than rendering a
 * guess.
 *
 * Returns null when the row is readable, or a predicate a caller prefixes
 * with whatever names the row (`note "n_x" …`, `Row 4: …`) — the file is
 * named in the message itself so it survives being read on its own.
 */
export function schemaCellProblem(raw: string | undefined, file: string): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) {
    return (
      `has a schema of "${s}", which is not a whole number — clear the schema cell in ` +
      `${file} to read this row as version ${CSV_SCHEMA}`
    );
  }
  const version = Number(s);
  if (version > CSV_SCHEMA) {
    return (
      `has schema ${version}, but this build of meanwhile reads ${file} up to schema ` +
      `${CSV_SCHEMA} — update the site, or clear the schema cell to read this row as ` +
      `version ${CSV_SCHEMA}`
    );
  }
  return null;
}

/**
 * A row this build could not interpret, kept exactly as it was read so the
 * next Save writes it back rather than deleting it.
 *
 * **Refusing to read a row and deleting it are not the same thing, and the
 * code used to treat them as one.** A row from a newer build, or one with a
 * day of 32, was reported at load and then silently absent from the file the
 * next Save produced — so the message telling someone to "update the site, or
 * clear the schema cell" was describing a repair for data that was already
 * gone. Anything the reader rejects lands here instead, and the writer puts it
 * back beside the rows that parsed.
 *
 * `cells` is the row as `parseCsv` produced it: keyed by the header names the
 * file itself declared, with the formula guard already removed (`formatCsv`
 * puts it back on write). One thing is NOT byte-identical across the round
 * trip: `formatCsv` writes every cell in Unicode NFC, so a decomposed
 * spelling comes back composed — the same treatment every other cell in the
 * file gets, and the reason `people-csv.ts` compares names with `nameKey`.
 * A row carrying MORE fields than the header row declares loses the surplus,
 * because there is no column name to file them under; a file written by a
 * newer build declares its own headers, so that case is a malformed file
 * rather than a version gap.
 */
export interface PreservedRow {
  /** The file it came from, named as a person would look for it. */
  file: string;
  /** 1-indexed file line, so someone can open the file and go to the row. */
  line: number;
  /** Every cell of the row, exactly as read. */
  cells: Record<string, string>;
}

/**
 * Every column name any preserved row carries that `known` does not already
 * list, in the order first seen.
 *
 * `formatCsv` only writes the headers it is handed, so a preserved row's own
 * columns — the whole point of a row written by a NEWER build — need adding
 * to the header list or they are dropped on the way out, which would defeat
 * the preservation entirely.
 */
export function preservedHeaders(
  known: readonly string[],
  preserved: readonly PreservedRow[],
): string[] {
  const seen = new Set<string>(known);
  const extra: string[] = [];
  for (const row of preserved) {
    for (const key of Object.keys(row.cells)) {
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      extra.push(key);
    }
  }
  return extra;
}

/**
 * Unicode Normalization Form C.
 *
 * Exported because normalising on write is only half the fix: every
 * comparison between two names has to normalise BOTH sides, or a file written
 * by another tool still fails to match one written here. See the module
 * comment.
 */
export function nfc(value: string): string {
  return value.normalize('NFC');
}

export function parseCsv(text: string): CsvTable {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  const records = splitRecords(body);
  // Headers go through `unguard` too, the same as any other cell: `formatCsv`
  // guards a header that starts `=`, `+`, `-` or `@` exactly like it guards a
  // value (`headers.map(cell)`), so a header must be unguarded symmetrically
  // or a round-tripped formula-like column name comes back with a leading
  // apostrophe baked in and never matches the name it was written under.
  const headerRecord = records.shift();
  const headers = (headerRecord?.fields ?? []).map((h) => unguard(h.trim()));
  const rows: Array<Record<string, string>> = [];
  const rowLines: number[] = [];
  for (const record of records) {
    // A trailing newline yields one empty record; so does a blank line left
    // behind by a spreadsheet. Neither is a row — and neither gets a slot in
    // `rowLines` either, which is exactly why it cannot be reconstructed from
    // the index afterwards.
    if (record.fields.length === 1 && record.fields[0] === '') continue;
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = unguard(record.fields[i] ?? '');
    });
    rows.push(row);
    rowLines.push(record.line);
  }
  return { headers, rows, rowLines };
}

/** One parsed record together with the file line it started on. */
interface RawRecord {
  fields: string[];
  /** 1-indexed, matching what a spreadsheet or text editor shows. */
  line: number;
}

/** Split into records, honouring quotes — newlines inside them are data. */
function splitRecords(text: string): RawRecord[] {
  const records: RawRecord[] = [];
  let field = '';
  let fields: string[] = [];
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        // A newline embedded in a quoted field is a real line break in the
        // file even though it does not end the record, so the counter used
        // for the NEXT record's line still has to move past it.
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Swallow the LF of a CRLF pair rather than emitting a blank record.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      fields.push(field);
      records.push({ fields, line: recordLine });
      field = '';
      fields = [];
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== '' || fields.length > 0) {
    fields.push(field);
    records.push({ fields, line: recordLine });
  }
  return records;
}

/**
 * The exact inverse of the formula guard in `cell`.
 *
 * **It used to strip a leading `'` unconditionally, and that lost data.**
 * Right for a file meanwhile wrote — the apostrophe is our own guard coming
 * back off — and wrong for one it did not: a note reading `'twas a long
 * night`, or a person named `'Bama`, came back without the apostrophe on the
 * FIRST read and was saved that way, silently and unrecoverably.
 *
 * The fix is to ask the question `cell` asked. `cell` writes an apostrophe
 * exactly when `FORMULA_LEAD` matches the value, so an apostrophe is ours
 * exactly when `FORMULA_LEAD` matches what FOLLOWS it. Six cases, all pinned
 * in `tests/csv.test.ts`:
 *
 * | read      | remainder | ours? | result   |
 * |-----------|-----------|-------|----------|
 * | `''twas`  | `'twas`   | yes   | `'twas`  |
 * | `'twas`   | `twas`    | no    | `'twas`  |
 * | `'=SUM()` | `=SUM()`  | yes   | `=SUM()` |
 * | `'@Priya` | `@Priya`  | yes   | `@Priya` |
 * | `'  =evil`| `  =evil` | yes   | `  =evil`|
 * | `'Bama`   | `Bama`    | no    | `'Bama`  |
 *
 * **Testing the whole remainder against `FORMULA_LEAD`, not just its first
 * character, is what makes row five work.** `cell` guards a cell whose first
 * NON-WHITESPACE character is a formula lead, so `  =evil` is written `'  =evil`
 * and a next-character check would see a space, call the apostrophe somebody
 * else's, and hand a live DDE payload back to the spreadsheet.
 *
 * There is no migration to do, and that is worth stating because it looks
 * like there should be: a file meanwhile wrote already carries the doubled
 * apostrophe (`FORMULA_LEAD`'s own anchored `'` branch guards `'twas` as
 * `''twas`), so it reads the same before and after this change. Only a file
 * from somewhere else reads differently, and it reads CORRECTLY now.
 */
function unguard(value: string): string {
  if (!value.startsWith("'")) return value;
  const rest = value.slice(1);
  return FORMULA_LEAD.test(rest) ? rest : value;
}

export function formatCsv(
  headers: readonly string[],
  rows: ReadonlyArray<Record<string, string>>,
): string {
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => cell(row[h] ?? '')).join(','));
  }
  return BOM + lines.join('\n') + '\n';
}

function cell(raw: string): string {
  // NFC first, so the guard and the quoting both see the form that actually
  // gets written — and so two spellings of the same name are one string on
  // disk. See the module comment.
  const normalized = nfc(raw);
  const guarded = FORMULA_LEAD.test(normalized) ? `'${normalized}` : normalized;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
