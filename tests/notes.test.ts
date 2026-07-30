import { describe, expect, it } from 'vitest';
import { formatCsv, parseCsv } from '../src/core/csv.ts';
import {
  dedupeNotes,
  fingerprintNote,
  mergeNotes,
  noteHeadersFor,
  noteToRow,
  resolveNotePhotos,
  rowToNote,
  stampBlankAuthors,
  type Note,
} from '../src/core/notes.ts';
import type { Item } from '../src/core/schema.ts';

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
      'tz', 'people', 'photo', 'author', 'text',
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
    expect(headers.slice(-2)).toEqual(['tags', 'mood']);
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

  it('leaves a note with no photo, and one matching nothing at all, untouched', () => {
    const items = [item('priya/a.jpg')];
    expect(resolveNotePhotos([note(undefined)], items).notes[0]?.photo).toBeUndefined();
    const { notes, problems } = resolveNotePhotos([note('ghost.jpg')], items);
    expect(notes[0]?.photo).toBe('ghost.jpg');
    expect(problems).toEqual([]);
  });
});
