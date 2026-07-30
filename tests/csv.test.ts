import { describe, expect, it } from 'vitest';
import { CSV_SCHEMA, formatCsv, nfc, parseCsv, schemaCellProblem } from '../src/core/csv.ts';

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

  /**
   * `rowLines` carries each surviving record's REAL 1-indexed line in the
   * file, which is the whole reason it exists: `parsePeopleCsv` and
   * `mergeNotes` quote it back to someone who is going to open the file in a
   * spreadsheet and jump to the row that is wrong. Counting position in
   * `rows` instead understates it, and the cases below are exactly where a
   * hand-rolled line counter goes wrong — each is silent, and none would be
   * caught by any other assertion in this suite.
   */
  it('numbers a row by its real line, skipping the blank lines it dropped', () => {
    expect(parseCsv('a\n1\n\n2\n').rowLines).toEqual([2, 4]);
  });

  it('numbers a row past the lines a quoted field consumed', () => {
    // The first record opens on line 2 and its quoted field swallows line 3,
    // so the next record is line 4 — not line 3. This is the assertion that
    // fails if the counter stops looking inside quotes.
    expect(parseCsv('a,b\n"x, y","one\ntwo"\n3,4\n').rowLines).toEqual([2, 4]);
  });

  it('does not double-count the LF of a CRLF ending', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4\r\n').rowLines).toEqual([2, 3]);
  });

  it('does not count the byte-order mark as a line', () => {
    expect(parseCsv('﻿a\n1\n').rowLines).toEqual([2]);
  });

  it('pads a short row with blank cells', () => {
    const table = parseCsv('a,b,c\n1\n');
    expect(table.rows[0]).toEqual({ a: '1', b: '', c: '' });
  });

  // Named for what it actually asserts, unlike its predecessor: an
  // over-long row's extra fields are dropped, not kept "addressable" as the
  // old name claimed. Worth pinning as a documented fact now that it can
  // actually matter — `formatCsv(headers, rows)` only ever emits `headers`,
  // so a header set that has fallen behind a row's real fields (see
  // `noteHeadersFor`) silently loses whatever spilled past it.
  it('drops any field beyond the header count in an over-long row', () => {
    const table = parseCsv('a,b\n1,2,3\n');
    expect(table.rows[0]).toEqual({ a: '1', b: '2' });
  });

  it('removes the apostrophe that guards a formula', () => {
    expect(parseCsv("a\n'=1+1\n").rows[0]?.a).toBe('=1+1');
  });

  it('unguards a header the same way it unguards a cell', () => {
    // `formatCsv` guards a header exactly like any other cell
    // (`headers.map(cell)`), so a header must be unguarded symmetrically or
    // a round-tripped formula-like column name comes back with a leading
    // apostrophe baked into its name.
    const out = formatCsv(['=col', 'b'], [{ '=col': 'x', b: 'y' }]);
    expect(parseCsv(out).headers).toEqual(['=col', 'b']);
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

/**
 * The guard used to be `/^['=+\-@]/`, anchored at character zero — and Excel
 * and LibreOffice STRIP leading whitespace before deciding whether a cell is a
 * formula. A CSV field can carry a TAB or a CR quite legally, so
 * `\t=cmd|'/c calc'!A0` sailed straight through: found by a security review
 * round-tripping it unguarded through an unknown `notes.csv` column, which is
 * the realistic path (`rowToNote` trims `text`, but every column this app does
 * not know the meaning of is written back exactly as it arrived). The owner
 * merges a crew member's file, saves, opens the result in Excel, and the DDE
 * payload runs.
 *
 * The guard belongs here in `csv.ts` rather than in each writer precisely so
 * one fix covers `notes*.csv`, `people.csv`, and anything written later.
 */
describe('formula guard: leading whitespace does not get a cell past it', () => {
  const HOSTILE = [
    '\t=cmd|\'/c calc\'!A0',
    '\r=1+1',
    '\n=1+1',
    ' =HYPERLINK("http://evil","click")',
    '\t\t@SUM(A1)',
    '  +1',
    '\t-2+3+cmd|\' /C calc\'!A0',
  ];

  for (const hostile of HOSTILE) {
    it(`guards ${JSON.stringify(hostile)} and still round-trips it exactly`, () => {
      const text = formatCsv(['a'], [{ a: hostile }]);
      // The guard is what a spreadsheet sees: an apostrophe before anything
      // it could mistake for a formula.
      expect(text).toContain(`'${hostile.replace(/"/g, '""')}`);
      // ...and the round trip stays lossless, which is the constraint that
      // makes guarding safe to do unconditionally.
      expect(parseCsv(text).rows[0]?.a).toBe(hostile);
    });
  }

  it('leaves a legitimate -PT4S clock offset readable after the round trip', () => {
    // `people.csv` writes an ISO-8601 duration here, and a negative one starts
    // with `-`. It is guarded (it always was) and must come back byte-exact.
    const text = formatCsv(['clock_offset'], [{ clock_offset: '-PT4S' }]);
    expect(parseCsv(text).rows[0]?.clock_offset).toBe('-PT4S');
  });

  it("leaves a name that genuinely starts with an apostrophe exactly as typed", () => {
    const text = formatCsv(['name'], [{ name: "'Bear' Malone" }]);
    expect(parseCsv(text).rows[0]?.name).toBe("'Bear' Malone");
  });

  it('does not guard text that merely contains a formula character later on', () => {
    const text = formatCsv(['text'], [{ text: 'mile 60 = the wall' }]);
    expect(text).not.toContain("'mile 60");
    expect(parseCsv(text).rows[0]?.text).toBe('mile 60 = the wall');
  });

  it('leaves an all-whitespace cell alone', () => {
    const text = formatCsv(['a'], [{ a: ' \t ' }]);
    expect(parseCsv(text).rows[0]?.a).toBe(' \t ');
  });
});

/**
 * `José` composed (U+00E9) and `José` decomposed (e + U+0301) render
 * identically and compare unequal as JavaScript strings — verified in both
 * directions against `resolvePersonNames`, which matched neither against the
 * other. Everything this app writes is normalised here; the comparisons in
 * `people-csv.ts` normalise both sides so a file written elsewhere matches
 * too.
 */
describe('NFC normalisation', () => {
  // Written as escapes, not as literal characters: the two are visually
  // identical, so a source file that got normalised by an editor would make
  // this whole block pass vacuously.
  const COMPOSED = 'Jos\u00e9';
  const DECOMPOSED = 'Jose\u0301';

  it('writes a decomposed name in composed form', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    const text = formatCsv(['name'], [{ name: DECOMPOSED }]);
    expect(parseCsv(text).rows[0]?.name).toBe(COMPOSED);
  });

  it('normalises headers too, so a column name still matches on read', () => {
    const text = formatCsv([DECOMPOSED], [{ [DECOMPOSED]: 'x' }]);
    expect(parseCsv(text).headers).toEqual([COMPOSED]);
  });

  it('leaves an already-composed name exactly as it was', () => {
    expect(nfc(COMPOSED)).toBe(COMPOSED);
  });
});

describe('schemaCellProblem', () => {
  it('accepts a blank cell, which means "the version this reader knows"', () => {
    expect(schemaCellProblem('', 'notes.csv')).toBeNull();
    expect(schemaCellProblem(undefined, 'notes.csv')).toBeNull();
  });

  it('accepts the current version and anything older', () => {
    expect(schemaCellProblem(String(CSV_SCHEMA), 'notes.csv')).toBeNull();
    expect(schemaCellProblem('0', 'notes.csv')).toBeNull();
  });

  it('refuses a newer version, naming the file and what to do about it', () => {
    const problem = schemaCellProblem(String(CSV_SCHEMA + 1), 'people.csv');
    expect(problem).toContain('people.csv');
    expect(problem).toContain('update the site');
  });

  it('refuses a version that is not a whole number rather than guessing', () => {
    expect(schemaCellProblem('1.5', 'notes.csv')).toContain('not a whole number');
    expect(schemaCellProblem('one', 'notes.csv')).toContain('not a whole number');
  });
});
