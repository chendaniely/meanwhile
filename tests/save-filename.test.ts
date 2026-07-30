// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { filenameForSave, filesForSave } from '../src/viewer/App.tsx';
import { parseCsv } from '../src/core/csv.ts';
import { mergeNotes, type Note } from '../src/core/notes.ts';
import { parsePeopleCsv } from '../src/core/people-csv.ts';
import { SCHEMA_VERSION, type Manifest } from '../src/core/schema.ts';

/**
 * The name of the file Save downloads. Saving is not a one-off — you write a
 * few notes, save, write more, save again — so every download carries the
 * moment it was made, or they collide in the browser's downloads folder and
 * you are left picking between `meanwhile-race (2).zip` and
 * `meanwhile-race (3).zip`.
 *
 * jsdom only because `App.tsx` pulls in the whole viewer on import; nothing
 * here touches the DOM.
 */

// 2026-07-30 09:12 LOCAL. Built from parts rather than parsed from a string
// so it means the same wall-clock time whatever zone the test runs in — a
// literal like '2026-07-30T09:12Z' would be 09:12 only in UTC, and this
// asserts on local-time output.
const AT = new Date(2026, 6, 30, 9, 12);

describe('filenameForSave', () => {
  it('carries the event name and the moment of saving', () => {
    expect(filenameForSave('Cascade Crest 100', AT)).toBe(
      'meanwhile-cascade-crest-100-2026-07-30-0912.zip',
    );
  });

  it('still produces a legal name when the event has no title', () => {
    expect(filenameForSave('', AT)).toBe('meanwhile-2026-07-30-0912.zip');
    expect(filenameForSave('   ', AT)).toBe('meanwhile-2026-07-30-0912.zip');
  });

  it('pads month, day, hour and minute so the names sort as plain text', () => {
    // A single-digit month/day/hour/minute is where an unpadded stamp stops
    // sorting: "2026-7-5-903" lands after "2026-10-...".
    const early = new Date(2026, 0, 5, 9, 3);
    expect(filenameForSave('Race', early)).toBe('meanwhile-race-2026-01-05-0903.zip');
  });

  it('uses a 24-hour clock, like the rest of the app', () => {
    const evening = new Date(2026, 6, 30, 21, 45);
    expect(filenameForSave('Race', evening)).toBe('meanwhile-race-2026-07-30-2145.zip');
  });

  it('reduces punctuation and accents in a title to a plain slug', () => {
    // Whatever someone types as an event name has to survive into a filename
    // every OS will accept, so anything outside a-z0-9 collapses to a hyphen.
    expect(filenameForSave("Sam's 100-miler!", AT)).toBe(
      'meanwhile-sam-s-100-miler-2026-07-30-0912.zip',
    );
  });

  it('never leaves a leading or trailing hyphen on the slug', () => {
    expect(filenameForSave('!!! Race !!!', AT)).toBe('meanwhile-race-2026-07-30-0912.zip');
  });

  it('produces a name .gitignore still keeps out of the repo', () => {
    // `.gitignore` matches these with `meanwhile-*.zip`. Event data must
    // never reach git, and the save zip carries notes.csv and people.csv.
    for (const title of ['Cascade Crest 100', '']) {
      expect(filenameForSave(title, AT)).toMatch(/^meanwhile-.*\.zip$/);
    }
  });
});

/**
 * What actually leaves the browser. `filesForSave` is the last thing that
 * touches a season of someone's writing, and each of these is a way the
 * 2026-07-30 columns could be added to the reader and quietly dropped by the
 * writer — which is the failure the owner would only find much later, after
 * the notes were committed.
 */
