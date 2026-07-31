import { describe, expect, it } from 'vitest';
import {
  EVENT_HEADERS, EVENT_KEYS, formatEventCsv, parseEventCsv,
} from '../src/core/event-csv.ts';
import { parseCsv } from '../src/core/csv.ts';
import type { CourseRef, EventInfo } from '../src/core/schema.ts';

/**
 * A file with everything filled in, written the way `formatEventCsv` writes it
 * so a test can edit one line and leave the rest correct.
 */
function csv(lines: readonly string[]): string {
  return `key,value\n${lines.join('\n')}\n`;
}

const RANGE_LINES = [
  'range_from_year,2026',
  'range_from_month,7',
  'range_from_day,22',
  'range_from_hour,16',
  'range_from_minute,13',
  'range_from_tz,America/Denver',
  'range_from_utc_offset_min,-360',
  'range_to_year,2026',
  'range_to_month,7',
  'range_to_day,24',
  'range_to_hour,2',
  'range_to_minute,0',
  'range_to_tz,America/Denver',
  'range_to_utc_offset_min,-360',
];

const FULL = csv([
  'title,Ridgeline 100 - Example City',
  'timezone,America/Denver',
  ...RANGE_LINES,
  'course_kind,gpx',
  'course_src,course.gpx',
  'course_person,google-pixel-9a',
  'schema,1',
]);

/** Turn a written file back into an ordered key → value map, for assertions. */
function pairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of parseCsv(text).rows) out[row['key'] as string] = row['value'] as string;
  return out;
}

function keysOf(text: string): string[] {
  return parseCsv(text).rows.map((r) => r['key'] as string);
}

describe('event.csv — reading', () => {
  it('reads the title, the timezone, the crop and the course', () => {
    const { event, course, problems } = parseEventCsv(FULL);
    expect(problems).toEqual([]);
    expect(event.title).toBe('Ridgeline 100 - Example City');
    expect(event.timezone).toBe('America/Denver');
    // 2026-07-22 16:13 at UTC-06:00.
    expect(event.range).toEqual({
      from: '2026-07-22T22:13:00.000Z',
      to: '2026-07-24T08:00:00.000Z',
    });
    expect(course).toEqual({ kind: 'gpx', src: 'course.gpx', person: 'google-pixel-9a' });
  });

  it('leaves the crop and the course absent when the file names neither', () => {
    const { event, course, problems } = parseEventCsv(csv(['title,A wedding']));
    expect(problems).toEqual([]);
    expect(event.range).toBeUndefined();
    expect(course).toBeUndefined();
  });

  /**
   * The row's own `utc_offset_min` is what decides the instant — a zone name
   * alone cannot say which side of a fall-back hour a wall clock means. 2026's
   * US fall-back is 01:00 on 1 November, so 01:30 is a real repeated hour:
   * -360 is the first pass (MDT) and -420 the second (MST).
   */
  it('resolves a repeated wall-clock hour by the row’s own offset', () => {
    const first = parseEventCsv(
      csv([
        'title,DST',
        'range_from_year,2026', 'range_from_month,11', 'range_from_day,1',
        'range_from_hour,1', 'range_from_minute,30',
        'range_from_tz,America/Denver', 'range_from_utc_offset_min,-360',
        'range_to_year,2026', 'range_to_month,11', 'range_to_day,1',
        'range_to_hour,1', 'range_to_minute,30',
        'range_to_tz,America/Denver', 'range_to_utc_offset_min,-420',
      ]),
    );
    expect(first.problems).toEqual([]);
    expect(first.event.range).toEqual({
      from: '2026-11-01T07:30:00.000Z',
      to: '2026-11-01T08:30:00.000Z',
    });
  });

  it('falls back to the event timezone when a range row carries no zone', () => {
    const { event, problems } = parseEventCsv(
      csv([
        'title,No zone on the row',
        'timezone,America/Denver',
        'range_from_year,2026', 'range_from_month,7', 'range_from_day,22',
        'range_from_hour,16', 'range_from_minute,13',
        'range_to_year,2026', 'range_to_month,7', 'range_to_day,23',
        'range_to_hour,16', 'range_to_minute,13',
      ]),
    );
    expect(problems).toEqual([]);
    expect(event.range?.from).toBe('2026-07-22T22:13:00.000Z');
  });

  /**
   * A spreadsheet leaves " 2026" in a cell as easily as "2026", and
   * `readCalendarParts` matches `/^\d{4}$/` — so an untrimmed cell is refused
   * as "not a whole number" for a value that is one, and the crop silently
   * fails to apply on a file whose numbers are all correct.
   */
  it('reads range integers a spreadsheet left padded with spaces', () => {
    const { event, problems } = parseEventCsv(
      csv([
        'title,Spacey',
        'range_from_year, 2026', 'range_from_month, 7 ', 'range_from_day,22',
        'range_from_hour,16', 'range_from_minute, 13',
        'range_from_tz,America/Denver', 'range_from_utc_offset_min, -360 ',
        'range_to_year,2026', 'range_to_month,7', 'range_to_day,24',
        'range_to_hour,2', 'range_to_minute,0',
        'range_to_tz,America/Denver', 'range_to_utc_offset_min,-360',
      ]),
    );
    expect(problems).toEqual([]);
    expect(event.range?.from).toBe('2026-07-22T22:13:00.000Z');
  });

  it('reports a missing title rather than inventing one', () => {
    const { event, problems } = parseEventCsv(csv(['timezone,America/Denver']));
    expect(event.title).toBe('');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no title');
  });

  it('reports a blank title the same as an absent one', () => {
    const { event, problems } = parseEventCsv(csv(['title,   ']));
    expect(event.title).toBe('');
    expect(problems.some((p) => p.includes('has no title'))).toBe(true);
  });
});

