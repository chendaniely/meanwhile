import { describe, expect, it } from 'vitest';
import {
  ingestFolder, legacyNoteToNote, manifestForSave, mergeSessionNotes, mergeSessionPeople,
  migrateLegacyNotes, reportUnresolvedNoteNames, reportUnsavedRosterEdits,
} from '../src/viewer/media/ingest.ts';
import { applyRename } from '../src/core/people-csv.ts';
import type { PickedFile } from '../src/viewer/media/folder.ts';
import { fingerprintNote, type Note } from '../src/core/notes.ts';
import type { Item, Manifest, Note as LegacyNote, Person } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { parseDuration } from '../src/core/time.ts';
import {
  NOTES_CSV_BEFORE, PEOPLE_CSV_BEFORE,
} from './fixtures/csv-before-2026-07-30.ts';
import { buildJpeg, buildTiff, TYPE_ASCII } from './fixtures/jpeg.ts';

/**
 * `legacyNoteToNote` and `migrateLegacyNotes` are the highest-risk new code
 * in the notes-as-CSV migration: duration arithmetic (an `until` becomes a
 * `duration`), person-name resolution, and — for captions — a resolved
 * instant rather than the item's raw recorded time. Both take plain
 * `Manifest`/`Note` objects, so none of this needs a `File` or a browser.
 */

const PEOPLE: Person[] = [{ id: 'p', name: 'Priya' }];

describe('legacyNoteToNote', () => {
  it('turns an until into a duration that lands exactly back on the until', () => {
    const legacy: LegacyNote = {
      id: 'n1',
      at: '2026-07-25T09:00:00Z',
      until: '2026-07-25T12:30:00Z',
      text: 'asleep in the car',
      person: 'p',
    };
    const note = legacyNoteToNote(legacy, PEOPLE);

    expect(note.at).toBe(legacy.at);
    expect(note.duration).toBeDefined();
    const span = parseDuration(note.duration as string);
    expect(span).not.toBeNull();
    // The point of the conversion: at + duration must reproduce the original
    // until EXACTLY, not approximately.
    expect(Date.parse(note.at) + (span as number)).toBe(Date.parse(legacy.until as string));
  });

  it('omits the duration key entirely when there is no until', () => {
    const legacy: LegacyNote = { id: 'n2', at: '2026-07-25T09:00:00Z', text: 'left the trailhead' };
    const note = legacyNoteToNote(legacy, PEOPLE);
    expect(Object.hasOwn(note, 'duration')).toBe(false);
  });

  it('drops the span when until is before at, keeping the moment', () => {
    const legacy: LegacyNote = {
      id: 'n3',
      at: '2026-07-25T12:00:00Z',
      until: '2026-07-25T09:00:00Z',
      text: 'muddled',
    };
    const note = legacyNoteToNote(legacy, PEOPLE);
    expect(note.at).toBe(legacy.at);
    expect(Object.hasOwn(note, 'duration')).toBe(false);
  });

  it('resolves person to a name, and keeps the id when nobody matches', () => {
    const withPerson: LegacyNote = { id: 'n4', at: '2026-07-25T09:00:00Z', text: 'x', person: 'p' };
    expect(legacyNoteToNote(withPerson, PEOPLE).people).toEqual(['Priya']);

    // Pinned rather than left to guess: an id that matches nobody in the
    // roster is kept as-is rather than dropped, so the note is not silently
    // unattributed.
    const ghost: LegacyNote = { id: 'n5', at: '2026-07-25T09:00:00Z', text: 'x', person: 'ghost' };
    expect(legacyNoteToNote(ghost, PEOPLE).people).toEqual(['ghost']);
  });

  it('leaves people empty when the legacy note has none', () => {
    const legacy: LegacyNote = { id: 'n6', at: '2026-07-25T09:00:00Z', text: 'event-level' };
    expect(legacyNoteToNote(legacy, PEOPLE).people).toEqual([]);
  });

  it('always carries an empty author list — legacy notes never recorded one', () => {
    const legacy: LegacyNote = { id: 'n7', at: '2026-07-25T09:00:00Z', text: 'x' };
    expect(legacyNoteToNote(legacy, PEOPLE).author).toEqual([]);
  });
});

