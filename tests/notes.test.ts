import { describe, expect, it } from 'vitest';
import { formatCsv, parseCsv } from '../src/core/csv.ts';
import {
  dedupeNotes,
  fingerprintNote,
  mergeNotes,
  mintNoteId,
  noteHeadersFor,
  noteToRow,
  partitionDeleted,
  resolveNotePhotos,
  rowToNote,
  stampBlankAuthors,
  type Note,
} from '../src/core/notes.ts';
import type { Item } from '../src/core/schema.ts';
import { NOTES_CSV_BEFORE } from './fixtures/csv-before-2026-07-30.ts';

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

  it('rejects a blank numeric field rather than resolving Number("") to 0', () => {
    expect(rowToNote(row({ minute: '' }), ZONE)).toHaveProperty('error');
  });

  it('rejects a row with every timestamp field blank', () => {
    const note = rowToNote(
      row({ year: '', month: '', day: '', hour: '', minute: '' }),
      ZONE,
    );
    expect(note).toHaveProperty('error');
  });

  it('reads an Excel serial date onto the same instant as the explicit form', () => {
    // Days between the Excel epoch (1899-12-30) and 2026-07-25.
    const serial = String(Math.round((Date.UTC(2026, 6, 25) - Date.UTC(1899, 11, 30)) / 86_400_000));
    const legacy = { id: 'n_1', date: serial, time: '15:45', text: 'x' };
    const note = rowToNote(legacy, ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
  });

  it('reads a day-fraction time onto the same instant as the explicit form', () => {
    // 15:45 as a fraction of a day: (15*60 + 45) / 1440.
    const legacy = { id: 'n_1', date: '2026-07-25', time: String(945 / 1440), text: 'x' };
    const note = rowToNote(legacy, ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
  });

  it('reads a 12-hour AM/PM time onto the same instant as the explicit form', () => {
    const legacy = { id: 'n_1', date: '2026-07-25', time: '3:45 PM', text: 'x' };
    const note = rowToNote(legacy, ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
  });

  it('collapses newlines in the text, which break naive tooling', () => {
    const note = rowToNote(row({ text: 'first\nsecond' }), ZONE) as Note;
    expect(note.text).toBe('first second');
  });
});

/**
 * Every one of these was VERIFIED silently accepted before this change, and
 * every one then rewrote itself on the next save — so the file stopped saying
 * what its author typed and nothing ever reported it. `Date.UTC` rolls all of
 * them over into a different, plausible-looking moment; a note placed
 * confidently in the wrong place is worse than a visible gap, which is the
 * whole reason this project refuses rather than repairs.
 */
describe('the five integers are range-checked, never rolled over', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['a two-digit year, which Date.UTC reads as 1926', { year: '26' }, 'four-digit'],
    ['a three-digit year', { year: '226' }, 'four-digit'],
    ['month 13, which rolls into next January', { month: '13' }, 'month runs 1–12'],
    ['month 0, which rolls back into December', { month: '0' }, 'month runs 1–12'],
    ['day 32, which rolls into next month', { day: '32' }, 'day runs 1–31'],
    ['day 30 in February, which rolls to 2 March', { month: '2', day: '30' }, 'February 2026 has 28 days'],
    ['hour 24, which rolls into tomorrow', { hour: '24' }, 'hour runs 0–23'],
    ['hour 25', { hour: '25' }, 'hour runs 0–23'],
    ['minute 60, which rolls into the next hour', { minute: '60' }, 'minute runs 0–59'],
    ['minute 99', { minute: '99' }, 'minute runs 0–59'],
    ['a fractional minute, which Number() truncates', { minute: '45.7' }, 'not a whole number'],
    ['a fractional hour', { hour: '12.5' }, 'not a whole number'],
    ['exponent notation, which Number() happily reads as 10', { hour: '1e1' }, 'not a whole number'],
  ];

  for (const [what, override, expected] of cases) {
    it(`refuses ${what}`, () => {
      const result = rowToNote(row(override), ZONE);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain(expected);
    });
  }

  it('still accepts every legal edge of each range', () => {
    for (const ok of [{ month: '1' }, { month: '12' }, { day: '1' }, { day: '31', month: '12' },
      { hour: '0' }, { hour: '23' }, { minute: '0' }, { minute: '59' }, { year: '1900' },
      { year: '2100' }, { day: '29', month: '2', year: '2028' }]) {
      expect(rowToNote(row(ok), ZONE)).not.toHaveProperty('error');
    }
  });

  it('applies the same check to the legacy date/time columns', () => {
    // The two shapes must not disagree about what is readable, or a file
    // repairs itself into something the strict path would have refused.
    const legacy = { id: 'n_1', date: '2026-02-30', time: '15:45', text: 'x' };
    expect(rowToNote(legacy, ZONE)).toHaveProperty('error');
  });
});