describe('event.csv — duplicate keys', () => {
  it('takes the last value AND reports the collision', () => {
    const { event, problems } = parseEventCsv(
      csv(['title,First', 'title,Second']),
    );
    expect(event.title).toBe('Second');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('names "title" more than once');
    expect(problems[0]).toContain('Second');
  });

  it('reports a duplicated unknown key too, and keeps the last value', () => {
    const { extra, problems } = parseEventCsv(
      csv(['title,X', 'photographer,Ana', 'photographer,Bo']),
    );
    expect(extra['photographer']).toBe('Bo');
    expect(problems.some((p) => p.includes('names "photographer" more than once'))).toBe(true);
  });
});

describe('event.csv — unknown keys survive a round trip', () => {
  it('keeps an unknown key, including one with a blank value', () => {
    const text = csv(['title,X', 'photographer,Ana', 'sponsor,', 'schema,1']);
    const first = parseEventCsv(text);
    expect(first.extra).toEqual({ photographer: 'Ana', sponsor: '' });

    const written = formatEventCsv(first.event, first.course, first.extra, first.preserved);
    expect(pairs(written)).toMatchObject({ photographer: 'Ana', sponsor: '' });

    const second = parseEventCsv(written);
    expect(second.extra).toEqual(first.extra);
    expect(second.problems).toEqual([]);
  });

  it('writes unknown keys after the known ones and before schema', () => {
    const { event, course, extra, preserved } = parseEventCsv(
      csv(['title,X', 'photographer,Ana', 'schema,1']),
    );
    const keys = keysOf(formatEventCsv(event, course, extra, preserved));
    expect(keys.indexOf('photographer')).toBeGreaterThan(keys.indexOf('title'));
    expect(keys.indexOf('photographer')).toBeLessThan(keys.indexOf('schema'));
    expect(keys[keys.length - 1]).toBe('schema');
  });
});

/**
 * The rule the whole module exists for: a value this build knows the name of
 * but cannot interpret is reported AND written back, because refusing to read
 * it is not permission to delete it. `schema.ts` names what refusing exactly
 * these fields cost once — the crop, every marker, the title, the timezone and
 * every hand-placed time.
 */