describe('migrateLegacyNotes', () => {
  const baseManifest = (over: Partial<Manifest> = {}): Manifest => ({
    schema: SCHEMA_VERSION,
    event: { title: 'Race', timezone: 'UTC' },
    people: PEOPLE,
    items: [],
    ...over,
  });

  it('migrates every manifest.notes entry through legacyNoteToNote', () => {
    const manifest = baseManifest({
      notes: [
        { id: 'a', at: '2026-07-25T09:00:00Z', text: 'first', person: 'p' },
        { id: 'b', at: '2026-07-25T10:00:00Z', text: 'second' },
      ],
    });
    const notes = migrateLegacyNotes(manifest);
    expect(notes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(notes.map((n) => n.text)).toEqual(['first', 'second']);
    expect(notes[0]?.people).toEqual(['Priya']);
  });

  it('migrates a caption using the RESOLVED instant, not the raw recorded at', () => {
    // A clockOffset makes resolved and raw diverge, so the assertion cannot
    // pass by accident if the code were to read item.at directly.
    const manifest = baseManifest({
      people: [{ id: 'p', name: 'Priya', clockOffset: '-PT47S' }],
      items: [
        {
          id: 'p/a.jpg',
          person: 'p',
          type: 'photo',
          src: 'p/a.jpg',
          timeSource: 'exif-offset',
          at: '2026-07-25T09:00:00Z',
          note: 'the buckle',
        } as Item,
      ],
    });

    const notes = migrateLegacyNotes(manifest);
    expect(notes).toHaveLength(1);
    const [caption] = notes;
    expect(caption?.photo).toBe('p/a.jpg');
    expect(caption?.people).toEqual(['Priya']);
    expect(caption?.text).toBe('the buckle');
    // Resolved = recorded + clockOffset (-47s), per resolveItemInstant in
    // core/time.ts — NOT the item's raw "at".
    const raw = Date.parse('2026-07-25T09:00:00Z');
    const resolved = raw + (parseDuration('-PT47S') as number);
    expect(resolved).not.toBe(raw); // sanity: the two really do differ
    expect(caption?.at).toBe(new Date(resolved).toISOString());
    expect(caption?.at).not.toBe('2026-07-25T09:00:00.000Z');
  });

  it('skips a caption on an item with no resolvable time, rather than fabricating one', () => {
    const manifest = baseManifest({
      items: [
        {
          id: 'p/b.jpg',
          person: 'p',
          type: 'photo',
          src: 'p/b.jpg',
          timeSource: 'none',
          note: 'unplaceable',
        } as Item,
      ],
    });
    expect(migrateLegacyNotes(manifest)).toEqual([]);
  });

  it('ignores items with no caption', () => {
    const manifest = baseManifest({
      items: [
        {
          id: 'p/c.jpg', person: 'p', type: 'photo', src: 'p/c.jpg',
          timeSource: 'exif-offset', at: '2026-07-25T09:00:00Z',
        } as Item,
      ],
    });
    expect(migrateLegacyNotes(manifest)).toEqual([]);
  });

  it('is empty for a manifest with neither notes nor captions', () => {
    expect(migrateLegacyNotes(baseManifest())).toEqual([]);
  });
});

describe('mergeSessionNotes', () => {
  /**
   * CRITICAL 1 from the whole-branch review: `App.tsx` used to call
   * `setNotes(loadedNotes)` unconditionally after a re-ingest ("Add files"
   * to drop in a GPX, most often), discarding every note and caption written
   * since the folder was opened — because the live session state was never
   * passed into `ingestFolder` at all. This is the reconciliation that
   * replaced that unconditional overwrite; these tests reproduce each half
   * of the failure the review described and pin the fix against it.
   */
  const note = (id: string, over: Partial<Note> = {}): Note => ({
    id, at: '2026-07-25T09:00:00.000Z', people: [], author: [], text: id, ...over,
  });

  it('keeps a note composed this session that is not yet on disk', () => {
    // "Write five notes, caption three photos, then click Add files" — none
    // of those eight have been saved, so a fresh read of the folder cannot
    // know about them at all.
    const session = [note('a'), note('b')];
    const out = mergeSessionNotes(session, [], new Set());
    expect(out.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps the SESSION copy of a note edited this session, not the stale re-read', () => {
    const edited = note('a', { text: 'edited' });
    const staleFromDisk = note('a', { text: 'original' });
    const out = mergeSessionNotes([edited], [staleFromDisk], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('edited');
  });

  it('does not resurrect a note deleted this session, even though the re-read still has it', () => {
    // The note is gone from `session` (deleted) but the fresh read still
    // carries it — it was never saved to disk, so re-reading the folder
    // finds it exactly as before. `deletedIds` is what tells the two apart
    // from a note the session has simply never seen.
    const staleFromDisk = note('a', { text: 'original' });
    const out = mergeSessionNotes([], [staleFromDisk], new Set(['a']));
    expect(out).toEqual([]);
  });

  it('adds a note that is genuinely new on disk and unknown to the session', () => {
    // A collaborator's notes-priya.csv landing in the folder between one
    // ingest and the next.
    const fromCollaborator = note('new-from-priya');
    const out = mergeSessionNotes([note('a')], [fromCollaborator], new Set());
    expect(out.map((n) => n.id).sort()).toEqual(['a', 'new-from-priya']);
  });

  it('reverts nothing: an untouched note surviving both sides is not duplicated', () => {
    const same = note('a');
    const out = mergeSessionNotes([same], [note('a', { text: 'a' })], new Set());
    expect(out).toHaveLength(1);
  });

  /**
   * Blocker from the scoped re-review: the fix above opened the OPPOSITE
   * failure. A blank-`id` row — the documented, encouraged way to hand-add a
   * note ("leave it blank on a new row", per the README) — gets a FRESH
   * random id from `dedupeNotes` on every parse, since nothing persists a
   * row-to-id mapping between calls. So the identical unsaved row mints id
   * `A` on the first ingest and a different id `B` on the next, and a plain
   * "is this id already in session" check sees `B` as unrelated and
   * duplicates the note on every "Add files". Fixed by also filtering
   * `fresh` against a content fingerprint of `session` (the same identity
   * rule `dedupeNotes` already applies within one parse), not id alone.
   */
  it('does not duplicate a fresh note whose content already matches a session note under a different, freshly-minted id', () => {
    // Stands in for a blank-id row: `session` holds the id minted on the
    // first ingest, `fresh` holds a DIFFERENT id minted for the identical
    // unsaved row on the second.
    const mintedFirst = note('A', { text: 'hand-typed note' });
    const mintedAgain = note('B', { text: 'hand-typed note' });
    const out = mergeSessionNotes([mintedFirst], [mintedAgain], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('A'); // the session's copy, not a second mint
  });

  it('does not over-collapse: a fresh note with genuinely different content is kept alongside one that matches', () => {
    // Two blank-id rows in the same file, re-minted on the second ingest:
    // one collides in content with what the session already has, the other
    // is a real second note and must survive.
    const sessionCopy = note('A', { text: 'aid station' });
    const matchingRemint = note('B', { text: 'aid station' });
    const genuinelyNew = note('C', { text: 'wrong turn' });
    const out = mergeSessionNotes([sessionCopy], [matchingRemint, genuinelyNew], new Set());
    expect(out.map((n) => n.id).sort()).toEqual(['A', 'C']);
    expect(out.map((n) => n.text).sort()).toEqual(['aid station', 'wrong turn']);
  });

  /**
   * Mirror-image blocker from a further re-review: `deletedIds` alone only
   * records the id minted for a note AT DELETE TIME. A blank-id row's
   * underlying `notes.csv` line is still unsaved and blank-id, so the NEXT
   * parse mints a DIFFERENT id — one `deletedIds` has never seen — and the
   * deleted note comes back. `deletedFingerprints` closes that the same way
   * the add-side duplication was closed: by content, not id.
   */
  it('a deleted blank-id note does not resurrect under a freshly-minted id', () => {
    // The id minted for the SAME unsaved row differs between the delete
    // ('A', deleted from `session`) and this re-ingest ('X', freshly minted)
    // — `deletedIds` alone would miss this.
    const deletedAt = note('A', { text: 'deleted note' });
    const staleRemint = note('X', { text: 'deleted note' });
    const out = mergeSessionNotes(
      [], [staleRemint], new Set(['A']), undefined, new Set([fingerprintNote(deletedAt)]),
    );
    expect(out).toEqual([]);
  });

  it('does not suppress a different note that merely shares some fields with a deleted one', () => {
    // Same text, but a different time — the fingerprint covers both, so this
    // must NOT read as the note that was deleted. An exact match on time,
    // text, people, author, photo, AND extra together is the bar; matching
    // on text alone is not.
    const deletedAt = note('A', { text: 'aid station', at: '2026-07-25T09:00:00.000Z' });
    const differentTime = note('B', { text: 'aid station', at: '2026-07-25T10:00:00.000Z' });
    const out = mergeSessionNotes(
      [], [differentTime], new Set(), undefined, new Set([fingerprintNote(deletedAt)]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('B');
  });
});

describe('ingestFolder — notes end to end', () => {
  /**
   * These eleven run the whole pipeline against real `File` objects (Node's
   * global `File`, no browser needed) rather than the pure pieces above, to
   * prove the WIRING and not just the individual functions: `ingestFolder`
   * really does dedupe a legacy manifest against its own migrated notes.csv;
   * really does carry a session forward when called the way `App.tsx` calls
   * it on "Add files"; and — grown over five rounds of bugfixing on top of
   * the original two — really does keep blank-id rows, edits and deletes
   * straight across repeated re-ingests, including the mode: "replace" case
   * where a folder omits a tombstone.
   */
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  const legacyManifest = (notes: LegacyNote[]) =>
    JSON.stringify({
      schema: SCHEMA_VERSION,
      event: { title: 'Race', timezone: 'UTC' },
      people: [{ id: 'p', name: 'Priya' }],
      items: [],
      notes,
    });

  it('dedupes a legacy manifest note against the copy notes.csv already carries', async () => {
    // The scenario the "also fix" list describes: a folder holding BOTH an
    // old-style manifest.json (migrated on the fly) and a notes.csv already
    // saved from it — the same note, same id, from two sources.
    const manifestJson = legacyManifest([
      { id: 'legacy1', at: '2026-07-25T09:00:00Z', text: 'first light', person: 'p' },
    ]);
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      'legacy1,2026,7,25,9,0,,,Priya,,,first light\n';

    const { notes } = await ingestFolder(
      [textFile('manifest.json', manifestJson), textFile('notes.csv', notesCsv)],
      { title: 'x' },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe('legacy1');
  });

  it('carries an edit and a delete forward, and keeps a note composed this session, across a re-ingest', async () => {
    // Reproduces the CRITICAL scenario directly: open a folder, do session
    // work, then re-ingest (what "Add files" does) — nothing must be lost,
    // and nothing deleted must come back, even though the files on disk are
    // untouched because nothing has been saved yet.
    const twoNotes = legacyManifest([
      { id: 'legacy1', at: '2026-07-25T09:00:00Z', text: 'first light', person: 'p' },
      { id: 'legacy2', at: '2026-07-25T10:00:00Z', text: 'aid station', person: 'p' },
    ]);

    const first = await ingestFolder([textFile('manifest.json', twoNotes)], { title: 'x' });
    expect(first.notes.map((n) => n.id).sort()).toEqual(['legacy1', 'legacy2']);

    // Session: edit legacy1, delete legacy2, compose a brand new note.
    const composed: Note = {
      id: 'new1', at: '2026-07-25T11:00:00Z', people: [], author: [], text: 'composed this session',
    };
    const session = [
      ...first.notes
        .filter((n) => n.id !== 'legacy2')
        .map((n) => (n.id === 'legacy1' ? { ...n, text: 'EDITED' } : n)),
      composed,
    ];

    const second = await ingestFolder([textFile('manifest.json', twoNotes)], {
      title: 'x', sessionNotes: session, deletedNoteIds: new Set(['legacy2']),
    });
    const byId = new Map(second.notes.map((n) => [n.id, n]));
    expect(byId.get('legacy1')?.text).toBe('EDITED'); // the edit survives
    expect(byId.has('legacy2')).toBe(false); // the delete stays deleted
    expect(byId.has('new1')).toBe(true); // the composed note survives
  });

  it('does not duplicate a hand-typed, blank-id note across "Add files"', async () => {
    // The blocker from the scoped re-review, reproduced end to end: a
    // blank `id` cell is the documented way to add a note by hand (README:
    // "leave it blank on a new row"), and `notes.csv` on disk is never
    // rewritten by a mere re-ingest — only by Save. So the SAME unsaved row
    // is parsed twice, minting a different random id each time, and only
    // the fingerprint-based half of `mergeSessionNotes` stops that from
    // becoming two notes.
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,hand-typed note\n';

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], { title: 'x' });
    expect(first.notes).toHaveLength(1);

    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', sessionNotes: first.notes, deletedNoteIds: new Set(),
    });
    expect(second.notes).toHaveLength(1);
    expect(second.notes[0]?.text).toBe('hand-typed note');
  });

  it('keeps two genuinely different blank-id rows as two notes across a re-ingest', async () => {
    // The guard above must not over-collapse: two DIFFERENT hand-typed rows,
    // both blank-id, must both survive "Add files" as two notes, not one.
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,first note\n' +
      ',2026,7,25,10,0,,,Priya,,,second note\n';

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], { title: 'x' });
    expect(first.notes).toHaveLength(2);

    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', sessionNotes: first.notes, deletedNoteIds: new Set(),
    });
    expect(second.notes).toHaveLength(2);
    expect(second.notes.map((n) => n.text).sort()).toEqual(['first note', 'second note']);
  });

  it('a deleted, blank-id note stays deleted across "Add files" — the mirror-image blocker', async () => {
    // Reproduces the exact failure the second re-review traced: write a
    // blank-id note in notes.csv, open the folder, delete it in the app
    // (App.tsx's deleteNote records BOTH the id it was minted under and its
    // content fingerprint), then click "Add files". The unsaved row is still
    // blank-id, so this re-ingest mints a DIFFERENT id for it — only the
    // fingerprint tombstone stops it from reappearing.
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,hand-typed note\n';

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], { title: 'x' });
    expect(first.notes).toHaveLength(1);
    const deleted = first.notes[0] as Note;

    // Simulates deleteNote: gone from the session's note list, recorded in
    // both tombstones (event.timezone is undefined here, matching what
    // ingestFolder itself computed for `manifest.event.timezone`).
    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x',
      sessionNotes: [],
      deletedNoteIds: new Set([deleted.id]),
      deletedNoteFingerprints: new Set([fingerprintNote(deleted)]),
    });
    expect(second.notes).toEqual([]);
  });

  it('a deletion does not carry into a folder that omits the tombstone — what mode: "replace" does', async () => {
    // `ingestFolder` itself has no notion of "session" vs "replace" — that
    // distinction lives entirely in what App.tsx chooses to pass through
    // `handlePicked`, and it resets both tombstone refs before a 'replace'
    // ingest so neither is passed at all. This proves the CONTRACT that
    // reset relies on: an ingest that carries no tombstone forward treats
    // every note in the file as never having been deleted, which is exactly
    // what "a genuinely different folder must not inherit yesterday's
    // deletions" requires.
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,hand-typed note\n';

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], { title: 'x' });
    const deletedText = (first.notes[0] as Note).text;

    // Re-opened with no sessionNotes/deletedNoteIds/deletedNoteFingerprints
    // at all — the tombstone was never carried across.
    const reopened = await ingestFolder([textFile('notes.csv', notesCsv)], { title: 'x' });
    expect(reopened.notes).toHaveLength(1);
    expect(reopened.notes[0]?.text).toBe(deletedText);
  });

  /**
   * A further review found the addendum-2 delete tombstone still had a
   * hole: EDIT a blank-id note, then DELETE it, and it came back on the
   * next "Add files" — `deleteNote` fingerprints the EDITED in-memory
   * content, but the untouched CSV row still re-parses to the ORIGINAL
   * text, so the tombstone fingerprint never matches. Rather than patch a
   * fourth symptom, the fix is the root cause: `noteRowIdentity` gives a
   * blank-id row a STABLE id across re-parses (keyed on the row's content
   * AS THE FILE HAS IT, not on whatever the in-memory note has become), so
   * every id-based mechanism here — including the plain `deletedNoteIds`
   * check that predates every fingerprint patch — works without needing
   * content to match at all.
   */
  it('an edited-then-deleted blank-id note stays deleted across "Add files"', async () => {
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,original text\n';
    const noteRowIdentity = new Map<string, string>();

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', noteRowIdentity,
    });
    expect(first.notes).toHaveLength(1);
    const original = first.notes[0] as Note;

    // Simulates editing in the app (App.tsx's editNote keeps `id`, changes
    // only the field edited) and then deleting the EDITED copy — deleteNote
    // records the fingerprint of what is in `notesRef.current` at that
    // moment, which is the edited text, not the original.
    const edited: Note = { ...original, text: 'edited text' };
    const deletedNoteIds = new Set([edited.id]);
    const deletedNoteFingerprints = new Set([fingerprintNote(edited)]);

    // Re-ingest: the CSV row on disk is UNCHANGED (nothing has been saved),
    // so this re-parses "original text" again. Passing the SAME
    // noteRowIdentity map is what resolves it back to `original.id` rather
    // than a fresh mint — proving the id-based deletedNoteIds check alone
    // is sufficient once the id is stable, with no fingerprint match needed.
    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x',
      sessionNotes: [], // deleted, so the session no longer carries it
      deletedNoteIds,
      deletedNoteFingerprints,
      noteRowIdentity,
    });
    expect(second.notes).toEqual([]);
  });

  it('a blank-id row keeps the SAME id across two ingests', async () => {
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,hand-typed note\n';
    const noteRowIdentity = new Map<string, string>();

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', noteRowIdentity,
    });
    const firstId = first.notes[0]?.id;
    expect(firstId).toBeDefined();

    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', sessionNotes: first.notes, noteRowIdentity,
    });
    // Equality of the id itself, not just a count — the count alone cannot
    // distinguish "the row kept its id" from "the row minted a new one and
    // some OTHER mechanism happened to dedupe it back down to one".
    expect(second.notes[0]?.id).toBe(firstId);
  });

  it('editing a blank-id note, then re-ingesting, keeps the edit as ONE note', async () => {
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,original text\n';
    const noteRowIdentity = new Map<string, string>();

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', noteRowIdentity,
    });
    const original = first.notes[0] as Note;
    const edited: Note = { ...original, text: 'EDITED' };

    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', sessionNotes: [edited], noteRowIdentity,
    });
    expect(second.notes).toHaveLength(1);
    expect(second.notes[0]?.id).toBe(original.id);
    expect(second.notes[0]?.text).toBe('EDITED');
  });

  it('a fresh (or omitted) noteRowIdentity map does not carry a stable id into a different ingest', async () => {
    // What `mode: 'replace'` does: App.tsx reassigns the ref to a brand new
    // `Map` before opening a genuinely different folder, so nothing from
    // the old one leaks in. Simulated here by using an unrelated, empty map
    // instead of the one the first call populated.
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,hand-typed note\n';

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', noteRowIdentity: new Map(),
    });
    const firstId = first.notes[0]?.id;

    const reopened = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', noteRowIdentity: new Map(),
    });
    expect(reopened.notes[0]?.id).not.toBe(firstId);
  });

  /**
   * The case `NoteRowIdentity` cannot resolve by construction, found by a
   * further review: two blank-id rows in ONE file whose parsed content is
   * BYTE-IDENTICAL — a copy-pasted row, or two people logging the same
   * minute in the same words, both plausible accidents. `NoteRowIdentity`
   * is keyed by content fingerprint, so identical rows collide on the SAME
   * map slot: only one of them can occupy it, so which physical row reuses
   * it churns from ingest to ingest (see the comment on `mergeSessionNotes`
   * for the full trace). `sessionFingerprints`/`deletedFingerprints` are the
   * backstop that stops that churn from ever becoming a visible duplicate —
   * this is what an earlier version of that comment wrongly called
   * removable, and this test is what proves it is not: with the guards
   * removed, this fails after the SECOND ingest, gaining one phantom note
   * per re-ingest (verified by hand while fixing the comment).
   */
  it('two byte-identical blank-id rows in one file stay two notes, not duplicated, across repeated re-ingests', async () => {
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      ',2026,7,25,9,0,,,Priya,,,same text typed twice\n' +
      ',2026,7,25,9,0,,,Priya,,,same text typed twice\n';
    const noteRowIdentity = new Map<string, string>();

    const first = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', noteRowIdentity,
    });
    expect(first.notes).toHaveLength(2);

    const second = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', sessionNotes: first.notes, noteRowIdentity,
    });
    expect(second.notes).toHaveLength(2);

    // A third ingest, since the churn above is not guaranteed to repeat
    // identically every time — this is the strongest check that the count
    // stays capped rather than merely surviving one extra re-ingest.
    const third = await ingestFolder([textFile('notes.csv', notesCsv)], {
      title: 'x', sessionNotes: second.notes, noteRowIdentity,
    });
    expect(third.notes).toHaveLength(2);
  });

  /**
   * Item 7 of the 2026-07-30 rename-corruption review, at the WIRING level
   * rather than the standalone `reportUnresolvedNoteNames`/`resolveNotePhotos`
   * functions (covered directly above and in `tests/notes.test.ts`): a
   * `people.csv` roster and a `notes.csv` referencing a name outside it —
   * the real shape of "someone deleted an alias by hand" — must surface in
   * `ingestFolder`'s own `noteProblems`, not just be reportable in isolation.
   */
  it('reports an unresolved note name AND a missing photo together in noteProblems', async () => {
    const peopleCsv = 'id,name\np,Priya\n';
    const notesCsv =
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text\n' +
      'n1,2026,7,25,9,0,,,Ghost,,,seen at the aid station\n' +
      'n2,2026,7,25,9,5,,,Priya,missing.jpg,,wrong turn\n';

    const { notes, noteProblems } = await ingestFolder(
      [textFile('people.csv', peopleCsv), textFile('notes.csv', notesCsv)],
      { title: 'x' },
    );

    expect(notes).toHaveLength(2);
    expect(noteProblems.some((p) => p.includes('n1') && p.includes('Ghost'))).toBe(true);
    expect(noteProblems.some((p) => p.includes('n2') && p.includes('missing.jpg'))).toBe(true);
  });
});

