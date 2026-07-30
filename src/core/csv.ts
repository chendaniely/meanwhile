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
  const headers = (records.shift() ?? []).map((h) => unguard(h.trim()));
  const rows: Array<Record<string, string>> = [];
  for (const record of records) {
    // A trailing newline yields one empty record; so does a blank line left
    // behind by a spreadsheet. Neither is a row.
    if (record.length === 1 && record[0] === '') continue;
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = unguard(record[i] ?? '');
    });
    rows.push(row);
  }
  return { headers, rows };
}

/** Split into records, honouring quotes — newlines inside them are data. */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;

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
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Swallow the LF of a CRLF pair rather than emitting a blank record.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
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
