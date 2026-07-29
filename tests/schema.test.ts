import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, TIME_SOURCE_RANK, isDeviceClock, validateManifest } from '../src/core/schema.ts';

function minimal(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: SCHEMA_VERSION,
    event: { title: 'Cascade Crest 100', timezone: 'America/Los_Angeles' },
    people: [{ id: 'sam', name: 'Sam', role: 'runner' }],
    items: [
      {
        id: 'a1f',
        person: 'sam',
        type: 'photo',
        src: 'sam/IMG_4417.jpg',
        at: '2026-08-22T13:12:04Z',
        timeSource: 'exif-offset',
      },
    ],
    ...overrides,
  };
}

function errorsOf(input: unknown): string[] {
  const r = validateManifest(input);
  return r.ok ? [] : r.errors;
}

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const r = validateManifest(minimal());
    expect(r.ok).toBe(true);
  });

  it('refuses a schema version it does not understand', () => {
    const r = validateManifest(minimal({ schema: 99 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // A legible refusal beats a render that is subtly wrong.
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('version 99');
    expect(r.errors[0]).toContain(`version ${SCHEMA_VERSION}`);
  });

  it('refuses a manifest with no schema field at all', () => {
    const noSchema = minimal() as Record<string, unknown>;
    delete noSchema['schema'];
    expect(errorsOf(noSchema)[0]).toContain('missing "schema"');
  });

  it('rejects non-objects', () => {
    expect(errorsOf(null)).toHaveLength(1);
    expect(errorsOf([])).toHaveLength(1);
    expect(errorsOf('{}')).toHaveLength(1);
  });

  it('collects every problem instead of stopping at the first', () => {
    const errs = errorsOf(
      minimal({
        event: {},
        people: [{ id: '', name: '' }],
      }),
    );
    expect(errs.length).toBeGreaterThan(2);
  });

  it('catches an item pointing at a person who does not exist', () => {
    const errs = errorsOf(
      minimal({
        items: [
          {
            id: 'a1f',
            person: 'nobody',
            type: 'photo',
            src: 'x.jpg',
            at: '2026-08-22T13:12:04Z',
            timeSource: 'exif-offset',
          },
        ],
      }),
    );
    expect(errs.some((e) => e.includes('unknown person "nobody"'))).toBe(true);
  });

  it('catches duplicate person and item ids', () => {
    expect(
      errorsOf(
        minimal({
          people: [
            { id: 'sam', name: 'Sam' },
            { id: 'sam', name: 'Sam Again' },
          ],
        }),
      ).some((e) => e.includes('more than once')),
    ).toBe(true);
  });

  it('requires a timestamp unless timeSource is "none"', () => {
    const errs = errorsOf(
      minimal({
        items: [{ id: 'a', person: 'sam', type: 'photo', src: 'x.jpg', timeSource: 'exif-offset' }],
      }),
    );
    expect(errs.some((e) => e.includes('.at must be an ISO-8601'))).toBe(true);
  });

  it('accepts an unplaced item with no timestamp', () => {
    const r = validateManifest(
      minimal({
        items: [{ id: 'a', person: 'sam', type: 'photo', src: 'x.jpg', timeSource: 'none' }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an unplaced item that nonetheless carries a time', () => {
    const errs = errorsOf(
      minimal({
        items: [
          {
            id: 'a',
            person: 'sam',
            type: 'photo',
            src: 'x.jpg',
            at: '2026-08-22T13:12:04Z',
            timeSource: 'none',
          },
        ],
      }),
    );
    expect(errs.some((e) => e.includes('"manual"'))).toBe(true);
  });

  it('validates GPS coordinates are on the planet', () => {
    const errs = errorsOf(
      minimal({
        items: [
          {
            id: 'a',
            person: 'sam',
            type: 'photo',
            src: 'x.jpg',
            at: '2026-08-22T13:12:04Z',
            timeSource: 'gps',
            gps: [147.39, -121.39],
          },
        ],
      }),
    );
    expect(errs.some((e) => e.includes('latitude, longitude'))).toBe(true);
  });

  it('requires a marker to say where it goes', () => {
    const errs = errorsOf(minimal({ markers: [{ label: 'Hyak aid station' }] }));
    expect(errs.some((e) => e.includes('atDistance'))).toBe(true);
  });

  it('accepts markers given in either time or distance', () => {
    const r = validateManifest(
      minimal({
        markers: [
          { label: 'Hyak aid station', atDistance: 66000 },
          { label: 'Sunrise', at: '2026-08-22T12:38:00Z' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('course variants', () => {
  it('accepts a GPX course', () => {
    const r = validateManifest(minimal({ course: { kind: 'gpx', src: 'sam.gpx', person: 'sam' } }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('accepts a Strava fallback but warns that the spine stays off', () => {
    const r = validateManifest(
      minimal({ course: { kind: 'strava-link', url: 'https://www.strava.com/activities/123' } }),
    );
    expect(r.ok).toBe(true);
    // The user needs to know why the map and elevation profile are missing.
    expect(r.warnings.join(' ')).toMatch(/GPX export/);
  });

  it('rejects an unknown course kind', () => {
    expect(errorsOf(minimal({ course: { kind: 'garmin-api', url: 'x' } })).length).toBe(1);
  });

  it('rejects a course owned by an unknown person', () => {
    const errs = errorsOf(minimal({ course: { kind: 'gpx', src: 'x.gpx', person: 'ghost' } }));
    expect(errs.some((e) => e.includes('unknown person "ghost"'))).toBe(true);
  });
});

describe('warnings do not block loading', () => {
  it('warns when more than one person is the runner', () => {
    const r = validateManifest(
      minimal({
        people: [
          { id: 'sam', name: 'Sam', role: 'runner' },
          { id: 'ali', name: 'Ali', role: 'runner' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/pinned to the top lane/);
  });
});

describe('isDeviceClock', () => {
  it('separates provenance from accuracy', () => {
    // Satellite time and author intent do NOT come from the device clock, so
    // a clockOffset correcting that clock must not touch them. Note this is
    // independent of rank: GPS time is ranked low because a fix goes stale,
    // but it is still not the camera's clock.
    expect(isDeviceClock('gps')).toBe(false);
    expect(isDeviceClock('manual')).toBe(false);
    expect(isDeviceClock('none')).toBe(false);

    expect(isDeviceClock('exif-offset')).toBe(true);
    expect(isDeviceClock('exif-naive')).toBe(true);
    expect(isDeviceClock('qt-offset')).toBe(true);
    expect(isDeviceClock('filename')).toBe(true);
    expect(isDeviceClock('mvhd')).toBe(true);
  });
});

describe('TIME_SOURCE_RANK', () => {
  it('ranks the shutter above GPS', () => {
    // Corrected against real race photos: a GPS fix lags the shutter by a
    // median 11s and non-uniformly, which scrambles the relative order of
    // photos taken close together.
    const rank = (s: Parameters<typeof isDeviceClock>[0]) => TIME_SOURCE_RANK.indexOf(s);
    expect(rank('exif-offset')).toBeLessThan(rank('gps'));
    expect(rank('exif-naive')).toBeLessThan(rank('gps'));
  });

  it('ranks a filename above mvhd', () => {
    // Android writes mvhd at the END of recording; the filename is the start.
    const rank = (s: Parameters<typeof isDeviceClock>[0]) => TIME_SOURCE_RANK.indexOf(s);
    expect(rank('filename')).toBeLessThan(rank('mvhd'));
  });

  it('lists every source exactly once', () => {
    expect(new Set(TIME_SOURCE_RANK).size).toBe(TIME_SOURCE_RANK.length);
    expect(TIME_SOURCE_RANK.at(-1)).toBe('none');
  });
});

describe('notes in the manifest', () => {
  const withNotes = (notes: unknown) => ({
    schema: 1,
    event: { title: 'Race' },
    people: [{ id: 'p', name: 'Priya' }],
    items: [],
    notes,
  });

  it('accepts a note at a moment', () => {
    const r = validateManifest(withNotes([{ id: 'n', at: '2026-07-25T21:45:00Z', text: 'wrong turn' }]));
    expect(r.ok).toBe(true);
  });

  it('accepts a note that spans time, which is most of crewing', () => {
    const r = validateManifest(
      withNotes([
        { id: 'n', at: '2026-07-26T09:00:00Z', until: '2026-07-26T12:00:00Z', text: 'asleep in the car', person: 'p' },
      ]),
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a note with no text', () => {
    const r = validateManifest(withNotes([{ id: 'n', at: '2026-07-25T21:45:00Z', text: '' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/text/);
  });

  it('refuses a note with an unparseable time', () => {
    const r = validateManifest(withNotes([{ id: 'n', at: 'tuesday-ish', text: 'x' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/ISO-8601/);
  });

  it('refuses a span that ends before it starts', () => {
    const r = validateManifest(
      withNotes([{ id: 'n', at: '2026-07-26T12:00:00Z', until: '2026-07-26T09:00:00Z', text: 'x' }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/before/);
  });

  it('refuses duplicate ids, which edit and delete address by', () => {
    const r = validateManifest(
      withNotes([
        { id: 'same', at: '2026-07-25T21:45:00Z', text: 'one' },
        { id: 'same', at: '2026-07-25T21:46:00Z', text: 'two' },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/more than once/);
  });

  it('accepts a manifest with no notes at all', () => {
    const r = validateManifest(withNotes(undefined));
    expect(r.ok).toBe(true);
  });
});
