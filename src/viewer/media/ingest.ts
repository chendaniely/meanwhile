/**
 * Running metadata extraction across a whole folder.
 *
 * Two things matter here at 2,000 files: don't freeze the tab, and tell the
 * user what is happening. A bounded pool does both — it keeps several file
 * reads in flight without queueing thousands of promises at once, and it
 * yields often enough for progress to paint.
 */

import {
  assembleManifest,
  describeGrouping,
  type GroupingInfo,
  type IngestedFile,
} from '../../core/assemble.ts';
import { parseCourse, type Course } from '../../core/course.ts';
import { isManifestFile, isNotesFile, isPeopleFile, isTrackFile } from '../../core/metadata.ts';
import { dedupeNotes, mergeNotes, resolveNotePhotos, type Note } from '../../core/notes.ts';
import { parsePeopleCsv } from '../../core/people-csv.ts';
import {
  validateManifest,
  type Item,
  type Manifest,
  type Note as LegacyNote,
  type Person,
} from '../../core/schema.ts';
import { formatDuration } from '../../core/time.ts';
import { placeItems } from '../../core/window.ts';
import { extractMetadata } from './extract.ts';
import type { PickedFile } from './folder.ts';

/**
 * File reads are IO-bound, so a handful in flight saturates the disk without
 * the memory cost of holding every slice at once.
 */
const CONCURRENCY = 8;

export interface IngestProgress {
  done: number;
  total: number;
  /** The file currently being read, for the progress line. */
  current: string;
}

export interface IngestOptions {
  title: string;
  timezone?: string;
  existingPeople?: readonly Person[];
  existingItems?: readonly Item[];
  /**
   * Notes are pure authorship — they belong to no file — so they are carried
   * across wholesale rather than merged per item. Without this a re-read of
   * the folder would silently drop every one.
   *
   * Still the legacy shape: this is `manifest.notes`, carried through to the
   * assembled manifest unchanged and then migrated (see `migrateLegacyNotes`)
   * alongside whatever `notes*.csv` files are found.
   */
  existingNotes?: readonly LegacyNote[];
  /**
   * Notes written or edited THIS SESSION — the live state the composer, the
   * caption field, and the Notes panel all read from — as opposed to
   * `existingNotes` above, which is the legacy `manifest.notes` array.
   *
   * Without this, re-ingesting (dropping a GPX in with "Add files", say)
   * would silently discard every note and caption written since the folder
   * was opened: `notes*.csv` on disk hasn't been saved yet, so re-reading it
   * produces the PRE-edit set, and the caller used to replace the live state
   * with that outright. See `mergeSessionNotes` for how these reconcile with
   * what a fresh read of the folder produces.
   */
  sessionNotes?: readonly Note[];
  /**
   * Ids deleted from `sessionNotes` since the folder was last read.
   *
   * A delete only changes the in-memory list — nothing is written to disk
   * until Save — so a plain "session wins by id" merge cannot tell "the
   * session never heard of this id" (a genuinely new note) from "the session
   * used to have this id and removed it" (a deletion). This is what makes
   * the distinction: an id in here is never resurrected from a fresh read,
   * however wide the fresh read's contents are.
   */
  deletedNoteIds?: ReadonlySet<string>;
  onProgress?: (progress: IngestProgress) => void;
  signal?: AbortSignal;
}

export interface IngestResult {
  manifest: Manifest;
  /** How people were worked out. Shown in the report; it is a guess. */
  grouping: GroupingInfo;
  /**
   * The course, if a .gpx or .tcx was sitting in the folder. Dropping the
   * track in with the photos is much kinder than a separate step, so the
   * walker picks it up and this parses whichever it finds.
   */
  course: Course | null;
  /** Name of the track file used, for the report. */
  courseFile: string | null;
  /** Path of a manifest.json found in the folder, if the author dropped one in. */
  importedFrom: string | null;
  /** Why a manifest that was found could not be used. Shown, never swallowed. */
  importError: string | null;
  /**
   * Every note, merged from `notes*.csv` and prepended with whatever a legacy
   * manifest's `notes[]` and `items[].note` captions migrate into. Picked up
   * the same way a `.gpx` is: drop the file in with the photos.
   */
  notes: Note[];
  /** A note or roster row that could not be read. Reported, never dropped. */
  noteProblems: string[];
}

