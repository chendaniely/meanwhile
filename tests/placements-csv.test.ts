import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_HEADERS, applyPlacements, formatPlacementsCsv, parsePlacementsCsv,
  type Placement,
} from '../src/core/placements-csv.ts';
import { parseCsv } from '../src/core/csv.ts';
import type { Item, Person } from '../src/core/schema.ts';

const DENVER = 'America/Denver';

/** A header row plus whatever body lines a test needs. */
function csv(lines: readonly string[]): string {
  return `${PLACEMENT_HEADERS.join(',')}\n${lines.join('\n')}\n`;
}

/**
 * One body line, in `PLACEMENT_HEADERS` order, from the named cells. Written
 * this way so a test can change one column and leave the rest correct.
 */
function row(cells: Readonly<Record<string, string>>): string {
  return PLACEMENT_HEADERS.map((h) => cells[h] ?? '').join(',');
}

const CLIMB = {
  item_id: 'priya/PXL_20260722_161300.jpg',
  year: '2026', month: '7', day: '22', hour: '16', minute: '13',
  tz: DENVER, utc_offset_min: '-360',
  person: 'Priya',
  schema: '1',
};

/** Every written row as a name → cell map, for assertions. */
function written(text: string): Array<Record<string, string>> {
  return parseCsv(text).rows;
}

/** A derived item, frozen so any test that mutates one fails loudly. */
function item(over: Partial<Item> & { id: string }): Item {
  return Object.freeze({
    person: 'priya',
    type: 'photo' as const,
    src: over.id,
    timeSource: 'exif-offset' as const,
    ...over,
  });
}

const PEOPLE: readonly Person[] = Object.freeze([
  Object.freeze({ id: 'priya', name: 'Priya' }),
  Object.freeze({ id: 'sam', name: 'Sam' }),
]);