describe('tz and utc_offset_min', () => {
  it('lets the offset pick between the two 01:30s of a fall-back night', () => {
    // 2026-11-01, America/Denver: 01:30 happens twice, an hour apart. Five
    // integers plus a zone NAME cannot tell them apart — a zone-only read
    // returns the earlier one both times. The offset can.
    const fallBack = { year: '2026', month: '11', day: '1', hour: '1', minute: '30' };
    const mdt = rowToNote(row({ ...fallBack, tz: ZONE, utc_offset_min: '-360' }), ZONE) as Note;
    const mst = rowToNote(row({ ...fallBack, tz: ZONE, utc_offset_min: '-420' }), ZONE) as Note;
    expect(mdt.at).toBe(new Date(Date.UTC(2026, 10, 1, 7, 30)).toISOString());
    expect(mst.at).toBe(new Date(Date.UTC(2026, 10, 1, 8, 30)).toISOString());
    expect(Date.parse(mst.at) - Date.parse(mdt.at)).toBe(3_600_000);

    // And each one writes back the offset it was read with, so the
    // distinction survives a save. This is the whole point.
    expect(noteToRow(mdt, ZONE).utc_offset_min).toBe('-360');
    expect(noteToRow(mst, ZONE).utc_offset_min).toBe('-420');
  });

  it('reports a zone and an offset that genuinely disagree, rather than picking one', () => {
    const result = rowToNote(row({ tz: ZONE, utc_offset_min: '330' }), ZONE);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('America/Denver');
    expect((result as { error: string }).error).toContain('330');
  });

  it('takes the offset as authoritative when no zone is named', () => {
    const note = rowToNote(row({ tz: '', utc_offset_min: '-300' }), ZONE) as Note;
    expect(note.at).toBe(new Date(Date.UTC(2026, 6, 25, 20, 45)).toISOString());
  });

  it('refuses an offset that is not a whole number of minutes, or is impossible', () => {
    expect(rowToNote(row({ utc_offset_min: '-6:00' }), ZONE)).toHaveProperty('error');
    expect(rowToNote(row({ utc_offset_min: '5000' }), ZONE)).toHaveProperty('error');
  });
});

describe('the schema column', () => {
  it('refuses a row written by a newer build, naming the file and what to do', () => {
    const result = rowToNote(row({ schema: '2' }), ZONE);
    expect(result).toHaveProperty('error');
    const { error } = result as { error: string };
    expect(error).toContain('notes.csv');
    expect(error).toContain('update the site');
  });

  it('accepts a blank schema as "the version this reader knows"', () => {
    expect(rowToNote(row({ schema: '' }), ZONE)).not.toHaveProperty('error');
  });

  it('accepts the current version and anything older', () => {
    expect(rowToNote(row({ schema: '1' }), ZONE)).not.toHaveProperty('error');
    expect(rowToNote(row({ schema: '0' }), ZONE)).not.toHaveProperty('error');
  });

  it('refuses a schema that is not a whole number rather than guessing at it', () => {
    expect(rowToNote(row({ schema: 'one' }), ZONE)).toHaveProperty('error');
  });

  it('does not let the schema cell fall through into extra', () => {
    const note = rowToNote(row({ schema: '1' }), ZONE) as Note;
    expect(note.extra).toBeUndefined();
  });
});