export async function ingestFolder(
  files: readonly PickedFile[],
  opts: IngestOptions,
): Promise<IngestResult> {
  // Whether naive timestamps can be resolved changes which source wins per
  // file, so it is decided once here and passed down.
  const ctx = { hasTimezone: Boolean(opts.timezone) };
  // None of a track, a manifest, notes, or a roster is media; each takes its
  // own path.
  const tracks = files.filter((f) => isTrackFile(f.path));
  const manifests = files.filter((f) => isManifestFile(f.path));
  const notesFiles = files.filter((f) => isNotesFile(f.path));
  const peopleFiles = files.filter((f) => isPeopleFile(f.path));
  const media = files.filter(
    (f) =>
      !isTrackFile(f.path) &&
      !isManifestFile(f.path) &&
      !isNotesFile(f.path) &&
      !isPeopleFile(f.path),
  );

  /*
   * A manifest found in the folder carries the AUTHOR'S work — names, roles,
   * captions, hand-placed times, the crop — while the files carry the bytes.
   * Merging the two is what makes "export, come back tomorrow, keep working"
   * possible on a site with no backend.
   *
   * It never overrides what the files themselves say: automatic timestamps
   * are always re-read, because those are facts about the bytes and a stale
   * copy in a manifest would be worse than no copy.
   */
  let imported: Manifest | null = null;
  let importedFrom: string | null = null;
  let importError: string | null = null;
  for (const found of manifests) {
    try {
      const parsed: unknown = JSON.parse(await found.file.text());
      const result = validateManifest(parsed);
      if (result.ok) {
        imported = result.manifest;
        importedFrom = found.path;
      } else {
        // Refused with a legible reason rather than half-applied. A manifest
        // that partly loads is how you lose work without noticing.
        importError = `${found.path}: ${result.errors.slice(0, 3).join('; ')}`;
      }
    } catch (err) {
      importError = `${found.path}: ${err instanceof Error ? err.message : 'not valid JSON'}`;
    }
  }

  let course: Course | null = null;
  let courseFile: string | null = null;
  for (const track of tracks) {
    const parsed = parseCourse(await track.file.text());
    // Prefer whichever carries the most: a TCX has heart rate and cadence
    // where a GPX has neither, and people often have both lying around.
    if (parsed && (!course || richness(parsed) > richness(course))) {
      course = parsed;
      courseFile = track.path;
    }
  }

  // A roster kept in people.csv is a spreadsheet edit away, which is the
  // whole point of this file — so it outranks `existingPeople`, the same way
  // an imported manifest.json already does.
  let peopleFromCsv: Person[] | null = null;
  const rosterProblems: string[] = [];
  for (const found of peopleFiles) {
    const { people, problems } = parsePeopleCsv(await found.file.text());
    if (people.length > 0) peopleFromCsv = people;
    for (const p of problems) rosterProblems.push(`${found.path}: ${p}`);
  }

  const results = new Array<IngestedFile | null>(media.length);
  let done = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= media.length) return;
      if (opts.signal?.aborted) throw new DOMException('Ingest cancelled', 'AbortError');

      const picked = media[index] as PickedFile;
      try {
        results[index] = {
          path: picked.path,
          metadata: await extractMetadata(picked.path, picked.file, ctx),
          bytes: picked.file.size,
        };
      } catch {
        // One unreadable file must not lose the other 1,999. It still becomes
        // an item, just an unplaced one the author can deal with by hand.
        results[index] = {
          path: picked.path,
          metadata: { type: 'photo', timeSource: 'none' },
          bytes: picked.file.size,
        };
      }

      done++;
      opts.onProgress?.({ done, total: media.length, current: picked.path });
      // Yield to the event loop so progress actually paints.
      if (done % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, media.length) }, worker));

  const ingested = results.filter((r): r is IngestedFile => r !== null);
  // A people.csv, then a manifest from the folder, then whatever is in
  // memory — each one is the author handing over more recent work on purpose.
  const existingPeople = peopleFromCsv ?? imported?.people ?? opts.existingPeople;
  const existingItems = imported?.items ?? opts.existingItems;

  const assembleOpts: Parameters<typeof assembleManifest>[1] = {
    title: imported?.event.title ?? opts.title,
  };
  const zone = imported?.event.timezone ?? opts.timezone;
  if (zone !== undefined) assembleOpts.timezone = zone;
  if (existingPeople !== undefined) assembleOpts.existingPeople = existingPeople;
  if (existingItems !== undefined) assembleOpts.existingItems = existingItems;

  const manifest = assembleManifest(ingested, assembleOpts);
  // The crop is authoring intent and has to survive the round trip.
  if (imported?.event.range) manifest.event.range = imported.event.range;
  if (imported?.course) manifest.course = imported.course;
  if (imported?.markers) manifest.markers = imported.markers;
  const legacyNotes = imported?.notes ?? opts.existingNotes;
  if (legacyNotes?.length) manifest.notes = [...legacyNotes];

  /*
   * Notes now live in notes*.csv, merged the same way several people's files
   * merge — but a manifest still carrying `notes[]` or `items[].note` from
   * before this change (an import, or existingNotes/existingItems carried
   * forward from a previous ingest) has real authorship in it that would
   * otherwise be invisible everywhere the new Note list is used. Migrating it
   * here, on every ingest, means it never needs a one-off conversion step —
   * and it costs nothing to migrate the same notes twice, since nothing here
   * is persisted between calls.
   *
   * Neither field is deleted from `manifest` by this step: the manifest
   * WRITER stops emitting them in a later task, once notes.csv + people.csv
   * are the actual save path. Until then the round trip through
   * download-manifest-and-reopen must keep working.
   */
  const noteFiles = await Promise.all(
    notesFiles.map(async (f) => ({ name: f.path, text: await f.file.text() })),
  );
  const { notes: csvNotes, problems: csvNoteProblems } = mergeNotes(
    noteFiles,
    manifest.event.timezone,
  );
  const migratedNotes = migrateLegacyNotes(manifest);
  // A folder can carry BOTH an old-style manifest.json (migratedNotes) and a
  // notes.csv saved from it (csvNotes) — the same notes, under the same
  // ids, from two sources. Without deduping here that is an exact id
  // collision on every ingest, not just a hypothetical one.
  const freshNotes = dedupeNotes([...migratedNotes, ...csvNotes], manifest.event.timezone);
  // `photo` names an item id, but the README calls the column "the
  // filename" and so does a person typing into the spreadsheet — resolve a
  // bare, unambiguous filename onto the item it actually names before
  // anything downstream keys off `photo`.
  const { notes: photoResolvedNotes, problems: photoProblems } = resolveNotePhotos(
    freshNotes,
    manifest.items,
  );
  // Reconcile against whatever this session already knows, so a re-ingest
  // (dropping a GPX in with "Add files", say) cannot revert an edit,
  // resurrect a delete, or drop a note nothing has been saved to disk yet.
  const notes = mergeSessionNotes(
    opts.sessionNotes ?? [],
    photoResolvedNotes,
    opts.deletedNoteIds ?? new Set(),
  );
  const noteProblems = [...rosterProblems, ...csvNoteProblems, ...photoProblems];

  return {
    manifest,
    grouping: describeGrouping(ingested),
    course,
    courseFile,
    importedFrom,
    importError,
    notes,
    noteProblems,
  };
}