describe('manifestForSave', () => {
  /**
   * The writer half of the notes-as-CSV migration: `notes[]` and
   * `items[].note` are legacy fields the VALIDATOR still accepts (so an old
   * manifest still loads), but this is the one place that has to stop
   * WRITING them, or a saved file would carry the same prose in two places —
   * silent duplication on the next load, not a crash, which is exactly the
   * kind of regression `make check` would otherwise wave through.
   */
  const baseManifest = (over: Partial<Manifest> = {}): Manifest => ({
    schema: SCHEMA_VERSION,
    event: { title: 'Race', timezone: 'UTC' },
    people: [{ id: 'p', name: 'Priya' }],
    items: [],
    ...over,
  });

  it('strips manifest.notes entirely — the key itself is gone, not emptied', () => {
    const manifest = baseManifest({
      notes: [{ id: 'n', at: '2026-07-25T09:00:00Z', text: 'wrong turn' }],
    });
    const saved = manifestForSave(manifest);
    // Object.hasOwn, not a truthiness check: `notes: []` or `notes: undefined`
    // would both read falsy but are not the same claim as "no such key".
    expect(Object.hasOwn(saved, 'notes')).toBe(false);
  });

  it('strips note from every item that carries one', () => {
    const manifest = baseManifest({
      items: [
        {
          id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
          timeSource: 'exif-offset', at: '2026-07-25T09:00:00Z', note: 'the buckle',
        } as Item,
        {
          id: 'b.jpg', person: 'p', type: 'photo', src: 'b.jpg',
          timeSource: 'exif-offset', at: '2026-07-25T09:05:00Z', note: 'the aid station',
        } as Item,
      ],
    });
    const saved = manifestForSave(manifest);
    expect(saved.items).toHaveLength(2);
    for (const item of saved.items) {
      expect(Object.hasOwn(item, 'note')).toBe(false);
    }
  });

  it('leaves an item with no note untouched, and does not add the key', () => {
    const manifest = baseManifest({
      items: [
        {
          id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
          timeSource: 'exif-offset', at: '2026-07-25T09:00:00Z',
        } as Item,
      ],
    });
    const saved = manifestForSave(manifest);
    expect(Object.hasOwn(saved.items[0] as object, 'note')).toBe(false);
    expect(saved.items[0]).toEqual(manifest.items[0]);
  });

  it('carries everything else through unchanged — event, people, course, markers', () => {
    const manifest = baseManifest({
      course: { kind: 'gpx', src: 'race.gpx' },
      markers: [{ label: 'Aid 3', atDistance: 42_000 }],
      items: [
        {
          id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
          timeSource: 'exif-offset', at: '2026-07-25T09:00:00Z', note: 'the buckle',
          width: 4000, height: 3000, gps: [45.5, -111.2],
        } as Item,
      ],
    });
    const saved = manifestForSave(manifest);
    expect(saved.schema).toBe(manifest.schema);
    expect(saved.event).toEqual(manifest.event);
    expect(saved.people).toEqual(manifest.people);
    expect(saved.course).toEqual(manifest.course);
    expect(saved.markers).toEqual(manifest.markers);
    // Everything on the item besides `note` rides along untouched.
    const { note: _dropped, ...restOfItem } = manifest.items[0] as Item;
    expect(saved.items[0]).toEqual(restOfItem);
  });

  it('does not mutate its input', () => {
    const manifest = baseManifest({
      notes: [{ id: 'n', at: '2026-07-25T09:00:00Z', text: 'wrong turn' }],
      items: [
        {
          id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
          timeSource: 'exif-offset', at: '2026-07-25T09:00:00Z', note: 'the buckle',
        } as Item,
      ],
    });
    manifestForSave(manifest);
    expect(Object.hasOwn(manifest, 'notes')).toBe(true);
    expect(manifest.notes).toHaveLength(1);
    expect(Object.hasOwn(manifest.items[0] as object, 'note')).toBe(true);
    expect((manifest.items[0] as Item).note).toBe('the buckle');
  });
});