describe('filesForSave', () => {
  const manifest: Manifest = {
    schema: SCHEMA_VERSION,
    event: { title: 'Race', timezone: 'America/Denver' },
    people: [{ id: 'p', name: 'Priya' }],
    items: [],
  };
  const note = (over: Partial<Note>): Note => ({
    id: 'n_a', at: '2026-07-25T21:45:00.000Z', people: [], author: ['Dan'], text: 'x', ...over,
  });
  const notesCsv = (files: Array<{ name: string; text: string }>) =>
    files.find((f) => f.name === 'notes.csv')?.text ?? '';
  const peopleCsv = (files: Array<{ name: string; text: string }>) =>
    files.find((f) => f.name === 'people.csv')?.text ?? '';

  it('writes tombstones into notes.csv, not just the live notes', () => {
    const files = filesForSave(
      manifest,
      [note({ id: 'n_live', text: 'still here' })],
      [note({ id: 'n_gone', text: 'removed', deleted: true })],
    );
    const { notes } = mergeNotes([{ name: 'notes.csv', text: notesCsv(files) }], 'America/Denver');
    expect(notes.map((n) => n.id).sort()).toEqual(['n_gone', 'n_live']);
    expect(notes.find((n) => n.id === 'n_gone')?.deleted).toBe(true);
  });

  it('keeps the file in one chronological list, tombstones included', () => {
    const files = filesForSave(
      manifest,
      [note({ id: 'n_late', at: '2026-07-25T23:00:00.000Z', text: 'late' })],
      [note({ id: 'n_early', at: '2026-07-25T09:00:00.000Z', text: 'early', deleted: true })],
    );
    const { rows } = parseCsv(notesCsv(files));
    expect(rows.map((r) => r.id)).toEqual(['n_early', 'n_late']);
  });

  it('keeps an unknown column that only a tombstone carries', () => {
    // Headers are computed over both lists; over the live notes alone, this
    // column vanishes from the file entirely.
    const files = filesForSave(
      manifest, [note({})], [note({ id: 'n_gone', deleted: true, extra: { tags: 'night' } })],
    );
    expect(parseCsv(notesCsv(files)).headers).toContain('tags');
  });

  it('keeps a people.csv column this app has no meaning for', () => {
    const files = filesForSave(manifest, [], [], new Map([['p', { pronouns: 'she/her' }]]));
    expect(parsePeopleCsv(peopleCsv(files)).extra.get('p')).toEqual({ pronouns: 'she/her' });
  });

  it('stamps the schema version onto both CSVs', () => {
    const files = filesForSave(manifest, [note({})], []);
    expect(parseCsv(notesCsv(files)).rows[0]?.schema).toBe('1');
    expect(parseCsv(peopleCsv(files)).rows[0]?.schema).toBe('1');
  });

  it('writes tz and utc_offset_min on every row, so a later zone change cannot move it', () => {
    const files = filesForSave(manifest, [note({})], []);
    const row = parseCsv(notesCsv(files)).rows[0];
    expect(row?.tz).toBe('America/Denver');
    expect(row?.utc_offset_min).toBe('-360');
  });

  it('still writes a manifest with no legacy note fields', () => {
    const files = filesForSave(manifest, [note({})], []);
    const text = files.find((f) => f.name === 'manifest.json')?.text ?? '';
    expect(JSON.parse(text)).not.toHaveProperty('notes');
  });
});

/**
 * The whole point of the `schema` column, tested at the seam it was failing
 * at: a row this build refuses must be in the file the next Save writes.
 *
 * Before this, "meanwhile could not read this row" and "meanwhile deleted
 * this row" were one event — so the message advising someone to "update the
 * site, or clear the schema cell" described a repair for data that a single
 * Save had already put beyond reach.
 */
