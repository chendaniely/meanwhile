# Notes as CSV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move notes and the people roster out of `manifest.json` into
spreadsheet-editable CSV files that any number of people can write separately
and the site merges by row-binding.

**Architecture:** Three new pure kernel modules — a CSV codec, a notes
codec/merger, and a people codec — plus a store-only ZIP writer in the viewer.
Ingest gains CSV loading beside the existing track and manifest loading. The
manifest stops *writing* notes and captions but keeps *reading* them, so old
files migrate on first save.

**Tech Stack:** TypeScript, React 19, Vitest. No new dependencies.

## Global Constraints

- `src/core/` is a **pure kernel**: only relative imports of other core files;
  no React, no Node APIs, no browser globals. `TextDecoder`, `TextEncoder`,
  `Intl` and `Date` are allowed. Enforced by `tests/core-purity.test.ts` —
  **never weaken that test.**
- **No new dependencies.** The ZIP writer is hand-rolled (~60 lines).
- Nothing outside `src/core/schema.ts` may define its own notion of the
  manifest.
- Timestamp columns are **plain integers**: `year,month,day,hour,minute`.
- Spans are **ISO-8601 durations** (`PT3H40M`), matching `clockOffset`.
- `people` and `author` are **semicolon-separated names**.
- CSV is written **UTF-8 with a BOM**; cells starting `=` `+` `-` `@` are
  written with a leading apostrophe.
- Note text is **single-line**: newlines collapse to spaces on write.
- Every user-visible string follows the existing vocabulary: *Open* replaces,
  *Add* merges, the crop is a "time window".
- Run `make check` before every commit.

---

### Task 1: CSV codec

Pure RFC 4180 read/write. Knows nothing about notes.

**Files:**
- Create: `src/core/csv.ts`
- Test: `tests/csv.test.ts`