describe('event.csv — a known key it cannot interpret is preserved', () => {
  const BAD_DAY = csv([
    'title,X',
    'timezone,America/Denver',
    ...RANGE_LINES.map((l) => (l.startsWith('range_from_day,') ? 'range_from_day,32' : l)),
    'schema,1',
  ]);

  it('reports a day of 32 and applies no crop', () => {
    const { event, problems } = parseEventCsv(BAD_DAY);
    expect(event.range).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('day of 32');
    expect(problems[0]).toContain('kept exactly as they are');
  });

  it('writes every range row back, both ends, not just the broken one', () => {
    const first = parseEventCsv(BAD_DAY);
    const written = formatEventCsv(first.event, first.course, first.extra, first.preserved);
    const out = pairs(written);
    expect(out['range_from_day']).toBe('32');
    // The other end parsed perfectly well and still has nowhere to be written
    // from — `event.range` is a pair or it is nothing — so it has to come back
    // through `preserved` or half the crop goes off disk.
    expect(out['range_to_day']).toBe('24');
    expect(out['range_to_utc_offset_min']).toBe('-360');
    expect(parseEventCsv(written).preserved).toEqual(first.preserved);
  });

  it('preserves a range end that is missing one integer', () => {
    const text = csv([
      'title,X',
      ...RANGE_LINES.filter((l) => !l.startsWith('range_to_hour,')),
      'schema,1',
    ]);
    const first = parseEventCsv(text);
    expect(first.event.range).toBeUndefined();
    expect(first.problems[0]).toContain('range_to_hour');
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['range_to_minute']).toBe('0');
    expect(out['range_from_year']).toBe('2026');
  });

  it('preserves a course_kind that is not one of the three', () => {
    const text = csv(['title,X', 'course_kind,strv', 'course_url,https://strava.com/a/1']);
    const first = parseEventCsv(text);
    expect(first.course).toBeUndefined();
    expect(first.problems[0]).toContain('course_kind is "strv"');
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['course_kind']).toBe('strv');
    expect(out['course_url']).toBe('https://strava.com/a/1');
  });

  it('preserves a half-present crop rather than repairing it', () => {
    const text = csv(['title,X', ...RANGE_LINES.filter((l) => l.startsWith('range_from_'))]);
    const first = parseEventCsv(text);
    expect(first.event.range).toBeUndefined();
    expect(first.problems[0]).toContain('gives range_from but no range_to');
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['range_from_hour']).toBe('16');
  });

  it('reports a from that is not before its to, and keeps both', () => {
    const text = csv([
      'title,X',
      ...RANGE_LINES.map((l) => (l.startsWith('range_to_day,') ? 'range_to_day,21' : l)),
    ]);
    const first = parseEventCsv(text);
    expect(first.event.range).toBeUndefined();
    expect(first.problems[0]).toContain('not before');
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['range_to_day']).toBe('21');
  });

  it('preserves course keys given with no course_kind', () => {
    const first = parseEventCsv(csv(['title,X', 'course_src,course.gpx']));
    expect(first.course).toBeUndefined();
    expect(first.problems[0]).toContain('no course_kind');
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['course_src']).toBe('course.gpx');
  });

  it('refuses a kind carrying both course_src and course_url, keeping both', () => {
    const first = parseEventCsv(
      csv(['title,X', 'course_kind,gpx', 'course_src,c.gpx', 'course_url,https://strava.com/a/1']),
    );
    expect(first.course).toBeUndefined();
    expect(first.problems[0]).toContain('both course_src and course_url');
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['course_src']).toBe('c.gpx');
    expect(out['course_url']).toBe('https://strava.com/a/1');
  });

  it('refuses a strava kind with no course_url', () => {
    const { course, problems } = parseEventCsv(csv(['title,X', 'course_kind,strava-link']));
    expect(course).toBeUndefined();
    expect(problems[0]).toContain('needs a course_url');
  });

  /**
   * The model wins over a preserved value, so a caller that has since set a
   * crop is not overwritten by the broken rows it replaced. Preservation exists
   * to fill a gap, never to override.
   */
  it('lets a caller-supplied crop replace preserved range rows', () => {
    const first = parseEventCsv(BAD_DAY);
    const event: EventInfo = {
      ...first.event,
      range: { from: '2026-07-22T22:13:00.000Z', to: '2026-07-24T08:00:00.000Z' },
    };
    const out = pairs(formatEventCsv(event, first.course, first.extra, first.preserved));
    expect(out['range_from_day']).toBe('22');
  });
});