describe('written and deleted', () => {
  it('reads written as epoch seconds and writes it straight back', () => {
    const note = rowToNote(row({ written: '1753500000' }), ZONE) as Note;
    expect(note.written).toBe(1753500000);
    expect(noteToRow(note, ZONE).written).toBe('1753500000');
  });

  it('leaves written blank when nothing recorded it', () => {
    expect((rowToNote(row(), ZONE) as Note).written).toBeUndefined();
    expect(noteToRow(rowToNote(row(), ZONE) as Note, ZONE).written).toBe('');
  });

  it('refuses a written that is not a whole number of seconds', () => {
    expect(rowToNote(row({ written: 'yesterday' }), ZONE)).toHaveProperty('error');
  });

  it('reads deleted=1 as a tombstone, and blank or 0 as a live note', () => {
    expect((rowToNote(row({ deleted: '1' }), ZONE) as Note).deleted).toBe(true);
    expect((rowToNote(row({ deleted: '0' }), ZONE) as Note).deleted).toBeUndefined();
    expect((rowToNote(row({ deleted: '' }), ZONE) as Note).deleted).toBeUndefined();
  });

  it('refuses a deleted cell that is neither, rather than assuming it is live', () => {
    // Assuming "live" would resurrect a note someone deleted; assuming
    // "deleted" would hide one nobody did. Neither is guessable.
    expect(rowToNote(row({ deleted: 'yes' }), ZONE)).toHaveProperty('error');
  });
});

describe('noteToRow', () => {
  it('writes five integers, unpadded', () => {
    const note = rowToNote(row(), ZONE) as Note;
    const out = noteToRow(note, ZONE);
    expect(out).toMatchObject({ year: '2026', month: '7', day: '25', hour: '15', minute: '45' });
  });

  /**
   * REVERSED 2026-07-30. `tz` used to be blanked whenever it agreed with the
   * event's zone, on the reasoning that the row would pick the same zone up
   * again on read. It does — until `event.timezone` changes, at which point
   * every note silently MOVES while the zoned-EXIF photographs beside them
   * stay put, and nothing on the row records which zone was meant. That is
   * unfixable after the fact, which is why the column is now always written.
   */
  it('always writes tz, even when it matches the event', () => {
    expect(noteToRow(rowToNote(row({ tz: ZONE }), ZONE) as Note, ZONE).tz).toBe(ZONE);
    // And a row that never named a zone gets the event's written into it,
    // rather than staying blank and deferring to whatever it is next time.
    expect(noteToRow(rowToNote(row(), ZONE) as Note, ZONE).tz).toBe(ZONE);
  });

  it('writes the UTC offset in force at that instant, as whole minutes', () => {
    // Denver is UTC-6 in July and UTC-7 in January; the offset is read from
    // the instant, so it is right on both sides of the transition with
    // nothing stored to remember it by.
    expect(noteToRow(rowToNote(row(), ZONE) as Note, ZONE).utc_offset_min).toBe('-360');
    expect(noteToRow(rowToNote(row({ month: '1' }), ZONE) as Note, ZONE).utc_offset_min)
      .toBe('-420');
  });

  it('writes the schema version last, so a reader knows what it is holding', () => {
    const out = noteToRow(rowToNote(row(), ZONE) as Note, ZONE);
    expect(out.schema).toBe('1');
  });

  it('round-trips through a row without losing anything', () => {
    const note = rowToNote(row({
      people: 'Priya;Sam', author: 'Dan;Priya', duration: 'PT3H40M',
      photo: 'a.jpg', tags: 'night', tz: ZONE, written: '1753500000',
    }), ZONE) as Note;
    expect(rowToNote(noteToRow(note, ZONE), ZONE)).toEqual(note);
  });

  it('is a fixed point after one write, for a note that never named a zone', () => {
    // `tz` is filled in on the first write (see above), so the first round
    // trip legitimately ADDS a field. Everything after that must be stable,
    // or a save-reload-save loop would keep rewriting the same file.
    const note = rowToNote(row(), ZONE) as Note;
    const once = rowToNote(noteToRow(note, ZONE), ZONE) as Note;
    expect(once.at).toBe(note.at);
    expect(once.tz).toBe(ZONE);
    expect(rowToNote(noteToRow(once, ZONE), ZONE)).toEqual(once);
  });

  it('writes a tombstone as deleted=1 and a live note as blank', () => {
    const note = rowToNote(row(), ZONE) as Note;
    expect(noteToRow(note, ZONE).deleted).toBe('');
    expect(noteToRow({ ...note, deleted: true }, ZONE).deleted).toBe('1');
  });
});

