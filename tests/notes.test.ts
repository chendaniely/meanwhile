import { describe, expect, it, vi } from 'vitest';
import { formatCsv, parseCsv } from '../src/core/csv.ts';
import {
  dedupeNotes,
  fingerprintNote,
  mergeNotes,
  mintNoteId,
  noteHeadersFor,
  noteRowsForSave,
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

  /**
   * The convergence property, end to end through the files themselves.
   *
   * The shape is ordinary and was measured growing 3 → 4 → 5 → 6 → 7: a crew
   * member's copy still carries the copy-pasted rows that share one id, and it
   * lands back in the folder next to the `notes.csv` this app saved last time.
   * Every round has to produce the same notes AND the same ids, or the shared
   * file grows a phantom note per cycle forever.
   *
   * THREE colliding rows, not two, and that is the whole reason this test can
   * see anything: with two, the count is stable even when the derived id is a
   * constant, because the one re-minted row is the only one there is. The
   * third row is what forces a second distinct derivation, and what a constant
   * (or random) derivation drops back to `mintUnique()` for.
   */
  it('reaches a fixed point when the saved file is re-merged with the colliding original', () => {
    const crew = file(
      'notes-crew.csv',
      'n_a,2026,7,25,15,0,,,,,Dan,one\n' +
        'n_a,2026,7,25,15,0,,,,,Dan,two\n' +
        'n_a,2026,7,25,15,0,,,,,Dan,three\n',
    );
    // Exactly what Save writes, so this exercises the real round trip rather
    // than a hand-built approximation of it.
    const save = (notes: Note[]) => ({
      name: 'notes.csv',
      text: formatCsv(noteHeadersFor(notes), noteRowsForSave(notes, [], ZONE)),
    });

    let saved = save(mergeNotes([crew], ZONE).notes);
    const rounds: Array<{ count: number; ids: string }> = [];
    for (let round = 0; round < 5; round++) {
      const { notes } = mergeNotes([saved, crew], ZONE);
      rounds.push({ count: notes.length, ids: notes.map((n) => n.id).sort().join(',') });
      saved = save(notes);
    }

    expect(rounds.map((r) => r.count)).toEqual([3, 3, 3, 3, 3]);
    // Not merely the same NUMBER of notes: the same notes, keeping the same
    // identities, or every save rewrites ids that other people's files
    // reference.
    expect(new Set(rounds.map((r) => r.ids)).size).toBe(1);
    expect(parseCsv(saved.text).rows.map((r) => r.text).sort()).toEqual(['one', 'three', 'two']);
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

  /**
   * A `deleted` row cancels whichever note its `id` names, in EVERYONE's copy,
   * and the next Save writes only the tombstone — so the original text leaves
   * the disk. Ids are not secret: everybody handed a `notes.csv` has all of
   * them, so a single row of `id,…,.,,1,1` in a file anyone contributes is
   * enough, by carelessness as easily as by malice.
   *
   * The deletion is not refused — propagating a deletion is what the tombstone
   * is FOR, and a delete another copy resurrects was itself a bug fixed
   * earlier. What was wrong is that it happened in complete silence:
   * `problems` came back empty. Reproduced exactly as below before the fix.
   */
  describe('a tombstone that removes somebody else\'s note is reported', () => {
    const withDeleted = (name: string, body: string) => ({
      name,
      text:
        'id,year,month,day,hour,minute,duration,tz,people,photo,author,text,written,deleted\n' +
        body,
    });
    const REAL = 'n_real1,2026,7,25,15,0,,,,,Dan,Runner collapsed at mile 60 and we called it,,\n';
    const TOMBSTONE = 'n_real1,2026,7,25,15,0,,,,,,.,,1\n';

    it('names the file, the row, the id and the text that went', () => {
      const { notes, problems } = mergeNotes([
        withDeleted('notes.csv', REAL),
        withDeleted('notes-crew.csv', TOMBSTONE),
      ], ZONE);

      expect(problems).toHaveLength(1);
      const problem = problems[0] as string;
      expect(problem).toContain('notes-crew.csv row 2');
      expect(problem).toContain('n_real1');
      expect(problem).toContain('Runner collapsed at mile 60 and we called it');
      expect(problem).toContain('notes.csv row 2');
      expect(problem).toContain('deleted');

      // The deletion still happens — loud, not refused.
      expect(notes.filter((n) => !n.deleted)).toHaveLength(0);
    });

    it('stays quiet for an ordinary deletion, where no live row is left to remove', () => {
      // This is what a Save writes after the site deletes a note: the
      // tombstone replaces the row rather than sitting beside it.
      const { problems } = mergeNotes([withDeleted('notes.csv', TOMBSTONE)], ZONE);
      expect(problems).toEqual([]);
    });

    it('reports it whichever order the two files are read in', () => {
      const { problems } = mergeNotes([
        withDeleted('notes-crew.csv', TOMBSTONE),
        withDeleted('notes.csv', REAL),
      ], ZONE);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('notes-crew.csv row 2');
    });

    it('reports a live row and a tombstone that sit in the SAME file', () => {
      const { problems } = mergeNotes([withDeleted('notes.csv', REAL + TOMBSTONE)], ZONE);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('notes.csv row 3');
    });

    it('shortens a very long note rather than pasting a paragraph into the report', () => {
      const long = 'x'.repeat(200);
      const { problems } = mergeNotes([
        withDeleted('notes.csv', `n_real1,2026,7,25,15,0,,,,,Dan,${long},,\n`),
        withDeleted('notes-crew.csv', TOMBSTONE),
      ], ZONE);
      expect(problems[0]).toContain('…');
      expect((problems[0] as string).length).toBeLessThan(400);
    });
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

  /**
   * The re-mint above must be DERIVED FROM THE CONTENT, not random.
   *
   * Reached by copy-pasting a row in a spreadsheet and editing the text: the
   * copy wears an id that already belongs to another note, so one side has to
   * be re-identified. When that id was minted at random it was different on
   * every pass — so a folder holding both the saved file and the still
   * uncorrected original grew by one note per save/merge cycle, measured at
   * 3 → 4 → 5 → 6 → 7 before this fix. A content-derived id makes the second
   * pass produce the id the first pass already saved, which then dedupes.
   */
  it('converges instead of growing when the same collision is merged five times over', () => {
    const original = note({ id: 'n_a', text: 'original text' });
    const clone = note({ id: 'n_a', text: 'edited copy' });

    let saved = dedupeNotes([original], ZONE);
    const counts: number[] = [];
    for (let round = 0; round < 5; round++) {
      // The saved file row-bound with the crew member's copy, which still
      // carries the colliding id every time.
      saved = dedupeNotes([...saved, clone], ZONE);
      counts.push(saved.length);
    }
    expect(counts).toEqual([2, 2, 2, 2, 2]);
    expect(saved.map((n) => n.text).sort()).toEqual(['edited copy', 'original text']);
  });

  it('gives the re-minted copy the same id every time, so a save round trip is stable', () => {
    const first = dedupeNotes([note({ text: 'one' }), note({ text: 'two' })], ZONE);
    const second = dedupeNotes([note({ text: 'one' }), note({ text: 'two' })], ZONE);
    expect(second.map((n) => n.id)).toEqual(first.map((n) => n.id));
  });

  it('still ends the derived id in a letter, which Excel\'s fill handle leaves alone', () => {
    // Same rule as `mintNoteId`: dragging a cell whose id ends in a digit
    // increments it, inventing ids for notes that do not exist.
    const out = dedupeNotes([note({ text: 'one' }), note({ text: 'two' })], ZONE);
    expect(out[1]?.id).toMatch(/^n_[0-9a-z]*[a-z]$/);
  });

  /**
   * The three tests above certify almost nothing about the derivation itself:
   * a `deriveNoteId` that returns a CONSTANT passes every one of them, and
   * the whole suite with them. It is deterministic, it ends in a letter, and
   * with a single colliding row it even converges — while silently falling
   * back to a RANDOM `mintUnique()` the moment a SECOND row collides, which
   * is exactly where the unbounded growth comes back. What has to be pinned
   * is the property the fix rests on: the id is a function of the content,
   * and of nothing else.
   */
  describe('the derived id is a function of the content, and of nothing else', () => {
    const colliding = (texts: readonly string[]): Note[] =>
      texts.map((text) => note({ id: 'n_a', text }));

    it('gives each colliding row a different id, and the same ids on every call', () => {
      // Four rows wearing one id, which is what copy-pasting a spreadsheet
      // row three times produces. Distinctness alone is not enough — a
      // constant derivation reaches it too, by way of random ids — so the
      // second call has to agree with the first, in order, exactly.
      const rows = colliding(['alpha', 'beta', 'gamma', 'delta']);
      const first = dedupeNotes(rows, ZONE);
      const second = dedupeNotes(rows, ZONE);
      expect(first).toHaveLength(4);
      expect(new Set(first.map((n) => n.id)).size).toBe(4);
      expect(second.map((n) => n.id)).toEqual(first.map((n) => n.id));
    });

    it('derives the same id on another machine, on another day, from another seed', () => {
      // "Separate calls" is the weak version of this; the real requirement is
      // that two crew members, merging the same two files months apart, land
      // on the same id — otherwise their corrected copies never dedupe
      // against each other and the shared file grows on every exchange.
      // Nothing may reach the clock or the random source.
      const rows = colliding(['one', 'two']);
      const idsUnder = (now: number, random: number): string[] => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const seed = vi.spyOn(Math, 'random').mockReturnValue(random);
        try {
          return dedupeNotes(rows, ZONE).map((n) => n.id);
        } finally {
          clock.mockRestore();
          seed.mockRestore();
        }
      };
      expect(idsUnder(1_700_000_000_000, 0.125)).toEqual(idsUnder(1_900_000_000_000, 0.875));
    });

    it('ends every derived id in a letter, across enough of them to notice', () => {
      // `mintNoteId` has its own 400-draw version of this test; the derived
      // id needs one too, and a single sample cannot see a failure rate of
      // 27.8%. Dragging a cell whose id ends in a digit invents ids for notes
      // that do not exist.
      const texts = Array.from({ length: 200 }, (_, i) => `note number ${i}`);
      const out = dedupeNotes(colliding(texts), ZONE);
      expect(out).toHaveLength(200);
      for (const n of out) expect(n.id, n.text).toMatch(/[a-z]$/);
    });
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

/**
 * A row this build refuses to interpret must still be in the file after a
 * Save. Reporting a row and deleting it were the same event until this
 * existed — which made the `schema` column's own advice ("update the site, or
 * clear the schema cell") describe a repair for data one Save had already
 * destroyed.
 */
describe('rows this build cannot read are kept, not dropped', () => {
  const HEADER =
    'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema';

  it('hands back the raw cells of a row written by a newer build', () => {
    const text = [
      HEADER,
      'n_ok,2026,7,25,10,0,,UTC,0,,,,readable,,,',
      'n_future,2026,7,25,11,0,,UTC,0,,,,from a newer build,,,2',
    ].join('\n');
    const { notes, preserved, problems } = mergeNotes([{ name: 'notes.csv', text }], 'UTC');

    expect(notes.map((n) => n.id)).toEqual(['n_ok']);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.file).toBe('notes.csv');
    expect(preserved[0]?.line).toBe(3);
    expect(preserved[0]?.cells['id']).toBe('n_future');
    expect(preserved[0]?.cells['schema']).toBe('2');
    expect(preserved[0]?.cells['text']).toBe('from a newer build');
    // The message must not read as an assurance while the row is on its way
    // to being deleted, so it says outright that the row survives.
    expect(problems[0]).toContain('kept exactly as it is');
  });

  it('keeps a row refused for an ordinary mistake too, not just a future schema', () => {
    // Reachable with no version gap at all: a bad day, no text, an
    // unreadable duration. All of them dropped the row before this.
    const text = [
      HEADER,
      'n_day,2026,7,32,12,0,,UTC,0,,,,bad day,,,',
      'n_text,2026,7,25,12,0,,UTC,0,,,,,,,',
      'n_dur,2026,7,25,13,0,not-a-duration,UTC,0,,,,x,,,',
    ].join('\n');
    const { notes, preserved } = mergeNotes([{ name: 'notes.csv', text }], 'UTC');
    expect(notes).toHaveLength(0);
    expect(preserved.map((p) => p.cells['id'])).toEqual(['n_day', 'n_text', 'n_dur']);
  });

  it('reports no preserved rows when every row reads cleanly', () => {
    const text = [HEADER, 'n_ok,2026,7,25,10,0,,UTC,0,,,,readable,,,'].join('\n');
    expect(mergeNotes([{ name: 'notes.csv', text }], 'UTC').preserved).toEqual([]);
  });
});

/**
 * The note-clone bug, in the rows nobody can read.
 *
 * A refused row sits in two crew members' copies of the notes file. Save
 * writes both of them into `notes.csv`; the next load reads two from there and
 * one more from the copy nobody touched, and writes three. Measured before the
 * fix, five save-and-merge rounds with two files and one identical refused
 * row: **2 → 3 → 4 → 5 → 6** — the same signature as the two note-id clone
 * bugs already fixed in `dedupeNotes`, and unbounded the same way.
 */
describe('a refused row several files carry is one row, not several', () => {
  const HEADER =
    'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema';
  const REFUSED = 'n_future,2026,7,25,11,0,,UTC,0,,,,from a newer build,,,2';
  const READABLE = 'n_ok,2026,7,25,10,0,,UTC,0,,,,readable,,,';

  /** One Save: merge every file, then write what a Save would write. */
  const save = (files: Array<{ name: string; text: string }>) => {
    const merged = mergeNotes(files, 'UTC');
    return {
      merged,
      text: formatCsv(
        noteHeadersFor(merged.notes, merged.preserved),
        noteRowsForSave(merged.notes, merged.preserved, 'UTC'),
      ),
    };
  };

  it('holds the count FLAT over five save-and-merge rounds', () => {
    const crew = [HEADER, REFUSED].join('\n');
    let notes = [HEADER, READABLE, REFUSED].join('\n');

    const counts: number[] = [];
    for (let round = 0; round < 5; round++) {
      const { merged, text } = save([
        { name: 'notes.csv', text: notes },
        { name: 'notes-crew.csv', text: crew },
      ]);
      counts.push(merged.preserved.length);
      notes = text;
    }

    expect(counts).toEqual([1, 1, 1, 1, 1]);
    // Flat is not enough on its own — dropping the row on the first save is
    // also perfectly flat. The row has to still be there, once.
    const rows = parseCsv(notes).rows;
    expect(rows.filter((r) => r['text'] === 'from a newer build')).toHaveLength(1);
    expect(rows[1]?.['schema']).toBe('2');
  });

  it('keeps two DIFFERENT refused rows that happen to share a line number', () => {
    // The cheap key — file plus line — would have collapsed these two, which
    // is the opposite failure and a worse one: it deletes somebody's row.
    const a = [HEADER, 'n_a,2026,7,25,11,0,,UTC,0,,,,first crew file,,,2'].join('\n');
    const b = [HEADER, 'n_b,2026,7,25,12,0,,UTC,0,,,,second crew file,,,2'].join('\n');
    const { preserved } = mergeNotes(
      [{ name: 'notes-a.csv', text: a }, { name: 'notes-b.csv', text: b }],
      'UTC',
    );
    expect(preserved.map((p) => p.line)).toEqual([2, 2]);
    expect(preserved.map((p) => p.cells['id'])).toEqual(['n_a', 'n_b']);
  });

  it('keeps BOTH copies when one file carries the same refused row twice', () => {
    // Somebody's own duplicate is a row they typed, not an artefact of
    // merging, and deleting it is the silent loss `PreservedRow` exists to
    // prevent. Per file the count is a maximum, never a sum.
    const twice = [HEADER, REFUSED, REFUSED].join('\n');
    const once = [HEADER, REFUSED].join('\n');
    const { preserved } = mergeNotes(
      [{ name: 'notes.csv', text: twice }, { name: 'notes-crew.csv', text: once }],
      'UTC',
    );
    expect(preserved).toHaveLength(2);
    expect(preserved.every((p) => p.file === 'notes.csv')).toBe(true);
  });

  it('holds a single file own duplicate flat across rounds too', () => {
    let notes = [HEADER, READABLE, REFUSED, REFUSED].join('\n');
    const counts: number[] = [];
    for (let round = 0; round < 5; round++) {
      const { merged, text } = save([{ name: 'notes.csv', text: notes }]);
      counts.push(merged.preserved.length);
      notes = text;
    }
    expect(counts).toEqual([2, 2, 2, 2, 2]);
  });

  it('matches two copies whose FILES declare different columns', () => {
    // The case that decides whether the dedupe fires on the second round at
    // all: this build's saved copy carries every column in `NOTE_HEADERS`, so
    // its `written` cell is present-and-empty, while the crew's older file
    // has no such column and yields a row with no `written` key. Same row.
    const mine = [HEADER, REFUSED].join('\n');
    const SHORT_HEADER = 'id,year,month,day,hour,minute,tz,utc_offset_min,text,schema';
    const crew = [SHORT_HEADER, 'n_future,2026,7,25,11,0,UTC,0,from a newer build,2'].join('\n');
    const { preserved } = mergeNotes(
      [{ name: 'notes.csv', text: mine }, { name: 'notes-crew.csv', text: crew }],
      'UTC',
    );
    expect(preserved).toHaveLength(1);

    // A cell that is genuinely different, rather than merely absent, still
    // makes two rows — the dedupe must not swallow a row someone edited.
    const edited = [SHORT_HEADER, 'n_future,2026,7,25,11,0,UTC,0,from a newer build!,2'].join('\n');
    const merged = mergeNotes(
      [{ name: 'notes.csv', text: mine }, { name: 'notes-crew.csv', text: edited }],
      'UTC',
    );
    expect(merged.preserved).toHaveLength(2);
  });

  it('still reports BOTH copies as problems, naming each file and row', () => {
    // `preserved` is what gets written; `problems` is what is on disk. A
    // person with the same bad row in two files has two rows to repair, and
    // deduping the message would hide one of them.
    const { problems } = mergeNotes(
      [{ name: 'notes.csv', text: [HEADER, REFUSED].join('\n') },
       { name: 'notes-crew.csv', text: [HEADER, REFUSED].join('\n') }],
      'UTC',
    );
    expect(problems.filter((p) => p.includes('n_future'))).toHaveLength(2);
    expect(problems.some((p) => p.startsWith('notes.csv row 2'))).toBe(true);
    expect(problems.some((p) => p.startsWith('notes-crew.csv row 2'))).toBe(true);
  });
});

describe('noteRowsForSave', () => {
  const note = (over: Partial<Note>): Note => ({
    id: 'n', at: '2026-07-25T12:00:00.000Z', people: [], author: [], text: 'x', ...over,
  });
  const preserved = (cells: Record<string, string>) => ({ file: 'notes.csv', line: 2, cells });

  it('slots a preserved row into its place in time, not at the end', () => {
    // Sweeping it to the bottom would detach it from the hour of the race it
    // belongs to, which is how nobody ever connects it back up again.
    const rows = noteRowsForSave(
      [note({ id: 'n_early', at: '2026-07-25T09:00:00.000Z' }),
       note({ id: 'n_late', at: '2026-07-25T23:00:00.000Z' })],
      [preserved({ id: 'n_mid', year: '2026', month: '7', day: '25', hour: '12', minute: '0' })],
      'UTC',
    );
    expect(rows.map((r) => r['id'])).toEqual(['n_early', 'n_mid', 'n_late']);
  });

  it('places a preserved row by a rolled-over day rather than giving up on it', () => {
    // `day` 32 is exactly why the row was refused, so it is not a date — but
    // it still says "the end of July", which is enough to sort by.
    const rows = noteRowsForSave(
      [note({ id: 'n_aug', at: '2026-08-02T00:00:00.000Z' }),
       note({ id: 'n_jul', at: '2026-07-20T00:00:00.000Z' })],
      [preserved({ id: 'n_32', year: '2026', month: '7', day: '32', hour: '0', minute: '0' })],
      'UTC',
    );
    expect(rows.map((r) => r['id'])).toEqual(['n_jul', 'n_32', 'n_aug']);
  });

  it('puts a row with nothing to date it by last, not at 1970', () => {
    const rows = noteRowsForSave(
      [note({ id: 'n_a', at: '2026-07-25T09:00:00.000Z' })],
      [preserved({ id: 'n_undated', text: 'no time columns at all' })],
      'UTC',
    );
    expect(rows.map((r) => r['id'])).toEqual(['n_a', 'n_undated']);
  });

  it('reads a legacy at cell for the sort key when there are no integers', () => {
    const rows = noteRowsForSave(
      [note({ id: 'n_late', at: '2026-07-25T23:00:00.000Z' })],
      [preserved({ id: 'n_at', at: '2026-07-25T01:00:00Z' })],
      'UTC',
    );
    expect(rows.map((r) => r['id'])).toEqual(['n_at', 'n_late']);
  });

  it('writes the preserved cells through untouched, schema included', () => {
    const rows = noteRowsForSave(
      [],
      [preserved({ id: 'n_f', year: '2026', month: '7', day: '25', hour: '1', minute: '0', schema: '9' })],
      'UTC',
    );
    expect(rows[0]?.['schema']).toBe('9');
  });

  /**
   * A preserved row's five integers are a WALL CLOCK, and every note it is
   * sorted against carries a true UTC instant. Reading them as though they
   * were UTC — which is what this did — displaced the row by the event's whole
   * offset: the same row, between two notes an hour either side of it, came
   * out FIRST under `America/Denver`, right under `UTC`, and LAST under
   * `Asia/Tokyo`. Nothing was lost, but "a preserved row keeps its place in
   * time" is the promise `noteRowsForSave` is written to keep, and up to
   * fourteen hours away is not its place.
   */
  describe('places a preserved row by its own zone, not by reading it as UTC', () => {
    // 11:00, 12:00 and 13:00 local on the same day, in three zones.
    const CASES = [
      { zone: 'America/Denver', early: '2026-07-25T17:00:00.000Z', late: '2026-07-25T19:00:00.000Z' },
      { zone: 'UTC', early: '2026-07-25T11:00:00.000Z', late: '2026-07-25T13:00:00.000Z' },
      { zone: 'Asia/Tokyo', early: '2026-07-25T02:00:00.000Z', late: '2026-07-25T04:00:00.000Z' },
    ];

    for (const { zone, early, late } of CASES) {
      it(`sorts it between the notes it was written between, in ${zone}`, () => {
        const rows = noteRowsForSave(
          [note({ id: 'n_early', at: early }), note({ id: 'n_late', at: late })],
          [preserved({ id: 'n_mid', year: '2026', month: '7', day: '25', hour: '12', minute: '0' })],
          zone,
        );
        expect(rows.map((r) => r['id'])).toEqual(['n_early', 'n_mid', 'n_late']);
      });
    }

    it('prefers the row own tz and utc_offset_min over the event zone', () => {
      // Written in Tokyo, saved by someone whose event runs on UTC: 12:00
      // Tokyo is 03:00Z, which is the whole point of the row carrying its own
      // zone. Resolved through the same ladder `rowToNote` uses.
      const rows = noteRowsForSave(
        [note({ id: 'n_early', at: '2026-07-25T02:00:00.000Z' }),
         note({ id: 'n_late', at: '2026-07-25T04:00:00.000Z' })],
        [preserved({
          id: 'n_mid', year: '2026', month: '7', day: '25', hour: '12', minute: '0',
          tz: 'Asia/Tokyo', utc_offset_min: '540',
        })],
        'UTC',
      );
      expect(rows.map((r) => r['id'])).toEqual(['n_early', 'n_mid', 'n_late']);
    });

    it('falls back to the event zone when the row own zone is unresolvable', () => {
      // An abbreviation is one of the things a row gets REFUSED for, so it is
      // exactly what turns up here. Better the event's zone than UTC.
      const rows = noteRowsForSave(
        [note({ id: 'n_early', at: '2026-07-25T17:00:00.000Z' }),
         note({ id: 'n_late', at: '2026-07-25T19:00:00.000Z' })],
        [preserved({
          id: 'n_mid', year: '2026', month: '7', day: '25', hour: '12', minute: '0', tz: 'MDT',
        })],
        'America/Denver',
      );
      expect(rows.map((r) => r['id'])).toEqual(['n_early', 'n_mid', 'n_late']);
    });

    it('reads a legacy at cell without its own offset in the event zone too', () => {
      const rows = noteRowsForSave(
        [note({ id: 'n_early', at: '2026-07-25T17:00:00.000Z' }),
         note({ id: 'n_late', at: '2026-07-25T19:00:00.000Z' })],
        [preserved({ id: 'n_mid', at: '2026-07-25T12:00:00' })],
        'America/Denver',
      );
      expect(rows.map((r) => r['id'])).toEqual(['n_early', 'n_mid', 'n_late']);
    });
  });
});

/**
 * A zone ABBREVIATION is the obvious thing for a person to type, and it is
 * not an IANA zone name. The five-integer path has always resolved through
 * the zone and so refused one; the legacy `at` path carried it straight
 * through unvalidated, and `noteToRow` then threw a bare `RangeError` out of
 * the Save button — no file, no message, and the session's writing unsaved.
 */
describe('a timezone this build cannot resolve', () => {
  it('is refused on the legacy at path, in words naming what to write instead', () => {
    const result = rowToNote({ id: 'n_1', at: '2026-07-25T10:00:00Z', tz: 'MDT', text: 'hello' });
    expect('error' in result).toBe(true);
    const { error } = result as { error: string };
    expect(error).toContain('"MDT"');
    expect(error).toContain('America/Denver');
  });

  it('is refused even when the at value carried its own offset', () => {
    // The instant does not need the zone here — but `noteToRow` writes the
    // row back THROUGH it, so an unusable `tz` is never a harmless spare cell.
    const result = rowToNote({ id: 'n_1', at: '2026-07-25T10:00:00-06:00', tz: 'MDT', text: 'x' });
    expect('error' in result).toBe(true);
  });

  it('leaves the abbreviations ICU really does know alone', () => {
    // Not every abbreviation is unusable: `EST`, `MST`, `CST` and `PST` are
    // real tzdata names (or ICU aliases for them) and resolve perfectly well.
    // The check has to be "can this be resolved", not "does it look like an
    // abbreviation" — refusing by shape would reject four working zones.
    for (const tz of ['EST', 'MST', 'CST', 'PST']) {
      const result = rowToNote({ id: 'n_1', at: '2026-07-25T10:00:00Z', tz, text: 'x' });
      expect('error' in result).toBe(false);
    }
  });

  it('still accepts a real zone on that path', () => {
    const result = rowToNote({ id: 'n_1', at: '2026-07-25T10:00:00Z', tz: ZONE, text: 'hello' });
    expect('error' in result).toBe(false);
    expect((result as Note).tz).toBe(ZONE);
  });

  it('makes noteToRow throw a legible Error rather than a bare RangeError', () => {
    const note: Note = {
      id: 'n_1', at: '2026-07-25T10:00:00.000Z', tz: 'MDT', people: [], author: [], text: 'x',
    };
    expect(() => noteToRow(note, 'UTC')).toThrow(/note "n_1"/);
    expect(() => noteToRow(note, 'UTC')).toThrow(/"MDT"/);
    // Not the raw Intl wording, which names no note and tells nobody what to
    // do about it.
    expect(() => noteToRow(note, 'UTC')).not.toThrow(/Invalid time zone specified/);
  });

  it('throws for an unusable EVENT zone too, rather than writing the wrong hour', () => {
    const note: Note = {
      id: 'n_2', at: '2026-07-25T10:00:00.000Z', people: [], author: [], text: 'x',
    };
    expect(() => noteToRow(note, 'Nowhere/Nothing')).toThrow(/Nowhere\/Nothing/);
  });
});