describe('filesForSave — rows this build could not read', () => {
  const manifest: Manifest = {
    schema: SCHEMA_VERSION,
    event: { title: 'Race', timezone: 'UTC' },
    people: [{ id: 'p1', name: 'Priya' }],
    items: [],
  };
  const note = (over: Partial<Note>): Note => ({
    id: 'n_a', at: '2026-07-25T12:00:00.000Z', people: [], author: [], text: 'x', ...over,
  });
  const preservedNote = (cells: Record<string, string>) => ({ file: 'notes.csv', line: 3, cells });
  const notesCsv = (files: Array<{ name: string; text: string }>) =>
    files.find((f) => f.name === 'notes.csv')?.text ?? '';
  const peopleCsv = (files: Array<{ name: string; text: string }>) =>
    files.find((f) => f.name === 'people.csv')?.text ?? '';

  it('writes a refused notes.csv row straight back out, verbatim', () => {
    const files = filesForSave(manifest, [note({ id: 'n_ok', text: 'readable' })], [], undefined, {
      notes: [preservedNote({
        id: 'n_future', year: '2026', month: '7', day: '25', hour: '13', minute: '0',
        text: 'from a newer build', schema: '2',
      })],
      people: [],
    });
    const rows = parseCsv(notesCsv(files)).rows;
    expect(rows.map((r) => r['id'])).toEqual(['n_ok', 'n_future']);
    // NOT rewritten to this build's schema — doing so would be this build
    // claiming it had understood the row.
    expect(rows[1]?.['schema']).toBe('2');
    expect(rows[1]?.['text']).toBe('from a newer build');
  });

  it('places a preserved row in time, among the notes rather than after them', () => {
    const files = filesForSave(
      manifest,
      [note({ id: 'n_early', at: '2026-07-25T09:00:00.000Z' }),
       note({ id: 'n_late', at: '2026-07-25T23:00:00.000Z' })],
      [],
      undefined,
      {
        notes: [preservedNote({
          id: 'n_mid', year: '2026', month: '7', day: '25', hour: '12', minute: '0', text: 'x',
        })],
        people: [],
      },
    );
    expect(parseCsv(notesCsv(files)).rows.map((r) => r['id']))
      .toEqual(['n_early', 'n_mid', 'n_late']);
  });

  it('keeps a column only a preserved row carries', () => {
    const files = filesForSave(manifest, [note({})], [], undefined, {
      notes: [preservedNote({ id: 'n_f', text: 'x', schema: '2', weather: 'sleet' })],
      people: [],
    });
    expect(parseCsv(notesCsv(files)).headers).toContain('weather');
    expect(parseCsv(notesCsv(files)).rows.map((r) => r['weather'])).toContain('sleet');
  });

  it('writes a refused people.csv row back too', () => {
    const files = filesForSave(manifest, [], [], undefined, {
      notes: [],
      people: [{ file: 'people.csv', line: 3, cells: { id: 'p2', name: 'Sam', schema: '2' } }],
    });
    const rows = parseCsv(peopleCsv(files)).rows;
    expect(rows.map((r) => r['id'])).toEqual(['p1', 'p2']);
    expect(rows[1]?.['schema']).toBe('2');
  });

  it('survives being read and saved again — every time, not just the first', () => {
    // The property that matters over months: the row is refused on every
    // load, so it must be preserved on every save, or the second save is
    // simply the first bug delayed.
    const text = [
      'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema',
      'n_ok,2026,7,25,10,0,,UTC,0,,,,readable,,,',
      'n_future,2026,7,25,11,0,,UTC,0,,,,from a newer build,,,2',
    ].join('\n');
    let round = text;
    for (let i = 0; i < 3; i++) {
      const merged = mergeNotes([{ name: 'notes.csv', text: round }], 'UTC');
      expect(merged.notes.map((n) => n.text)).toEqual(['readable']);
      expect(merged.preserved).toHaveLength(1);
      round = notesCsv(
        filesForSave(manifest, merged.notes, [], undefined, { notes: merged.preserved, people: [] }),
      );
    }
    expect(round).toContain('from a newer build');
  });

  it('throws a legible message rather than a bare RangeError on an unusable zone', () => {
    // The other half of the same failure: this used to escape the Save click
    // handler as `RangeError: Invalid time zone specified: MDT` — no file, no
    // message, nothing saved. App.tsx now catches it and shows the text.
    const bad = note({ id: 'n_tz', tz: 'MDT' });
    expect(() => filesForSave(manifest, [bad], [])).toThrow(/note "n_tz"/);
    expect(() => filesForSave(manifest, [bad], [])).not.toThrow(/Invalid time zone specified/);
  });
});
