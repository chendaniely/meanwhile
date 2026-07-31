import { describe, expect, it } from 'vitest';
import {
  MARKER_HEADERS, formatMarkersCsv, parseMarkersCsv,
} from '../src/core/markers-csv.ts';
import { parseCsv } from '../src/core/csv.ts';
import type { Marker } from '../src/core/schema.ts';

const DENVER = 'America/Denver';

/** A header row plus whatever body lines a test needs. */
function csv(lines: readonly string[]): string {
  return `${MARKER_HEADERS.join(',')}\n${lines.join('\n')}\n`;
}

/**
 * One body line, in `MARKER_HEADERS` order, from the named cells. Written this
 * way so a test can change one column and leave the rest correct.
 */
function row(cells: Readonly<Record<string, string>>): string {
  return MARKER_HEADERS.map((h) => cells[h] ?? '').join(',');
}

const COTTONWOOD = {
  label: 'Cottonwood',
  year: '2026', month: '7', day: '22', hour: '16', minute: '13',
  tz: DENVER, utc_offset_min: '-360',
  distance_m: '32100',
  schema: '1',
};

/** Every written row as a name → cell map, for assertions. */
function written(text: string): Array<Record<string, string>> {
  return parseCsv(text).rows;
}

describe('markers.csv — reading', () => {
  it('reads the label, the wall clock, the zone and the distance', () => {
    const { markers, extra, preserved, problems } = parseMarkersCsv(
      csv([row(COTTONWOOD)]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(preserved).toEqual([]);
    // 2026-07-22 16:13 at UTC-06:00.
    expect(markers).toEqual([
      { label: 'Cottonwood', at: '2026-07-22T22:13:00.000Z', atDistance: 32100 },
    ]);
    // The invariant `MarkersExtra` promises: one entry per marker, always.
    expect(extra).toHaveLength(markers.length);
  });

  it('reads several markers, in file order', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([
        row({ ...COTTONWOOD, label: 'Start', hour: '6', minute: '0', distance_m: '0' }),
        row(COTTONWOOD),
        row({ ...COTTONWOOD, label: 'Finish', day: '23', hour: '15', distance_m: '168700' }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(markers.map((m) => m.label)).toEqual(['Start', 'Cottonwood', 'Finish']);
  });

  /**
   * The row's own `utc_offset_min` is what decides the instant — a zone name
   * alone cannot say which side of a fall-back hour a wall clock means. 2026's
   * US fall-back is 01:00 on 1 November, so 01:30 is a real repeated hour:
   * -360 is the first pass (MDT) and -420 the second (MST).
   */
  it('resolves a repeated wall-clock hour by the row’s own offset', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([
        row({
          label: 'First pass', year: '2026', month: '11', day: '1', hour: '1', minute: '30',
          tz: DENVER, utc_offset_min: '-360',
        }),
        row({
          label: 'Second pass', year: '2026', month: '11', day: '1', hour: '1', minute: '30',
          tz: DENVER, utc_offset_min: '-420',
        }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(markers.map((m) => m.at)).toEqual([
      '2026-11-01T07:30:00.000Z',
      '2026-11-01T08:30:00.000Z',
    ]);
  });

  it('falls back to the event timezone when a row carries no zone', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, tz: '', utc_offset_min: '' })]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(markers[0]?.at).toBe('2026-07-22T22:13:00.000Z');
  });

  it('falls back to UTC when there is no zone anywhere', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, tz: '', utc_offset_min: '' })]),
      undefined,
    );
    expect(problems).toEqual([]);
    expect(markers[0]?.at).toBe('2026-07-22T16:13:00.000Z');
  });

  /**
   * A spreadsheet leaves " 2026" in a cell as easily as "2026", and
   * `readCalendarParts` matches `/^\d{4}$/` — so an untrimmed cell is refused
   * as "not a whole number" for a value that is one.
   */
  it('reads integers a spreadsheet left padded with spaces', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([
        row({
          ...COTTONWOOD,
          year: ' 2026', month: ' 7 ', minute: ' 13', utc_offset_min: ' -360 ',
          distance_m: ' 32100 ',
        }),
      ]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(markers[0]).toEqual({
      label: 'Cottonwood', at: '2026-07-22T22:13:00.000Z', atDistance: 32100,
    });
  });

  it('trims the label', () => {
    const { markers } = parseMarkersCsv(csv([row({ ...COTTONWOOD, label: '  Cottonwood  ' })]), DENVER);
    expect(markers[0]?.label).toBe('Cottonwood');
  });

  it('takes a time alone, with no distance', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, distance_m: '' })]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(markers[0]).toEqual({ label: 'Cottonwood', at: '2026-07-22T22:13:00.000Z' });
    expect(markers[0]).not.toHaveProperty('atDistance');
  });

  it('takes a distance alone, with no time', () => {
    const { markers, preserved } = parseMarkersCsv(
      csv([
        row({
          label: 'Summit', year: '', month: '', day: '', hour: '', minute: '',
          tz: '', utc_offset_min: '', distance_m: '72400',
        }),
      ]),
      DENVER,
    );
    expect(preserved).toEqual([]);
    expect(markers[0]).toEqual({ label: 'Summit', atDistance: 72400 });
    expect(markers[0]).not.toHaveProperty('at');
  });

  /**
   * The start line is a real marker at a real distance. A falsy check on the
   * cell drops it silently, which is exactly the bug this pins.
   */
  it('keeps a distance_m of 0 as 0, not as absent', () => {
    const { markers } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, distance_m: '0' })]),
      DENVER,
    );
    expect(markers[0]?.atDistance).toBe(0);
  });

  it('reads a fractional distance', () => {
    const { markers } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, distance_m: '32100.75' })]),
      DENVER,
    );
    expect(markers[0]?.atDistance).toBe(32100.75);
  });

  /**
   * `validateManifest` permits both fields together, and this format must not
   * quietly tighten what the manifest allows.
   */
  it('allows a time and a distance on the same marker', () => {
    const { markers, problems } = parseMarkersCsv(csv([row(COTTONWOOD)]), DENVER);
    expect(problems).toEqual([]);
    expect(markers[0]?.at).toBeDefined();
    expect(markers[0]?.atDistance).toBeDefined();
  });
});