describe('placements.csv — reading', () => {
  it('reads the item_id, the wall clock, the zone and the person', () => {
    const { placements, extra, preserved, problems } = parsePlacementsCsv(
      csv([row(CLIMB)]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(preserved).toEqual([]);
    // 2026-07-22 16:13 at UTC-06:00.
    expect(placements).toEqual([
      {
        itemId: 'priya/PXL_20260722_161300.jpg',
        at: '2026-07-22T22:13:00.000Z',
        person: 'Priya',
      },
    ]);
    // The invariant `PlacementsExtra` promises: one entry per placement, always.
    expect(extra).toHaveLength(placements.length);
  });

  it('reads several placements, in file order', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([
        row({ ...CLIMB, item_id: 'a.jpg' }),
        row({ ...CLIMB, item_id: 'b.jpg', hour: '17' }),
        row({ ...CLIMB, item_id: 'c.jpg', hour: '18' }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(placements.map((p) => p.itemId)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
  });

  /**
   * The row's own `utc_offset_min` is what decides the instant — a zone name
   * alone cannot say which side of a fall-back hour a wall clock means. 2026's
   * US fall-back is 01:00 on 1 November, so 01:30 is a real repeated hour:
   * -360 is the first pass (MDT) and -420 the second (MST).
   */
  it('resolves a repeated wall-clock hour by the row’s own offset', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([
        row({
          item_id: 'first.jpg', year: '2026', month: '11', day: '1', hour: '1', minute: '30',
          tz: DENVER, utc_offset_min: '-360',
        }),
        row({
          item_id: 'second.jpg', year: '2026', month: '11', day: '1', hour: '1', minute: '30',
          tz: DENVER, utc_offset_min: '-420',
        }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(placements.map((p) => p.at)).toEqual([
      '2026-11-01T07:30:00.000Z',
      '2026-11-01T08:30:00.000Z',
    ]);
  });

  it('falls back to the event timezone when a row carries no zone', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([row({ ...CLIMB, tz: '', utc_offset_min: '' })]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(placements[0]?.at).toBe('2026-07-22T22:13:00.000Z');
  });

  it('falls back to UTC when there is no zone anywhere', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([row({ ...CLIMB, tz: '', utc_offset_min: '' })]),
      undefined,
    );
    expect(problems).toEqual([]);
    expect(placements[0]?.at).toBe('2026-07-22T16:13:00.000Z');
  });

  it('trims the item_id and the person', () => {
    const { placements } = parsePlacementsCsv(
      csv([row({ ...CLIMB, item_id: '  a.jpg  ', person: '  Priya  ' })]),
      DENVER,
    );
    expect(placements[0]?.itemId).toBe('a.jpg');
    expect(placements[0]?.person).toBe('Priya');
  });

  /**
   * A spreadsheet leaves " 2026" in a cell as easily as "2026", and
   * `readCalendarParts` matches `/^\d{4}$/` — so an untrimmed cell is refused
   * as "not a whole number" for a value that is one.
   */
  it('reads integers a spreadsheet left padded with spaces', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([
        row({
          ...CLIMB,
          year: ' 2026', month: ' 7 ', minute: ' 13', utc_offset_min: ' -360 ',
        }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(placements[0]?.at).toBe('2026-07-22T22:13:00.000Z');
  });

  /**
   * The case that makes this file worth having at all: device grouping is
   * re-derived on every open, so a corrected person is destroyed silently
   * without a row here. It needs no time.
   */
  it('takes a person alone, with no time', () => {
    const { placements, preserved, problems } = parsePlacementsCsv(
      csv([
        row({
          item_id: 'a.jpg', year: '', month: '', day: '', hour: '', minute: '',
          tz: '', utc_offset_min: '', person: 'Sam',
        }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(preserved).toEqual([]);
    expect(placements[0]).toEqual({ itemId: 'a.jpg', person: 'Sam' });
    expect(placements[0]).not.toHaveProperty('at');
  });

  it('takes a time alone, with no person', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([row({ ...CLIMB, person: '' })]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(placements[0]).toEqual({
      itemId: 'priya/PXL_20260722_161300.jpg', at: '2026-07-22T22:13:00.000Z',
    });
    expect(placements[0]).not.toHaveProperty('person');
  });

  it('reads an empty file as no placements at all', () => {
    const { placements, extra, preserved, problems } = parsePlacementsCsv(
      `${PLACEMENT_HEADERS.join(',')}\n`,
      DENVER,
    );
    expect({ placements, extra, preserved, problems }).toEqual({
      placements: [], extra: [], preserved: [], problems: [],
    });
  });
});

/**
 * The rule the whole module exists for, and it bites harder here than anywhere
 * else in the set: a placement is the ONLY record of a decision somebody made
 * by hand, and no file on disk can re-derive it.
 */
describe('placements.csv — a row it cannot interpret is preserved, never dropped', () => {
  /** Parse, then write straight back, which is what a Save does. */
  function roundTrip(text: string, zone: string | undefined = DENVER) {
    const first = parsePlacementsCsv(text, zone);
    return {
      first,
      out: written(formatPlacementsCsv(first.placements, zone, first.extra, first.preserved)),
    };
  }

  it('preserves a row with no item_id, and reports it', () => {
    const { first, out } = roundTrip(csv([row({ ...CLIMB, item_id: '   ' })]));
    expect(first.placements).toEqual([]);
    expect(first.preserved).toHaveLength(1);
    expect(first.problems[0]).toContain('has no item_id');
    expect(first.problems[0]).toContain('kept exactly as it is');
    expect(out[0]?.['minute']).toBe('13');
    expect(out[0]?.['person']).toBe('Priya');
  });

  it('preserves a row whose month is 13 rather than rolling into January', () => {
    const { first, out } = roundTrip(csv([row({ ...CLIMB, month: '13' })]));
    expect(first.placements).toEqual([]);
    expect(first.problems[0]).toContain('placement "priya/PXL_20260722_161300.jpg"');
    expect(first.problems[0]).toContain('has a month of 13');
    expect(out[0]?.['month']).toBe('13');
  });

  it('preserves a row whose day does not exist in its month', () => {
    const { first } = roundTrip(csv([row({ ...CLIMB, month: '2', day: '30' })]));
    expect(first.placements).toEqual([]);
    expect(first.problems[0]).toContain('February 2026 has 28 days');
  });

  it('preserves a row missing one of the five integers', () => {
    const { first, out } = roundTrip(csv([row({ ...CLIMB, minute: '' })]));
    expect(first.placements).toEqual([]);
    expect(first.problems[0]).toContain('is missing minute');
    expect(out[0]?.['hour']).toBe('16');
  });

  it('preserves a row whose tz is an abbreviation Intl cannot resolve', () => {
    const { first, out } = roundTrip(csv([row({ ...CLIMB, tz: 'MDT', utc_offset_min: '' })]));
    expect(first.placements).toEqual([]);
    expect(first.problems[0]).toContain(
      'placement "priya/PXL_20260722_161300.jpg" could not be resolved in timezone "MDT"',
    );
    expect(out[0]?.['tz']).toBe('MDT');
  });

  it('preserves a row whose tz and utc_offset_min disagree', () => {
    const { first } = roundTrip(csv([row({ ...CLIMB, utc_offset_min: '540' })]));
    expect(first.placements).toEqual([]);
    expect(first.problems[0]).toContain('correct one of the two rather than have meanwhile pick');
  });

  /**
   * A row naming a file with nothing to say about it is somebody's
   * half-finished edit. Dropping it on the next Save would delete the half
   * they had done.
   */
  it('preserves a row that gives neither a time nor a person', () => {
    const { first, out } = roundTrip(csv([row({ item_id: 'a.jpg' })]));
    expect(first.placements).toEqual([]);
    expect(first.preserved).toHaveLength(1);
    expect(first.problems[0]).toContain('neither a time nor a person');
    expect(out[0]?.['item_id']).toBe('a.jpg');
  });

  it('keeps the good rows around a bad one', () => {
    const { first } = roundTrip(
      csv([
        row({ ...CLIMB, item_id: 'a.jpg' }),
        row({ ...CLIMB, item_id: 'broken.jpg', day: '32' }),
        row({ ...CLIMB, item_id: 'c.jpg' }),
      ]),
    );
    expect(first.placements.map((p) => p.itemId)).toEqual(['a.jpg', 'c.jpg']);
    expect(first.preserved).toHaveLength(1);
    expect(first.preserved[0]?.cells['item_id']).toBe('broken.jpg');
  });

  it('names the file and the real line, counting blank lines', () => {
    const text =
      `${PLACEMENT_HEADERS.join(',')}\n${row(CLIMB)}\n\n${row({ item_id: 'x.jpg' })}\n`;
    const { preserved, problems } = parsePlacementsCsv(text, DENVER, 'their-placements.csv');
    expect(preserved[0]?.line).toBe(4);
    expect(preserved[0]?.file).toBe('their-placements.csv');
    expect(problems[0]).toContain('their-placements.csv row 4');
  });

  it('writes preserved rows at the END, after every placement', () => {
    const { out } = roundTrip(
      csv([
        row({ ...CLIMB, item_id: 'broken.jpg', day: '32' }),
        row({ ...CLIMB, item_id: 'good.jpg' }),
      ]),
    );
    expect(out.map((r) => r['item_id'])).toEqual(['good.jpg', 'broken.jpg']);
  });

  it('brings a preserved row’s own unknown columns back with it', () => {
    const text =
      `${PLACEMENT_HEADERS.join(',')},why\n` +
      `${row({ ...CLIMB, day: '32' })},from the finish-line video\n`;
    const first = parsePlacementsCsv(text, DENVER);
    const out = formatPlacementsCsv(first.placements, DENVER, first.extra, first.preserved);
    expect(parseCsv(out).headers).toContain('why');
    expect(written(out)[0]?.['why']).toBe('from the finish-line video');
  });
});

describe('placements.csv — the per-file schema', () => {
  it('refuses a file whose row declares a newer version, naming the file', () => {
    const { placements, preserved, problems } = parsePlacementsCsv(
      csv([row(CLIMB), row({ ...CLIMB, item_id: 'b.jpg', schema: '2' })]),
      DENVER,
    );
    // Per FILE: the readable row is refused too, because a newer build may mean
    // something different by every column in the file.
    expect(placements).toEqual([]);
    expect(preserved).toHaveLength(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('placements.csv');
    expect(problems[0]).toContain('schema 2');
    expect(problems[0]).toContain('statement about the whole of it');
  });

  it('names whichever file it was handed', () => {
    const { problems } = parsePlacementsCsv(
      csv([row({ ...CLIMB, schema: '9' })]),
      DENVER,
      'their-placements.csv',
    );
    expect(problems[0]).toContain('their-placements.csv');
  });

  it('refuses a schema that is not a whole number', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([row({ ...CLIMB, schema: 'one' })]),
      DENVER,
    );
    expect(placements).toEqual([]);
    expect(problems[0]).toContain('not a whole number');
  });

  it('reads a blank schema as the version this build knows', () => {
    const { placements, problems } = parsePlacementsCsv(
      csv([row({ ...CLIMB, schema: '' })]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(placements).toHaveLength(1);
  });

  /**
   * Writing `schema,1` over a file that declared 2 would claim a version this
   * build never read and erase the only marker that made the refusal legible.
   */
  it('writes a refused file back verbatim, keeping its own schema cells', () => {
    const first = parsePlacementsCsv(csv([row({ ...CLIMB, schema: '2' })]), DENVER);
    const out = written(
      formatPlacementsCsv(first.placements, DENVER, first.extra, first.preserved),
    );
    expect(out[0]?.['schema']).toBe('2');
    expect(out[0]?.['item_id']).toBe('priya/PXL_20260722_161300.jpg');
    expect(out[0]?.['minute']).toBe('13');
    expect(out[0]?.['person']).toBe('Priya');
  });

  it('writes this build’s version on an ordinary placement', () => {
    const out = written(formatPlacementsCsv([{ itemId: 'a.jpg', person: 'Sam' }], DENVER));
    expect(out[0]?.['schema']).toBe('1');
  });
});

describe('placements.csv — writing', () => {
  const AT_PLACEMENT: Placement = { itemId: 'a.jpg', at: '2026-07-22T22:13:00.000Z' };

  it('writes the documented columns, in order', () => {
    // The literal names, NOT `[...PLACEMENT_HEADERS]` — comparing the output
    // against the same constant that produced it is a tautology.
    expect(parseCsv(formatPlacementsCsv([AT_PLACEMENT], DENVER)).headers).toEqual([
      'item_id', 'year', 'month', 'day', 'hour', 'minute',
      'tz', 'utc_offset_min', 'person', 'schema',
    ]);
    // There is no `second`, and no `time_source`: a row in this file IS a
    // manual placement, so a column saying so would only ever say one thing.
    expect(PLACEMENT_HEADERS).not.toContain('second');
    expect(PLACEMENT_HEADERS).not.toContain('time_source');
  });

  it('writes the five integers unpadded, so a spreadsheet leaves them alone', () => {
    const out = written(
      formatPlacementsCsv([{ itemId: 'a.jpg', at: '2026-07-05T07:08:00.000Z' }], 'UTC'),
    );
    expect(out[0]?.['month']).toBe('7');
    expect(out[0]?.['day']).toBe('5');
    expect(out[0]?.['hour']).toBe('7');
    expect(out[0]?.['minute']).toBe('8');
  });

  it('writes midnight as 0, never as 24', () => {
    const out = written(
      formatPlacementsCsv([{ itemId: 'a.jpg', at: '2026-07-05T00:00:00.000Z' }], 'UTC'),
    );
    expect(out[0]?.['hour']).toBe('0');
  });

  /**
   * Blanking `tz` when it matches the event's looked free and is not: change
   * `event.timezone` afterwards and every hand-placed photograph silently
   * MOVES, with nothing on the row to say which zone was meant.
   */
  it('always writes tz and utc_offset_min, even when the zone is the event’s', () => {
    const out = written(formatPlacementsCsv([AT_PLACEMENT], DENVER));
    expect(out[0]?.['tz']).toBe(DENVER);
    expect(out[0]?.['utc_offset_min']).toBe('-360');
  });

  it('writes the offset in force at THAT instant, not the event’s usual one', () => {
    const out = written(
      formatPlacementsCsv([{ itemId: 'a.jpg', at: '2026-12-22T22:13:00.000Z' }], DENVER),
    );
    // Mountain Standard Time, not the -360 a summer race would carry.
    expect(out[0]?.['utc_offset_min']).toBe('-420');
    expect(out[0]?.['hour']).toBe('15');
  });

  it('leaves all seven timestamp cells blank for a person-only placement', () => {
    const out = written(formatPlacementsCsv([{ itemId: 'a.jpg', person: 'Sam' }], DENVER));
    for (const column of ['year', 'month', 'day', 'hour', 'minute', 'tz', 'utc_offset_min']) {
      expect(out[0]?.[column]).toBe('');
    }
    expect(out[0]?.['person']).toBe('Sam');
  });

  /**
   * A name, never an id. Resolving it on the way out would put a slug the UI
   * never shows into the one file whose point is being editable by hand.
   */
  it('writes the person exactly as it was read', () => {
    const first = parsePlacementsCsv(csv([row({ ...CLIMB, person: 'Google Pixel 8 Pro' })]), DENVER);
    const out = written(formatPlacementsCsv(first.placements, DENVER));
    expect(out[0]?.['person']).toBe('Google Pixel 8 Pro');
  });

  it('leaves person blank when the placement only fixes a time', () => {
    const out = written(formatPlacementsCsv([AT_PLACEMENT], DENVER));
    expect(out[0]?.['person']).toBe('');
  });

  it('refuses to write a placement in a zone it cannot resolve, in words', () => {
    expect(() => formatPlacementsCsv([AT_PLACEMENT], 'MDT')).toThrow(
      /not a name meanwhile recognises/,
    );
  });

  it('writes a person-only placement happily even in an unresolvable zone', () => {
    // There is no wall clock to place, so the zone is never consulted.
    const out = written(formatPlacementsCsv([{ itemId: 'a.jpg', person: 'Sam' }], 'MDT'));
    expect(out[0]?.['item_id']).toBe('a.jpg');
  });

  it('refuses to write an unreadable time, in words', () => {
    expect(() => formatPlacementsCsv([{ itemId: 'a.jpg', at: 'yesterday' }], DENVER)).toThrow(
      /not a date and time meanwhile can read/,
    );
  });

  it('goes through csv.ts, so a formula-looking cell is guarded and a BOM written', () => {
    const text = formatPlacementsCsv([{ itemId: '=cmd|calc.jpg', person: 'Sam' }], DENVER);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain("'=cmd|calc.jpg");
    // And back off again on read, so the round trip is invisible to a person.
    expect(parsePlacementsCsv(text, DENVER).placements[0]?.itemId).toBe('=cmd|calc.jpg');
  });

  it('a known column always wins over an extra wearing the same name', () => {
    const out = written(
      formatPlacementsCsv([{ itemId: 'real.jpg', person: 'Sam' }], DENVER, [
        { item_id: 'fake.jpg', person: 'Nobody' },
      ]),
    );
    expect(out[0]?.['item_id']).toBe('real.jpg');
    expect(out[0]?.['person']).toBe('Sam');
  });
});

describe('placements.csv — unknown columns survive a round trip', () => {
  const WITH_EXTRA =
    `${PLACEMENT_HEADERS.join(',')},why\n` +
    `${row(CLIMB)},from the finish-line video\n` +
    `${row({ ...CLIMB, item_id: 'b.jpg', hour: '17' })},\n`;

  it('keeps an unknown column, including a blank one, aligned per placement', () => {
    const first = parsePlacementsCsv(WITH_EXTRA, DENVER);
    expect(first.problems).toEqual([]);
    expect(first.extra).toEqual([{ why: 'from the finish-line video' }, { why: '' }]);

    const out = formatPlacementsCsv(first.placements, DENVER, first.extra, first.preserved);
    expect(written(out)[0]?.['why']).toBe('from the finish-line video');

    const second = parsePlacementsCsv(out, DENVER);
    expect(second.extra).toEqual(first.extra);
    expect(second.placements).toEqual(first.placements);
  });

  it('writes unknown columns after the known ones and before schema', () => {
    const first = parsePlacementsCsv(WITH_EXTRA, DENVER);
    const headers = parseCsv(
      formatPlacementsCsv(first.placements, DENVER, first.extra, first.preserved),
    ).headers;
    expect(headers.indexOf('why')).toBeGreaterThan(headers.indexOf('person'));
    expect(headers[headers.length - 1]).toBe('schema');
  });

  it('gives every placement an extra entry, so the two arrays stay aligned', () => {
    const { placements, extra } = parsePlacementsCsv(
      csv([row(CLIMB), row({ ...CLIMB, item_id: 'b.jpg' })]),
      DENVER,
    );
    expect(extra).toHaveLength(placements.length);
    expect(extra).toEqual([{}, {}]);
  });
});

describe('placements.csv — round trips', () => {
  const FULL =
    `${PLACEMENT_HEADERS.join(',')},why\n` +
    `${row(CLIMB)},from the finish-line video\n` +
    `${row({ item_id: 'b.jpg', person: 'Sam' })},\n` +
    `${row({ ...CLIMB, item_id: 'broken.jpg', day: '32' })},\n`;

  it('parse → format → parse is identity, and writing again is a fixed point', () => {
    const first = parsePlacementsCsv(FULL, DENVER);
    expect(first.placements).toHaveLength(2);
    expect(first.preserved).toHaveLength(1);

    const out = formatPlacementsCsv(first.placements, DENVER, first.extra, first.preserved);
    const second = parsePlacementsCsv(out, DENVER);
    expect(second.placements).toEqual(first.placements);
    expect(second.extra).toEqual(first.extra);
    // The CELLS, not the whole `PreservedRow`: a preserved row is written at
    // the end of the file, so its `line` legitimately moves. What must not
    // change is a single character of what it says.
    expect(second.preserved.map((p) => p.cells)).toEqual(first.preserved.map((p) => p.cells));
    expect(second.problems).toEqual(first.problems);

    expect(formatPlacementsCsv(second.placements, DENVER, second.extra, second.preserved)).toBe(out);
  });

  it('round-trips an item_id carrying a comma and a quote', () => {
    const itemId = 'priya/holiday, the "good" one.jpg';
    const text = formatPlacementsCsv([{ itemId, person: 'Sam' }], DENVER);
    expect(parsePlacementsCsv(text, DENVER).placements[0]?.itemId).toBe(itemId);
  });

  it('round-trips a person carrying NFC-sensitive text, composed', () => {
    // "José" decomposed: e + U+0301. `csv.ts` normalises every cell it writes,
    // which is what makes two spellings of one name compare equal anywhere.
    const text = formatPlacementsCsv([{ itemId: 'a.jpg', person: 'José' }], DENVER);
    expect(written(text)[0]?.['person']).toBe('José');
    expect(parsePlacementsCsv(text, DENVER).placements[0]?.person).toBe('José');
  });

  it('reads a file written with CRLF line endings', () => {
    // The assertion is on an unknown column, deliberately. Every KNOWN cell is
    // read through `nonEmpty` or `.trim()`, so a stray `\r` on the end of a
    // line would be silently absorbed and the test could not fail. An unknown
    // column is the one path that keeps a value verbatim.
    const text = (
      `${PLACEMENT_HEADERS.join(',')},why\n${row(CLIMB)},from the video\n`
    ).replace(/\n/g, '\r\n');
    const { placements, extra, problems } = parsePlacementsCsv(text, DENVER);
    expect(problems).toEqual([]);
    expect(placements[0]?.at).toBe('2026-07-22T22:13:00.000Z');
    expect(extra).toEqual([{ why: 'from the video' }]);
  });

  it('reads a file with no BOM and writes one', () => {
    const text = csv([row(CLIMB)]);
    expect(text.startsWith('﻿')).toBe(false);
    const first = parsePlacementsCsv(text, DENVER);
    expect(first.placements).toHaveLength(1);
    expect(formatPlacementsCsv(first.placements, DENVER).startsWith('﻿')).toBe(true);
  });

  it('writes an empty file when there is nothing to write', () => {
    const out = formatPlacementsCsv([], DENVER);
    expect(parseCsv(out).rows).toEqual([]);
    expect(parsePlacementsCsv(out, DENVER)).toEqual({
      placements: [], extra: [], preserved: [], problems: [],
    });
  });
});

describe('applyPlacements — joining a row to a file', () => {
  const ITEMS: readonly Item[] = Object.freeze([
    item({ id: 'priya/a.jpg', at: '2026-07-22T10:00:00Z' }),
    item({ id: 'sam/b.jpg', person: 'sam', at: '2026-07-22T11:00:00Z' }),
  ]);

  it('applies a time by exact item_id, as a manual placement', () => {
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'priya/a.jpg', at: '2026-07-22T22:13:00.000Z' }],
      PEOPLE,
    );
    expect(problems).toEqual([]);
    expect(items[0]?.at).toBe('2026-07-22T22:13:00.000Z');
    // The whole point: the author's time must outrank every device source and
    // must never have that person's clockOffset applied to it.
    expect(items[0]?.timeSource).toBe('manual');
    expect(items[1]).toBe(ITEMS[1]);
  });

  it('applies a person by exact item_id, leaving the time source alone', () => {
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'priya/a.jpg', person: 'Sam' }],
      PEOPLE,
    );
    expect(problems).toEqual([]);
    expect(items[0]?.person).toBe('sam');
    expect(items[0]?.at).toBe('2026-07-22T10:00:00Z');
    expect(items[0]?.timeSource).toBe('exif-offset');
  });

  /**
   * The documented hole this closes: an item's id is its relative path, so a
   * folder reorganisation orphans every manual placement. Notes survive a
   * reorg because they join photographs by basename; so does this.
   */
  it('falls back to an unambiguous basename, and says that it did', () => {
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'old-folder/a.jpg', at: '2026-07-22T22:13:00.000Z' }],
      PEOPLE,
    );
    expect(items[0]?.at).toBe('2026-07-22T22:13:00.000Z');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('nothing in this folder is at "old-folder/a.jpg"');
    expect(problems[0]).toContain('"priya/a.jpg"');
  });

  /**
   * Two phones both produce `PXL_20260822_131204.jpg`. Attaching somebody's
   * hand-placed time to the wrong photograph is worse than leaving the row
   * unapplied — the same call `resolveNotePhotos` makes for a note's `photo`.
   */
  it('refuses an ambiguous basename rather than guessing, and applies nothing', () => {
    const ambiguous: readonly Item[] = Object.freeze([
      item({ id: 'priya/PXL_1.jpg', at: '2026-07-22T10:00:00Z' }),
      item({ id: 'sam/PXL_1.jpg', person: 'sam', at: '2026-07-22T11:00:00Z' }),
    ]);
    const { items, problems } = applyPlacements(
      ambiguous,
      [{ itemId: 'PXL_1.jpg', at: '2026-07-22T22:13:00.000Z' }],
      PEOPLE,
    );
    expect(items).toEqual([...ambiguous]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 files are called "PXL_1.jpg"');
    expect(problems[0]).toContain('priya/PXL_1.jpg, sam/PXL_1.jpg');
    expect(problems[0]).toContain('will not guess');
  });

  it('prefers an exact path over a basename that several files share', () => {
    const ambiguous: readonly Item[] = Object.freeze([
      item({ id: 'priya/PXL_1.jpg', at: '2026-07-22T10:00:00Z' }),
      item({ id: 'sam/PXL_1.jpg', person: 'sam', at: '2026-07-22T11:00:00Z' }),
    ]);
    const { items, problems } = applyPlacements(
      ambiguous,
      [{ itemId: 'sam/PXL_1.jpg', at: '2026-07-22T22:13:00.000Z' }],
      PEOPLE,
    );
    expect(problems).toEqual([]);
    expect(items[0]).toBe(ambiguous[0]);
    expect(items[1]?.at).toBe('2026-07-22T22:13:00.000Z');
  });

  /**
   * Deleting somebody's correction because they opened the wrong folder is the
   * failure this project keeps legislating against. The row lives in the
   * `Placement[]` the writer is handed, so it is written straight back.
   */
  it('reports an item_id matching nothing, and disturbs no item', () => {
    const placements: Placement[] = [{ itemId: 'gone/x.jpg', at: '2026-07-22T22:13:00.000Z' }];
    const { items, problems } = applyPlacements(ITEMS, placements, PEOPLE);
    expect(items).toEqual([...ITEMS]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('nothing in this folder matches "gone/x.jpg"');
    expect(problems[0]).toContain('kept and written back');
    // The unapplied row is still in the list the writer is handed.
    expect(placements).toHaveLength(1);
  });

  it('names whichever file it was told about', () => {
    const { problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'gone.jpg', person: 'Sam' }],
      PEOPLE,
      { file: 'their-placements.csv' },
    );
    expect(problems[0]).toContain('their-placements.csv');
  });

  it('applies nothing and reports nothing when there are no placements', () => {
    const { items, problems } = applyPlacements(ITEMS, [], PEOPLE);
    expect(problems).toEqual([]);
    expect(items).toEqual([...ITEMS]);
  });
});

describe('applyPlacements — the person must resolve to somebody this event names', () => {
  const ITEMS: readonly Item[] = Object.freeze([
    item({ id: 'a.jpg', at: '2026-07-22T10:00:00Z' }),
  ]);

  it('resolves an alias, so a rename does not orphan the row', () => {
    const renamed: readonly Person[] = [
      { id: 'priya', name: 'Priya', alsoKnownAs: ['Google Pixel 8 Pro'] },
    ];
    const { items, problems } = applyPlacements(
      [item({ id: 'a.jpg', person: 'sam', at: '2026-07-22T10:00:00Z' })],
      [{ itemId: 'a.jpg', person: 'Google Pixel 8 Pro' }],
      renamed,
    );
    expect(problems).toEqual([]);
    expect(items[0]?.person).toBe('priya');
  });

  it('matches a name case-insensitively', () => {
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'a.jpg', person: 'sAm' }],
      PEOPLE,
    );
    expect(problems).toEqual([]);
    expect(items[0]?.person).toBe('sam');
  });

  /**
   * The union, not the roster alone. Correcting a photograph onto a device lane
   * `people.csv` has never been told about is an ordinary thing to want, and
   * that lane's label is `displayNameFor(id)` — what the swimlanes show.
   */
  it('accepts a person the items were derived onto but the roster never named', () => {
    const derived: readonly Item[] = Object.freeze([
      item({ id: 'a.jpg', person: 'sam', at: '2026-07-22T10:00:00Z' }),
      item({ id: 'b.jpg', person: 'google-pixel-8-pro', at: '2026-07-22T11:00:00Z' }),
    ]);
    const { items, problems } = applyPlacements(
      derived,
      [{ itemId: 'a.jpg', person: 'Google Pixel 8 Pro' }],
      [{ id: 'sam', name: 'Sam' }],
    );
    expect(problems).toEqual([]);
    expect(items[0]?.person).toBe('google-pixel-8-pro');
  });

  /**
   * Carrying an unresolved name through as an id produces a manifest
   * `validateManifest` refuses outright, and a photograph with no lane colour
   * at all — `assignLaneColors` has no entry for an id not in
   * `manifest.people`.
   */
  it('leaves the derived person standing when the name matches nobody, and says so', () => {
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'a.jpg', person: 'Nobody' }],
      PEOPLE,
    );
    expect(items[0]?.person).toBe('priya');
    // Nothing corrected it, so the very same object comes back.
    expect(items[0]).toBe(ITEMS[0]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"Nobody"');
    expect(problems[0]).toContain('does not name exactly one person');
    // The lane it stays on is named, so the message says what actually happened.
    expect(problems[0]).toContain('Priya');
  });

  /**
   * `resolvePersonNames` never guesses between two people who share a key —
   * silently attaching a correction to the wrong person is worse than leaving
   * it unapplied.
   */
  it('leaves the derived person standing when two people answer to the name', () => {
    const contested: readonly Person[] = [
      { id: 'p1', name: 'Bob' },
      { id: 'p2', name: 'Rob', alsoKnownAs: ['Bob'] },
    ];
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'a.jpg', person: 'Bob' }],
      contested,
    );
    expect(items[0]?.person).toBe('priya');
    expect(problems[0]).toContain('never guessed at either');
  });

  /**
   * The two corrections in a row are independent: an unresolvable name must not
   * throw away a perfectly good hand-placed time sitting beside it.
   */
  it('still applies the time when only the person fails to resolve', () => {
    const { items, problems } = applyPlacements(
      ITEMS,
      [{ itemId: 'a.jpg', at: '2026-07-22T22:13:00.000Z', person: 'Nobody' }],
      PEOPLE,
    );
    expect(items[0]?.at).toBe('2026-07-22T22:13:00.000Z');
    expect(items[0]?.timeSource).toBe('manual');
    expect(items[0]?.person).toBe('priya');
    expect(problems).toHaveLength(1);
  });
});

