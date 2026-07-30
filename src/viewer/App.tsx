import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupingInfo } from '../core/assemble.ts';
import {
  anchorItems,
  atDistance,
  estimateInstant,
  simplify,
  type Anchor,
  type Course,
  type TimeAnchor,
} from '../core/course.ts';
import { formatCsv } from '../core/csv.ts';
import {
  fingerprintNote, mintNoteId, noteHeadersFor, noteToRow, stampBlankAuthors,
  type Note, type NoteRowIdentity,
} from '../core/notes.ts';
import {
  applyRename, displayName, formatPeopleCsv, type PeopleExtra,
} from '../core/people-csv.ts';
import type { Manifest, PersonId } from '../core/schema.ts';
import { isVisible, toggleVisible, VIEW_NAMES, type ViewName } from '../core/state.ts';
import { formatClock, type Instant } from '../core/time.ts';
import { assignLaneColors } from '../core/palette.ts';
import {
  excludingCaptions,
  fullSpan,
  isWithin,
  placeItems,
  placeNotes,
  resolveDefaultRange,
  windowIncludingNotes,
  type PlacedItem,
  type TimeWindow,
} from '../core/window.ts';
import { CourseCharts } from './components/CourseCharts.tsx';
import { CourseFallback } from './components/CourseFallback.tsx';
import { CourseRail } from './components/CourseRail.tsx';
import { NoteList } from './components/Notes.tsx';
import { NoteDock } from './components/NoteDock.tsx';
import { PersonPicker } from './components/PersonPicker.tsx';
import { Feed } from './components/Feed.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { Swimlanes } from './components/Swimlanes.tsx';
import { FilePicker, FolderPicker } from './components/FolderPicker.tsx';
import { IngestReport } from './components/IngestReport.tsx';
import { TimeWindowSlider } from './components/TimeWindowSlider.tsx';
import { TimezoneField } from './components/TimezoneField.tsx';
import { UnplacedTray } from './components/UnplacedTray.tsx';
import { CourseMap } from './map/CourseMap.tsx';
import { MediaProvider } from './media/MediaContext.tsx';
import { useMediaStore } from './media/useMediaStore.ts';
import { trackView } from './analytics.ts';
import { useAppState } from './hooks/useAppState.ts';
import { useMeasuredHeight } from './hooks/useMeasuredHeight.ts';
import type { PickedFile } from './media/folder.ts';
import {
  ingestFolder,
  manifestForSave,
  type IngestProgress,
} from './media/ingest.ts';
import { zipBytes } from './media/zip.ts';
import './App.css';

/** The browser's own zone is right far more often than not — it is where the
 * author lives, and usually where the race was. Editable either way. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The URL of whichever course variant is set, for the input's value. */
function courseUrlOf(manifest: Manifest): string {
  const course = manifest.course;
  if (!course) return '';
  return course.kind === 'gpx' ? course.src : course.url;
}

/**
 * `meanwhile-<slug of the event title>-<when>.zip`, or
 * `meanwhile-<when>.zip` when there is no title to slug — a blank event name
 * must still produce a legal filename.
 *
 * The stamp is the moment of SAVING, not anything about the event, and it is
 * there because saving is not a one-off: you open the folder, write a few
 * notes, save, write more, save again. Without it every download collides in
 * the browser's downloads folder and you get `meanwhile-race (3).zip`, which
 * sorts by nothing and tells you nothing about which is newest.
 *
 * `YYYY-MM-DD-HHMM`, local time and 24-hour, so the names sort
 * chronologically as plain text and match the date format used everywhere
 * else here. Colons would be illegal on Windows, so the time runs together.
 *
 * `now` is a parameter rather than read inside so the format can be pinned by
 * a test without faking the clock.
 */
export function filenameForSave(title: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const when =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;

  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `meanwhile-${slug}-${when}.zip` : `meanwhile-${when}.zip`;
}

/**
 * The three files a Save writes, as text.
 *
 * Pure and exported for the same reason `filenameForSave` above is: this is
 * the last thing that happens to a season of someone's writing before it
 * leaves the browser, and every question worth asking about it — is the
 * tombstone in there, did the roster keep the column somebody added, is the
 * manifest still stripped of its legacy note fields — is a question about
 * these strings, not about a Blob, an anchor, or a zip.
 *
 * `deleted` rides along with the live notes in ONE chronological list rather
 * than in a block at the end: a tombstone is an event on the timeline like
 * any other row, and a deletion that is not written out is one that any
 * older copy of `notes.csv` silently undoes on the next merge.
 */
