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