**Interfaces:**
- Produces:
  - `parseCsv(text: string): CsvTable` where
    `interface CsvTable { headers: string[]; rows: Array<Record<string, string>> }`
  - `formatCsv(headers: readonly string[], rows: ReadonlyArray<Record<string, string>>): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/csv.test.ts
import { describe, expect, it } from 'vitest';
import { formatCsv, parseCsv } from '../src/core/csv.ts';

describe('parseCsv', () => {
  it('reads a header row and keys each row by it', () => {
    const table = parseCsv('a,b\n1,2\n');
    expect(table.headers).toEqual(['a', 'b']);
    expect(table.rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('reads quoted fields containing commas, quotes and newlines', () => {
    const table = parseCsv('a,b\n"x, y","he said ""hi""\nsecond line"\n');
    expect(table.rows[0]?.a).toBe('x, y');
    expect(table.rows[0]?.b).toBe('he said "hi"\nsecond line');
  });

  it('strips a byte-order mark, which Excel writes', () => {
    expect(parseCsv('﻿a\n1\n').headers).toEqual(['a']);
  });

  it('accepts CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('ignores blank lines rather than emitting empty rows', () => {
    expect(parseCsv('a\n1\n\n2\n').rows).toEqual([{ a: '1' }, { a: '2' }]);
  });

  it('pads a short row and keeps an over-long one addressable', () => {
    const table = parseCsv('a,b,c\n1\n');
    expect(table.rows[0]).toEqual({ a: '1', b: '', c: '' });
  });

  it('removes the apostrophe that guards a formula', () => {
    expect(parseCsv("a\n'=1+1\n").rows[0]?.a).toBe('=1+1');
  });
});

describe('formatCsv', () => {
  it('writes a BOM so Excel on Windows reads UTF-8 correctly', () => {
    expect(formatCsv(['a'], [{ a: 'x' }]).startsWith('﻿')).toBe(true);
  });

  it('quotes only what needs quoting', () => {
    const out = formatCsv(['a', 'b'], [{ a: 'plain', b: 'x, y' }]);
    expect(out).toContain('plain,"x, y"');
  });

  it('doubles embedded quotes', () => {
    expect(formatCsv(['a'], [{ a: 'he said "hi"' }])).toContain('"he said ""hi"""');
  });

  it('guards a cell that a spreadsheet would run as a formula', () => {
    // These files are passed between people; Excel executes =, +, - and @.
    for (const danger of ['=1+1', '+1', '-1', '@SUM(A1)']) {
      expect(formatCsv(['a'], [{ a: danger }])).toContain(`'${danger}`);
    }
  });

  it('round-trips everything it wrote', () => {
    const rows = [{ a: 'x, y', b: 'he said "hi"', c: "=1+1" }];
    const back = parseCsv(formatCsv(['a', 'b', 'c'], rows));
    expect(back.rows).toEqual(rows);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/csv.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/csv.ts"`

- [ ] **Step 3: Implement**

```ts
// src/core/csv.ts
/**
 * A CSV codec, RFC 4180, with the three concessions a file that people open
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
  const headers = (records.shift() ?? []).map((h) => h.trim());
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/csv.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Confirm the kernel stayed pure and commit**

```bash
npx vitest run tests/core-purity.test.ts
make check
git add src/core/csv.ts tests/csv.test.ts
git commit -m "Add a CSV codec that survives spreadsheets

RFC 4180 plus the three things a file people open in Excel needs: a BOM so
UTF-8 is read correctly on Windows, a guard on cells beginning = + - or @
which Excel executes as formulas, and tolerance of CRLF and stray blank lines."
```

---

### Task 2: Note rows

Convert between a `Note` and a CSV row. No merging yet.

**Files:**
- Create: `src/core/notes.ts`
- Test: `tests/notes.test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `formatCsv` from Task 1; `zonedToInstant`,
  `parseDuration`, `formatDuration` from `src/core/time.ts`.
- Produces:
  - `interface Note { id: string; at: string; duration?: string; tz?: string; people: string[]; photo?: string; author: string[]; text: string; extra?: Record<string, string> }`
    — `at` is an ISO instant string, resolved from the integer columns.
  - `NOTE_HEADERS: readonly string[]`
  - `rowToNote(row: Record<string, string>, eventTimezone?: string): Note | { error: string }`
  - `noteToRow(note: Note, eventTimezone?: string): Record<string, string>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/notes.test.ts
import { describe, expect, it } from 'vitest';
import { noteToRow, rowToNote, type Note } from '../src/core/notes.ts';

const ZONE = 'America/Denver';
const row = (over: Record<string, string> = {}) => ({
  id: 'n_1', year: '2026', month: '7', day: '25',
  hour: '15', minute: '45', duration: '', tz: '',
  people: '', photo: '', author: '', text: 'wrong turn', ...over,
});

describe('rowToNote', () => {
  it('resolves the five integers through the event timezone', () => {
    // 15:45 in Denver in July is UTC-6.
    const note = rowToNote(row(), ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
  });

  it('prefers the row own timezone over the event one', () => {
    const note = rowToNote(row({ tz: 'UTC' }), ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 15, 45)).toISOString());
  });

  it('accepts zero-padded numbers, which a hand-edited file may carry', () => {
    const note = rowToNote(row({ month: '07', day: '05' }), ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 5, 21, 45)).toISOString());
  });

  it('splits a combined date and time column, for files written by hand', () => {
    const legacy = { id: 'n_1', date: '2026-07-25', time: '15:45', text: 'x' };
    const note = rowToNote(legacy, ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
  });

  it('splits a single ISO `at` column, as written before this change', () => {
    const legacy = { id: 'n_1', at: '2026-07-25T21:45:00Z', text: 'x' };
    expect((rowToNote(legacy, ZONE) as Note).at)
      .toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
  });

  it('splits people and author on semicolons, trimming space', () => {
    const note = rowToNote(row({ people: 'Priya; Sam', author: 'Dan' }), ZONE) as Note;
    expect(note.people).toEqual(['Priya', 'Sam']);
    expect(note.author).toEqual(['Dan']);
  });

  it('reads a duration as ISO-8601, and a bare number as minutes', () => {
    expect((rowToNote(row({ duration: 'PT3H40M' }), ZONE) as Note).duration).toBe('PT3H40M');
    expect((rowToNote(row({ duration: '20' }), ZONE) as Note).duration).toBe('PT20M');
  });

  it('keeps unknown columns so a round trip cannot lose them', () => {
    const note = rowToNote(row({ tags: 'night' }), ZONE) as Note;
    expect(note.extra).toEqual({ tags: 'night' });
  });

  it('reports a row it cannot read rather than dropping it', () => {
    expect(rowToNote(row({ year: 'nineteen' }), ZONE)).toHaveProperty('error');
    expect(rowToNote(row({ text: '' }), ZONE)).toHaveProperty('error');
  });

  it('collapses newlines in the text, which break naive tooling', () => {
    const note = rowToNote(row({ text: 'first\nsecond' }), ZONE) as Note;
    expect(note.text).toBe('first second');
  });
});

describe('noteToRow', () => {
  it('writes five integers, unpadded', () => {
    const note = rowToNote(row(), ZONE) as Note;
    const out = noteToRow(note, ZONE);
    expect(out).toMatchObject({ year: '2026', month: '7', day: '25', hour: '15', minute: '45' });
  });

  it('leaves tz blank when it matches the event', () => {
    expect(noteToRow(rowToNote(row(), ZONE) as Note, ZONE).tz).toBe('');
  });

  it('round-trips through a row without losing anything', () => {
    const note = rowToNote(row({
      people: 'Priya;Sam', author: 'Dan;Priya', duration: 'PT3H40M',
      photo: 'a.jpg', tags: 'night',
    }), ZONE) as Note;
    expect(rowToNote(noteToRow(note, ZONE), ZONE)).toEqual(note);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/notes.test.ts`
Expected: FAIL — cannot resolve `../src/core/notes.ts`

- [ ] **Step 3: Implement**

Write `src/core/notes.ts` exporting `Note`, `NOTE_HEADERS`, `rowToNote` and
`noteToRow`.

Requirements the tests above pin down:

- `NOTE_HEADERS = ['id','year','month','day','hour','minute','duration','tz','people','photo','author','text']`
- Read the five integers with `Number(String(v).trim())`; reject
  non-finite values with `{ error }`. Zero-padding falls out for free.
- Legacy shapes, tried in order when `year` is absent: a `date` + `time`
  pair, then a single `at`. For `date` accept `YYYY-MM-DD`, `M/D/YY`,
  `M/D/YYYY` and an Excel serial (days since 1899-12-30). For `time` accept
  `HH:MM`, `HH:MM:SS`, `h:MM AM/PM` and a day fraction.
- Resolve to an instant with `zonedToInstant(naive, tz ?? eventTimezone ?? 'UTC')`
  where `naive` is `YYYY-MM-DDTHH:MM:00` zero-padded.
- `duration`: pass an ISO string through `parseDuration` to validate; a bare
  number becomes `PT<n>M`.
- `people`/`author`: `split(';')`, trim, drop empties.
- `text`: `replace(/\s*[\r\n]+\s*/g, ' ').trim()`; empty is an error.
- `extra`: every key in the row that is not in `NOTE_HEADERS` and not a
  legacy key (`date`, `time`, `at`).
- `noteToRow` writes the integers from the instant **rendered in the note's
  zone** (use `Intl.DateTimeFormat` with `timeZone`, as `toLocalInput` in
  `Notes.tsx` already does), joins arrays with `;`, and spreads `extra`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/notes.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
make check
git add src/core/notes.ts tests/notes.test.ts
git commit -m "Convert notes to and from CSV rows

Timestamps are five plain integers, which no spreadsheet reformats — splitting
date from time only made corruption recoverable, and integers make it
impossible. Spans are ISO-8601 durations so the unit travels with the value.
Legacy shapes (a date/time pair, a single ISO at) are read and repaired on the
next write."
```

---

### Task 3: Merging note files

**Files:**
- Modify: `src/core/notes.ts`
- Test: `tests/notes.test.ts`

**Interfaces:**
- Produces:
  - `mintNoteId(): string`
  - `mergeNotes(files: ReadonlyArray<{ name: string; text: string }>, eventTimezone?: string): { notes: Note[]; problems: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/notes.test.ts
import { mergeNotes } from '../src/core/notes.ts';

const file = (name: string, body: string) => ({
  name,
  text: 'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' + body,
});

describe('mergeNotes', () => {
  it('row-binds several files and sorts by time', () => {
    const { notes } = mergeNotes([
      file('notes-dan.csv', 'n_b,2026,7,25,16,0,,,,,Dan,second\n'),
      file('notes-priya.csv', 'n_a,2026,7,25,15,0,,,,,Priya,first\n'),
    ], ZONE);
    expect(notes.map((n) => n.text)).toEqual(['first', 'second']);
  });

  it('mints an id for a row typed by hand', () => {
    const { notes } = mergeNotes([file('n.csv', ',2026,7,25,15,0,,,,,Dan,typed\n')], ZONE);
    expect(notes[0]?.id).toMatch(/^n_/);
  });

  it('re-mints a duplicated id, because a duplicate is a copied row', () => {
    const { notes } = mergeNotes([
      file('a.csv', 'same,2026,7,25,15,0,,,,,Dan,one\n'),
      file('b.csv', 'same,2026,7,25,16,0,,,,,Priya,two\n'),
    ], ZONE);
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });

  it('keeps an identical id-and-content row only once', () => {
    const body = 'n_a,2026,7,25,15,0,,,,,Dan,one\n';
    const { notes } = mergeNotes([file('a.csv', body), file('b.csv', body)], ZONE);
    expect(notes).toHaveLength(1);
  });

  it('reports a bad row and still loads the rest of the file', () => {
    const { notes, problems } = mergeNotes([
      file('a.csv', 'n_a,nineteen,7,25,15,0,,,,,Dan,bad\nn_b,2026,7,25,15,0,,,,,Dan,good\n'),
    ], ZONE);
    expect(notes.map((n) => n.text)).toEqual(['good']);
    expect(problems[0]).toContain('a.csv');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/notes.test.ts -t mergeNotes`
Expected: FAIL — `mergeNotes is not a function`

- [ ] **Step 3: Implement**

```ts
// append to src/core/notes.ts
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
): { notes: Note[]; problems: string[] } {
  const notes: Note[] = [];
  const problems: string[] = [];
  const seen = new Map<string, string>(); // id -> a fingerprint of its content

  for (const file of files) {
    const table = parseCsv(file.text);
    table.rows.forEach((row, i) => {
      const result = rowToNote(row, eventTimezone);
      if ('error' in result) {
        // Reported, never dropped silently — the same rule as unplaced media.
        problems.push(`${file.name} row ${i + 2}: ${result.error}`);
        return;
      }
      const note = result;
      const fingerprint = `${note.at} ${note.text}`;
      if (!note.id) {
        note.id = mintNoteId();
      } else if (seen.has(note.id)) {
        // The same row in two files is one note. A different row wearing the
        // same id is a copy, and gets its own identity.
        if (seen.get(note.id) === fingerprint) return;
        note.id = mintNoteId();
      }
      seen.set(note.id, fingerprint);
      notes.push(note);
    });
  }

  notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { notes, problems };
}

/** Short, opaque and unique enough that two people never collide. */
export function mintNoteId(): string {
  return `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/notes.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
make check
git add src/core/notes.ts tests/notes.test.ts
git commit -m "Merge note files by row-binding

Concatenate, dedupe by id, sort by time. Ids are globally unique in practice,
so there is no conflict resolution, no locking and no merge UI — which is what
lets several people keep their own file with no version control. A duplicated
id is a copied row and gets a fresh identity; an identical row in two files is
one note."
```

---

### Task 4: The people roster as CSV

**Files:**
- Create: `src/core/people-csv.ts`
- Test: `tests/people-csv.test.ts`

**Interfaces:**
- Produces:
  - `PEOPLE_HEADERS: readonly string[]`
  - `parsePeopleCsv(text: string): { people: Person[]; problems: string[] }`
  - `formatPeopleCsv(people: readonly Person[]): string`
  - `resolvePersonNames(names: readonly string[], people: readonly Person[]): { ids: PersonId[]; unknown: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/people-csv.test.ts
import { describe, expect, it } from 'vitest';
import {
  formatPeopleCsv, parsePeopleCsv, resolvePersonNames,
} from '../src/core/people-csv.ts';
import type { Person } from '../src/core/schema.ts';

const PEOPLE: Person[] = [
  { id: 'pixel8', name: 'Priya', role: 'runner' },
  { id: 'zflip4', name: 'Sam', clockOffset: 'PT-4S' },
];

describe('people.csv', () => {
  it('round-trips a roster', () => {
    expect(parsePeopleCsv(formatPeopleCsv(PEOPLE)).people).toEqual(PEOPLE);
  });

  it('reads role and clock offset, leaving blanks absent rather than empty', () => {
    const { people } = parsePeopleCsv(
      'id,name,role,clock_offset\npixel8,Priya,runner,\n',
    );
    expect(people[0]).toEqual({ id: 'pixel8', name: 'Priya', role: 'runner' });
  });

  it('reports a row with no id or name', () => {
    const { people, problems } = parsePeopleCsv('id,name\n,Nobody\npixel8,Priya\n');
    expect(people).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });
});

describe('resolvePersonNames', () => {
  it('matches names case-insensitively, ignoring surrounding space', () => {
    expect(resolvePersonNames([' priya ', 'SAM'], PEOPLE).ids).toEqual(['pixel8', 'zflip4']);
  });

  it('keeps an unrecognised name rather than dropping the note it is on', () => {
    const { ids, unknown } = resolvePersonNames(['Priya', 'Ghost'], PEOPLE);
    expect(ids).toEqual(['pixel8']);
    expect(unknown).toEqual(['Ghost']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/people-csv.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

`PEOPLE_HEADERS = ['id','name','role','clock_offset']`. `parsePeopleCsv` uses
`parseCsv`; a row missing `id` or `name` becomes a problem string rather than a
person. Omit `role` and `clockOffset` when blank — an empty string would fail
the manifest validator. `formatPeopleCsv` uses `formatCsv`.
`resolvePersonNames` lower-cases and trims both sides.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/people-csv.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
make check
git add src/core/people-csv.ts tests/people-csv.test.ts
git commit -m "Read and write the people roster as CSV

Renaming a device to a person is exactly a spreadsheet job. Notes refer to
people by name, matched case-insensitively, and an unrecognised name is kept
rather than dropping the note it appears on."
```

---

### Task 5: Load the CSVs during ingest

**Files:**
- Modify: `src/core/metadata.ts` — add `isNotesFile`, `isPeopleFile`
- Modify: `src/viewer/media/folder.ts:55,98` — accept them
- Modify: `src/viewer/media/ingest.ts` — read, merge, migrate
- Modify: `src/core/window.ts:269` — `placeNotes` takes notes, not a manifest
- Test: `tests/metadata.test.ts`, `tests/window.test.ts`

**Interfaces:**
- Consumes: `mergeNotes` (Task 3), `parsePeopleCsv` (Task 4).
- Produces: `IngestResult` gains `notes: Note[]` and `noteProblems: string[]`.
  `placeNotes(notes: readonly Note[]): PlacedNote[]`.

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/metadata.test.ts
import { isNotesFile, isPeopleFile } from '../src/core/metadata.ts';

describe('recognising the metadata files', () => {
  it('accepts any notes file, however it was named', () => {
    for (const n of ['notes.csv', 'notes-priya.csv', 'notes_dan.csv', 'sub/notes.csv']) {
      expect(isNotesFile(n)).toBe(true);
    }
  });

  it('does not sweep in an unrelated spreadsheet', () => {
    for (const n of ['budget.csv', 'my-notes-draft.txt', 'notes.txt']) {
      expect(isNotesFile(n)).toBe(false);
    }
  });

  it('recognises the roster', () => {
    expect(isPeopleFile('people.csv')).toBe(true);
    expect(isPeopleFile('peoples.csv')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/metadata.test.ts -t "metadata files"`
Expected: FAIL — `isNotesFile is not a function`

- [ ] **Step 3: Implement**

In `metadata.ts`:

```ts
/** Any `notes*.csv`, so several people's files are all picked up. */
export function isNotesFile(filename: string): boolean {
  return /(^|\/)notes[^/]*\.csv$/i.test(filename);
}

export function isPeopleFile(filename: string): boolean {
  return /(^|\/)people\.csv$/i.test(filename);
}
```

In `folder.ts`, add both to the two accept conditions at lines 55 and 98.

In `ingest.ts`, alongside the existing track and manifest handling: collect
files matching each predicate, read them with `await f.file.text()`, call
`mergeNotes(files, timezone)` and `parsePeopleCsv`, and return `notes` and
`noteProblems` on `IngestResult`. A roster from `people.csv` outranks
`existingPeople` in the same way an imported manifest already does.

**Migration:** after building the manifest, if it still carries
`manifest.notes` or any `items[].note`, convert them into `Note` objects and
prepend them to the merged list. Do not delete them from the manifest here —
Task 9 stops writing them.

In `window.ts`, change `placeNotes(manifest: Manifest)` to
`placeNotes(notes: readonly Note[])` and update its three call sites in
`App.tsx`. Its tests change shape but not meaning.

- [ ] **Step 4: Run the tests**

Run: `make check`
Expected: PASS. Update `tests/window.test.ts` to pass an array where it
previously passed a manifest.

- [ ] **Step 5: Verify by hand, then commit**

Put a `notes.csv` in a folder with two photos, open it, and confirm the notes
appear in the feed at the right times.

```bash
make check
git add -A
git commit -m "Load notes and people from CSV files in the folder

Picked up the same way a .gpx is — drop them in with the photos, no separate
step. Any notes*.csv matches, so several people's files merge without a naming
rule to explain. Notes still in an old manifest are migrated into the list on
load."
```

---

### Task 6: A store-only ZIP writer

**Files:**
- Create: `src/viewer/media/zip.ts`
- Test: `tests/zip.test.ts`

**Interfaces:**
- Produces: `zip(files: ReadonlyArray<{ name: string; text: string }>): Blob`

- [ ] **Step 1: Write the failing test**

```ts
// tests/zip.test.ts
import { describe, expect, it } from 'vitest';
import { zipBytes } from '../src/viewer/media/zip.ts';

describe('zipBytes', () => {
  it('starts with the local file header signature', () => {
    const bytes = zipBytes([{ name: 'a.csv', text: 'x' }]);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('ends with the end-of-central-directory signature', () => {
    const bytes = zipBytes([{ name: 'a.csv', text: 'x' }]);
    const tail = bytes.slice(-22, -18);
    expect(Array.from(tail)).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('records one central directory entry per file', () => {
    const bytes = zipBytes([
      { name: 'a.csv', text: 'x' },
      { name: 'b.csv', text: 'y' },
    ]);
    const count = new DataView(bytes.buffer).getUint16(bytes.length - 14, true);
    expect(count).toBe(2);
  });

  it('stores the content uncompressed and intact', () => {
    const bytes = zipBytes([{ name: 'a.csv', text: 'hello' }]);
    expect(new TextDecoder().decode(bytes).includes('hello')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/zip.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement**

```ts
// src/viewer/media/zip.ts
/**
 * A store-only ZIP writer — about sixty lines, and no dependency.
 *
 * Compression is pointless here: the payload is a few kilobytes of CSV, and a
 * deflate implementation would be the largest thing in the project. Storing
 * means the archive is legal ZIP that every operating system opens, and the
 * writer is small enough to read in one sitting.
 *
 * Only a writer is needed. Import stays loose files, so nothing has to
 * inflate anything.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipBytes(files: ReadonlyArray<{ name: string; text: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const sum = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);      // version needed
    lv.setUint16(8, 0, true);       // stored, no compression
    lv.setUint32(14, sum, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);

    chunks.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, e) => n + e.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests, then verify a real archive opens**

Run: `npx vitest run tests/zip.test.ts`
Expected: PASS, 4 tests.

Then confirm the operating system agrees, not just our own tests:

```bash
node -e "
import('./src/viewer/media/zip.ts').then(async (m) => {
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/mw.zip', m.zipBytes([{name:'a.csv',text:'x,y\n1,2\n'}]));
});
" && unzip -t /tmp/mw.zip && unzip -p /tmp/mw.zip a.csv
```

Expected: `No errors detected` and the CSV printed back.

- [ ] **Step 5: Commit**

```bash
make check
git add src/viewer/media/zip.ts tests/zip.test.ts
git commit -m "Add a store-only ZIP writer, no dependency

Sixty lines for local headers, a central directory and CRC-32. Compression is
pointless on a few kilobytes of CSV and a deflate implementation would be the
largest thing in the project. Verified with unzip -t, not only our own tests."
```

---

### Task 7: A searchable multi-select for people

**Files:**
- Create: `src/viewer/components/PersonPicker.tsx`
- Modify: `src/viewer/App.css`
- Read first: `src/viewer/components/TimezoneField.tsx` — follow its pattern

**Interfaces:**
- Produces:
  `PersonPicker({ people, value, onChange, label }: { people: readonly Person[]; value: readonly string[]; onChange: (names: string[]) => void; label: string })`

- [ ] **Step 1: Build it against the existing pattern**

Read `TimezoneField.tsx` and mirror it: a text input that filters a list,
keyboard navigable, closing on blur and Escape. Differences: multiple
selection, chosen names shown as removable chips above the input, and a typed
name that matches nobody is still accepted — the roster may be incomplete.

- [ ] **Step 2: Verify by hand in the browser**

`make dev`, open a folder, and check: typing filters; Enter adds; Backspace on
an empty input removes the last chip; Escape closes without changing anything.

- [ ] **Step 3: Commit**

```bash
make check
git add src/viewer/components/PersonPicker.tsx src/viewer/App.css
git commit -m "Add a searchable multi-select for people

The same control pattern as the timezone field, chosen on the same grounds: a
list you filter by typing beats a list you scroll. Both people and author take
any number of names now, so both use it."
```

---

### Task 8: The composer writes the new shape

**Files:**
- Modify: `src/viewer/components/Notes.tsx` — `people` and `author` pickers
- Modify: `src/viewer/App.tsx` — the "you are…" setting
- Modify: `src/viewer/components/NoteDock.tsx` — pass it through

- [ ] **Step 1: Replace the single person select**

Swap the `<select>` for two `PersonPicker`s: **Whose** (`people`) and **Written
by** (`author`). Keep one time box and the end-time box — the file stores five
integers and a duration, the UI does not.

- [ ] **Step 2: Add the "you are…" setting**

A `PersonPicker` in the top bar, persisted in `localStorage` under
`meanwhile.author`. It defaults to unset and never blocks writing: notes with
no author are saved blank, and Save asks once and stamps them.

This is the only thing the site persists locally, and it holds no event data —
it describes who is at this laptop, which is why it is not in the manifest.

- [ ] **Step 3: Verify the round trip by hand**

Write a note with two people and two authors, save, reopen the CSV in a
spreadsheet, and confirm the columns read as expected.

- [ ] **Step 4: Commit**

```bash
make check
git add -A
git commit -m "The composer writes the columns the spec defines

Whose and Written by are both multi-selects now. The time stays one box: the
five-integer split is a property of the file, and five inputs would slow down
the path this feature exists to make fast."
```

---

### Task 9: Captions become notes, and the manifest stops carrying them

**Files:**
- Modify: `src/viewer/components/Lightbox.tsx` — caption writes a note
- Modify: `src/viewer/components/MediaTile.tsx` — the chat symbol
- Modify: `src/core/schema.ts` — stop writing `notes[]` and `items[].note`
- Modify: `src/viewer/App.tsx` — save produces the zip
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Write the failing migration test**

```ts
// append to tests/schema.test.ts
it('still READS an old manifest carrying notes and captions', () => {
  const old = {
    schema: 1,
    event: { title: 'Race' },
    people: [{ id: 'p', name: 'Priya' }],
    notes: [{ id: 'n', at: '2026-07-25T21:45:00Z', text: 'wrong turn' }],
    items: [{
      id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
      timeSource: 'exif-offset', at: '2026-07-25T21:45:00Z', note: 'the buckle',
    }],
  };
  const result = validateManifest(old);
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/schema.test.ts -t "old manifest"`
Expected: PASS already — the reader is unchanged. This test exists to stop a
later change breaking migration.

- [ ] **Step 3: Make the changes**

- The lightbox caption writes a note with `photo` set to the item id, instead
  of `items[].note`.
- `MediaTile` shows a small chat glyph when a note references its item. Hover
  shows the text; the lightbox shows it too. **This is the discoverability
  fix** — today a caption is invisible until the lightbox is open.
- The manifest **writer** omits `notes` and `items[].note`. The **validator
  keeps accepting them**, so old files still load.
- Save produces `meanwhile-<event>.zip` containing `notes.csv`, `people.csv`
  and `manifest.json`, via `zipBytes` from Task 6.

- [ ] **Step 4: Verify the whole round trip by hand**

Load a folder, caption a photo, write a note, save the zip, unzip it beside
the photos, reload, and confirm both come back and the manifest no longer
contains them.

- [ ] **Step 5: Commit**

```bash
make check
git add -A
git commit -m "Captions become notes; the manifest stops carrying prose

A caption is a note whose photo column is filled in — one file, one editor, one
merge. A photo with a comment now shows a chat glyph, which is the
discoverability fix: until now a caption was invisible unless the lightbox was
open. Saving produces one zip of notes.csv, people.csv and manifest.json.

The validator still accepts notes[] and items[].note so old manifests load; the
writer simply stops emitting them, so a file migrates the first time it is
saved."
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `PROMPTS.md`, `TODO.md`

- [ ] **Step 1: Update each, per the documentation contract**

- `README.md` — a section on the notes file: what the columns mean, that you
  can edit it in a spreadsheet, and that several people's files merge.
- `CLAUDE.md` — the decision record: why timestamps are integers, why spans
  are ISO durations, why merging needs no version control, and the
  formula-injection and BOM rules.
- `CHANGELOG.md` — an unreleased section, paired with the owner's prompts.
- `PROMPTS.md` — append this session's prompts verbatim.
- `TODO.md` — the remote metadata repo, and full `YYYY,MM,DD,HH,MM` splitting.

- [ ] **Step 2: Commit**

```bash
make check
git add -A
git commit -m "Document notes as CSV"
```

---

## Self-review

**Spec coverage.** Every section maps to a task: the file format → Tasks 1-2;
identity and merging → Task 3; `people.csv` → Task 4; reading and migration →
Task 5; the zip → Task 6; the composer and multi-selects → Tasks 7-8; display,
the chat glyph and captions → Task 9; docs → Task 10. The "you are…" setting is
Task 8 Step 2. Formula injection, the BOM and newline handling are Task 1 and
Task 2.

**Type consistency.** `Note` is defined once in Task 2 and used unchanged
afterwards. `zipBytes` returns `Uint8Array` in both its definition and its use.
`placeNotes` changes signature once, in Task 5, with its call sites named.

**Known risk.** Task 5 changes `placeNotes` and touches `App.tsx` in three
places; if the subagent doing it cannot find all three, `make check` fails at
the type-check rather than silently.
