/**
 * A CSV codec, RFC 4180, with the two concessions a file that people open
 * in a spreadsheet actually needs.
 *
 * BOM: Excel on Windows misreads UTF-8 without one, and notes are exactly
 * where apostrophes, em dashes and emoji turn up.
 *
 * FORMULA GUARD: a cell beginning `=`, `+`, `-` or `@` is executed when the
 * file is opened. These files are meant to be passed between people, so that
 * is a live risk rather than a theoretical one. A leading apostrophe disarms
 * it; spreadsheets hide the apostrophe, and `parseCsv` removes it.
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
const FORMULA_LEAD = /^['=+\-@]/;

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

function unguard(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
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
  const guarded = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