/**
 * The rule the whole module exists for: a row this build cannot interpret is
 * reported AND written back, because refusing to read it is not permission to
 * delete it.
 */
describe('markers.csv — a row it cannot interpret is preserved, never dropped', () => {
  /** Parse, then write straight back, which is what a Save does. */
  function roundTrip(text: string, zone: string | undefined = DENVER) {
    const first = parseMarkersCsv(text, zone);
    return {
      first,
      out: written(formatMarkersCsv(first.markers, zone, first.extra, first.preserved)),
    };
  }

  it('preserves a row with no label, and reports it', () => {
    const { first, out } = roundTrip(csv([row({ ...COTTONWOOD, label: '   ' })]));
    expect(first.markers).toEqual([]);
    expect(first.preserved).toHaveLength(1);
    expect(first.problems[0]).toContain('has no label');
    expect(first.problems[0]).toContain('kept exactly as it is');
    expect(out[0]?.['minute']).toBe('13');
    expect(out[0]?.['distance_m']).toBe('32100');
  });

  it('preserves a row whose month is 13 rather than rolling into January', () => {
    const { first, out } = roundTrip(csv([row({ ...COTTONWOOD, month: '13' })]));
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('marker "Cottonwood" has a month of 13');
    expect(out[0]?.['month']).toBe('13');
  });

  it('preserves a row whose day does not exist in its month', () => {
    const { first } = roundTrip(csv([row({ ...COTTONWOOD, month: '2', day: '30' })]));
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('February 2026 has 28 days');
  });

  it('preserves a row missing one of the five integers', () => {
    const { first, out } = roundTrip(csv([row({ ...COTTONWOOD, minute: '' })]));
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('is missing minute');
    expect(out[0]?.['hour']).toBe('16');
  });

  it('preserves a row whose tz is an abbreviation Intl cannot resolve', () => {
    const { first, out } = roundTrip(
      csv([row({ ...COTTONWOOD, tz: 'MDT', utc_offset_min: '' })]),
    );
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('could not be resolved in timezone "MDT"');
    expect(out[0]?.['tz']).toBe('MDT');
  });

  it('preserves a row whose tz and utc_offset_min disagree', () => {
    const { first } = roundTrip(csv([row({ ...COTTONWOOD, utc_offset_min: '540' })]));
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('correct one of the two rather than have meanwhile pick');
  });

  it('preserves a non-numeric distance_m rather than reading it as zero', () => {
    const { first, out } = roundTrip(csv([row({ ...COTTONWOOD, distance_m: 'about 32k' })]));
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('distance_m of "about 32k"');
    expect(out[0]?.['distance_m']).toBe('about 32k');
  });

  /**
   * `NaN` is `typeof 'number'`, so `validateManifest`'s only check on this
   * field passes — and `JSON.stringify` then writes it as `null`, which the
   * same validator refuses on the next open, taking the whole manifest with it.
   */
  it.each(['Infinity', '1e999', '0x10', '1_000'])(
    'preserves a distance_m of %s rather than producing a non-finite number',
    (cell) => {
      const { markers, preserved } = parseMarkersCsv(
        csv([row({ ...COTTONWOOD, distance_m: cell })]),
        DENVER,
      );
      expect(markers).toEqual([]);
      expect(preserved).toHaveLength(1);
      expect(preserved[0]?.cells['distance_m']).toBe(cell);
    },
  );

  it('preserves a row that gives neither a time nor a distance', () => {
    const { first, out } = roundTrip(csv([row({ label: 'Somewhere' })]));
    expect(first.markers).toEqual([]);
    expect(first.problems[0]).toContain('neither a time nor a distance_m');
    expect(out[0]?.['label']).toBe('Somewhere');
  });

  it('keeps the good rows around a bad one', () => {
    const { first } = roundTrip(
      csv([
        row(COTTONWOOD),
        row({ ...COTTONWOOD, label: 'Broken', day: '32' }),
        row({ ...COTTONWOOD, label: 'Finish', hour: '20' }),
      ]),
    );
    expect(first.markers.map((m) => m.label)).toEqual(['Cottonwood', 'Finish']);
    expect(first.preserved).toHaveLength(1);
    expect(first.preserved[0]?.cells['label']).toBe('Broken');
  });

  it('names the file and the real line, counting blank lines', () => {
    const text = `${MARKER_HEADERS.join(',')}\n${row(COTTONWOOD)}\n\n${row({ label: 'X' })}\n`;
    const { preserved, problems } = parseMarkersCsv(text, DENVER, 'their-markers.csv');
    expect(preserved[0]?.line).toBe(4);
    expect(preserved[0]?.file).toBe('their-markers.csv');
    expect(problems[0]).toContain('their-markers.csv row 4');
  });

  it('writes preserved rows at the END, after every marker', () => {
    const { out } = roundTrip(
      csv([
        row({ ...COTTONWOOD, label: 'Broken', day: '32' }),
        row(COTTONWOOD),
      ]),
    );
    expect(out.map((r) => r['label'])).toEqual(['Cottonwood', 'Broken']);
  });

  it('brings a preserved row’s own unknown columns back with it', () => {
    const text =
      `${MARKER_HEADERS.join(',')},crew_notes\n` +
      `${row({ ...COTTONWOOD, day: '32' })},bring soup\n`;
    const first = parseMarkersCsv(text, DENVER);
    const out = formatMarkersCsv(first.markers, DENVER, first.extra, first.preserved);
    expect(parseCsv(out).headers).toContain('crew_notes');
    expect(written(out)[0]?.['crew_notes']).toBe('bring soup');
  });
});

