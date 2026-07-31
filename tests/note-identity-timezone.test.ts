import { describe, expect, it } from 'vitest';
import {
  dedupeNotes, fingerprintNote, mergeNotes, type Note, type NoteRowIdentity,
} from '../src/core/notes.ts';
import { mergeSessionNotes } from '../src/viewer/media/ingest.ts';

/**
 * Editing `event.timezone` must not lose or duplicate a note.
 *
 * `fingerprintNote` is the identity every id-stabilising mechanism around
 * notes is keyed on — `rowIdentity` (what gives a blank-`id` row the same id
 * on a second parse), the `identified` map that lets a blank-`id` row adopt
 * an id an existing row already has, and the tombstone fingerprints
 * `viewer/media/ingest.ts` compares a fresh read against. It used to take the
 * event's zone as an input, in two ways at once: it compared the RESOLVED
 * instant, which a zone-less row re-resolves differently under a new zone,
 * and it folded `tz` away whenever it matched the event's, which moved the
 * fingerprint of a row whose instant had not moved at all.
 *
 * Nothing recomputes those caches when the zone is edited, so the identity of
 * a note silently changed underneath them. Reproduced by execution as two
 * failures, both in this file:
 *
 *   change event.timezone  ->  a previously DELETED note RESURRECTS
 *   change event.timezone  ->  blank-id adoption fails, producing a DUPLICATE
 *
 * The three "under a stable zone" cases are here on purpose: they are the
 * control that says the zone edit is the cause, and they are also the
 * properties the fix had to keep.
 */

const DENVER = 'America/Denver';
const NEW_YORK = 'America/New_York';

const HEADERS =
  'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,' +
  'written,deleted,schema';

/** One notes*.csv file, as `mergeNotes` takes them. */
function file(name: string, ...rows: string[]): { name: string; text: string } {
  return { name, text: [HEADERS, ...rows].join('\n') };
}

/**
 * A row as the site saves it: an id, its own zone, and the offset in force at
 * that instant. Its instant does not depend on `event.timezone` at all.
 */
const SAVED = 'n_keepa,2026,7,25,15,45,,America/Denver,-360,,,,boiling water,,,1';

/**
 * The same note as a person would type it by hand: `id` left blank, as the
 * README tells them to, and no zone — so this one DOES resolve through
 * `event.timezone`.
 */
const HAND_TYPED = ',2026,7,25,15,45,,,,,,,boiling water,,,';

/** The saved shape with its id cleared — a saved row copied in a spreadsheet. */
const COPIED = ',2026,7,25,15,45,,America/Denver,-360,,,,boiling water,,,1';

describe('a deleted note stays deleted when event.timezone is edited', () => {
  /**
   * Open a folder, delete a hand-added note, then edit the timezone and click
   * "Add files". The row is still on disk (nothing is written until Save), so
   * the re-read finds it again and only the tombstones stop it coming back.
   */
  const deleteThenReingest = (row: string, second: string): Note[] => {
    const rowIdentity: NoteRowIdentity = new Map();
    const first = mergeNotes([file('notes.csv', row)], DENVER, rowIdentity);
    expect(first.notes).toHaveLength(1);
    const note = first.notes[0] as Note;

    // What App.tsx's `deleteNote` records, at delete time, in the zone that
    // was live then.
    const deletedIds = new Set([note.id]);
    const deletedFingerprints = new Set([fingerprintNote(note, DENVER)]);

    const fresh = mergeNotes([file('notes.csv', row)], second, rowIdentity);
    return mergeSessionNotes([], fresh.notes, deletedIds, second, deletedFingerprints);
  };

  it('stays deleted under the same zone — the control', () => {
    expect(deleteThenReingest(COPIED, DENVER)).toEqual([]);
    expect(deleteThenReingest(HAND_TYPED, DENVER)).toEqual([]);
  });

  it('stays deleted when the zone changes and the row pins its own instant', () => {
    // This row carries tz and utc_offset_min, so it resolves to the SAME
    // instant either way — nothing about it has changed, and only the
    // fingerprint's fold against the event zone ever moved.
    expect(deleteThenReingest(COPIED, NEW_YORK)).toEqual([]);
  });

  it('stays deleted when the zone changes and the row inherits the zone', () => {
    // This row genuinely resolves to a different instant now. It is still the
    // same row, and the author still deleted it.
    expect(deleteThenReingest(HAND_TYPED, NEW_YORK)).toEqual([]);
  });
});