describe('mergeNotes', () => {
  const file = (name: string, body: string) => ({
    name,
    text: 'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' + body,
  });

  it('row-binds several files and sorts by time', () => {
    const { notes } = mergeNotes([
      file('notes-dan.csv', 'n_b,2026,7,25,16,0,,,,,Dan,second\n'),
      file('notes-priya.csv', 'n_a,2026,7,25,15,0,,,,,Priya,first\n'),
    ], ZONE);
    expect(notes.map((n) => n.text)).toEqual(['first', 'second']);
  });

  it('reports the real file line when blank lines sit above a bad row', () => {
    // `parseCsv` drops blank records, so counting surviving rows understates
    // the line number. These numbers exist so someone can open the file in a
    // spreadsheet and go to the row that is wrong.
    const { problems } = mergeNotes([
      file('n.csv', '\n\nn_a,2026,7,25,15,0,,,,,Dan,fine\nn_b,nope,7,25,15,0,,,,,Dan,bad\n'),
    ], ZONE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('row 5');
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

  it('keeps two rows differing only in people, even with the same id and time', () => {
    const { notes } = mergeNotes([
      file('a.csv', 'n_x,2026,7,25,15,0,,,Dan,,Dan,same\n'),
      file('b.csv', 'n_x,2026,7,25,15,0,,,Priya,,Dan,same\n'),
    ], ZONE);
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });

  it('dedupes the same id and content even when people/author are reordered', () => {
    // Reordering names in a spreadsheet — e.g. sorting the column — is a
    // completely ordinary edit and must not be read as a content change.
    const { notes } = mergeNotes([
      file('a.csv', 'n_x,2026,7,25,15,0,,,Priya;Sam,,Dan;Ana,same\n'),
      file('b.csv', 'n_x,2026,7,25,15,0,,,Sam;Priya,,Ana;Dan,same\n'),
    ], ZONE);
    expect(notes).toHaveLength(1);
  });

  it('dedupes a blank tz against an explicit tz that matches the event zone', () => {
    // `noteToRow` leaves `tz` blank when it agrees with the event; a row
    // that spells the event's own zone out by hand says the same thing.
    const { notes } = mergeNotes([
      file('a.csv', 'n_x,2026,7,25,15,0,,,,,Dan,same\n'),
      file('b.csv', `n_x,2026,7,25,15,0,,${ZONE},,,Dan,same\n`),
    ], ZONE);
    expect(notes).toHaveLength(1);
  });

  it('threads a rowIdentity map through to dedupeNotes, so a blank-id row keeps its id across two calls', () => {
    const blankIdRow = ',2026,7,25,15,0,,,,,,hand-typed note\n';
    const rowIdentity = new Map<string, string>();
    const first = mergeNotes([file('notes.csv', blankIdRow)], ZONE, rowIdentity);
    const second = mergeNotes([file('notes.csv', blankIdRow)], ZONE, rowIdentity);
    expect(second.notes[0]?.id).toBe(first.notes[0]?.id);
  });
});

/**
 * The half of this work that matters most. Every reader has to accept a file
 * written before the 2026-07-30 columns existed and produce exactly what it
 * produced then — the fixture is frozen (see its header) so a reader and a
 * writer cannot drift together and still agree with each other.
 */
describe('a notes.csv written before the 2026-07-30 columns existed', () => {
  const parsed = () => mergeNotes([{ name: 'notes.csv', text: NOTES_CSV_BEFORE }], ZONE);

  it('reads every row, with no problems reported', () => {
    const { notes, problems } = parsed();
    expect(problems).toEqual([]);
    expect(notes).toHaveLength(3);
  });

  /** Sorted by `at`, so rows are found by id rather than by file position. */
  const byId = (notes: readonly Note[], id: string) => notes.find((n) => n.id === id);

  it('resolves the same instants it always did', () => {
    const { notes } = parsed();
    // Blank tz, so the event's zone: 15:45 Denver in July is 21:45Z.
    expect(byId(notes, 'n_k3f9x2')?.at)
      .toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
    // An explicit tz of UTC, which must still beat the event's zone.
    expect(byId(notes, 'n_p1a7m4')?.at)
      .toBe(new Date(Date.UTC(2026, 6, 25, 15, 53)).toISOString());
    // The blank-id row, at 03:00 Denver the next morning.
    expect(notes.find((n) => n.duration !== undefined)?.at)
      .toBe(new Date(Date.UTC(2026, 6, 26, 9, 0)).toISOString());
  });

  it('keeps ids, text, people, author, duration, photo and the unknown column', () => {
    const { notes } = parsed();
    expect(byId(notes, 'n_k3f9x2')?.text).toBe('wrong turn on the ridge');
    expect(byId(notes, 'n_k3f9x2')?.author).toEqual(['Dan']);
    expect(byId(notes, 'n_p1a7m4')?.people).toEqual(['Priya', 'Sam']);
    expect(byId(notes, 'n_p1a7m4')?.photo).toBe('PXL_20260725_215331309.jpg');
    expect(byId(notes, 'n_p1a7m4')?.extra).toEqual({ tags: 'night' });
    const minted = notes.find((n) => n.duration !== undefined);
    // A blank id is minted, as it always was — and now always ends in a
    // letter, so Excel's fill handle cannot increment it.
    expect(minted?.id).toMatch(/^n_.*[a-z]$/);
    expect(minted?.duration).toBe('PT3H40M');
  });

  it('carries none of the new columns as data, and none as tombstones', () => {
    const { notes } = parsed();
    for (const note of notes) {
      expect(note.written).toBeUndefined();
      expect(note.deleted).toBeUndefined();
    }
  });

  it('repairs itself into the new shape on the first save, losing nothing', () => {
    const { notes } = parsed();
    const text = formatCsv(
      noteHeadersFor(notes),
      notes.map((n) => noteToRow(n, ZONE)),
    );
    const { notes: reread, problems } = mergeNotes([{ name: 'notes.csv', text }], ZONE);
    expect(problems).toEqual([]);
    // Same instants, same ids, same content — the file changed shape and
    // said the same thing.
    expect(reread.map((n) => n.at)).toEqual(notes.map((n) => n.at));
    expect(reread.map((n) => n.id)).toEqual(notes.map((n) => n.id));
    expect(reread.map((n) => n.text)).toEqual(notes.map((n) => n.text));
    expect(reread.find((n) => n.id === 'n_p1a7m4')?.extra).toEqual({ tags: 'night' });
    // And it now carries the marker and the offsets it was missing.
    expect(text).toContain('schema');
    expect(text).toContain('utc_offset_min');
  });
});

describe('deleted notes', () => {
  const file = (name: string, body: string) => ({
    name,
    text:
      'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,' +
      'author,text,written,deleted,schema\n' + body,
  });

  it('lets a tombstone win over a live row with the same id, in either file order', () => {
    const live = 'n_x,2026,7,25,15,0,,,,,,Dan,a wrong turn,,,1\n';
    const dead = 'n_x,2026,7,25,15,0,,,,,,Dan,a wrong turn,,1,1\n';
    for (const files of [[file('a.csv', live), file('b.csv', dead)],
      [file('a.csv', dead), file('b.csv', live)]]) {
      const { notes } = mergeNotes(files, ZONE);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.deleted).toBe(true);
    }
  });

  it('keeps the tombstone in the list so it can be written back out', () => {
    // Dropping it here would undo the deletion the moment anyone merged an
    // older copy of the file — exactly what the column exists to stop.
    const { notes } = mergeNotes(
      [file('a.csv', 'n_x,2026,7,25,15,0,,,,,,Dan,gone,,1,1\n')], ZONE,
    );
    const { live, deleted } = partitionDeleted(notes);
    expect(live).toEqual([]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.text).toBe('gone');
  });

  it('does not swallow a hand-typed blank-id row that matches a tombstone', () => {
    // A blank `id` is the documented way to add a note by hand, and it has
    // no identity for a tombstone to address. Dropping it would lose
    // something a person typed because its text happened to match something
    // deleted earlier — the worse of the two failures, since the other (a
    // deleted note reappearing) is visible and can simply be deleted again.
    const { notes } = mergeNotes([
      file('a.csv', 'n_x,2026,7,25,15,0,,UTC,0,,,Dan,a wrong turn,,1,1\n'),
      file('b.csv', ',2026,7,25,15,0,,UTC,0,,,Dan,a wrong turn,,,1\n'),
    ], 'UTC');
    const { live, deleted } = partitionDeleted(notes);
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe('n_x');
    expect(deleted).toHaveLength(1);
  });

  it('leaves an unrelated note alone', () => {
    const { notes } = mergeNotes([file('a.csv',
      'n_x,2026,7,25,15,0,,,,,,Dan,gone,,1,1\nn_y,2026,7,25,16,0,,,,,,Dan,kept,,,1\n')], ZONE);
    expect(partitionDeleted(notes).live.map((n) => n.text)).toEqual(['kept']);
  });
});

describe('dedupeNotes', () => {
  const note = (over: Partial<Note> = {}): Note => ({
    id: 'n_a', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x', ...over,
  });

  it('drops an exact repeat of the same id and content', () => {
    expect(dedupeNotes([note(), note()])).toHaveLength(1);
  });

  it('re-mints one side of a same-id, different-content collision, keeping both', () => {
    const out = dedupeNotes([note({ text: 'one' }), note({ text: 'two' })]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((n) => n.id)).size).toBe(2);
  });

  it('mints an id for a note with none', () => {
    const out = dedupeNotes([note({ id: '' })]);
    expect(out[0]?.id).toMatch(/^n_/);
  });

  /**
   * The root-cause fix for a THIRD symptom of the same bug (a blank-id row
   * has no identity of its own across parses): editing a hand-typed note
   * and then deleting it used to resurrect it under the pre-edit text,
   * because the delete tombstone recorded the EDITED content's fingerprint
   * while the fresh re-parse still produced the original. Giving the row a
   * STABLE id via `rowIdentity` fixes this and the two earlier symptoms
   * (duplication on add, resurrection on delete) at their source, rather
   * than patching a fourth one — every id-based mechanism downstream works
   * unchanged once ids behave the way the rest of the design assumed.
   */
  describe('rowIdentity', () => {
    const blank = (over: Partial<Note> = {}): Note => ({
      id: '', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x', ...over,
    });

    it('reuses the id from an earlier call for the same content, instead of minting a new one', () => {
      const rowIdentity = new Map<string, string>();
      const first = dedupeNotes([blank()], undefined, rowIdentity);
      const second = dedupeNotes([blank()], undefined, rowIdentity);
      expect(second[0]?.id).toBe(first[0]?.id);
    });

    it('does not let two identical blank-id rows in the SAME call collapse into one', () => {
      // Content alone cannot distinguish two rows typed once from the same
      // row read twice — only a row seen in an EARLIER call gets reused;
      // rowIdentity is a snapshot taken at the start of each call, so a
      // sibling row minting a fresh id moments earlier in this same loop
      // must not be handed out to a second row that merely matches it.
      const row = blank({ text: 'same text, typed twice' });
      const out = dedupeNotes([row, row], undefined, new Map());
      expect(out).toHaveLength(2);
      expect(new Set(out.map((n) => n.id)).size).toBe(2);
    });

    /**
     * Measured at 2 → 3 → 4 → 5 → 6 notes over five rounds before this fix.
     * The shape is ordinary: someone saves `notes.csv` (ids filled in), a
     * crew member still has the pristine copy whose rows are blank-`id`, and
     * both land back in the folder. `rowIdentity` only stabilises an id
     * within a session and the ided row had already claimed its slot, so
     * every round minted one more phantom.
     */
    it('does not grow the count when a saved copy is merged with a pristine blank-id one', () => {
      const rowIdentity = new Map<string, string>();
      const pristine = [blank({ text: 'one' }), blank({ text: 'two' })];
      let current = dedupeNotes(pristine, ZONE, rowIdentity);
      expect(current).toHaveLength(2);

      for (let round = 0; round < 5; round++) {
        // The saved file (ids) row-bound with the pristine one (blank ids).
        current = dedupeNotes([...current, ...pristine], ZONE, rowIdentity);
        expect(current).toHaveLength(2);
      }
      expect(current.map((n) => n.text).sort()).toEqual(['one', 'two']);
    });

    it('adopts an existing id whichever side of the merge it arrives on', () => {
      const ided: Note = {
        id: 'n_kept', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x',
      };
      for (const order of [[ided, blank()], [blank(), ided]]) {
        const out = dedupeNotes(order, ZONE, new Map());
        expect(out).toHaveLength(1);
        expect(out[0]?.id).toBe('n_kept');
      }
    });

    it('mints a fresh id exactly as before when rowIdentity is omitted', () => {
      const out = dedupeNotes([blank()]);
      expect(out[0]?.id).toMatch(/^n_/);
    });

    it('gives a genuinely different note (even sharing an id-collision path) its own identity', () => {
      // Sanity check that rowIdentity only ever affects the BLANK-id branch:
      // an explicit-id collision with different content still re-mints, the
      // same as without rowIdentity at all.
      const rowIdentity = new Map<string, string>();
      const out = dedupeNotes(
        [note({ text: 'one' }), note({ text: 'two' })],
        undefined,
        rowIdentity,
      );
      expect(out).toHaveLength(2);
      expect(new Set(out.map((n) => n.id)).size).toBe(2);
    });
  });
});

describe('mintNoteId', () => {
  /**
   * Excel's fill handle increments a trailing NUMBER when a cell is dragged,
   * so `n_abc12` dragged down a column silently becomes `n_abc13`, `n_abc14`
   * — ids for notes that do not exist, and rows detached from their own
   * identity. The base-36 mint ended in a digit 26.9% of the time. 400 draws
   * is far more than enough to catch a regression at that rate.
   */
  it('never ends in a digit, which a spreadsheet fill handle would increment', () => {
    for (let i = 0; i < 400; i++) {
      expect(mintNoteId()).toMatch(/[a-z]$/);
    }
  });

  it('still starts with the n_ prefix everything else matches on', () => {
    expect(mintNoteId()).toMatch(/^n_/);
  });
});

describe('fingerprintNote', () => {
  it('is order-independent for people and author', () => {
    const a = fingerprintNote({
      id: 'x', at: '2026-07-25T21:45:00.000Z', people: ['Priya', 'Sam'],
      author: ['Dan', 'Ana'], text: 'same',
    });
    const b = fingerprintNote({
      id: 'x', at: '2026-07-25T21:45:00.000Z', people: ['Sam', 'Priya'],
      author: ['Ana', 'Dan'], text: 'same',
    });
    expect(a).toBe(b);
  });

  it('treats an unset tz and an explicit tz matching the event as the same', () => {
    const a = fingerprintNote(
      { id: 'x', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x' },
      ZONE,
    );
    const b = fingerprintNote(
      { id: 'x', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x', tz: ZONE },
      ZONE,
    );
    expect(a).toBe(b);
  });

  it('treats two spellings of the same instant as identical, milliseconds or not', () => {
    // `rowToNote` always emits Date#toISOString's canonical, millisecond-
    // bearing form; a legacy manifest's `at` is carried through unchanged and
    // very often has none. Same instant, different string — this is exactly
    // what let a legacy manifest note and its own migrated notes.csv copy
    // collide as two notes instead of deduping to one.
    const a = fingerprintNote({
      id: 'x', at: '2026-07-25T09:00:00Z', people: [], author: [], text: 'x',
    });
    const b = fingerprintNote({
      id: 'x', at: '2026-07-25T09:00:00.000Z', people: [], author: [], text: 'x',
    });
    expect(a).toBe(b);
  });

  it('still distinguishes a tz that genuinely disagrees with the event', () => {
    const a = fingerprintNote(
      { id: 'x', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x' },
      ZONE,
    );
    const b = fingerprintNote(
      { id: 'x', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x', tz: 'UTC' },
      ZONE,
    );
    expect(a).not.toBe(b);
  });
});

describe('noteHeadersFor', () => {
  it('is exactly NOTE_HEADERS when nothing carries an extra column', () => {
    const plain: Note = { id: 'n', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x' };
    expect(noteHeadersFor([plain])).toEqual([
      'id', 'year', 'month', 'day', 'hour', 'minute', 'duration',
      'tz', 'utc_offset_min', 'people', 'photo', 'author', 'text',
      'written', 'deleted', 'schema',
    ]);
  });

  it('appends unknown columns in the order first seen, without duplicates', () => {
    const withExtra = (extra: Record<string, string>): Note => ({
      id: 'n', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x', extra,
    });
    const headers = noteHeadersFor([
      withExtra({ tags: 'night' }),
      withExtra({ mood: 'tired', tags: 'night' }),
    ]);
    // `schema` stays genuinely last, after the extras, so "the last column"
    // is a true statement about the file rather than about this module.
    expect(headers.slice(-3)).toEqual(['tags', 'mood', 'schema']);
  });

  it('round-trips an unknown column through save, so a reload does not duplicate the note', () => {
    // This is the failure the finding describes end to end: without
    // `noteHeadersFor`, writing with the fixed `NOTE_HEADERS` alone drops
    // `tags`, which changes the fingerprint on reload and re-mints the note
    // as a SECOND one with the same id instead of the same content.
    const row = (over: Record<string, string> = {}) => ({
      id: 'n_1', year: '2026', month: '7', day: '25', hour: '15', minute: '45',
      duration: '', tz: '', people: '', photo: '', author: '', text: 'wrong turn', ...over,
    });
    const original = rowToNote(row({ tags: 'night' }), ZONE) as Note;
    const csvText = formatCsv(noteHeadersFor([original]), [noteToRow(original, ZONE)]);
    const { rows } = parseCsv(csvText);
    const reloaded = rowToNote(rows[0] as Record<string, string>, ZONE) as Note;

    expect(reloaded.extra).toEqual({ tags: 'night' });
    expect(dedupeNotes([original, reloaded], ZONE)).toHaveLength(1);
  });
});

describe('stampBlankAuthors', () => {
  const blank = (id: string): Note => ({
    id, at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x',
  });
  const authored = (id: string, author: string[]): Note => ({
    id, at: '2026-07-25T21:45:00.000Z', people: [], author, text: 'x',
  });

  it('stamps only the notes with no author', () => {
    const out = stampBlankAuthors([blank('a'), authored('b', ['Priya'])], ['Sam']);
    expect(out.find((n) => n.id === 'a')?.author).toEqual(['Sam']);
    expect(out.find((n) => n.id === 'b')?.author).toEqual(['Priya']);
  });

  it('never blocks a save — an unset "you are" leaves every note untouched', () => {
    const notes = [blank('a'), authored('b', ['Priya'])];
    expect(stampBlankAuthors(notes, [])).toEqual(notes);
  });
});

describe('resolveNotePhotos', () => {
  const item = (id: string): Item => ({
    id, person: 'p', type: 'photo', src: id, timeSource: 'exif-offset', at: '2026-07-25T09:00:00Z',
  });
  const note = (photo: string | undefined): Note => ({
    id: 'n', at: '2026-07-25T09:00:00Z', people: [], author: [], text: 'x',
    ...(photo !== undefined ? { photo } : {}),
  });

  it('leaves an exact item-id match alone', () => {
    const { notes, problems } = resolveNotePhotos([note('priya/a.jpg')], [item('priya/a.jpg')]);
    expect(notes[0]?.photo).toBe('priya/a.jpg');
    expect(problems).toEqual([]);
  });

  it('resolves an unambiguous bare filename to the item id that carries it', () => {
    // The README calls the `photo` column "the filename", and a person
    // typing into the spreadsheet does exactly that — it must resolve when
    // photos sit in a per-person subfolder, not attach to nothing.
    const { notes, problems } = resolveNotePhotos([note('a.jpg')], [item('priya/a.jpg')]);
    expect(notes[0]?.photo).toBe('priya/a.jpg');
    expect(problems).toEqual([]);
  });

  it('reports, rather than guesses, when the filename is ambiguous', () => {
    const items = [item('priya/a.jpg'), item('sam/a.jpg')];
    const { notes, problems } = resolveNotePhotos([note('a.jpg')], items);
    // Left as typed rather than guessed — guessing wrong attaches a caption
    // to the wrong person's photo, worse than leaving it unattached.
    expect(notes[0]?.photo).toBe('a.jpg');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('priya/a.jpg');
    expect(problems[0]).toContain('sam/a.jpg');
  });

  it('leaves a note with no photo untouched, and reports no problem for it', () => {
    const items = [item('priya/a.jpg')];
    const { notes, problems } = resolveNotePhotos([note(undefined)], items);
    expect(notes[0]?.photo).toBeUndefined();
    expect(problems).toEqual([]);
  });

  /**
   * IMPORTANT 7 from the URGENT rename-corruption review (2026-07-30): a
   * `photo` matching NOTHING at all — distinct from matching more than one
   * candidate, above — used to be silently left as typed with no problem
   * reported, the same as a genuinely absent `photo`. A hand-typed filename
   * with a typo, or a photo renamed/deleted after the note was written, is a
   * broken join and must be loud, the same rule `resolveNotePhotos` already
   * applies to an ambiguous match.
   */
  it('reports, rather than silently leaving unlinked, a photo matching nothing at all', () => {
    const items = [item('priya/a.jpg')];
    const { notes, problems } = resolveNotePhotos([note('ghost.jpg')], items);
    expect(notes[0]?.photo).toBe('ghost.jpg');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ghost.jpg');
    expect(problems[0]).toContain('note "n"');
  });
});
