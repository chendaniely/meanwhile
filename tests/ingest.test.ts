import { describe, expect, it } from 'vitest';
import {
  ingestFolder, legacyNoteToNote, manifestForSave, mergeSessionNotes, migrateLegacyNotes,
} from '../src/viewer/media/ingest.ts';
import type { PickedFile } from '../src/viewer/media/folder.ts';
import type { Note } from '../src/core/notes.ts';
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