describe('event.csv — the per-file schema', () => {
  it('refuses a file declaring a newer version, naming the file', () => {
    const { event, course, problems } = parseEventCsv(csv(['title,X', 'schema,2']));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('event.csv');
    expect(problems[0]).toContain('schema 2');
    // Nothing is interpreted: a newer build may mean something different by
    // every other key in the file.
    expect(event.title).toBe('');
    expect(course).toBeUndefined();
  });

  it('names whichever file it was handed', () => {
    const { problems } = parseEventCsv(csv(['title,X', 'schema,9']), 'their-event.csv');
    expect(problems[0]).toContain('their-event.csv');
  });

  it('refuses a schema that is not a whole number', () => {
    const { problems } = parseEventCsv(csv(['title,X', 'schema,one']));
    expect(problems[0]).toContain('not a whole number');
  });

  it('reads a blank schema as the version this build knows', () => {
    const { event, problems } = parseEventCsv(csv(['title,X', 'schema,']));
    expect(problems).toEqual([]);
    expect(event.title).toBe('X');
  });

  /**
   * The whole file comes back, `schema` included. Writing `schema,1` over a
   * file that declared 2 would claim a version this build never read and erase
   * the only marker that made the refusal legible.
   */
  it('writes a refused file back verbatim, keeping its own schema cell', () => {
    const text = csv([
      'title,Ridgeline 100',
      'timezone,America/Denver',
      ...RANGE_LINES,
      'course_kind,gpx',
      'course_src,course.gpx',
      'photographer,Ana',
      'schema,2',
    ]);
    const first = parseEventCsv(text);
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['schema']).toBe('2');
    expect(out['title']).toBe('Ridgeline 100');
    expect(out['timezone']).toBe('America/Denver');
    expect(out['range_from_minute']).toBe('13');
    expect(out['course_src']).toBe('course.gpx');
    expect(out['photographer']).toBe('Ana');

    const second = parseEventCsv(
      formatEventCsv(first.event, first.course, first.extra, first.preserved),
    );
    expect(second.preserved).toEqual(first.preserved);
    expect(second.extra).toEqual(first.extra);
    expect(second.problems).toEqual(first.problems);
  });

  it('writes this build’s version on an ordinary file', () => {
    expect(pairs(formatEventCsv({ title: 'X' }))['schema']).toBe('1');
  });
});