describe('markers.csv — the per-file schema', () => {
  it('refuses a file whose row declares a newer version, naming the file', () => {
    const { markers, preserved, problems } = parseMarkersCsv(
      csv([row(COTTONWOOD), row({ ...COTTONWOOD, label: 'Finish', schema: '2' })]),
      DENVER,
    );
    // Per FILE: the readable row is refused too, because a newer build may mean
    // something different by every column in the file.
    expect(markers).toEqual([]);
    expect(preserved).toHaveLength(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('markers.csv');
    expect(problems[0]).toContain('schema 2');
    expect(problems[0]).toContain('statement about the whole of it');
  });

  it('names whichever file it was handed', () => {
    const { problems } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, schema: '9' })]),
      DENVER,
      'their-markers.csv',
    );
    expect(problems[0]).toContain('their-markers.csv');
  });

  it('refuses a schema that is not a whole number', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, schema: 'one' })]),
      DENVER,
    );
    expect(markers).toEqual([]);
    expect(problems[0]).toContain('not a whole number');
  });

  it('reads a blank schema as the version this build knows', () => {
    const { markers, problems } = parseMarkersCsv(
      csv([row({ ...COTTONWOOD, schema: '' })]),
      DENVER,
    );
    expect(problems).toEqual([]);
    expect(markers).toHaveLength(1);
  });

  /**
   * Writing `schema,1` over a file that declared 2 would claim a version this
   * build never read and erase the only marker that made the refusal legible.
   */
  it('writes a refused file back verbatim, keeping its own schema cells', () => {
    const first = parseMarkersCsv(csv([row({ ...COTTONWOOD, schema: '2' })]), DENVER);
    const out = written(formatMarkersCsv(first.markers, DENVER, first.extra, first.preserved));
    expect(out[0]?.['schema']).toBe('2');
    expect(out[0]?.['label']).toBe('Cottonwood');
    expect(out[0]?.['minute']).toBe('13');
    expect(out[0]?.['distance_m']).toBe('32100');
  });

  it('writes this build’s version on an ordinary marker', () => {
    const out = written(formatMarkersCsv([{ label: 'X', atDistance: 1 }], DENVER));
    expect(out[0]?.['schema']).toBe('1');
  });
});