export function filesForSave(
  manifest: Manifest,
  notes: readonly Note[],
  tombstones: readonly Note[],
  peopleExtra?: PeopleExtra,
): Array<{ name: string; text: string }> {
  const rows = [...notes, ...tombstones].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return [
    {
      name: 'notes.csv',
      text: formatCsv(
        // Headers computed over the tombstones TOO, or an unknown column
        // that only a deleted row carries would be dropped from the file.
        noteHeadersFor(rows),
        rows.map((n) => noteToRow(n, manifest.event.timezone)),
      ),
    },
    { name: 'people.csv', text: formatPeopleCsv(manifest.people, peopleExtra) },
    { name: 'manifest.json', text: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
}

/**
 * "Who is at this laptop" — the only thing meanwhile persists locally.
 *
 * It pre-fills a new note's "Written by" and nothing else. It holds no event
 * data (no photos, no timestamps, no manifest content), which is exactly why
 * it lives in `localStorage` rather than the manifest: it describes this
 * machine, not the event, and would be meaningless — or wrong — carried to
 * anyone else's copy of the folder.
 *
 * `localStorage` throws in some privacy modes (Safari private browsing has
 * historically done this), and a note must always be writable even then, so
 * every access is guarded and a failure just means the setting doesn't
 * stick — it never blocks the composer.
 */
const AUTHOR_STORAGE_KEY = 'meanwhile.author';

function loadStoredAuthor(): string[] {
  try {
    const raw = localStorage.getItem(AUTHOR_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

type Stage =
  | { name: 'empty' }
  | { name: 'reading'; progress: IngestProgress }
  | {
      name: 'loaded';
      manifest: Manifest;
      grouping: GroupingInfo;
      /** Null until a .gpx or .tcx turns up in the folder. */
      course: Course | null;
      courseFile: string | null;
      /** A manifest.json found in the folder, whose author work was merged in. */
      importedFrom: string | null;
      importError: string | null;
      /** A notes*.csv or people.csv row that could not be read. Shown, never swallowed. */
      noteProblems: string[];
      /**
       * Columns of `people.csv` this app has no meaning for, carried so Save
       * puts them back rather than deleting someone's own column. Held on the
       * stage (not a ref) because it is replaced wholesale on every ingest,
       * exactly like `manifest`.
       */
      peopleExtra: PeopleExtra;
    };

export function App() {
  const [stage, setStage] = useState<Stage>({ name: 'empty' });
  // Cursor, view, visible lanes, and the crop — one object, mirrored in the
  // URL so any moment is a link.
  const [view, setView] = useAppState();

  // Report only which view is open, and only when it genuinely changes.
  // Depending on `view.view` alone — not on `view` — is the whole point:
  // `cursor`, `range` and `visible` all live on the same object and change
  // continuously while scrubbing, and none of those may reach Google. See
  // `analytics.ts` for what actually gets sent.
  useEffect(() => {
    trackView(view.view);
  }, [view.view]);

  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled event');
  const [timezone, setTimezone] = useState(guessTimezone);

  // Who is at this laptop — see the comment on `loadStoredAuthor` above.
  // Defaults to unset (`[]`); a note written before this is ever touched is
  // saved with an empty `author`, never blocked on it.
  const [me, setMe] = useState<string[]>(loadStoredAuthor);
  const setMeAndPersist = useCallback((names: string[]) => {
    setMe(names);
    try {
      localStorage.setItem(AUTHOR_STORAGE_KEY, JSON.stringify(names));
    } catch {
      // Writing can throw too (storage disabled, quota). The setting just
      // doesn't stick for next time — it must never stop this one.
    }
  }, []);

  // Kept so re-reading the folder preserves names, clock offsets, captions,
  // and hand-placed times rather than starting over.
  const previous = useRef<Manifest | null>(null);

  /**
   * The actual File handles, kept for as long as the folder is loaded.
   *
   * Ingest reads only a metadata-sized head of each file (~115KB on average,
   * measured); showing the pictures needs the files themselves. Nothing is
   * copied — a File is a handle to bytes on disk, and they are only read when
   * a tile asks.
   */
  const [files, setFiles] = useState<ReadonlyMap<string, File> | null>(null);

  /**
   * Notes merged from `notes*.csv`, plus whatever a legacy manifest's
   * `notes[]` and captions migrate into (see `legacyNoteToNote` and
   * `ingestFolder`).
   *
   * A state of its own rather than derived from `manifest` on every render:
   * this is the one list the composer, the note list, and (once Task 9 wires
   * up the zip) the CSV writer all read from, and re-deriving it from
   * `manifest` on every change would double up whatever ingest already
   * migrated. `addNote`/`editNote`/`deleteNote` write here directly now —
   * `manifest.notes`, where it exists at all, is a read-only leftover from an
   * imported legacy manifest.
   */
  const [notes, setNotes] = useState<Note[]>([]);
  // Mirrors `notes` on every render, so `handlePicked` can read the CURRENT
  // session notes without needing `notes` in its own dependency array — the
  // same `rangeRef` pattern used below. Read at re-ingest time to merge
  // session work forward rather than discarding it (see the CRITICAL note on
  // `mergeSessionNotes`: without this, "Add files" silently dropped every
  // note and caption written since the folder was opened).
  const notesRef = useRef<Note[]>([]);
  notesRef.current = notes;
  // Mirrors the event's timezone, read by `deleteNote` below without needing
  // it in that callback's own dependency array — same reason `notesRef`
  // exists. `fingerprintNote` needs it to match what `ingestFolder` computes
  // fingerprints against.
  const timezoneRef = useRef<string | undefined>(timezone);
  timezoneRef.current = timezone;
  // Ids removed from `notes` this session. A delete only changes in-memory
  // state — nothing is written until Save — so a re-ingest must be told
  // which ids were deliberately removed, or it re-reads them straight off
  // disk and resurrects them.
  const deletedNoteIds = useRef<Set<string>>(new Set());
  // Content fingerprints of deleted notes, alongside their ids.
  //
  // A blank-`id` row — the documented way to hand-add a note — has no stable
  // identity across parses: `dedupeNotes` mints a FRESH random id every
  // time `notes.csv` is re-read, since nothing persists a row-to-id mapping
  // between calls. So `deletedNoteIds` alone catches a delete only until the
  // next re-ingest mints a DIFFERENT id for the same unsaved row, at which
  // point it reads as a note nobody has ever deleted and comes back. This is
  // the mirror image of the bug `mergeSessionNotes`'s fingerprint check
  // already fixes on the ADD side — same root cause, reached from delete
  // instead. A fingerprint match is treated as the same note for every
  // practical purpose here, since it already covers time, text, people,
  // author, photo, and extra together.
  const deletedNoteFingerprints = useRef<Set<string>>(new Set());
  /**
   * The ROOT fix behind both tombstone fingerprints above (see the long
   * comment on `mergeSessionNotes` in `ingest.ts`): a session-scoped map
   * from a blank-id row's content-as-parsed to the id minted for it, so the
   * SAME unsaved row resolves to the SAME id on every re-ingest of this
   * folder instead of a fresh random one every time. Passed to EVERY
   * ingest — including the first, "replace" one — because the map has to
   * start recording from the very first parse of a session for the first
   * "Add files" afterward to already find something in it. Reassigned to a
   * fresh, empty `Map` on `mode === 'replace'`, same as the tombstones:
   * `ingestFolder` mutates whatever map it is given in place, so simply not
   * resetting it would let a stable id assigned in one folder leak into an
   * unrelated one opened next.
   */
  const noteRowIdentity = useRef<NoteRowIdentity>(new Map());
  /**
   * Tombstones — notes deleted on purpose, kept so Save writes them back.
   *
   * A ref rather than state because nothing renders them: they exist only to
   * be written out. Before the `deleted` column, deleting a note removed it
   * from memory and from nowhere else, so any other copy of `notes.csv`
   * resurrected it on the next merge and no file anywhere recorded that the
   * removal had been deliberate.
   *
   * Carried forward across "Add files" and reset on "Open folder", the same
   * scoping as the two tombstone sets above and for the same reason: a
   * deletion belongs to the event being worked on, not to the next one.
   */
  const tombstones = useRef<Note[]>([]);

  /**
   * Read a set of files into the app.
   *
   * `mode` matters, and getting it wrong loses work. Opening a FOLDER replaces
   * what is loaded — "open a different folder" means exactly that. Picking
   * FILES adds to it, because the reason to reach for that button once a
   * folder is open is to drop in something the folder lacked, usually the
   * track. Replacing there silently discarded every photo, leaving a screen
   * of zeroes and no way back but re-opening the folder.
   */
  const handlePicked = useCallback(
    async (picked: PickedFile[], mode: 'replace' | 'add' = 'replace') => {
      setError(null);
      // Merge by path, so re-picking the same file updates rather than
      // duplicating it. An item's id IS its path, so a duplicate here would
      // become two timeline entries for one photo.
      const merged = new Map<string, File>(mode === 'add' && files ? files : []);
      for (const f of picked) merged.set(f.path, f.file);
      const all: PickedFile[] = [...merged].map(([path, file]) => ({ path, file }));

      // Opening a FOLDER starts a new session — a genuinely different event
      // must not carry yesterday's deletions (or notes) across into it. Only
      // "Add files" continues the current one, which is the whole point of
      // passing `sessionNotes`/`deletedNoteIds`/`deletedNoteFingerprints`
      // into ingest below. Both tombstones are session-scoped for the same
      // reason: a fingerprint deleted in one session must not suppress a
      // genuinely new note of the same shape in a LATER one.
      if (mode === 'replace') {
        deletedNoteIds.current = new Set();
        deletedNoteFingerprints.current = new Set();
        noteRowIdentity.current = new Map();
        tombstones.current = [];
      }

      setFiles(merged);
      setStage({ name: 'reading', progress: { done: 0, total: all.length, current: '' } });
      try {
        const {
          manifest, grouping, course, courseFile, importedFrom, importError,
          notes: loadedNotes, deletedNotes, peopleExtra, noteProblems,
        } = await ingestFolder(all, {
          title,
          timezone,
          // Only when a folder is OPENED. On "Add files" the live zone may be
          // one the author typed by hand, and reverting that silently would
          // move every naive timestamp under them. See `IngestOptions`.
          inferTimezone: mode === 'replace',
          ...(previous.current
            ? {
                existingPeople: previous.current.people,
                existingItems: previous.current.items,
                ...(previous.current.notes ? { existingNotes: previous.current.notes } : {}),
              }
            : {}),
          // Always passed, unlike the tombstones below: the map has to
          // start recording from THIS parse (even on 'replace', the first
          // ingest of a session) for the next "Add files" to find anything
          // stable to reuse. See the doc comment on the ref above.
          noteRowIdentity: noteRowIdentity.current,
          // CRITICAL: without these, re-ingesting replaces the live session's
          // notes and captions with whatever a stale re-read of the folder
          // produces — see the doc comment on `mergeSessionNotes`. Omitted on
          // 'replace', matching the reset just above (`ingestFolder` treats
          // missing tombstones/session notes as empty): that mode means a
          // different folder, not a continuation of this one.
          ...(mode === 'add'
            ? {
                sessionNotes: notesRef.current,
                deletedNoteIds: deletedNoteIds.current,
                deletedNoteFingerprints: deletedNoteFingerprints.current,
              }
            : {}),
          onProgress: (progress) => setStage({ name: 'reading', progress }),
        });
        previous.current = manifest;
        // The imported title and timezone become the live ones, or editing
        // either would immediately overwrite what was just loaded.
        setTitle(manifest.event.title);
        if (manifest.event.timezone) setTimezone(manifest.event.timezone);
        setNotes(loadedNotes);
        // Keyed by id so a tombstone read off disk and the same one recorded
        // in memory this session are one row, not two.
        const carried = new Map<string, Note>(
          (mode === 'add' ? tombstones.current : []).map((n) => [n.id, n]),
        );
        for (const n of deletedNotes) carried.set(n.id, n);
        tombstones.current = [...carried.values()];
        setStage({
          name: 'loaded', manifest, grouping, course, courseFile,
          importedFrom, importError, noteProblems, peopleExtra,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong reading that folder.');
        setStage({ name: 'empty' });
      }
    },
    [title, timezone, files],
  );

  /**
   * Editing the title or timezone rewrites the manifest in place. The
   * timezone especially is not cosmetic: it is what turns a naive camera
   * timestamp into a real instant, so changing it can move items out of the
   * unplaced tray and onto the timeline.
   */
  const updateEvent = (next: { title?: string; timezone?: string }) => {
    if (next.title !== undefined) setTitle(next.title);
    if (next.timezone !== undefined) setTimezone(next.timezone);
    if (stage.name !== 'loaded') return;
    const event = { ...stage.manifest.event, title: next.title ?? stage.manifest.event.title };
    const zone = next.timezone ?? stage.manifest.event.timezone;
    // An empty box means "no timezone", which is a real state: naive
    // timestamps then cannot be placed at all. Drop the key rather than
    // storing an empty string that would fail to resolve.
    if (zone) event.timezone = zone;
    else delete event.timezone;
    const manifest: Manifest = { ...stage.manifest, event };
    previous.current = manifest;
    setStage({ ...stage, manifest });
  };

  /**
   * A Strava link is presentational: it cannot be queried for where the
   * runner was at 2am, because the embed token is not derivable from an
   * activity URL and the embed is an opaque iframe either way. Only a GPX
   * gives the spine. Setting one here at least records the reference.
   */
  const updateCourse = (url: string) => {
    if (stage.name !== 'loaded') return;
    const manifest: Manifest = { ...stage.manifest };
    const trimmed = url.trim();
    if (!trimmed) delete manifest.course;
    else if (/\/embed\//.test(trimmed)) manifest.course = { kind: 'strava-embed', url: trimmed };
    else manifest.course = { kind: 'strava-link', url: trimmed };
    previous.current = manifest;
    setStage({ ...stage, manifest });
  };

  /**
   * Author edits to the manifest: names, roles, captions.
   *
   * All of them go through here so `previous.current` stays in step — that is
   * what re-ingest reads to carry the work forward, and a path that updates
   * `stage` without it silently loses everything on the next folder read.
   */
  const editManifest = useCallback((change: (m: Manifest) => Manifest) => {
    setStage((current) => {
      if (current.name !== 'loaded') return current;
      const manifest = change(current.manifest);
      previous.current = manifest;
      return { ...current, manifest };
    });
  }, []);

  /**
   * Rename a person, non-destructively. `applyRename` (`core/people-csv.ts`)
   * does the actual work — see its doc comment for why a rename has to touch
   * both the roster (pushing the old name onto `alsoKnownAs`) and every
   * already-loaded note (rewriting the old name to the new one) — this is
   * just the wiring: read the current people and notes, apply, write both
   * results back. `notesRef` (not `notes`) is read here so this callback
   * does not need `notes` itself in its dependency array, the same reason
   * that ref exists elsewhere in this file.
   *
   * Returns the refusal message when `applyRename` refuses outright (a
   * blank name, a `;`, or a name already claimed by someone else) so
   * `IngestReport.tsx`'s `RenameInput` can show it — and, on refusal,
   * deliberately does NOT touch `people`/`notes` at all, matching
   * `applyRename`'s "return input unchanged" contract.
   */
  const renamePerson = useCallback(
    (id: PersonId, name: string): string | undefined => {
      if (stage.name !== 'loaded') return undefined;
      const result = applyRename(stage.manifest.people, notesRef.current, id, name);
      if (result.refused) return result.refused;
      editManifest((m) => ({ ...m, people: result.people }));
      setNotes(result.notes);
      return undefined;
    },
    [stage, editManifest],
  );

  const setRole = useCallback(
    (id: PersonId, role: 'runner' | undefined) =>
      editManifest((m) => ({
        ...m,
        // Exactly one runner. Marking a second moves the badge rather than
        // creating two spines, since the role owns the course.
        people: m.people.map((p) => {
          if (p.id === id) {
            const next = { ...p };
            if (role) next.role = role;
            else delete next.role;
            return next;
          }
          if (role && p.role === 'runner') {
            const cleared = { ...p };
            delete cleared.role;
            return cleared;
          }
          return p;
        }),
      })),
    [editManifest],
  );

  /** A note that landed outside the crop, so it can be pointed at. */
  const [noteOutside, setNoteOutside] = useState<Instant | null>(null);
  /** Opened by clicking the course (see `pickOnCourse` below), so the dock appears already open. */
  const [noteOpen, setNoteOpen] = useState(false);
  const rangeRef = useRef<TimeWindow | null>(null);

  /*
   * The composer now produces the new, CSV-backed note shape directly (Task
   * 8), so these write straight to the `notes` state — the same list ingest
   * populates from notes*.csv and legacy migration, and the list `NoteList`
   * renders from. They no longer touch `manifest.notes`: that field is a
   * read-only relic of an imported legacy manifest until Task 9 makes the
   * save path write notes.csv and stops the writer emitting it at all, at
   * which point there is nothing left to keep in step.
   */
  const addNote = useCallback(
    (note: Note) => {
      setNotes((prev) => [...prev, note]);
      const at = Date.parse(note.at);
      // The crop hides photos from outside the event, and notes follow it for
      // consistency — but a note you JUST wrote disappearing is indefensible.
      // Read through a ref: the range is derived further down the component.
      const crop = rangeRef.current;
      setNoteOutside(!Number.isNaN(at) && crop && !isWithin(at, crop) ? at : null);
    },
    [],
  );

  const editNote = useCallback((id: string, change: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, ...change } : n)));
  }, []);

  const deleteNote = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
    // Recorded so a later re-ingest (see `handlePicked`) knows this id was
    // deliberately removed, rather than re-reading it off disk and treating
    // its reappearance as a brand new note nobody has ever deleted.
    deletedNoteIds.current.add(id);
    // The id alone is not enough for a blank-id, hand-typed row: the next
    // parse of notes.csv mints a DIFFERENT id for the identical unsaved row
    // (see the comment on `deletedNoteFingerprints` above), so record its
    // content fingerprint too. `notesRef.current` still holds the note here
    // — this runs before the `setNotes` above has re-rendered.
    const deleted = notesRef.current.find((n) => n.id === id);
    if (deleted) {
      deletedNoteFingerprints.current.add(fingerprintNote(deleted, timezoneRef.current));
      // Recorded IN THE FILE too, not just in this session. The two
      // tombstone sets above stop a re-ingest resurrecting it here; only a
      // `deleted` row stops someone else's copy of notes.csv resurrecting it
      // on the next merge, days later, with nothing to say the removal was
      // ever deliberate.
      tombstones.current = [
        ...tombstones.current.filter((n) => n.id !== id),
        { ...deleted, deleted: true },
      ];
    }
  }, []);

  const manifest = stage.name === 'loaded' ? stage.manifest : null;

  // Lifecycle lives in the hook, where it is tested under StrictMode. See
  // tests/media-store-lifecycle.test.tsx for why that matters.
  const store = useMediaStore(files);

  /** Lets the map show a photo on hover without owning the media pipeline. */
  const thumbnails = useMemo(
    () =>
      store
        ? {
            acquire: (item: Parameters<typeof store.acquireThumbnail>[0]) =>
              store.acquireThumbnail(item),
            release: (id: string) => store.release(id),
          }
        : undefined,
    [store],
  );

  // One resolution pass per manifest, shared by the slider and the report, so
  // every part of the screen agrees about where things sit.
  const placement = useMemo(() => (manifest ? placeItems(manifest) : null), [manifest]);
  const placedNotes = useMemo(() => placeNotes(notes), [notes]);

  /**
   * Caption text keyed by item id, so a tile can show the discoverability
   * glyph without every call site re-deriving the lookup. A caption IS a
   * note — one whose `photo` names the item it is attached to.
   */
  const captionByItem = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of notes) {
      if (n.photo) map.set(n.photo, n.text);
    }
    return map;
  }, [notes]);

  /**
   * The outer limit of the timeline — what the slider can reach.
   *
   * Photos AND notes, because a note is an event on the timeline too. Taking
   * it from photos alone meant `clampWindow` silently clamped any window back
   * to the last photograph, so a note written after the finish could not be
   * shown at all: you could widen the crop and nothing happened.
   */
  const bounds = useMemo(() => {
    if (!placement) return null;
    return windowIncludingNotes(fullSpan(placement.placed), placedNotes);
  }, [placement, placedNotes]);

  /**
   * The track thinned once, for both the map and the charts.
   *
   * A real Strava export is 120,909 points. Simplified once here rather than
   * inside each component, so the expensive pass happens a single time and
   * both views draw exactly the same line. 8 metres is well under what a
   * screen can resolve at any zoom the whole course fits in.
   */
  const course = stage.name === 'loaded' ? stage.course : null;
  const track = useMemo(() => (course ? simplify(course.samples, 8) : []), [course]);

  /**
   * Which views have something to draw right now.
   *
   * The feed and the lanes need placed photos; the course needs a track. A
   * view with neither renders nothing at all, and the app looked broken:
   * a stale `#view=course` in the address bar — left over from a previous
   * session, since the view IS the URL — meant opening a folder of photos
   * with no track gave a blank page under the tabs. The state has to be
   * reconciled against what actually exists, not trusted.
   */
  const available = useMemo<ViewName[]>(() => {
    const names: ViewName[] = [];
    if (placement && placement.placed.length > 0) names.push('feed', 'lanes');
    // Any kind of course reference earns the tab — a bare Strava link shows
    // what it can and says what it cannot, which beats the tab vanishing with
    // no explanation of why.
    if (course || manifest?.course) names.push('course');
    return names;
  }, [placement, course, manifest]);

  useEffect(() => {
    if (available.length === 0) return;
    if (available.includes(view.view)) return;
    // Written in an effect, never during render: the URL is written from
    // state, and an impure updater is exactly what StrictMode double-invokes
    // to catch. This project has paid for that lesson once already.
    setView({ view: available[0] as ViewName });
  }, [available, view.view, setView]);

  /**
   * Each item's position along the course — time first, GPS as a fallback.
   *
   * This is what lets scrolling the feed move the map. Computed against the
   * SIMPLIFIED track for the GPS path, which is a scan per item; time-based
   * anchoring is a binary search and costs nothing.
   */
  const anchors = useMemo(() => {
    if (!course || !placement) return new Map<string, Anchor>();
    return anchorItems(
      placement.placed.map((e) => e.item),
      course,
      new Map(placement.placed.map((e) => [e.item.id, e.instant])),
      track,
    );
  }, [course, placement, track]);

  /**
   * Places on the course whose time is actually known, from photographs.
   *
   * These are what make "note here" possible where nobody took a picture:
   * point at a climb, and the time comes from interpolating between the
   * photographs on either side of it.
   */
  const timeAnchors = useMemo<TimeAnchor[]>(() => {
    if (!placement) return [];
    const out: TimeAnchor[] = [];
    for (const entry of placement.placed) {
      const anchor = anchors.get(entry.item.id);
      if (anchor) out.push({ distance: anchor.distance, at: entry.instant });
    }
    return out;
  }, [placement, anchors]);

  /**
   * Where the reader is pointing along the course, in metres.
   *
   * Deliberately NOT in the URL alongside the cursor: a hover is a transient
   * pointer position, not a place in the event worth sharing, and writing it
   * to the address bar on every mouse move would be absurd.
   */
  const [focus, setFocus] = useState<number | null>(null);
  /** Something is selected but has no place on the course. See CourseRail. */
  const [unplaceable, setUnplaceable] = useState(false);

  /**
   * Point the rail at whatever is nearest a moment in time.
   *
   * The swimlanes have a cursor rather than a scroll position, so this is
   * their equivalent of the feed's scroll-spy. On a timed track the cursor
   * alone would do, but this also works on an untimed one by falling back to
   * the nearest item that could be anchored at all.
   */
  const focusAt = useCallback(
    (cursor: Instant) => {
      if (!placement) return;
      let best: number | null = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const entry of placement.placed) {
        const anchor = anchors.get(entry.item.id);
        if (!anchor) continue;
        const gap = Math.abs(entry.instant - cursor);
        if (gap < bestGap) {
          bestGap = gap;
          best = anchor.distance;
        }
      }
      setFocus(best);
      setUnplaceable(best === null);
    },
    [placement, anchors],
  );

  /**
   * The visible range: what the manifest says, or a sensible guess.
   *
   * The guess matters. A folder is rarely just the event — this one spans 46
   * days for a two-day race — so opening on the full span would show mostly
   * empty timeline. Falling back to the densest cluster lands on the race —
   * but that cluster is built from photos alone, so it is then widened to
   * cover every note too. Two photos two hours apart can cluster down to a
   * single instant, which would otherwise crop out notes written between
   * them with no on-screen sign that anything was hidden.
   */
  const range: TimeWindow | null = useMemo(() => {
    if (!manifest || !placement || !bounds) return null;
    const saved = manifest.event.range;
    let savedWindow: TimeWindow | null = null;
    if (saved) {
      const from = Date.parse(saved.from);
      const to = Date.parse(saved.to);
      if (!Number.isNaN(from) && !Number.isNaN(to)) savedWindow = { from, to };
    }
    // Precedence lives in `resolveDefaultRange`: an explicit link wins, then
    // the manifest's saved crop honoured exactly, and only the last resort —
    // the computed default — gets widened to cover every note.
    return resolveDefaultRange(placement.placed, placedNotes, bounds, view.range, savedWindow);
    // `view.range` is read inside `resolveDefaultRange`, so it must be a
    // dependency — without it the crop only refreshed when something else
    // happened to change.
  }, [manifest, placement, bounds, view.range, placedNotes]);

  /**
   * The one set every view works from: inside the crop, and belonging to
   * someone whose lane is showing. Computed once here rather than per view,
   * so switching between them cannot show different things.
   */
  const items: readonly PlacedItem[] = useMemo(() => {
    if (!placement || !range) return [];
    return placement.placed.filter(
      (entry) => isWithin(entry.instant, range) && isVisible(view, entry.item.person),
    );
  }, [placement, range, view]);

  /**
   * Write, update, or clear the caption note for a photo, from the lightbox.
   *
   * A caption IS a note — one whose `photo` column names the item — so this
   * writes straight into the same `notes` state the composer and NoteList
   * use, rather than a separate `items[].note` field. Clearing the field
   * deletes the note, the same rule NoteList's own text field follows: an
   * empty caption is not a caption. The first time a photo is captioned this
   * mints a fresh note at the item's own resolved instant (clock offset
   * applied, timezone resolved) and in its own person's lane, so it reads
   * exactly where the photo does everywhere notes are shown.
   */
  const setCaption = useCallback(
    (itemId: string, text: string) => {
      const body = text.trim();
      const existing = notes.find((n) => n.photo === itemId);
      if (!body) {
        if (existing) deleteNote(existing.id);
        return;
      }
      if (existing) {
        editNote(existing.id, { text: body });
        return;
      }
      const entry = items.find((e) => e.item.id === itemId);
      if (!entry || stage.name !== 'loaded') return;
      const person = stage.manifest.people.find((p) => p.id === entry.item.person);
      const note: Note = {
        id: mintNoteId(),
        at: new Date(entry.instant).toISOString(),
        people: person ? [displayName(person)] : [],
        photo: itemId,
        author: [...me],
        text: body,
        // When it was TYPED, which `at` (when the photograph was taken) does
        // not record and nothing can reconstruct later.
        written: Math.floor(Date.now() / 1000),
      };
      addNote(note);
    },
    [notes, items, stage, me, addNote, editNote, deleteNote],
  );

  /**
   * The one line worth seeing without opening the panel.
   *
   * Unplaced files are the number that changes what you do next — they are
   * the ones nobody can see on the timeline — so it is named even when zero
   * is the happy answer.
   */
  const summaryLine = placement
    ? [
        `${placement.placed.length.toLocaleString()} placed`,
        placement.unplaced.length > 0
          ? `${placement.unplaced.length.toLocaleString()} unplaced`
          : null,
        `${manifest?.people.length ?? 0} ${manifest?.people.length === 1 ? 'person' : 'people'}`,
        placedNotes.length > 0
          ? `${placedNotes.length} ${placedNotes.length === 1 ? 'note' : 'notes'}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  rangeRef.current = range;

  /** Why a click on the course could not be turned into a time. */
  const [pickFailed, setPickFailed] = useState(false);

  /**
   * Clicking the course means "note something here".
   *
   * ONE entry point, deliberately. The first attempt put a "Note here" button
   * beside the readout while hovering, and moving the pointer towards it left
   * the plot, cleared the focus and removed the button — you had to chase it.
   *
   * The time comes from the track when the track is timed, and from
   * `estimateInstant` — interpolating between the photographs either side —
   * when it is not. If neither can answer, that is said rather than guessed.
   */
  const pickOnCourse = useCallback(
    (distance: number) => {
      const course = stage.name === 'loaded' ? stage.course : null;
      if (!course) return;
      setFocus(distance);
      const fromTrack = course.timed ? (atDistance(course, distance)?.at ?? null) : null;
      const at =
        fromTrack ??
        estimateInstant(timeAnchors, distance, view.cursor ?? undefined)?.at ??
        null;
      if (at === null) {
        setPickFailed(true);
        return;
      }
      setPickFailed(false);
      // Through the shared cursor, like every other way of choosing a moment.
      setView({ cursor: Math.round(at) });
      setNoteOpen(true);
    },
    [stage, timeAnchors, view.cursor, setView],
  );

  /** Notes inside the crop, so they follow the window like the photos do. */
  const visibleNotes = useMemo(
    () => (range ? placedNotes.filter((n) => isWithin(n.instant, range)) : placedNotes),
    [placedNotes, range],
  );

  /**
   * Notes for the feed's interleaved stream and the note-dock's count badge.
   *
   * A caption lives ON its photo — discovered via the tile's speech-bubble
   * glyph, read in the lightbox or the Notes panel — so showing it AGAIN in
   * the feed's chronological stream, and counting it again on the dock
   * button, says the same thing three times and makes the glyph's whole
   * "otherwise invisible" justification false. The Notes panel is exempt: it
   * is the reference list, and a caption belongs there like any other note.
   */
  const feedNotes = useMemo(() => excludingCaptions(visibleNotes), [visibleNotes]);
  const noteCount = useMemo(() => excludingCaptions(placedNotes).length, [placedNotes]);

  // The lightbox belongs to the app, not to a view: you can open a photo from
  // the feed or from the lanes, and stepping through it walks the same list.
  const [openId, setOpenId] = useState<string | null>(null);
  const openIndex = openId === null ? -1 : items.findIndex((e) => e.item.id === openId);

  const setWindow = (next: TimeWindow | null) => {
    // Kept in both places on purpose: the manifest so it survives export, the
    // URL so it survives being sent to someone.
    setView({ range: next });
    if (stage.name !== 'loaded') return;
    const event = { ...stage.manifest.event };
    if (next) {
      event.range = {
        from: new Date(next.from).toISOString(),
        to: new Date(next.to).toISOString(),
      };
    } else {
      // Clearing it means "work it out again", not "show everything".
      delete event.range;
    }
    const updated: Manifest = { ...stage.manifest, event };
    previous.current = updated;
    setStage({ ...stage, manifest: updated });
  };

  /**
   * Save produces ONE file: a zip of `notes.csv`, `people.csv`, and
   * `manifest.json`. Three files rather than three separate downloads,
   * because "save" has to mean one action with one name — and because the
   * whole point of the round trip is that all three land back in the same
   * folder the photos are in and are picked up together on the next open.
   *
   * `manifestForSave` is what actually migrates a manifest: it strips
   * `notes[]` and `items[].note`, which is the writer half of "the validator
   * still reads them, but nothing this app saves carries them again."
   *
   * Before any of that: if "you are" is set and some note has no author,
   * offer ONCE to stamp all of them — never per note, and never blocking the
   * save either way, whichever button is pressed.
   *
   * The trigger is the standard hidden-anchor pattern: an anchor click on an
   * object URL, revoked immediately after — here aimed at a zip Blob rather
   * than a JSON one.
   */
  const saveEvent = () => {
    if (stage.name !== 'loaded') return;

    let notesToSave = notes;
    const blankAuthorCount = notes.filter((n) => n.author.length === 0).length;
    if (me.length > 0 && blankAuthorCount > 0) {
      const stamp = window.confirm(
        `Stamp ${blankAuthorCount} ${blankAuthorCount === 1 ? 'note' : 'notes'} with no ` +
          `author as written by ${me.join(', ')}?`,
      );
      if (stamp) {
        notesToSave = stampBlankAuthors(notes, me);
        setNotes(notesToSave);
      }
    }

    const manifest = manifestForSave(stage.manifest);
    const files = filesForSave(manifest, notesToSave, tombstones.current, stage.peopleExtra);
    // `zipBytes` is typed to return a bare `Uint8Array`, whose backing buffer
    // TypeScript therefore widens to `ArrayBufferLike` — but `BlobPart` wants
    // one backed by a concrete `ArrayBuffer`. The array really is: it comes
    // from `new Uint8Array(length)` inside `zipBytes`, which only ever
    // allocates a real `ArrayBuffer`, never a `SharedArrayBuffer`.
    const bytes = zipBytes(files) as Uint8Array<ArrayBuffer>;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filenameForSave(manifest.event.title);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // `--mw-header-measured` (App.css) sizes `.rail`'s sticky `top` so it sits
  // just under the sticky header rather than tucking beneath it. App.css's
  // static `--mw-header-h` `calc()` was sized for a button-only header and
  // undercounts it once a person is loaded, so the real height is measured
  // and published live instead — see `useMeasuredHeight` for the full story,
  // including why it must never publish to `--mw-header-h` itself.
  const headerRef = useMeasuredHeight('--mw-header-measured');

  return (
    <div className="app">
      {/*
        * The bar carries what must always be reachable: which event this is,
        * and the file actions. Those used to sit under the photographs, which
        * put them a couple of thousand pixels down a 200-photo feed — the
        * content region is unbounded, so nothing persistent can live after it.
        */}
      <header className="app__header" ref={headerRef}>
        <h1 className="app__title">meanwhile</h1>
        {stage.name === 'loaded' ? (
          <>
            <input
              className="app__event"
              value={stage.manifest.event.title}
              aria-label="Event name"
              onChange={(e) => updateEvent({ title: e.target.value })}
            />
            <div className="app__bar-actions">
              {/*
                * "Who is at this laptop" — pre-fills a new note's "Written
                * by" (see the `AUTHOR_STORAGE_KEY` comment above). Not a
                * fifth action: it sets no note by itself, and stays blank
                * with no effect on anything else if never touched.
                */}
              <div className="app__author">
                <PersonPicker
                  people={stage.manifest.people}
                  value={me}
                  onChange={setMeAndPersist}
                  label="You are"
                />
              </div>
              <FolderPicker
                variant="quiet"
                label="Open folder"
                onPicked={(f) => void handlePicked(f, 'replace')}
                onError={setError}
              />
              <FilePicker
                onPicked={(f) => void handlePicked(f, 'add')}
                onError={setError}
                label="Add files"
              />
              <button type="button" className="button button--primary" onClick={saveEvent}>
                Save
              </button>
            </div>
          </>
        ) : (
          <p className="app__tagline">Many people&rsquo;s photos, one shared timeline.</p>
        )}
      </header>

      {error && (
        <p className="callout callout--error" role="alert">
          {error}
        </p>
      )}

      {stage.name === 'empty' && (
        <main className="app__empty">
          <p className="app__empty-lead">Nothing loaded yet.</p>
          <p>
            meanwhile is a renderer, not a locker. Point it at a folder and it reads your photos and
            video straight off your disk &mdash; they never leave this machine, even though this site
            is public. This browser does remember your own name locally, for notes; see the README
            for exactly what else the published page loads.
          </p>
          <p className="app__hint">
            Put each person&rsquo;s photos in their own subfolder. The folder name becomes their name
            on the timeline.
          </p>
          {/* There is no separate control for the track, and no way to guess
              that, so the empty state has to say it. */}
          <p className="app__hint">
            Drop a <strong>.gpx</strong> or <strong>.tcx</strong> in with the photos and the course
            map and elevation profile appear too. There is no separate step for it.
          </p>
          <div className="app__actions">
            <FolderPicker onPicked={(f) => void handlePicked(f, 'replace')} onError={setError} />
            <FilePicker
              onPicked={(f) => void handlePicked(f, 'replace')}
              onError={setError}
              label="Choose files"
            />
          </div>
        </main>
      )}

      {stage.name === 'reading' && (
        <main className="app__reading">
          <p className="app__empty-lead">
            Reading {stage.progress.total.toLocaleString()} files&hellip;
          </p>
          <progress
            className="progress"
            value={stage.progress.done}
            max={stage.progress.total}
            aria-label="Reading files"
          />
          <p className="app__progress-detail mw-mono">
            {stage.progress.done.toLocaleString()} / {stage.progress.total.toLocaleString()}
            {stage.progress.current && ` · ${stage.progress.current}`}
          </p>
          <p className="app__hint">
            Only metadata is read &mdash; about 115KB per file on average
            (measured on a real 2GB folder), not the whole photo.
          </p>
        </main>
      )}

      {stage.name === 'loaded' && (
        // Wraps the ENTIRE loaded stage, not just the views at the bottom —
        // the unplaced tray sits in the reference panel above the views and
        // needs a thumbnail too (see UnplacedTray.tsx: it was rendered
        // outside any provider before, so `useMedia()` always returned the
        // default `{ store: null }` and no tile in the tray ever acquired
        // one). `MediaProvider` is a context provider, not a DOM element, so
        // lifting it here changes nothing about the rendered tree or CSS.
        <MediaProvider store={store}>
          <main className="app__loaded">
            {/*
              * Settings and the ingest report are REFERENCE: read once when the
              * folder lands, then rarely. Collapsed and placed above the views,
              * they cost one line until wanted — where before they sat below the
              * feed and could not be reached at all.
              */}
            <details className="panel">
              <summary className="panel__summary">
                <span className="panel__title">Event settings and report</span>
                <span className="panel__digest mw-mono">
                  {summaryLine}
                </span>
              </summary>

              <div className="panel__body">
                <div className="event-fields">
                  <TimezoneField
                    value={stage.manifest.event.timezone ?? ''}
                    onChange={(next) => updateEvent({ timezone: next })}
                  />
                  <label className="field">
                    <span className="field__label">Strava activity (optional)</span>
                    <input
                      className="field__input mw-mono"
                      value={courseUrlOf(stage.manifest)}
                      placeholder="https://www.strava.com/activities/…"
                      onChange={(e) => updateCourse(e.target.value)}
                    />
                  </label>
                </div>
                <p className="app__hint">
                  A bare Strava activity link renders as a link and nothing more; a link
                  containing <code>/embed/</code> (from Strava&rsquo;s share dialog) renders as an
                  embedded iframe instead. Either way it carries no time-and-distance data, so
                  there is no elevation profile and no map. Those need a{' '}
                  <strong>GPX export</strong> from the
                  activity (the &hellip; menu &rarr; Export GPX), which works the same from
                  Garmin or COROS. Camera clock differences are corrected by hand, in{' '}
                  <code>people.csv</code>, whichever course option you use.
                </p>

                <IngestReport
                  manifest={stage.manifest}
                  grouping={stage.grouping}
                  {...(range ? { range } : {})}
                  onRename={renamePerson}
                  onRole={setRole}
                />

                {placement && (
                  <UnplacedTray manifest={stage.manifest} unplaced={placement.unplaced} />
                )}

                <section className="notes" aria-label="Notes">
                  <h2 className="notes__heading">Notes</h2>
                  <NoteList
                    manifest={stage.manifest}
                    notes={placedNotes}
                    onEdit={editNote}
                    onDelete={deleteNote}
                    onGo={(cursor) => setView({ cursor })}
                    {...(stage.manifest.event.timezone
                      ? { timezone: stage.manifest.event.timezone }
                      : {})}
                  />
                </section>
              </div>
            </details>

            {stage.importError && (
              <p className="callout callout--warn">
                A manifest was found but could not be used, so nothing from it was
                applied: {stage.importError}
              </p>
            )}
            {stage.noteProblems.length > 0 && (
              <p className="callout callout--warn">
                {stage.noteProblems.length === 1 ? 'A row' : `${stage.noteProblems.length} rows`} in
                a notes*.csv or people.csv file needed a closer look rather than being
                guessed at &mdash; some were skipped entirely (an unreadable date, a
                missing name), others were kept but left with something unresolved
                (like a photo filename that matches more than one file); which file is
                named below: {stage.noteProblems.join('; ')}
              </p>
            )}
            {stage.importedFrom && (
              <p className="callout">
                Loaded your saved work from <strong>{stage.importedFrom}</strong> &mdash;
                names and hand-placed times came back with it. Notes and
                captions live in notes.csv now, and load the same way when
                it&rsquo;s in the folder alongside it. A hand-placed time stays
                exactly as you set it; every automatic timestamp is still
                re-read fresh from the file itself.
              </p>
            )}

            {placement && bounds && range && placement.placed.length > 0 && (
              <TimeWindowSlider
                placed={placement.placed}
                bounds={bounds}
                range={range}
                onChange={setWindow}
                onReset={() => setWindow(null)}
                {...(stage.manifest.event.timezone ? { timezone: stage.manifest.event.timezone } : {})}
              />
            )}

            {/* The course stands on its own: a GPX with no photos yet is a
                perfectly good thing to look at, and gating the tabs on a time
                range — which only photos produce — hid it completely. */}
            {available.length > 0 && (
              <nav className="views" aria-label="View">
                {VIEW_NAMES.filter((name) => available.includes(name)).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={view.view === name ? 'view-tab view-tab--on' : 'view-tab'}
                    aria-pressed={view.view === name}
                    onClick={() => setView({ view: name })}
                  >
                    {name === 'feed' ? 'Feed' : name === 'lanes' ? 'Swimlanes' : 'Course'}
                  </button>
                ))}
              </nav>
            )}

            {/* Outside the media gate on purpose: the map and profile need no
                photos and no time range, only the track. */}
            {view.view === 'course' && !stage.course && stage.manifest.course && (
              <CourseFallback course={stage.manifest.course} />
            )}

            {view.view === 'course' && stage.course && (
              <>
                <CourseMap
                  manifest={stage.manifest}
                  course={stage.course}
                  track={track}
                  items={items}
                  at={view.cursor}
                  focus={focus}
                  onFocus={setFocus}
                  onCursor={(cursor) => setView({ cursor })}
                  {...(thumbnails ? { thumbnails } : {})}
                  onPick={pickOnCourse}
                />
                <CourseCharts
                  course={stage.course}
                  track={track}
                  {...(range ? { range } : {})}
                  at={view.cursor}
                  focus={focus}
                  onFocus={setFocus}
                  onCursor={(cursor) => setView({ cursor })}
                  onPick={pickOnCourse}
                  {...(stage.manifest.event.timezone
                    ? { timezone: stage.manifest.event.timezone }
                    : {})}
                />
              </>
            )}

            {/* The course, riding along with the photographs. The Course tab
                answers "what did the race look like"; this answers the question
                you have while scrolling, which is "where was this taken". */}
            {stage.course && range && view.view !== 'course' && (
              <CourseRail
                manifest={stage.manifest}
                course={stage.course}
                track={track}
                items={items}
                focus={focus}
                onFocus={setFocus}
                at={view.cursor}
                onCursor={(cursor) => setView({ cursor })}
                unplaceable={unplaceable}
                {...(thumbnails ? { thumbnails } : {})}
                onPick={pickOnCourse}
                {...(stage.manifest.event.timezone
                  ? { timezone: stage.manifest.event.timezone }
                  : {})}
              />
            )}

            {placement && range && store && (
              // The provider itself now lives above, wrapping the whole
              // loaded stage (see the comment by `<MediaProvider>` up top) —
              // this fragment just keeps the same gate on rendering these
              // views until placement, range and the store are all ready.
              <>
                {view.view === 'lanes' && (
                  <Swimlanes
                    manifest={stage.manifest}
                    placed={placement.placed}
                    range={range}
                    state={view}
                    onCursor={(cursor) => {
                      setView({ cursor });
                      // A null cursor is the scrub being cleared, not a moment.
                      if (stage.course && cursor !== null) focusAt(cursor);
                    }}
                    onTogglePerson={(person: PersonId) =>
                      setView({
                        visible: toggleVisible(view, person, stage.manifest.people.map((p) => p.id)),
                      })
                    }
                    onOpen={(entry) => setOpenId(entry.item.id)}
                    lightboxOpen={openIndex >= 0}
                    {...(bounds ? { bounds } : {})}
                    onRange={setWindow}
                    captionByItem={captionByItem}
                    notes={visibleNotes}
                  />
                )}

                {view.view === 'feed' && (
                  <Feed
                    manifest={stage.manifest}
                    items={items}
                    notes={feedNotes}
                    captionByItem={captionByItem}
                    onOpen={(entry) => setOpenId(entry.item.id)}
                    onActive={(moment: readonly PlacedItem[]) => {
                      const first = moment[0];
                      if (!first) return;

                      /*
                       * Scrolling the feed moves the SHARED cursor.
                       *
                       * The premise of this app is one cursor and three
                       * projections of it, and the feed was the one view not
                       * taking part: you could scrub in the lanes and flip to
                       * the feed, but not the other way. It also gives the note
                       * composer a sensible default time — scroll to the small
                       * hours, and a new note is already in the small hours.
                       *
                       * Fires once per moment crossed, not per scroll event —
                       * the observer in Feed dedupes — so this does not churn
                       * the URL.
                       */
                      setView({ cursor: first.instant });

                      if (!stage.course) return;
                      // The first item in the moment that can be placed on the
                      // course at all. Some carry no GPS and some fall outside a
                      // timed track's span; those simply do not move the marker
                      // rather than moving it wrongly.
                      for (const entry of moment) {
                        const anchor = anchors.get(entry.item.id);
                        if (anchor) {
                          setFocus(anchor.distance);
                          setUnplaceable(false);
                          return;
                        }
                      }
                      setFocus(null);
                      setUnplaceable(true);
                    }}
                  />
                )}

                {openIndex >= 0 && (
                  <Lightbox
                    items={items}
                    index={openIndex}
                    onIndex={(next) => setOpenId(items[next]?.item.id ?? null)}
                    onClose={() => setOpenId(null)}
                    colors={assignLaneColors(stage.manifest.people)}
                    names={new Map(stage.manifest.people.map((p) => [p.id, displayName(p)]))}
                    notes={notes}
                    onCaption={setCaption}
                    {...(stage.manifest.event.timezone
                      ? { timezone: stage.manifest.event.timezone }
                      : {})}
                  />
                )}
              </>
            )}

            {/*
              * Present in EVERY view, because writing a note is a thing you do
              * while reading, not a feature of one page. It was in the feed and
              * the course but inline under the lanes, which meant scrolling to
              * reach it there and a different shape in each place.
              */}
            {/* Hidden while the lightbox is up: a floating button over a
                full-screen photograph is noise, and it cannot be used there. */}
            {placement && openIndex < 0 && (
              <NoteDock
                manifest={stage.manifest}
                cursor={view.cursor}
                author={me}
                onAdd={addNote}
                count={noteCount}
                open={noteOpen}
                onOpenChange={setNoteOpen}
                notice={
                  pickFailed
                    ? {
                        text: 'No photographs either side of there, so there is no time to place a note at.',
                        action: 'Dismiss',
                        onAction: () => setPickFailed(false),
                        onDismiss: () => setPickFailed(false),
                      }
                    : noteOutside === null || !range
                    ? undefined
                    : {
                        text: `Added at ${formatClock(noteOutside, stage.manifest.event.timezone)} — outside the window, so it is not shown.`,
                        action: 'Show it',
                        onAction: () => {
                          setWindow({
                            from: Math.min(range.from, noteOutside - 60_000),
                            to: Math.max(range.to, noteOutside + 60_000),
                          });
                          setNoteOutside(null);
                        },
                        onDismiss: () => setNoteOutside(null),
                      }
                }
                {...(stage.manifest.event.timezone
                  ? { timezone: stage.manifest.event.timezone }
                  : {})}
              />
            )}
          </main>
        </MediaProvider>
      )}
    </div>
  );
}