describe('a blank-id row still adopts an existing id when event.timezone is edited', () => {
  /**
   * The 2 -> 3 -> 4 -> 5 -> 6 case: someone's saved `notes.csv` (ids filled
   * in) lands back in the folder beside a pristine copy whose rows are still
   * blank-`id`. Adoption is what collapses the pair back to one note.
   */
  const merge = (zone: string): string[] =>
    mergeNotes(
      [file('notes.csv', SAVED), file('notes-priya.csv', HAND_TYPED)],
      zone,
    ).notes.map((n) => n.id);

  it('adopts under the same zone — the control', () => {
    expect(merge(DENVER)).toEqual(['n_keepa']);
  });

  it('adopts after the zone is edited', () => {
    expect(merge(NEW_YORK)).toEqual(['n_keepa']);
  });

  it('adopts when the pristine copy carries the zone too', () => {
    expect(
      mergeNotes([file('notes.csv', SAVED), file('notes-priya.csv', COPIED)], NEW_YORK)
        .notes.map((n) => n.id),
    ).toEqual(['n_keepa']);
  });
});

describe('one hand-typed row is one note across a timezone edit', () => {
  it('does not split into two when the session already holds it', () => {
    // "Add files" reconciles the live session against a fresh read. The
    // session's copy still carries the instant it was resolved to under the
    // OLD zone — nothing re-resolves an in-memory note — so this only holds
    // because the row keeps its id across the two parses.
    const rowIdentity: NoteRowIdentity = new Map();
    const session = mergeNotes([file('notes.csv', HAND_TYPED)], DENVER, rowIdentity).notes;
    const fresh = mergeNotes([file('notes.csv', HAND_TYPED)], NEW_YORK, rowIdentity).notes;

    expect(fresh[0]?.id).toBe(session[0]?.id);
    expect(mergeSessionNotes(session, fresh, new Set(), NEW_YORK, new Set())).toHaveLength(1);
  });
});

describe('the timestamp identity keeps what it is meant to keep', () => {
  const note = (over: Partial<Note>): Note => ({
    id: 'x', at: '2026-07-25T21:45:00.000Z', people: [], author: [], text: 'x', ...over,
  });

  it('is unchanged by the event zone for a note carrying its own', () => {
    expect(fingerprintNote(note({ tz: DENVER }), DENVER))
      .toBe(fingerprintNote(note({ tz: DENVER }), NEW_YORK));
  });

  it('separates the two halves of a repeated hour', () => {
    // 2026-11-01 01:30 happens twice in Denver: once at UTC-6 and again an
    // hour later at UTC-7. Same five integers, same zone, same text — the
    // case `utc_offset_min` was added for. Collapsing them would swallow one
    // of the two notes with nothing said.
    const mdt = note({ at: '2026-11-01T07:30:00.000Z', tz: DENVER });
    const mst = note({ at: '2026-11-01T08:30:00.000Z', tz: DENVER });
    expect(fingerprintNote(mdt, DENVER)).not.toBe(fingerprintNote(mst, DENVER));

    // And a zone-less row, which cannot say which half it means, still
    // matches the one it resolves to.
    const inherited = note({ at: '2026-11-01T07:30:00.000Z' });
    expect(fingerprintNote(inherited, DENVER)).toBe(fingerprintNote(mdt, DENVER));
  });

  it('separates two notes a few seconds apart', () => {
    // The five integers stop at the minute; a legacy manifest's `at` does
    // not, and `legacyNoteToNote` passes it through untouched.
    expect(fingerprintNote(note({ at: '2026-07-25T21:45:00Z' }), DENVER))
      .not.toBe(fingerprintNote(note({ at: '2026-07-25T21:45:30Z' }), DENVER));
  });

  it('separates two notes an hour apart in different zones', () => {
    expect(fingerprintNote(note({ tz: DENVER }), DENVER))
      .not.toBe(fingerprintNote(note({ tz: 'UTC' }), DENVER));
  });
});

describe('an unreadable timestamp is not an identity', () => {
  /**
   * `Date.parse` returns `NaN` for an `at` this build cannot read, and
   * `JSON.stringify(NaN)` is `null` — so every unreadable timestamp used to
   * land in the same fingerprint slot and dedupe against every other one,
   * whatever it said. Reachable through `legacyNoteToNote`, which copies an
   * imported manifest's `at` across without validating it.
   */
  const broken = (id: string, at: string, text = 'the same words'): Note =>
    ({ id, at, people: [], author: [], text });

  it('keeps two different unreadable values apart', () => {
    expect(fingerprintNote(broken('a', 'sometime on Saturday'), DENVER))
      .not.toBe(fingerprintNote(broken('b', 'after the second aid station'), DENVER));
  });

  it('still matches an unreadable value against itself', () => {
    expect(fingerprintNote(broken('a', 'sometime on Saturday'), DENVER))
      .toBe(fingerprintNote(broken('a', 'sometime on Saturday'), NEW_YORK));
  });

  it('does not let one blank-id row adopt an unrelated broken note id', () => {
    const notes = dedupeNotes(
      [broken('n_real', 'sometime on Saturday'), broken('', 'after the second aid station')],
      DENVER,
    );
    expect(notes).toHaveLength(2);
    expect(notes[1]?.id).not.toBe('n_real');
  });
});