/**
 * Reconcile a fresh read of `notes*.csv` (and migrated legacy notes) against
 * whatever the live session already knows, so re-ingesting a folder — "Add
 * files" to drop in a GPX, most often — cannot lose a note or a caption
 * nothing has been saved to disk yet.
 *
 * The rule: **the session is authoritative for any id it already knows.**
 * `fresh` contributes only ids the session has never seen:
 *
 *   - A note composed this session, not yet in any file on disk, has no
 *     match in `fresh` at all — kept because it's in `session`.
 *   - A note EDITED this session keeps its id; `fresh` re-reads the stale,
 *     pre-edit copy under that same id, so it is excluded and the session's
 *     edited copy is what survives.
 *   - A note DELETED this session is gone from `session`, but `fresh` still
 *     has it (it's still on disk, unsaved) — `deletedIds` is what stops
 *     that from resurrecting it; without a record of the deletion, "absent
 *     from session" would be indistinguishable from "session never heard
 *     of it", and the second case is exactly how a genuinely new note (a
 *     collaborator's freshly dropped-in `notes-priya.csv`) has to get in.
 *   - A note that is new on disk and unknown to the session — that
 *     collaborator's file — has no id collision with `session` and is not
 *     in `deletedIds`, so it is added.
 *
 * Pure and independent of `ingestFolder`'s file-reading, so it is directly
 * testable with plain `Note[]` — no `File` mocking needed.
 */