/**
 * Item 7 of the 2026-07-30 rename-corruption review: a note naming someone
 * who does not resolve — a hand-deleted `also_known_as` alias, a typo, a
 * bystander nobody grouped media for — used to leave zero trace anywhere in
 * `noteProblems`. `resolvePersonNames` already tells "unknown" apart from
 * "known" (kept, not dropped — see its own doc comment); this is what makes
 * that visible at ingest, alongside `resolveNotePhotos`'s report for a
 * missing `photo` (covered directly in `tests/notes.test.ts`, since that
 * function lives in `core/notes.ts`).
 */
describe('reportUnresolvedNoteNames', () => {
  const PEOPLE: Person[] = [{ id: 'p', name: 'Priya' }];
  const note = (overrides: Partial<Note> & { id: string }): Note => ({
    at: '2026-07-25T09:00:00Z',
    people: [],
    author: [],
    text: 'x',
    ...overrides,
  });

  it('reports nothing when every name resolves', () => {
    const notes = [note({ id: 'n1', people: ['Priya'], author: ['Priya'] })];
    expect(reportUnresolvedNoteNames(notes, PEOPLE)).toEqual([]);
  });

  it('reports a note whose people name resolves to nobody', () => {
    const notes = [note({ id: 'n1', people: ['Ghost'] })];
    const problems = reportUnresolvedNoteNames(notes, PEOPLE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('n1');
    expect(problems[0]).toContain('Ghost');
  });

  it('reports a note whose author name resolves to nobody, distinctly from people', () => {
    const notes = [note({ id: 'n1', author: ['Ghost Writer'] })];
    const problems = reportUnresolvedNoteNames(notes, PEOPLE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Ghost Writer');
  });

  it('reports a partially-resolved note (one known name, one unknown) once, naming only the unknown one', () => {
    const notes = [note({ id: 'n1', people: ['Priya', 'Ghost'] })];
    const problems = reportUnresolvedNoteNames(notes, PEOPLE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Ghost');
    expect(problems[0]).not.toContain('"Priya"');
  });

  it('reports each affected note separately, and skips notes with nothing wrong', () => {
    const notes = [
      note({ id: 'n1', people: ['Ghost'] }),
      note({ id: 'n2', people: ['Priya'] }),
      note({ id: 'n3', author: ['Also Ghost'] }),
    ];
    const problems = reportUnresolvedNoteNames(notes, PEOPLE);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes('n1'))).toBe(true);
    expect(problems.some((p) => p.includes('n3'))).toBe(true);
  });
});

/**
 * The 2026-07-30 format change, at the WIRING level rather than against the
 * pure functions in `core/` — a column carried correctly by `notes.ts` and
 * then dropped by `ingestFolder` is exactly the failure the owner would only
 * find after committing a season of notes.
 */
describe('ingestFolder — the 2026-07-30 columns', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  const HEADERS =
    'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,' +
    'author,text,written,deleted,schema\n';

  it('keeps tombstones out of `notes` and in `deletedNotes`', async () => {
    const csv = HEADERS +
      'n_live,2026,7,25,15,0,,UTC,0,,,Dan,still here,,,1\n' +
      'n_gone,2026,7,25,16,0,,UTC,0,,,Dan,removed on purpose,,1,1\n';
    const { notes, deletedNotes } = await ingestFolder([textFile('notes.csv', csv)], {
      title: 'x', timezone: 'UTC',
    });
    expect(notes.map((n) => n.id)).toEqual(['n_live']);
    expect(deletedNotes.map((n) => n.id)).toEqual(['n_gone']);
  });

  it('does not resurrect a note another copy of the file still has', async () => {
    // The whole point of the column: one crew member's notes.csv still
    // carries the note, another's records that it went.
    const stillThere = HEADERS + 'n_x,2026,7,25,15,0,,UTC,0,,,Dan,a wrong turn,,,1\n';
    const deleted = HEADERS + 'n_x,2026,7,25,15,0,,UTC,0,,,Dan,a wrong turn,,1,1\n';
    const { notes, deletedNotes } = await ingestFolder(
      [textFile('notes-priya.csv', stillThere), textFile('notes-dan.csv', deleted)],
      { title: 'x', timezone: 'UTC' },
    );
    expect(notes).toEqual([]);
    expect(deletedNotes).toHaveLength(1);
  });

  it('refuses a row from a newer build, reports it, and loads the rest', async () => {
    const csv = HEADERS +
      'n_ok,2026,7,25,15,0,,UTC,0,,,Dan,readable,,,1\n' +
      'n_future,2026,7,25,16,0,,UTC,0,,,Dan,from a newer meanwhile,,,2\n';
    const { notes, noteProblems } = await ingestFolder([textFile('notes.csv', csv)], {
      title: 'x', timezone: 'UTC',
    });
    expect(notes.map((n) => n.id)).toEqual(['n_ok']);
    const refusal = noteProblems.filter((p) => p.includes('schema'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain('notes.csv');
    expect(refusal[0]).toContain('n_future');
  });

  it('carries people.csv columns it does not understand through to the caller', async () => {
    const { peopleExtra, noteProblems } = await ingestFolder(
      [textFile('people.csv', 'id,name,pronouns\np,Priya,she/her\n')],
      { title: 'x' },
    );
    expect(noteProblems).toEqual([]);
    expect(peopleExtra.get('p')).toEqual({ pronouns: 'she/her' });
  });

  it('reports a people.csv row from a newer build rather than reading it', async () => {
    const { noteProblems } = await ingestFolder(
      [textFile('people.csv', 'id,name,schema\np,Priya,99\n')],
      { title: 'x' },
    );
    expect(noteProblems).toHaveLength(1);
    expect(noteProblems[0]).toContain('people.csv');
  });

  /**
   * A file written before any of these columns existed. The instants it
   * produces are the promise being made to a repo of real notes, so they are
   * asserted against a frozen fixture rather than against whatever the
   * current writer emits.
   */
  it('reads a pre-change notes.csv to exactly the instants it always did', async () => {
    const { notes, noteProblems } = await ingestFolder(
      [textFile('notes.csv', NOTES_CSV_BEFORE), textFile('people.csv', PEOPLE_CSV_BEFORE)],
      { title: 'x', timezone: 'America/Denver' },
    );
    // The fixture names an author who is not on this roster and a photo that
    // is not in this folder, both of which are reported as they always were.
    // Nothing about the FORMAT may be.
    expect(noteProblems.filter((p) => p.includes('schema'))).toEqual([]);
    expect(noteProblems.filter((p) => p.includes('utc_offset'))).toEqual([]);
    expect(notes).toHaveLength(3);
    expect(notes.find((n) => n.id === 'n_k3f9x2')?.at)
      .toBe(new Date(Date.UTC(2026, 6, 25, 21, 45)).toISOString());
    expect(notes.find((n) => n.id === 'n_p1a7m4')?.at)
      .toBe(new Date(Date.UTC(2026, 6, 25, 15, 53)).toISOString());
  });
});

describe('ingestFolder — inferring the event timezone', () => {
  /** A file with nothing in it that states an offset. */
  function bareFile(path: string): PickedFile {
    return { path, file: new File([new Uint8Array(8)], path) };
  }

  /**
   * A real JPEG whose EXIF carries `OffsetTimeOriginal` — the signal the
   * inference reads. Built rather than stubbed because the whole claim under
   * test is that ingest reaches the offset the photograph actually records.
   */
  function photoAt(path: string, offset: string): PickedFile {
    const tiff = buildTiff({
      exif: [
        { tag: 0x9003, type: TYPE_ASCII, values: '2026:07:25 15:45:00' },
        { tag: 0x9011, type: TYPE_ASCII, values: offset },
      ],
    });
    // `buildJpeg` is typed as a bare `Uint8Array`, whose backing buffer
    // TypeScript widens to `ArrayBufferLike`, while `BlobPart` wants a
    // concrete `ArrayBuffer`. It really is one — the same cast, and the same
    // reason, as the `zipBytes` call in `App.tsx`.
    const bytes = buildJpeg(tiff) as Uint8Array<ArrayBuffer>;
    return { path, file: new File([bytes], path) };
  }

  it('leaves the given zone alone when nothing carries an offset', async () => {
    const { manifest } = await ingestFolder([bareFile('IMG_0001.jpg')], {
      title: 'x', timezone: 'America/Denver', inferTimezone: true,
    });
    expect(manifest.event.timezone).toBe('America/Denver');
  });

  it('takes the zone from the photographs when the browser zone disagrees', async () => {
    // A race in the Alps, opened on a laptop in Denver. The photographs say
    // where the event was; the laptop says where the author is now.
    const { manifest } = await ingestFolder(
      [photoAt('a.jpg', '+02:00'), photoAt('b.jpg', '+02:00')],
      { title: 'x', timezone: 'America/Denver', inferTimezone: true },
    );
    expect(manifest.event.timezone).toBe('Etc/GMT-2');
  });

  it('never infers unless asked, so "Add files" cannot revert a hand-set zone', async () => {
    // Same photographs, `inferTimezone` off: the live zone may be one the
    // author typed by hand, and silently reverting that would move every
    // naive timestamp under them.
    const { manifest } = await ingestFolder(
      [photoAt('a.jpg', '+02:00'), photoAt('b.jpg', '+02:00')],
      { title: 'x', timezone: 'America/Denver' },
    );
    expect(manifest.event.timezone).toBe('America/Denver');
  });

  it('lets a manifest in the folder win outright', async () => {
    const manifestJson = JSON.stringify({
      schema: SCHEMA_VERSION,
      event: { title: 'Race', timezone: 'Europe/Zurich' },
      people: [],
      items: [],
    });
    const { manifest } = await ingestFolder(
      [{ path: 'manifest.json', file: new File([manifestJson], 'manifest.json') }],
      { title: 'x', timezone: 'America/Denver', inferTimezone: true },
    );
    expect(manifest.event.timezone).toBe('Europe/Zurich');
  });
});

/**
 * `isManifestFile` and `isPeopleFile` match `manifest.json` and `people.csv`
 * ANYWHERE in the tree, which is deliberate — it is how dragging a subfolder
 * in works. What was not deliberate is that `ingestFolder` looped over every
 * match without stopping, so the LAST one in path order won.
 *
 * Reproduced by a security review: adding `zz-crew/manifest.json` and
 * `zz-crew/people.csv` replaced the event title, timezone, time window, course
 * reference and whole roster — a 10-hour `clockOffset` included, which moves
 * every photo on the timeline — with `importedFrom` naming the subfolder file
 * and not one word said about it. Far likelier by ACCIDENT than by malice: a
 * contributor zips their own working folder in.
 */
describe('ingestFolder — one manifest and one roster per folder, the shallowest', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  const manifestJson = (title: string, timezone: string) => JSON.stringify({
    schema: SCHEMA_VERSION,
    event: {
      title,
      timezone,
      range: { from: '2026-07-25T00:00:00Z', to: '2026-07-26T00:00:00Z' },
    },
    people: [{ id: 'p', name: title, clockOffset: 'PT10H' }],
    items: [],
  });

  const ROOT_MANIFEST = manifestJson('Real race', 'America/Denver');
  const NESTED_MANIFEST = manifestJson('Crew working folder', 'UTC');

  it('keeps the root manifest when a subfolder carries one too', async () => {
    const { manifest, importedFrom } = await ingestFolder([
      textFile('zz-crew/manifest.json', NESTED_MANIFEST),
      textFile('manifest.json', ROOT_MANIFEST),
    ], { title: 'fallback' });

    expect(importedFrom).toBe('manifest.json');
    expect(manifest.event.title).toBe('Real race');
    expect(manifest.event.timezone).toBe('America/Denver');
  });

  it('keeps the root manifest even when the subfolder one sorts last', async () => {
    // The original bug: last file in path order wins. `zz-` sorts after
    // `manifest.json`, which is exactly how the review reproduced it.
    const { manifest } = await ingestFolder([
      textFile('manifest.json', ROOT_MANIFEST),
      textFile('zz-crew/manifest.json', NESTED_MANIFEST),
    ], { title: 'fallback' });
    expect(manifest.event.title).toBe('Real race');
  });

  it('keeps the root roster, clock offsets and all', async () => {
    const { manifest } = await ingestFolder([
      textFile('people.csv', 'id,name,role,clock_offset\np,Priya,runner,\n'),
      textFile('zz-crew/people.csv', 'id,name,role,clock_offset\np,IMPOSTOR,,PT10H\n'),
    ], { title: 'x' });

    expect(manifest.people).toHaveLength(1);
    expect(manifest.people[0]?.name).toBe('Priya');
    expect(manifest.people[0]?.clockOffset).toBeUndefined();
  });

  it('says which file it used and which it ignored, in plain words', async () => {
    const { noteProblems } = await ingestFolder([
      textFile('manifest.json', ROOT_MANIFEST),
      textFile('people.csv', 'id,name\np,Priya\n'),
      textFile('zz-crew/manifest.json', NESTED_MANIFEST),
      textFile('zz-crew/people.csv', 'id,name\np,IMPOSTOR\n'),
    ], { title: 'x' });

    const ignored = noteProblems.filter((p) => p.startsWith('Ignored'));
    expect(ignored).toHaveLength(2);
    expect(ignored[0]).toContain('zz-crew/manifest.json');
    expect(ignored[0]).toContain('manifest.json');
    expect(ignored[0]).toContain('closest to the top');
    expect(ignored[1]).toContain('zz-crew/people.csv');
    expect(ignored[1]).toContain('people.csv');
  });

  it('breaks a same-depth tie by path, so the same folder always loads the same way', async () => {
    const first = await ingestFolder([
      textFile('b.manifest.json', NESTED_MANIFEST),
      textFile('a.manifest.json', ROOT_MANIFEST),
    ], { title: 'x' });
    const second = await ingestFolder([
      textFile('a.manifest.json', ROOT_MANIFEST),
      textFile('b.manifest.json', NESTED_MANIFEST),
    ], { title: 'x' });
    expect(first.importedFrom).toBe('a.manifest.json');
    expect(second.importedFrom).toBe('a.manifest.json');
  });

  it('still uses a subfolder manifest when that is the only one there', async () => {
    // Dropping one person's folder in is a supported way to work; nothing
    // about this change may break it.
    const { manifest, importedFrom, noteProblems } = await ingestFolder(
      [textFile('crew/manifest.json', ROOT_MANIFEST)], { title: 'fallback' },
    );
    expect(importedFrom).toBe('crew/manifest.json');
    expect(manifest.event.title).toBe('Real race');
    expect(noteProblems.filter((p) => p.startsWith('Ignored'))).toEqual([]);
  });
});

/**
 * A malformed track used to be read in silence: an unclosed element ground
 * the whole tab to a halt, and a `lat="999999"` was plotted as though it were
 * a real place. `parseCourse` now says what was wrong with the file, and this
 * is the wiring that puts it in front of the person who has to fix it.
 */
describe('ingestFolder — a track file with something wrong with it', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  it('names the track file and what was wrong with it', async () => {
    const xml =
      '<?xml version="1.0"?><gpx><trk><trkseg>' +
      '<trkpt lat="999999" lon="-110.5"><ele>1500</ele></trkpt>' +
      '<trkpt lat="45.8" lon="-110.5"><ele>1500</ele></trkpt>' +
      '<trkpt lat="45.81" lon="-110.5"><ele>1600</ele></trkpt>' +
      '</trkseg></trk></gpx>';
    const { course, noteProblems } = await ingestFolder(
      [textFile('race/track.gpx', xml)], { title: 'x' },
    );
    expect(course?.samples).toHaveLength(2);
    const reported = noteProblems.filter((p) => p.includes('not on Earth'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('race/track.gpx');
  });

  it('says nothing about a track that is fine', async () => {
    const xml =
      '<?xml version="1.0"?><gpx><trk><trkseg>' +
      '<trkpt lat="45.8" lon="-110.5"><ele>1500</ele></trkpt>' +
      '<trkpt lat="45.81" lon="-110.5"><ele>1600</ele></trkpt>' +
      '</trkseg></trk></gpx>';
    const { noteProblems } = await ingestFolder([textFile('track.gpx', xml)], { title: 'x' });
    expect(noteProblems).toEqual([]);
  });
});

/**
 * The other seam a tombstone can cross: a `notes.csv` row cancelling a note
 * that came out of a legacy `manifest.json` sitting in the same folder.
 * `mergeNotes` cannot see this one — by the time the two lists meet, they have
 * already been through separate readers — so it is reported here instead.
 */
describe('ingestFolder — a tombstone that cancels a legacy manifest note', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  it('says which file deleted it and what the note said', async () => {
    const manifestJson = JSON.stringify({
      schema: SCHEMA_VERSION,
      event: { title: 'Race', timezone: 'UTC' },
      people: [],
      items: [],
      notes: [{ id: 'n_old', at: '2026-07-25T15:00:00Z', text: 'the note in the old manifest' }],
    });
    const csv =
      'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,' +
      'author,text,written,deleted,schema\n' +
      'n_old,2026,7,25,15,0,,UTC,0,,,,.,,1,1\n';

    const { notes, noteProblems } = await ingestFolder(
      [textFile('manifest.json', manifestJson), textFile('notes.csv', csv)],
      { title: 'x', timezone: 'UTC' },
    );
    expect(notes).toEqual([]);
    const reported = noteProblems.filter((p) => p.includes('n_old'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('notes.csv');
    expect(reported[0]).toContain('the note in the old manifest');
    expect(reported[0]).toContain('manifest.json');
  });
});

/**
 * Four data-loss bugs found by execution on 2026-07-30, all at the seam
 * between "this session" and "what is on disk". Each one is reproduced here
 * as it was hit — the roster reverting, the course vanishing, the refused row
 * disappearing, the deeper manifest standing in for the broken shallow one.
 */
describe('ingestFolder — what "Add files" must not throw away', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  const PEOPLE_CSV = ['id,name,role,clock_offset,also_known_as,schema', 'p1,Google Pixel 8 Pro,,,,'].join('\n');
  const NOTES_CSV = [
    'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema',
    'n_1,2026,7,25,10,0,,UTC,0,Google Pixel 8 Pro,,,at the aid station,,,',
  ].join('\n');

  it('keeps an in-session rename instead of reverting to the unsaved people.csv', async () => {
    const first = await ingestFolder(
      [textFile('people.csv', PEOPLE_CSV), textFile('notes.csv', NOTES_CSV)],
      { title: 'T', timezone: 'UTC' },
    );
    const renamed = applyRename(first.manifest.people, first.notes, 'p1', 'Priya');
    expect(renamed.people[0]?.name).toBe('Priya');
    expect(renamed.people[0]?.alsoKnownAs).toEqual(['Google Pixel 8 Pro']);
    expect(renamed.notes[0]?.people).toEqual(['Priya']);

    // "Add files" to drop in a track — the documented workflow. Nothing has
    // been saved, so people.csv on disk still says the device name.
    const second = await ingestFolder(
      [textFile('people.csv', PEOPLE_CSV), textFile('notes.csv', NOTES_CSV), textFile('r.gpx', '<gpx></gpx>')],
      {
        title: 'T', timezone: 'UTC',
        existingPeople: renamed.people,
        sessionPeople: renamed.people,
        sessionNotes: renamed.notes,
      },
    );

    expect(second.manifest.people[0]?.name).toBe('Priya');
    // The alias is the load-bearing half: without it the rewritten note's
    // name resolves to nobody at all.
    expect(second.manifest.people[0]?.alsoKnownAs).toEqual(['Google Pixel 8 Pro']);
    expect(second.noteProblems.some((p) => p.includes("doesn't match anyone"))).toBe(false);
    // And it says the roster on disk is out of date rather than doing it
    // silently.
    expect(second.noteProblems.some((p) => p.includes('Save to write them'))).toBe(true);
  });

  it('keeps an in-session role too', async () => {
    const first = await ingestFolder([textFile('people.csv', PEOPLE_CSV)], { title: 'T', timezone: 'UTC' });
    const withRole = first.manifest.people.map((p) => ({ ...p, role: 'runner' as const }));
    const second = await ingestFolder(
      [textFile('people.csv', PEOPLE_CSV), textFile('r.gpx', '<gpx></gpx>')],
      { title: 'T', timezone: 'UTC', existingPeople: withRole, sessionPeople: withRole },
    );
    expect(second.manifest.people[0]?.role).toBe('runner');
  });

  it('still lets a people.csv dropped in mid-session introduce someone new', async () => {
    // Session-wins must not mean the file is ignored: an id the session has
    // never heard of is exactly how a collaborator's roster gets in.
    const session = [{ id: 'p1', name: 'Priya' }];
    const roster = ['id,name,role,clock_offset,also_known_as,schema', 'p1,Google Pixel 8 Pro,,,,', 'p9,Sam,,,,'].join('\n');
    const result = await ingestFolder([textFile('people.csv', roster)], {
      title: 'T', timezone: 'UTC', existingPeople: session, sessionPeople: session,
    });
    expect(result.manifest.people.map((p) => p.name).sort()).toEqual(['Priya', 'Sam']);
  });

  it('carries the crop, the course link and the markers forward', async () => {
    // Set a Strava link, then add a track: all three used to be restored only
    // from an imported manifest.json, so all three vanished.
    const notes = 'id,year,month,day,hour,minute,text\nn_1,2026,7,25,10,0,hi\n';
    const result = await ingestFolder([textFile('notes.csv', notes)], {
      title: 'T', timezone: 'UTC',
      existingRange: { from: '2026-07-25T00:00:00Z', to: '2026-07-26T00:00:00Z' },
      existingCourse: { kind: 'strava-link', url: 'https://www.strava.com/activities/1' },
      existingMarkers: [{ at: '2026-07-25T10:00:00Z', label: 'start' }],
    });
    expect(result.manifest.course).toEqual({
      kind: 'strava-link', url: 'https://www.strava.com/activities/1',
    });
    expect(result.manifest.event.range?.from).toBe('2026-07-25T00:00:00Z');
    expect(result.manifest.markers?.[0]?.label).toBe('start');
  });

  it('surfaces a refused course URL as a problem, and keeps everything else', async () => {
    /*
     * The end-to-end shape of the warning-not-error decision.
     *
     * A scheme-less paste — the ordinary thing to type — used to refuse the
     * WHOLE manifest here, which took the crop, the markers and every
     * `timeSource: 'manual'` placement with it. Now the manifest loads, the
     * URL is kept verbatim, and the reason the link will not render is in the
     * same problems callout as every other silent outcome.
     *
     * `validateManifest`'s warnings had NEVER been read by anything in
     * src/viewer before this, so without the last assertion the warning would
     * be collected into a variable nobody renders and the reader would see a
     * missing link with no explanation anywhere.
     */
    const inFolder = JSON.stringify({
      schema: SCHEMA_VERSION,
      event: {
        title: 'CM100', timezone: 'UTC',
        range: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
      },
      course: { kind: 'strava-link', url: 'strava.com/activities/123' },
      markers: [{ at: '2026-01-01T10:00:00Z', label: 'Cottonwood' }],
      people: [{ id: 'p', name: 'Priya' }],
      items: [
        {
          id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
          at: '2026-01-01T10:00:00Z', timeSource: 'manual',
        },
      ],
    });
    // The photograph itself is in the folder too, so the manual placement has
    // a file to stay attached to — that is the thing a refusal destroyed.
    const result = await ingestFolder(
      [textFile('manifest.json', inFolder), textFile('a.jpg', 'pretend jpeg bytes')],
      { title: 'T', timezone: 'UTC' },
    );

    // Nothing was lost.
    expect(result.importError).toBeNull();
    expect(result.manifest.event.title).toBe('CM100');
    expect(result.manifest.event.range?.from).toBe('2026-01-01T00:00:00Z');
    expect(result.manifest.markers?.[0]?.label).toBe('Cottonwood');
    expect(result.manifest.items.find((i) => i.id === 'a.jpg')?.timeSource).toBe('manual');
    // The URL is kept exactly as written — refusing to act on a value is not
    // permission to delete it.
    expect(result.manifest.course).toEqual({
      kind: 'strava-link', url: 'strava.com/activities/123',
    });
    // And the reader is told why the link will not appear.
    expect(
      result.noteProblems.some((p) => p.includes('manifest.json') && p.includes('course.url')),
    ).toBe(true);
  });

  it('reports NOTHING AT ALL for a clean manifest with a Strava link', async () => {
    /*
     * Asserts the whole list is empty, not merely that it lacks the string
     * "course.url" — the weaker assertion was what this test made first, and
     * it passed while the callout was in fact firing on every correct file,
     * because the noise came from a DIFFERENT warning (the unconditional
     * "no time-and-distance data" advisory). Aim at the property — this
     * folder has nothing wrong with it, so the reader must be told nothing.
     */
    const inFolder = JSON.stringify({
      schema: SCHEMA_VERSION,
      event: { title: 'T', timezone: 'UTC' },
      course: { kind: 'strava-link', url: 'https://www.strava.com/activities/1' },
      people: [], items: [],
    });
    const result = await ingestFolder([textFile('manifest.json', inFolder)], {
      title: 'T', timezone: 'UTC',
    });
    expect(result.noteProblems).toEqual([]);
  });

  it('puts a manifest advisory LAST, behind anything that reports a loss', async () => {
    /*
     * Ordering, pinned because it is invisible otherwise. `noteProblems` is
     * rendered as one joined sentence, so whatever comes first is what gets
     * read. Everything else in that list reports something DISCARDED or
     * unreadable — a note another file deleted, a roster ignored, a name that
     * resolved to nobody. A manifest advisory is not that, and it spliced in
     * second until this was fixed, ahead of every one of them.
     */
    const inFolder = JSON.stringify({
      schema: SCHEMA_VERSION,
      event: { title: 'T', timezone: 'UTC' },
      // Produces a manifest warning: not a plain https:// address.
      course: { kind: 'strava-link', url: 'strava.com/activities/1' },
      people: [{ id: 'p', name: 'Priya' }],
      items: [],
    });
    // Produces a real report: a note naming somebody not on the roster.
    const notes = 'id,year,month,day,hour,minute,people,text\nn_1,2026,7,25,10,0,Ghost,hi\n';
    const result = await ingestFolder(
      [textFile('manifest.json', inFolder), textFile('notes.csv', notes)],
      { title: 'T', timezone: 'UTC' },
    );

    const advisory = result.noteProblems.findIndex((p) => p.includes('course.url'));
    const loss = result.noteProblems.findIndex((p) => p.includes('Ghost'));
    expect(advisory, 'the advisory should be reported').toBeGreaterThanOrEqual(0);
    expect(loss, 'the unresolved name should be reported').toBeGreaterThanOrEqual(0);
    expect(loss).toBeLessThan(advisory);
  });

  it('lets a manifest in the folder still outrank what the session carries', async () => {
    const inFolder = JSON.stringify({
      schema: SCHEMA_VERSION,
      event: {
        title: 'From the folder', timezone: 'UTC',
        range: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
      },
      course: { kind: 'strava-link', url: 'https://www.strava.com/activities/999' },
      people: [], items: [],
    });
    const result = await ingestFolder([textFile('manifest.json', inFolder)], {
      title: 'T', timezone: 'UTC',
      existingRange: { from: '2026-07-25T00:00:00Z', to: '2026-07-26T00:00:00Z' },
      existingCourse: { kind: 'strava-link', url: 'https://www.strava.com/activities/1' },
    });
    expect(result.manifest.event.range?.from).toBe('2026-01-01T00:00:00Z');
    expect(result.manifest.course).toEqual({
      kind: 'strava-link', url: 'https://www.strava.com/activities/999',
    });
  });
});

describe('mergeSessionPeople', () => {
  const disk: Person[] = [{ id: 'p1', name: 'Google Pixel 8 Pro' }, { id: 'p9', name: 'Sam' }];

  it('returns the disk roster untouched when there is no session', () => {
    expect(mergeSessionPeople(undefined, disk)).toBe(disk);
  });

  it('lays the session over the disk, per id, keeping disk-only people', () => {
    const merged = mergeSessionPeople([{ id: 'p1', name: 'Priya' }], disk) ?? [];
    expect(merged.map((p) => p.name)).toEqual(['Priya', 'Sam']);
  });

  it('is the session alone when nothing is on disk', () => {
    const session: Person[] = [{ id: 'p1', name: 'Priya' }];
    expect(mergeSessionPeople(session, undefined)).toBe(session);
  });
});

describe('reportUnsavedRosterEdits', () => {
  const disk: Person[] = [{ id: 'p1', name: 'Google Pixel 8 Pro' }];

  it('names the person whose row on disk disagrees', () => {
    const problems = reportUnsavedRosterEdits([{ id: 'p1', name: 'Priya' }], disk, 'people.csv');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Google Pixel 8 Pro');
    expect(problems[0]).toContain('Priya');
    expect(problems[0]).toContain('people.csv');
  });

  it('says nothing when the two agree', () => {
    expect(reportUnsavedRosterEdits([{ id: 'p1', name: 'Google Pixel 8 Pro' }], disk, 'people.csv')).toEqual([]);
  });

  it('notices a role or a clock offset changing, not just a name', () => {
    expect(
      reportUnsavedRosterEdits([{ id: 'p1', name: 'Google Pixel 8 Pro', role: 'runner' }], disk, 'people.csv'),
    ).toHaveLength(1);
    expect(
      reportUnsavedRosterEdits(
        [{ id: 'p1', name: 'Google Pixel 8 Pro', clockOffset: '-PT4S' }], disk, 'people.csv',
      ),
    ).toHaveLength(1);
  });

  // The message used to be a rename either way, so a change that left the
  // name alone read `"Bob" is now "Bob"` — a sentence that describes nothing
  // and, worse, blames the one field that did not move.
  it('says what a clock-offset-only change actually was, not that it is a rename', () => {
    const problems = reportUnsavedRosterEdits(
      [{ id: 'p1', name: 'Google Pixel 8 Pro', clockOffset: '-PT4S' }], disk, 'people.csv',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('clock offset');
    expect(problems[0]).not.toContain('is now');
    expect(problems[0]).not.toContain('"Google Pixel 8 Pro" is now "Google Pixel 8 Pro"');
  });

  it('says what a role-only change actually was', () => {
    const problems = reportUnsavedRosterEdits(
      [{ id: 'p1', name: 'Google Pixel 8 Pro', role: 'runner' }], disk, 'people.csv',
    );
    expect(problems[0]).toContain('role');
    expect(problems[0]).not.toContain('is now');
  });

  it('says what an alias-only change actually was', () => {
    const problems = reportUnsavedRosterEdits(
      [{ id: 'p1', name: 'Google Pixel 8 Pro', alsoKnownAs: ['Pixel'] }], disk, 'people.csv',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('earlier names');
    expect(problems[0]).not.toContain('is now');
  });

  it('names the rename AND the other field when both moved', () => {
    const problems = reportUnsavedRosterEdits(
      [{ id: 'p1', name: 'Priya', clockOffset: '-PT4S' }], disk, 'people.csv',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"Google Pixel 8 Pro" is now "Priya"');
    expect(problems[0]).toContain('clock offset');
  });

  it('keeps naming a plain rename the way it always did', () => {
    const problems = reportUnsavedRosterEdits([{ id: 'p1', name: 'Priya' }], disk, 'people.csv');
    expect(problems[0]).toContain('"Google Pixel 8 Pro" is now "Priya"');
    expect(problems[0]).not.toContain('clock offset');
    expect(problems[0]).not.toContain('role');
  });
});

describe('ingestFolder — rows it could not read come back out', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }

  it('hands the raw notes.csv and people.csv rows to the save path', async () => {
    const notes = [
      'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema',
      'n_ok,2026,7,25,10,0,,UTC,0,,,,readable,,,',
      'n_future,2026,7,25,11,0,,UTC,0,,,,from a newer build,,,2',
    ].join('\n');
    const people = ['id,name,role,clock_offset,also_known_as,schema', 'p1,Priya,,,,', 'p2,Sam,,,,2'].join('\n');
    const result = await ingestFolder(
      [textFile('notes.csv', notes), textFile('people.csv', people)],
      { title: 'T', timezone: 'UTC' },
    );

    expect(result.notes.map((n) => n.text)).toEqual(['readable']);
    expect(result.preservedNoteRows.map((r) => r.cells['id'])).toEqual(['n_future']);
    expect(result.manifest.people.map((p) => p.id)).toEqual(['p1']);
    expect(result.preservedPeopleRows.map((r) => r.cells['id'])).toEqual(['p2']);
  });

  it('reports nothing preserved for a folder that reads cleanly', async () => {
    const notes = 'id,year,month,day,hour,minute,text\nn_1,2026,7,25,10,0,hi\n';
    const result = await ingestFolder([textFile('notes.csv', notes)], { title: 'T', timezone: 'UTC' });
    expect(result.preservedNoteRows).toEqual([]);
    expect(result.preservedPeopleRows).toEqual([]);
  });
});

describe('ingestFolder — a broken manifest closest to the top', () => {
  function textFile(path: string, text: string): PickedFile {
    return { path, file: new File([text], path.slice(path.lastIndexOf('/') + 1)) };
  }
  const good = JSON.stringify({
    schema: SCHEMA_VERSION,
    event: { title: 'Deep event', timezone: 'UTC' },
    people: [{ id: 'p1', name: 'Deep person' }],
    items: [],
  });

  it('says so when a deeper manifest stood in for it', async () => {
    // `shallowestFirst` exists to stop this substitution, and an unreadable
    // shallowest candidate fell straight through it: the only trace was an
    // `importError` naming a DIFFERENT file from the one actually in use,
    // which reads as "nothing was applied".
    const result = await ingestFolder(
      [textFile('manifest.json', '{ not json'), textFile('sub/manifest.json', good)],
      { title: 'T', timezone: 'UTC' },
    );
    expect(result.importedFrom).toBe('sub/manifest.json');
    const said = result.noteProblems.join(' ');
    expect(said).toContain('manifest.json');
    expect(said).toContain('sub/manifest.json');
    expect(said).toContain('closer to the top');
  });

  it('stays quiet when the broken manifest was the only one', async () => {
    // With no substitute, `importError` is the whole story and repeating it
    // in the problems list would just be noise.
    const result = await ingestFolder([textFile('manifest.json', '{ not json')], {
      title: 'T', timezone: 'UTC',
    });
    expect(result.importedFrom).toBeNull();
    expect(result.importError).toContain('manifest.json');
    expect(result.noteProblems).toEqual([]);
  });
});