describe('markers.csv — a distance-only marker is invisible, and says so', () => {
  const DISTANCE_ONLY = row({ label: 'Summit', distance_m: '72400' });

  it('warns that it will not appear anywhere, while still returning it', () => {
    const { markers, preserved, problems } = parseMarkersCsv(csv([DISTANCE_ONLY]), DENVER);
    expect(markers).toEqual([{ label: 'Summit', atDistance: 72400 }]);
    expect(preserved).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Summit');
    expect(problems[0]).toContain('will not appear');
  });

  it('says it once for the whole file, naming every such marker', () => {
    const { problems } = parseMarkersCsv(
      csv([
        DISTANCE_ONLY,
        row({ label: 'Water drop', distance_m: '90000' }),
        row(COTTONWOOD),
      ]),
      DENVER,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('2 markers');
    expect(problems[0]).toContain('Summit, Water drop');
  });

  it('says nothing when every marker has a time', () => {
    const { problems } = parseMarkersCsv(csv([row(COTTONWOOD)]), DENVER);
    expect(problems).toEqual([]);
  });
});

describe('markers.csv — writing', () => {
  const AT_MARKER: Marker = { label: 'Cottonwood', at: '2026-07-22T22:13:00.000Z' };

  it('writes the documented columns, in order, with no id among them', () => {
    // The literal names, NOT `[...MARKER_HEADERS]` — comparing the output
    // against the same constant that produced it is a tautology.
    expect(parseCsv(formatMarkersCsv([AT_MARKER], DENVER)).headers).toEqual([
      'label', 'year', 'month', 'day', 'hour', 'minute',
      'tz', 'utc_offset_min', 'distance_m', 'schema',
    ]);
    // A marker has no identity; an id column would be minted on write and
    // churned on every save. See the module doc.
    expect(MARKER_HEADERS).not.toContain('id');
  });

  it('writes the five integers unpadded, so a spreadsheet leaves them alone', () => {
    const out = written(
      formatMarkersCsv([{ label: 'X', at: '2026-07-05T07:08:00.000Z' }], 'UTC'),
    );
    expect(out[0]?.['month']).toBe('7');
    expect(out[0]?.['day']).toBe('5');
    expect(out[0]?.['hour']).toBe('7');
    expect(out[0]?.['minute']).toBe('8');
  });

  it('writes midnight as 0, never as 24', () => {
    const out = written(
      formatMarkersCsv([{ label: 'X', at: '2026-07-05T00:00:00.000Z' }], 'UTC'),
    );
    expect(out[0]?.['hour']).toBe('0');
  });

  /**
   * Blanking `tz` when it matches the event's looked free and is not: change
   * `event.timezone` afterwards and every marker silently MOVES, with nothing
   * on the row to say which zone was meant.
   */
  it('always writes tz and utc_offset_min, even when the zone is the event’s', () => {
    const out = written(formatMarkersCsv([AT_MARKER], DENVER));
    expect(out[0]?.['tz']).toBe(DENVER);
    expect(out[0]?.['utc_offset_min']).toBe('-360');
  });

  it('writes the offset in force at THAT instant, not the event’s usual one', () => {
    const out = written(
      formatMarkersCsv([{ label: 'Winter', at: '2026-12-22T22:13:00.000Z' }], DENVER),
    );
    // Mountain Standard Time, not the -360 a summer race would carry.
    expect(out[0]?.['utc_offset_min']).toBe('-420');
    expect(out[0]?.['hour']).toBe('15');
  });

  it('leaves all seven timestamp cells blank for a distance-only marker', () => {
    const out = written(formatMarkersCsv([{ label: 'Summit', atDistance: 72400 }], DENVER));
    for (const column of ['year', 'month', 'day', 'hour', 'minute', 'tz', 'utc_offset_min']) {
      expect(out[0]?.[column]).toBe('');
    }
    expect(out[0]?.['distance_m']).toBe('72400');
  });

  it('writes a distance of 0 as "0" and an absent one as blank', () => {
    const out = written(
      formatMarkersCsv(
        [{ label: 'Start', at: AT_MARKER.at as string, atDistance: 0 }, AT_MARKER],
        DENVER,
      ),
    );
    expect(out[0]?.['distance_m']).toBe('0');
    expect(out[1]?.['distance_m']).toBe('');
  });

  it('refuses to write a marker in a zone it cannot resolve, in words', () => {
    expect(() => formatMarkersCsv([AT_MARKER], 'MDT')).toThrow(
      /not a name meanwhile recognises/,
    );
  });

  it('writes a distance-only marker happily even in an unresolvable zone', () => {
    // There is no wall clock to place, so the zone is never consulted.
    const out = written(formatMarkersCsv([{ label: 'Summit', atDistance: 1 }], 'MDT'));
    expect(out[0]?.['label']).toBe('Summit');
  });

  it('refuses to write an unreadable time, in words', () => {
    expect(() => formatMarkersCsv([{ label: 'X', at: 'yesterday' }], DENVER)).toThrow(
      /not a date and time meanwhile can read/,
    );
  });

  it('refuses to write a non-finite distance, in words', () => {
    // `JSON.stringify(NaN)` is `null`, which `validateManifest` then refuses on
    // the next open — taking the whole manifest with it.
    expect(() => formatMarkersCsv([{ label: 'X', atDistance: NaN }], DENVER)).toThrow(
      /not a distance meanwhile can write/,
    );
    expect(() => formatMarkersCsv([{ label: 'X', atDistance: Infinity }], DENVER)).toThrow(
      /not a distance meanwhile can write/,
    );
  });

  it('goes through csv.ts, so a formula-looking label is guarded and a BOM written', () => {
    const text = formatMarkersCsv([{ label: '=cmd|calc', atDistance: 1 }], DENVER);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain("'=cmd|calc");
    // And back off again on read, so the round trip is invisible to a person.
    expect(parseMarkersCsv(text, DENVER).markers[0]?.label).toBe('=cmd|calc');
  });

  it('a known column always wins over an extra wearing the same name', () => {
    const out = written(
      formatMarkersCsv([{ label: 'Real', atDistance: 1 }], DENVER, [{ label: 'Fake' }]),
    );
    expect(out[0]?.['label']).toBe('Real');
  });
});

describe('markers.csv — unknown columns survive a round trip', () => {
  const WITH_EXTRA =
    `${MARKER_HEADERS.join(',')},crew_notes\n` +
    `${row(COTTONWOOD)},bring soup\n` +
    `${row({ ...COTTONWOOD, label: 'Finish', hour: '20' })},\n`;

  it('keeps an unknown column, including a blank one, aligned per marker', () => {
    const first = parseMarkersCsv(WITH_EXTRA, DENVER);
    expect(first.problems).toEqual([]);
    expect(first.extra).toEqual([{ crew_notes: 'bring soup' }, { crew_notes: '' }]);

    const out = formatMarkersCsv(first.markers, DENVER, first.extra, first.preserved);
    expect(written(out)[0]?.['crew_notes']).toBe('bring soup');

    const second = parseMarkersCsv(out, DENVER);
    expect(second.extra).toEqual(first.extra);
    expect(second.markers).toEqual(first.markers);
  });

  it('writes unknown columns after the known ones and before schema', () => {
    const first = parseMarkersCsv(WITH_EXTRA, DENVER);
    const headers = parseCsv(
      formatMarkersCsv(first.markers, DENVER, first.extra, first.preserved),
    ).headers;
    expect(headers.indexOf('crew_notes')).toBeGreaterThan(headers.indexOf('distance_m'));
    expect(headers[headers.length - 1]).toBe('schema');
  });

  it('gives every marker an extra entry, so the two arrays stay aligned', () => {
    const { markers, extra } = parseMarkersCsv(
      csv([row(COTTONWOOD), row({ ...COTTONWOOD, label: 'Finish', hour: '20' })]),
      DENVER,
    );
    expect(extra).toHaveLength(markers.length);
    expect(extra).toEqual([{}, {}]);
  });
});

describe('markers.csv — round trips', () => {
  const FULL =
    `${MARKER_HEADERS.join(',')},crew_notes\n` +
    `${row(COTTONWOOD)},bring soup\n` +
    `${row({ label: 'Summit', distance_m: '72400' })},\n` +
    `${row({ ...COTTONWOOD, label: 'Broken', day: '32' })},\n`;

  it('parse → format → parse is identity, and writing again is a fixed point', () => {
    const first = parseMarkersCsv(FULL, DENVER);
    expect(first.markers).toHaveLength(2);
    expect(first.preserved).toHaveLength(1);

    const out = formatMarkersCsv(first.markers, DENVER, first.extra, first.preserved);
    const second = parseMarkersCsv(out, DENVER);
    expect(second.markers).toEqual(first.markers);
    expect(second.extra).toEqual(first.extra);
    // The CELLS, not the whole `PreservedRow`: a preserved row is written at
    // the end of the file, so its `line` legitimately moves. What must not
    // change is a single character of what it says.
    expect(second.preserved.map((p) => p.cells)).toEqual(first.preserved.map((p) => p.cells));
    expect(second.problems).toEqual(first.problems);

    expect(formatMarkersCsv(second.markers, DENVER, second.extra, second.preserved)).toBe(out);
  });

  it('round-trips a label carrying a comma and a quote', () => {
    const label = 'Cottonwood, the "high" one';
    const text = formatMarkersCsv([{ label, atDistance: 1 }], DENVER);
    expect(parseMarkersCsv(text, DENVER).markers[0]?.label).toBe(label);
  });

  it('round-trips a label carrying NFC-sensitive text, composed', () => {
    // "José" decomposed: e + U+0301. `csv.ts` normalises every cell it writes,
    // which is what makes two spellings of one name compare equal anywhere.
    const text = formatMarkersCsv([{ label: 'José aid', atDistance: 1 }], DENVER);
    expect(written(text)[0]?.['label']).toBe('José aid');
    expect(parseMarkersCsv(text, DENVER).markers[0]?.label).toBe('José aid');
  });

  it('reads a file written with CRLF line endings', () => {
    // The assertion is on an unknown column, deliberately. Every KNOWN cell is
    // read through `nonEmpty` or `.trim()`, so a stray `\r` on the end of a
    // line would be silently absorbed and the test could not fail. An unknown
    // column is the one path that keeps a value verbatim.
    const text = (
      `${MARKER_HEADERS.join(',')},crew_notes\n${row(COTTONWOOD)},bring soup\n`
    ).replace(/\n/g, '\r\n');
    const { markers, extra, problems } = parseMarkersCsv(text, DENVER);
    expect(problems).toEqual([]);
    expect(markers[0]?.at).toBe('2026-07-22T22:13:00.000Z');
    expect(extra).toEqual([{ crew_notes: 'bring soup' }]);
  });

  it('reads a file with no BOM and writes one', () => {
    const text = csv([row(COTTONWOOD)]);
    expect(text.startsWith('﻿')).toBe(false);
    const first = parseMarkersCsv(text, DENVER);
    expect(first.markers).toHaveLength(1);
    expect(formatMarkersCsv(first.markers, DENVER).startsWith('﻿')).toBe(true);
  });

  it('writes an empty file when there is nothing to write', () => {
    const out = formatMarkersCsv([], DENVER);
    expect(parseCsv(out).rows).toEqual([]);
    expect(parseMarkersCsv(out, DENVER)).toEqual({
      markers: [], extra: [], preserved: [], problems: [],
    });
  });
});