export function mergeSessionNotes(
  session: readonly Note[],
  fresh: readonly Note[],
  deletedIds: ReadonlySet<string>,
): Note[] {
  const sessionIds = new Set(session.map((n) => n.id));
  const notes = [
    ...session,
    ...fresh.filter((n) => !sessionIds.has(n.id) && !deletedIds.has(n.id)),
  ];
  notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return notes;
}

/**
 * Convert one legacy `Note` (the shape `manifest.notes[]` still carries) into
 * the new CSV-backed shape.
 *
 * Exported so App.tsx can build the same shape for a note just added through
 * the in-browser composer, which still produces the legacy shape today —
 * moving the composer itself to write the new shape directly is later work.
 * `id` is reused as-is, which is what lets an edit or delete made against the
 * migrated note keep finding the right `manifest.notes` entry.
 */
export function legacyNoteToNote(legacy: LegacyNote, people: readonly Person[]): Note {
  const nameOf = (id: string): string => people.find((p) => p.id === id)?.name ?? id;
  const note: Note = {
    id: legacy.id,
    at: legacy.at,
    people: legacy.person ? [nameOf(legacy.person)] : [],
    author: [],
    text: legacy.text,
  };
  if (legacy.until !== undefined) {
    const start = Date.parse(legacy.at);
    const end = Date.parse(legacy.until);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      note.duration = formatDuration(end - start);
    }
  }
  return note;
}

/**
 * Convert a manifest's legacy `notes[]` and per-item `note` captions into the
 * shape notes*.csv rows produce, so old authorship shows up everywhere the
 * merged list does rather than only in the parts of the UI still reading
 * `manifest.notes` directly.
 *
 * A caption has no id of its own, so it gets a stable one derived from the
 * item id (`caption:<item id>`), which stays the same across re-ingests of
 * the same folder rather than minting a new one every time.
 *
 * Exported for direct testing — this is the highest-risk code in the task
 * (duration arithmetic, name resolution, resolved-instant lookup), and it
 * only needs a plain `Manifest` object to exercise, no `File`/browser mocking.
 */
export function migrateLegacyNotes(manifest: Manifest): Note[] {
  const out: Note[] = [];
  for (const legacy of manifest.notes ?? []) {
    out.push(legacyNoteToNote(legacy, manifest.people));
  }

  // A caption's time is the item's RESOLVED instant (clock offset applied,
  // timezone resolved) — not the raw `item.at` — so it lands exactly where
  // the photo itself does.
  const hasCaptions = manifest.items.some((it) => it.note !== undefined);
  if (hasCaptions) {
    const nameOf = (id: string): string => manifest.people.find((p) => p.id === id)?.name ?? id;
    const { placed } = placeItems(manifest);
    const instantById = new Map(placed.map((p) => [p.item.id, p.instant]));
    for (const item of manifest.items) {
      if (item.note === undefined) continue;
      const instant = instantById.get(item.id);
      // No resolvable time means no valid `at` for a Note. The caption still
      // shows on the item itself; it just cannot migrate until it is placed.
      if (instant === undefined) continue;
      out.push({
        id: `caption:${item.id}`,
        at: new Date(instant).toISOString(),
        photo: item.id,
        people: [nameOf(item.person)],
        author: [],
        text: item.note,
      });
    }
  }

  return out;
}

/** How many optional series a track carries, for choosing between files. */
function richness(course: Course): number {
  return Number(course.has.elevation) + Number(course.has.hr) + Number(course.has.cadence);
}

/**
 * The manifest as it is SAVED: without `notes[]` or `items[].note`.
 *
 * Prose lives in `notes*.csv` now (see Task 9's brief). The validator in
 * `schema.ts` still ACCEPTS both legacy fields, so a manifest saved before
 * this change keeps loading — this is the writer half of that split. It is a
 * pure function of the manifest (no I/O, no mutation of its argument) so it
 * can sit in front of whatever saving means: `App.tsx`'s `saveEvent` calls it
 * before embedding `manifest.json` in the zip, which is the app's only save
 * path today. A manifest therefore migrates itself the first time it is
 * saved after being opened.
 */
export function manifestForSave(manifest: Manifest): Manifest {
  const { notes: _legacyNotes, ...rest } = manifest;
  const items = manifest.items.map((item) => {
    if (item.note === undefined) return item;
    const { note: _legacyNote, ...kept } = item;
    return kept;
  });
  return { ...rest, items };
}
