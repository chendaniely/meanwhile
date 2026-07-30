import { describe, expect, it } from 'vitest';
import {
  ingestFolder, legacyNoteToNote, manifestForSave, mergeSessionNotes, migrateLegacyNotes,
} from '../src/viewer/media/ingest.ts';
import type { PickedFile } from '../src/viewer/media/folder.ts';
import { fingerprintNote, type Note } from '../src/core/notes.ts';
import type { Item, Manifest, Note as LegacyNote, Person } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { parseDuration } from '../src/core/time.ts';

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
   * These two run the whole pipeline against real `File` objects (Node's
   * global `File`, no browser needed) rather than the pure pieces above, to
   * prove the WIRING and not just the individual functions: `ingestFolder`
   * really does dedupe a legacy manifest against its own migrated notes.csv,
   * and really does carry a session forward when called the way `App.tsx`
   * calls it on "Add files".
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