describe('event.csv — the course URL guard is a warning, never a refusal', () => {
  it('keeps a scheme-less URL, reports it, and still returns the course', () => {
    const { course, problems } = parseEventCsv(
      csv(['title,X', 'course_kind,strava-link', 'course_url,strava.com/activities/123']),
    );
    // Returned, not refused: refusing this took the crop, the markers, the
    // title and every hand-placed time down with it for one commit.
    expect(course).toEqual({ kind: 'strava-link', url: 'strava.com/activities/123' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not a plain https://');
  });

  it('writes an unsafe URL back exactly as it was written', () => {
    const first = parseEventCsv(
      csv(['title,X', 'course_kind,strava-link', 'course_url,strava.com/activities/123']),
    );
    const out = pairs(formatEventCsv(first.event, first.course, first.extra, first.preserved));
    expect(out['course_url']).toBe('strava.com/activities/123');
  });

  it('warns that a non-Strava embed will not be framed, but keeps the link out', () => {
    const { course, problems } = parseEventCsv(
      csv(['title,X', 'course_kind,strava-embed', 'course_url,https://example.test/a']),
    );
    expect(course).toEqual({ kind: 'strava-embed', url: 'https://example.test/a' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('example.test');
    expect(problems[0]).toContain('link out');
  });

  it('says nothing about a proper Strava embed URL', () => {
    const { problems } = parseEventCsv(
      csv(['title,X', 'course_kind,strava-embed', 'course_url,https://www.strava.com/a/1/embed/z']),
    );
    expect(problems).toEqual([]);
  });
});

describe('event.csv — the header row', () => {
  it('reports a missing header row and reads that line as a setting', () => {
    const { event, problems } = parseEventCsv('title,My Race\ntimezone,America/Denver\n');
    // Without this, `parseCsv` takes the first line as column names and the
    // title is eaten silently.
    expect(event.title).toBe('My Race');
    expect(event.timezone).toBe('America/Denver');
    expect(problems.some((p) => p.includes('should begin with a header row'))).toBe(true);
  });

  it('says nothing about a correct header row', () => {
    expect(parseEventCsv(csv(['title,X'])).problems).toEqual([]);
  });

  it('reports a row with a value but no key', () => {
    const { problems } = parseEventCsv(csv(['title,X', ',orphan']));
    expect(problems.some((p) => p.includes('no key'))).toBe(true);
  });

  it('says nothing about an empty file beyond the missing title', () => {
    const { problems } = parseEventCsv('');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('has no title');
  });
});

describe('event.csv — writing', () => {
  it('writes two columns named key and value', () => {
    // The literal names, NOT `[...EVENT_HEADERS]` — comparing the output
    // against the same constant that produced it is a tautology, and a
    // mutation run proved it: renaming the constant to `['setting','value']`
    // killed 25 other tests in this file and left this one green.
    expect(parseCsv(formatEventCsv({ title: 'X' })).headers).toEqual(['key', 'value']);
    expect(EVENT_HEADERS).toEqual(['key', 'value']);
  });

  it('writes only the keys that have something to say', () => {
    expect(keysOf(formatEventCsv({ title: 'X' }))).toEqual(['title', 'schema']);
  });

  it('writes title even when it is blank, so the key stays visible', () => {
    expect(pairs(formatEventCsv({ title: '' }))).toHaveProperty('title', '');
  });

  it('writes the crop in the event timezone, always including tz and the offset', () => {
    const out = pairs(
      formatEventCsv({
        title: 'X',
        timezone: 'America/Denver',
        range: { from: '2026-07-22T22:13:00.000Z', to: '2026-07-24T08:00:00.000Z' },
      }),
    );
    expect(out['range_from_hour']).toBe('16');
    expect(out['range_from_tz']).toBe('America/Denver');
    expect(out['range_from_utc_offset_min']).toBe('-360');
    expect(out['range_to_hour']).toBe('2');
  });

  it('writes the five integers unpadded, so a spreadsheet leaves them alone', () => {
    const out = pairs(
      formatEventCsv({
        title: 'X',
        timezone: 'UTC',
        range: { from: '2026-07-05T07:08:00.000Z', to: '2026-07-06T00:00:00.000Z' },
      }),
    );
    expect(out['range_from_month']).toBe('7');
    expect(out['range_from_day']).toBe('5');
    expect(out['range_from_hour']).toBe('7');
    expect(out['range_from_minute']).toBe('8');
    // Midnight is 0, never the "24" some ICU builds render under h23 — which
    // `readCalendarParts` would then refuse outright.
    expect(out['range_to_hour']).toBe('0');
  });

  it('writes the keys in the documented order', () => {
    const course: CourseRef = { kind: 'gpx', src: 'c.gpx', person: 'p1' };
    const keys = keysOf(
      formatEventCsv(
        {
          title: 'X',
          timezone: 'UTC',
          range: { from: '2026-07-05T00:00:00.000Z', to: '2026-07-06T00:00:00.000Z' },
        },
        course,
      ),
    );
    expect(keys.slice(0, 4)).toEqual([
      'title', 'timezone', 'range_from_year', 'range_from_month',
    ]);
    expect(keys.indexOf('range_to_year')).toBeGreaterThan(keys.indexOf('range_from_tz'));
    expect(keys.indexOf('course_kind')).toBeGreaterThan(keys.indexOf('range_to_utc_offset_min'));
    expect(keys.filter((k) => k.startsWith('course_'))).toEqual([
      'course_kind', 'course_src', 'course_person',
    ]);
  });

  it('refuses to write a crop in a zone it cannot resolve, in words', () => {
    expect(() =>
      formatEventCsv({
        title: 'X',
        timezone: 'MDT',
        range: { from: '2026-07-22T22:13:00.000Z', to: '2026-07-24T08:00:00.000Z' },
      }),
    ).toThrow(/not a name meanwhile recognises/);
  });

  it('writes an unresolvable timezone happily when there is no crop to place', () => {
    expect(pairs(formatEventCsv({ title: 'X', timezone: 'MDT' }))['timezone']).toBe('MDT');
  });

  it('refuses to write an unreadable range value, in words', () => {
    expect(() =>
      formatEventCsv({ title: 'X', timezone: 'UTC', range: { from: 'yesterday', to: 'today' } }),
    ).toThrow(/not a date and time meanwhile can read/);
  });

  it('goes through csv.ts, so a formula-looking value is guarded and a BOM written', () => {
    const written = formatEventCsv({ title: '=cmd|calc' });
    expect(written.startsWith('﻿')).toBe(true);
    expect(written).toContain("'=cmd|calc");
    // And back off again on read, so the round trip is invisible to a person.
    expect(parseEventCsv(written).event.title).toBe('=cmd|calc');
  });
});

describe('event.csv — round trips', () => {
  it('parse → format → parse is identity for a full file', () => {
    const first = parseEventCsv(FULL);
    const written = formatEventCsv(first.event, first.course, first.extra, first.preserved);
    const second = parseEventCsv(written);
    expect(second.event).toEqual(first.event);
    expect(second.course).toEqual(first.course);
    expect(second.extra).toEqual(first.extra);
    expect(second.preserved).toEqual(first.preserved);
    expect(second.problems).toEqual([]);
    // And it is a fixed point: writing what was read again changes nothing.
    expect(formatEventCsv(second.event, second.course, second.extra, second.preserved))
      .toBe(written);
  });

  it('round-trips each course kind', () => {
    for (const course of [
      { kind: 'gpx', src: 'c.gpx' },
      { kind: 'strava-link', url: 'https://www.strava.com/activities/1' },
      { kind: 'strava-embed', url: 'https://www.strava.com/activities/1/embed/z', person: 'p1' },
    ] as CourseRef[]) {
      const written = formatEventCsv({ title: 'X' }, course);
      expect(parseEventCsv(written).course).toEqual(course);
    }
  });

  it('round-trips a value carrying NFC-sensitive text, composed', () => {
    // "José" decomposed: e + U+0301. `csv.ts` normalises every cell it writes,
    // which is what makes two spellings of one name compare equal anywhere.
    const written = formatEventCsv({ title: 'José Memorial 50k' });
    expect(pairs(written)['title']).toBe('José Memorial 50k');
    expect(parseEventCsv(written).event.title).toBe('José Memorial 50k');
  });

  it('round-trips a value carrying a comma and a quote', () => {
    const title = 'Ridgeline 100, the "big" one';
    expect(parseEventCsv(formatEventCsv({ title })).event.title).toBe(title);
  });

  it('reads a file written with CRLF line endings', () => {
    // The assertion is on an `extra` value, deliberately. Every KNOWN key is
    // read through `nonEmpty`, which trims — so a stray `\r` left on the end
    // of a line would be silently absorbed and the test could not fail.
    // `extra` is the one path that keeps a value verbatim, so it is the only
    // one where broken CRLF handling shows up.
    const text = csv(['title,Ridgeline 100', 'photographer,Ana']).replace(/\n/g, '\r\n');
    const { event, extra, problems } = parseEventCsv(text);
    expect(problems).toEqual([]);
    expect(event.title).toBe('Ridgeline 100');
    expect(extra).toEqual({ photographer: 'Ana' });
  });

  it('exports every key it writes in EVENT_KEYS', () => {
    const written = formatEventCsv(
      {
        title: 'X',
        timezone: 'UTC',
        range: { from: '2026-07-05T00:00:00.000Z', to: '2026-07-06T00:00:00.000Z' },
      },
      { kind: 'gpx', src: 'c.gpx', person: 'p1' },
    );
    for (const key of keysOf(written)) expect(EVENT_KEYS).toContain(key);
  });

  it('has no media_base key', () => {
    // `manifest.media` is read nowhere in src/. A key that configures nothing
    // is one somebody fills in and expects to work.
    expect(EVENT_KEYS).not.toContain('media_base');
  });
});
