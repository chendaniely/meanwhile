import { describe, expect, it } from 'vitest';
import { mergeNotes, noteToRow, rowToNote, type Note } from '../src/core/notes.ts';

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
});