describe('applyPlacements — redundancy, duplicates, and not mutating anything', () => {
  it('reports a correction that changes nothing, and never deletes it', () => {
    const items: readonly Item[] = Object.freeze([
      item({ id: 'a.jpg', at: '2026-07-22T10:00:00Z' }),
      item({ id: 'b.jpg', at: '2026-07-22T11:00:00Z' }),
    ]);
    const placements: Placement[] = [
      { itemId: 'a.jpg', person: 'Priya' },
      { itemId: 'b.jpg', person: 'Priya' },
    ];
    const { problems } = applyPlacements(items, placements, PEOPLE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 rows correct nothing');
    expect(problems[0]).toContain('a.jpg, b.jpg');
    expect(problems[0]).toContain('will not do it for you');
    // Reported, never removed: the list the writer is handed is untouched.
    expect(placements).toHaveLength(2);
  });

  it('says it in the singular for one row', () => {
    const { problems } = applyPlacements(
      [item({ id: 'a.jpg', at: '2026-07-22T10:00:00Z' })],
      [{ itemId: 'a.jpg', person: 'Priya' }],
      PEOPLE,
    );
    expect(problems[0]).toContain('one row corrects nothing');
  });

  it('calls a real correction real, and says nothing about it', () => {
    const { problems } = applyPlacements(
      [item({ id: 'a.jpg', at: '2026-07-22T10:00:00Z' })],
      [{ itemId: 'a.jpg', person: 'Sam' }],
      PEOPLE,
    );
    expect(problems).toEqual([]);
  });

  it('calls a time redundant only when the item already holds it AS a manual placement', () => {
    const already = item({
      id: 'a.jpg', at: '2026-07-22T22:13:00.000Z', timeSource: 'manual',
    });
    const { problems } = applyPlacements(
      [already],
      [{ itemId: 'a.jpg', at: '2026-07-22T22:13:00.000Z' }],
      PEOPLE,
    );
    expect(problems[0]).toContain('one row corrects nothing');
  });

  /**
   * Applying the row flips `timeSource` to `manual`, which stops that person's
   * `clockOffset` being applied — so deleting it would MOVE the photograph, and
   * calling it redundant would be false.
   */
  it('does not call a time redundant when the same instant came from the file', () => {
    const derived = item({
      id: 'a.jpg', at: '2026-07-22T22:13:00.000Z', timeSource: 'exif-offset',
    });
    const { items, problems } = applyPlacements(
      [derived],
      [{ itemId: 'a.jpg', at: '2026-07-22T22:13:00.000Z' }],
      PEOPLE,
    );
    expect(problems).toEqual([]);
    expect(items[0]?.timeSource).toBe('manual');
  });

  /**
   * "You can delete this" must not be said about a row that is also carrying a
   * name nobody could resolve — the row still has an unfinished half in it.
   */
  it('does not call a row redundant when its person failed to resolve', () => {
    const already = item({
      id: 'a.jpg', at: '2026-07-22T22:13:00.000Z', timeSource: 'manual',
    });
    const { problems } = applyPlacements(
      [already],
      [{ itemId: 'a.jpg', at: '2026-07-22T22:13:00.000Z', person: 'Nobody' }],
      PEOPLE,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not name exactly one person');
  });

  it('reports two rows correcting the same file, and lets the last one win', () => {
    const { items, problems } = applyPlacements(
      [item({ id: 'a.jpg', at: '2026-07-22T10:00:00Z' })],
      [
        { itemId: 'a.jpg', at: '2026-07-22T20:00:00.000Z' },
        { itemId: 'a.jpg', at: '2026-07-22T21:00:00.000Z' },
      ],
      PEOPLE,
    );
    expect(items[0]?.at).toBe('2026-07-22T21:00:00.000Z');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 rows correct "a.jpg"');
    expect(problems[0]).toContain('the last of them wins');
  });

  it('counts two rows that reach one file by different names as duplicates', () => {
    const { problems } = applyPlacements(
      [item({ id: 'priya/a.jpg', at: '2026-07-22T10:00:00Z' })],
      [
        { itemId: 'priya/a.jpg', at: '2026-07-22T20:00:00.000Z' },
        { itemId: 'old/a.jpg', at: '2026-07-22T21:00:00.000Z' },
      ],
      PEOPLE,
    );
    expect(problems.some((p) => p.includes('2 rows correct "priya/a.jpg"'))).toBe(true);
  });

  it('mutates neither the items nor the placements it is given', () => {
    // The items are frozen by `item()`, so an in-place write throws in strict
    // mode; the snapshots catch anything that reorders or replaces instead.
    const items: readonly Item[] = Object.freeze([
      item({ id: 'a.jpg', at: '2026-07-22T10:00:00Z' }),
      item({ id: 'b.jpg', person: 'sam', at: '2026-07-22T11:00:00Z' }),
    ]);
    const placements: readonly Placement[] = [
      { itemId: 'a.jpg', at: '2026-07-22T22:13:00.000Z', person: 'Sam' },
    ];
    const itemsBefore = JSON.stringify(items);
    const placementsBefore = JSON.stringify(placements);

    const { items: next } = applyPlacements(items, placements, PEOPLE);

    expect(JSON.stringify(items)).toBe(itemsBefore);
    expect(JSON.stringify(placements)).toBe(placementsBefore);
    expect(next).not.toBe(items);
    expect(next[0]).not.toBe(items[0]);
    expect(next[0]?.person).toBe('sam');
  });

  it('reads a whole file and applies it, which is the wiring a later task does', () => {
    const items: readonly Item[] = Object.freeze([
      item({ id: 'priya/PXL_20260722_161300.jpg', person: 'sam', timeSource: 'none' }),
    ]);
    const { placements } = parsePlacementsCsv(csv([row(CLIMB)]), DENVER);
    const applied = applyPlacements(items, placements, PEOPLE);
    expect(applied.problems).toEqual([]);
    expect(applied.items[0]).toEqual({
      id: 'priya/PXL_20260722_161300.jpg',
      person: 'priya',
      type: 'photo',
      src: 'priya/PXL_20260722_161300.jpg',
      timeSource: 'manual',
      at: '2026-07-22T22:13:00.000Z',
    });
  });
});
