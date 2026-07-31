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
import {
  dedupeNotes, fingerprintNote, mergeNotes, partitionDeleted, reportTombstoneRemovals,
  resolveNotePhotos, type Note, type NoteRowIdentity,
} from '../../core/notes.ts';
import {
  displayName, parsePeopleCsv, resolvePersonNames, type PeopleExtra,
} from '../../core/people-csv.ts';
import type { PreservedRow } from '../../core/csv.ts';
import {
  validateManifest,
  type CourseRef,
  type Item,
  type Manifest,
  type Marker,
  type Note as LegacyNote,
  type Person,
} from '../../core/schema.ts';
import { formatDuration, inferEventTimezone } from '../../core/time.ts';
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
  /**
   * Let the media's own recorded UTC offsets choose the event timezone, when
   * no manifest in the folder states one — see `inferEventTimezone`
   * (`core/time.ts`).
   *
   * Off by default and set only when a folder is OPENED, never when files are
   * added to one already open: on "Add files" the current zone may well be
   * one the author typed by hand, and silently reverting a correction is a
   * worse failure than a first guess being imperfect.
   */
  inferTimezone?: boolean;
  existingPeople?: readonly Person[];
  existingItems?: readonly Item[];
  /**
   * The roster as it stands in this session — names, roles, aliases and clock
   * offsets the author has changed since the folder was opened, none of which
   * is on disk until Save.
   *
   * Passed ONLY on "Add files", exactly like `sessionNotes`, and it wins over
   * `people.csv` for any id it already knows. Without it, dropping a GPX into
   * an open folder re-read the unsaved `people.csv` and reverted every rename
   * — taking the `also_known_as` alias with it, so notes the rename had
   * rewritten to the new name then matched nobody at all. Notes and timezone
   * inference were already protected this way; the roster was not.
   *
   * Ids only `people.csv` has are still added, so a roster file dropped in
   * mid-session still introduces the people it names. What it cannot do is
   * silently overwrite a person the author has already edited here — the
   * report says so when the two disagree.
   */
  sessionPeople?: readonly Person[];
  /**
   * The crop, the course reference and the markers as they stand in this
   * session.
   *
   * Same rule and same reason as `sessionPeople`: these were restored only
   * from an imported `manifest.json`, so setting a Strava link and then using
   * "Add files" to drop in a track discarded the link, the time window and
   * every marker with nothing said. Passed only on "Add files" — on "Open
   * folder" they belong to the folder being left behind, not the one being
   * opened.
   */
  existingRange?: { from: string; to: string };
  existingCourse?: CourseRef;
  existingMarkers?: readonly Marker[];
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
  /**
   * Content fingerprints (`fingerprintNote`) of notes deleted this session,
   * alongside `deletedNoteIds`.
   *
   * `deletedNoteIds` alone is not enough for a blank-`id` row — the
   * documented way to hand-add a note — because `dedupeNotes` mints a FRESH
   * random id for one on every parse of `notes*.csv`, since nothing persists
   * a row-to-id mapping between calls. Deleting such a note removes the id
   * minted at delete time from `session`, but the underlying row is still
   * blank-id and unsaved, so the NEXT parse mints a different id that
   * `deletedNoteIds` has never seen — and the deleted note comes back. A
   * fingerprint match is treated as the same note for every practical
   * purpose here, since it already compares time, text, people, author,
   * photo, and extra together.
   */
  deletedNoteFingerprints?: ReadonlySet<string>;
  /**
   * The ROOT fix behind `deletedNoteFingerprints`/`sessionFingerprints`
   * (see `mergeSessionNotes`'s doc comment) rather than another patch on
   * top of them: a session-scoped map from a blank-`id` row's content
   * fingerprint to the id minted for it, forwarded to `mergeNotes` →
   * `dedupeNotes`. Reusing the SAME id for the SAME unsaved row across
   * every re-ingest of one open folder is what lets every other
   * id-based mechanism here — session-wins, the deletion tombstones,
   * edit-preservation — work exactly as designed, because ids finally
   * behave the way the rest of this design already assumed they did.
   *
   * MUTATED IN PLACE by `ingestFolder` (via `dedupeNotes`), unlike every
   * other option here: the whole point is that the SAME `Map` object comes
   * back in on the next call already carrying what the last one recorded.
   * `App.tsx` owns one for the lifetime of an open folder and replaces it
   * with a fresh, empty one when a genuinely different folder is opened —
   * see the comment on `noteRowIdentity` there.
   */
  noteRowIdentity?: NoteRowIdentity;
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
   * Every note, merged from `notes*.csv` with whatever a legacy manifest's
   * `notes[]` and `items[].note` captions migrate into, then sorted by `at`
   * (`mergeSessionNotes` re-sorts chronologically) — NOT ordered by which
   * source contributed a note. Picked up the same way a `.gpx` is: drop the
   * file in with the photos.
   */
  notes: Note[];
  /**
   * Tombstones: rows of `notes*.csv` marked `deleted`, kept apart from
   * `notes` so nothing shows them and everything still WRITES them back.
   *
   * Dropping them on save would undo the deletion the moment anyone merged
   * an older copy of the file, which is precisely the failure the column
   * exists to stop.
   */
  deletedNotes: Note[];
  /**
   * Columns of `people.csv` this app has no meaning for, kept so the save
   * path can put them back. See `PeopleExtra` in `core/people-csv.ts`.
   */
  peopleExtra: PeopleExtra;
  /**
   * Rows of `notes*.csv` and `people.csv` this build could not read, kept
   * verbatim so the save path writes them back rather than deleting them.
   *
   * See `PreservedRow` in `core/csv.ts` for why: reporting a row and then
   * dropping it from the next saved file are the same loss under two names,
   * and it defeated the `schema` column outright — a row from a newer build
   * was reported with advice to "update the site", and one Save later there
   * was nothing left to read with the updated site.
   */
  preservedNoteRows: PreservedRow[];
  preservedPeopleRows: PreservedRow[];
  /**
   * A note or roster row with a problem, always reported here rather than
   * failing silently — but not every problem leaves the row in place.
   *
   * A roster row missing an id/name, or reusing an id already seen, is not
   * USED (`parsePeopleCsv` in ./core/people-csv.ts); same for a notes.csv
   * row with an unreadable date or no text (`rowToNote` in ./core/notes.ts).
   * Not used is not the same as gone: every one of those rows is kept in
   * `preservedNoteRows`/`preservedPeopleRows` and written back on the next
   * Save, so the file still holds what its author typed.
   * Three problems KEEP the row and degrade only the field at fault: an
   * ambiguous `photo` match — a filename fitting more than one item — leaves
   * the note in place with its photo link unresolved (`resolveNotePhotos` in
   * ./core/notes.ts); and a roster row with an unrecognised `role` or an
   * unparseable `clock_offset` keeps the person, blanking just that column
   * rather than saving it wrong (`parsePeopleCsv`).
   *
   * **It is no longer only about rows**, after a security review found three
   * things going wrong in complete silence. Also reported here: a second
   * `manifest.json` or `people.csv` found deeper in the folder and therefore
   * ignored (`ignoredCandidate`); a `deleted` row that cancelled a note some
   * other file still held, with the text that went (`reportTombstoneRemovals`
   * in ./core/notes.ts); and a malformed track file
   * (`Course.problems`). Every one of them used to change what the timeline
   * showed with nothing said anywhere.
   */
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
  // Shallowest first, so the folder's OWN manifest and roster win over a copy
  // that came along inside somebody's subfolder. See `shallowestFirst`.
  const manifests = shallowestFirst(files.filter((f) => isManifestFile(f.path)));
  const notesFiles = files.filter((f) => isNotesFile(f.path));
  const peopleFiles = shallowestFirst(files.filter((f) => isPeopleFile(f.path)));
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
  /*
   * ONE manifest per folder, and it is the first one this loop accepts — which
   * `shallowestFirst` has already made the one closest to the top.
   *
   * This loop used to run to the end without a `break`, so the LAST file in
   * path order won. A contributor who zips their own working folder in — much
   * likelier than malice — could therefore replace the event title, timezone,
   * time window, course reference and whole roster (a 10-hour `clockOffset`
   * included, which moves every photo) from `zz-crew/manifest.json`, with
   * nothing said about it anywhere.
   */
  const ignoredCandidates: string[] = [];
  /** Warnings from `validateManifest` for the manifest actually used. */
  const manifestWarnings: string[] = [];
  /**
   * Manifests closer to the top that could not be read at all.
   *
   * `shallowestFirst` exists to stop a copy from somebody's subfolder standing
   * in for the folder's own manifest — but a malformed shallowest candidate
   * fell straight through it: the loop simply carried on and accepted the
   * deeper one, so `{ not json` at the root handed the whole event (title,
   * timezone, crop, course, roster) to `sub/manifest.json`. That is the exact
   * substitution the ordering was added to prevent, and the only trace of it
   * was an `importError` naming a DIFFERENT file from the one in use, which
   * reads as "nothing was applied" when in fact something was.
   */
  const unreadableAbove: string[] = [];
  for (const found of manifests) {
    // Tested on `importedFrom` rather than on `imported`, though the two are
    // set together: it is the one that gives the message the name of the file
    // that WAS used, with no cast needed to persuade the type checker of it.
    if (importedFrom !== null) {
      ignoredCandidates.push(ignoredCandidate('manifest', found.path, importedFrom));
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(await found.file.text());
      const result = validateManifest(parsed);
      if (result.ok) {
        imported = result.manifest;
        importedFrom = found.path;
        /*
         * A warning nothing renders is not a warning.
         *
         * `validateManifest` has always collected these and NOTHING in
         * `src/viewer` had ever read them — verified by grep before this was
         * written. That was survivable while every warning was advisory ("two
         * people have role runner"), and stopped being survivable the moment a
         * refused `course.url` became a warning rather than an error: the
         * whole point of that change is that the manifest still loads, which
         * only works if the reader is told why the link is missing.
         *
         * Routed into the same problems callout that carries `importError`
         * and every other silent-outcome report, because this project already
         * has one channel for "something was not done the way the file said"
         * and a second one would be a second place to forget to look.
         */
        manifestWarnings.push(...result.warnings.map((w) => `${found.path}: ${w}`));
      } else {
        // Refused with a legible reason rather than half-applied. A manifest
        // that partly loads is how you lose work without noticing.
        importError = `${found.path}: ${result.errors.slice(0, 3).join('; ')}`;
        unreadableAbove.push(found.path);
      }
    } catch (err) {
      importError = `${found.path}: ${err instanceof Error ? err.message : 'not valid JSON'}`;
      unreadableAbove.push(found.path);
    }
  }
  // Said out loud only when a broken candidate actually let a deeper one
  // through. With no substitute, `importError` alone is the whole story and
  // repeating it would just be noise.
  if (importedFrom !== null && unreadableAbove.length > 0) {
    ignoredCandidates.push(
      `Could not read ${unreadableAbove.map((p) => `"${p}"`).join(' or ')}, which ${
        unreadableAbove.length === 1 ? 'sits' : 'sit'
      } closer to the top of the folder, so meanwhile used "${importedFrom}" instead — the ` +
        'event name, timezone, time window, course and people you are looking at came from ' +
        `that file. Fix or remove ${unreadableAbove.map((p) => `"${p}"`).join(' and ')} if ` +
        'that is not the manifest you meant.',
    );
  }

  let course: Course | null = null;
  let courseFile: string | null = null;
  // A track that is malformed enough to be worth saying so about: an element
  // the file never closes, a latitude off the planet. Reported, never guessed
  // through — see `parseCourse`.
  const courseProblems: string[] = [];
  for (const track of tracks) {
    const parsed = parseCourse(await track.file.text());
    // Prefer whichever carries the most: a TCX has heart rate and cadence
    // where a GPX has neither, and people often have both lying around.
    if (parsed && (!course || richness(parsed) > richness(course))) {
      course = parsed;
      courseFile = track.path;
    }
    for (const problem of parsed?.problems ?? []) courseProblems.push(`${track.path}: ${problem}`);
  }

  // A roster kept in people.csv is a spreadsheet edit away, which is the
  // whole point of this file — so it outranks `existingPeople`, the same way
  // an imported manifest.json already does.
  //
  // ONE roster per folder, the shallowest — exactly as for the manifest above,
  // and for the same reason: this loop used to let the last `people.csv` in
  // path order win, so a roster inside anybody's subfolder replaced the real
  // one, names, roles and clock offsets together.
  let peopleFromCsv: Person[] | null = null;
  const peopleExtra: PeopleExtra = new Map();
  const rosterProblems: string[] = [];
  const preservedPeopleRows: PreservedRow[] = [];
  const rosterFile = peopleFiles[0];
  if (rosterFile) {
    const { people, problems, extra, preserved } = parsePeopleCsv(
      await rosterFile.file.text(),
      rosterFile.path,
    );
    if (people.length > 0) peopleFromCsv = people;
    for (const [id, columns] of extra) peopleExtra.set(id, columns);
    for (const p of problems) rosterProblems.push(`${rosterFile.path}: ${p}`);
    preservedPeopleRows.push(...preserved);
    for (const other of peopleFiles.slice(1)) {
      ignoredCandidates.push(ignoredCandidate('roster', other.path, rosterFile.path));
    }
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
  const rosterFromDisk = peopleFromCsv ?? imported?.people ?? opts.existingPeople;
  // ...and, on "Add files", the live session on top of all of it. See
  // `sessionPeople` and `mergeSessionPeople`.
  const existingPeople = mergeSessionPeople(opts.sessionPeople, rosterFromDisk);
  const existingItems = imported?.items ?? opts.existingItems;
  const rosterProblemsFromSession =
    opts.sessionPeople === undefined
      ? []
      : reportUnsavedRosterEdits(opts.sessionPeople, rosterFromDisk, rosterFile?.path ?? 'people.csv');

  const assembleOpts: Parameters<typeof assembleManifest>[1] = {
    title: imported?.event.title ?? opts.title,
  };
  // A manifest in the folder states the zone outright and always wins.
  // Otherwise the media's OWN recorded UTC offsets beat the browser's zone,
  // which is a fact about the laptop rather than about where the race was —
  // see `inferEventTimezone`.
  const zone =
    imported?.event.timezone ??
    (opts.inferTimezone
      ? inferEventTimezone(ingested.map((f) => f.metadata), opts.timezone)
      : opts.timezone);
  if (zone !== undefined) assembleOpts.timezone = zone;
  if (existingPeople !== undefined) assembleOpts.existingPeople = existingPeople;
  if (existingItems !== undefined) assembleOpts.existingItems = existingItems;

  const manifest = assembleManifest(ingested, assembleOpts);
  // The crop is authoring intent and has to survive the round trip — and
  // "the round trip" includes "Add files", not just export-and-reopen. These
  // used to be restored from an imported `manifest.json` and from nothing
  // else, so a Strava link set in the settings panel vanished the moment a
  // GPX was dropped in, which is the documented way to add one.
  const range = imported?.event.range ?? opts.existingRange;
  if (range) manifest.event.range = range;
  const courseRef = imported?.course ?? opts.existingCourse;
  if (courseRef) manifest.course = courseRef;
  const markers = imported?.markers ?? opts.existingMarkers;
  if (markers) manifest.markers = [...markers];
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
   * WRITER (`manifestForSave`, below) is what stops emitting them, on save.
   * Until a manifest has been saved once since this change, the round trip
   * through download-manifest-and-reopen keeps working with both fields
   * still present on disk.
   */
  const noteFiles = await Promise.all(
    notesFiles.map(async (f) => ({ name: f.path, text: await f.file.text() })),
  );
  const {
    notes: csvNotes, problems: csvNoteProblems, preserved: preservedNoteRows,
  } = mergeNotes(noteFiles, manifest.event.timezone, opts.noteRowIdentity);
  const migratedNotes = migrateLegacyNotes(manifest);
  // A folder can carry BOTH an old-style manifest.json (migratedNotes) and a
  // notes.csv saved from it (csvNotes) — the same notes, under the same
  // ids, from two sources. Without deduping here that is an exact id
  // collision on every ingest, not just a hypothetical one.
  const merged = dedupeNotes([...migratedNotes, ...csvNotes], manifest.event.timezone);
  // Tombstones are separated here and nowhere else: everything downstream —
  // placement, the feed, the lanes, the note list — works on live notes only,
  // and the save path is the one place that has to see them again.
  const { live: freshNotes, deleted: deletedNotes } = partitionDeleted(merged);
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
    manifest.event.timezone,
    opts.deletedNoteFingerprints ?? new Set(),
  );
  const noteProblems = [
    ...ignoredCandidates,
    ...courseProblems,
    ...rosterProblems,
    ...rosterProblemsFromSession,
    ...csvNoteProblems,
    // A tombstone in notes*.csv can also cancel a note that came out of a
    // legacy manifest.json in the same folder — the same silent loss, across
    // the other seam. `mergeNotes` has already collapsed the notes files into
    // one list by here, so the tombstone side is named by the files it could
    // have come from.
    ...reportTombstoneRemovals([
      { name: importedFrom ?? 'manifest.json', notes: migratedNotes },
      { name: noteFiles.map((f) => f.name).join(' or ') || 'notes.csv', notes: csvNotes },
    ]),
    ...photoProblems,
    ...reportUnresolvedNoteNames(notes, manifest.people),
    // LAST, deliberately. Everything above reports something that was
    // DISCARDED or could not be read — a note another file deleted, a roster
    // that was ignored, a row that would not parse. These are advisories
    // about the manifest, and putting one ahead of those buries the report
    // that costs somebody data under the one that does not.
    ...manifestWarnings,
  ];

  return {
    manifest,
    grouping: describeGrouping(ingested),
    course,
    courseFile,
    importedFrom,
    importError,
    notes,
    deletedNotes,
    peopleExtra,
    preservedNoteRows,
    preservedPeopleRows,
    noteProblems,
  };
}

/**
 * The live session's roster laid over whatever the folder says, per id.
 *
 * Only reached on "Add files" (`sessionPeople` is passed nowhere else), and
 * the asymmetry is the point: a rename, a role, an alias — none of it is on
 * disk until Save, so re-reading `people.csv` mid-session reverts work the
 * author can see on screen. Notes had this protection already; the roster is
 * the seam it was missing, and the bug it caused was worse than a lost name:
 * the vanished `also_known_as` alias broke the join from every note that had
 * been rewritten to the new name, so they resolved to nobody at all.
 *
 * Ids only the FILE has are kept, appended after the session's own, so a
 * `people.csv` dropped in mid-session still introduces the people it names.
 * What it cannot do is quietly overwrite someone already edited here —
 * `reportUnsavedRosterEdits` says so when the two disagree.
 */
export function mergeSessionPeople(
  session: readonly Person[] | undefined,
  fromDisk: readonly Person[] | undefined,
): readonly Person[] | undefined {
  if (session === undefined) return fromDisk;
  if (fromDisk === undefined) return session;
  const known = new Set(session.map((p) => p.id));
  return [...session, ...fromDisk.filter((p) => !known.has(p.id))];
}

/**
 * Name the people whose roster row on disk disagrees with the session's.
 *
 * The session wins (see `mergeSessionPeople`), and a person is entitled to
 * know that the file in the folder still says something else — usually
 * because they have renamed someone and not saved yet, occasionally because
 * they have just dropped in somebody else's `people.csv` and it is being
 * overruled. One line either way, naming the people first and then only
 * whichever of their columns actually moved.
 *
 * **Every difference used to be phrased as a rename**, so changing a clock
 * offset or an alias and nothing else produced `"Bob" is now "Bob"` — a
 * sentence that describes nothing, and points at the one field that did not
 * change. The report still has to FIRE for those (an unsaved clock offset
 * moves every photo that person took, which is exactly the kind of edit worth
 * warning about); what changed is that it now says which column it was.
 */
export function reportUnsavedRosterEdits(
  session: readonly Person[],
  fromDisk: readonly Person[] | undefined,
  file: string,
): string[] {
  if (!fromDisk) return [];
  const bySession = new Map(session.map((p) => [p.id, p]));
  const differing: string[] = [];
  for (const p of fromDisk) {
    const mine = bySession.get(p.id);
    if (!mine) continue;
    // The clauses ARE the comparison — there is no separate "are they the
    // same" test to drift out of step with what the message says. An empty
    // list is the two rows agreeing.
    const clauses: string[] = [];
    if (mine.name !== p.name) clauses.push(`is now "${displayName(mine)}"`);
    // Named the way `people.csv`'s own columns read, so someone can open the
    // file and go straight to the one being talked about. "different earlier
    // names" carries no article on purpose: the column is a list, and it is
    // the one phrase here that is plural.
    const columns: string[] = [];
    if (mine.role !== p.role) columns.push('a different role');
    if (mine.clockOffset !== p.clockOffset) columns.push('a different clock offset');
    if ((mine.alsoKnownAs ?? []).join(';') !== (p.alsoKnownAs ?? []).join(';')) {
      columns.push('different earlier names');
    }
    if (columns.length > 0) clauses.push(`has ${andList(columns)}`);
    if (clauses.length > 0) differing.push(`"${displayName(p)}" ${clauses.join(' and ')}`);
  }
  if (differing.length === 0) return [];
  return [
    `Kept your unsaved changes to the people list rather than what is in ${file}: ` +
      `${differing.join(', ')}. Save to write them to ${file}.`,
  ];
}

/** `a`, `a and b`, `a, b and c` — plain prose rather than a bare join. */
function andList(parts: readonly string[]): string {
  if (parts.length < 2) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
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
 * **A blank `id` cell is the one case id-matching alone cannot handle, and
 * it is the documented, encouraged way to hand-add a note** — README says
 * "leave it blank on a new row." `rowToNote` sets `id: ''` for it, and
 * `dedupeNotes` mints a FRESH random id on every parse; nothing persists a
 * row-to-id mapping between calls. So the identical unsaved row gets id `A`
 * on the first ingest and a different id `B` on the next re-ingest, and a
 * plain "does `fresh`'s id appear in `session`" check sees `B` as unknown
 * and duplicates the note. Filtering `fresh` by CONTENT fingerprint as well
 * (`fingerprintNote` — the same identity rule `dedupeNotes` already applies
 * within one parse, just applied at this seam too) closes that: a fresh
 * note whose content already matches something in `session` is the same
 * hand-typed row wearing a new mint, not a new note, regardless of id.
 *
 * Deliberately NOT the fix on the other side — minting the id FROM the
 * content instead of randomly — because that breaks the moment someone
 * edits a hand-typed note: the id would change with the text, and identity
 * (what an edit or delete addresses) would be lost exactly when it matters.
 *
 * **The same blank-id problem has a mirror image on the DELETE side**, found
 * by a later review: `deletedIds` records the id minted for a note AT
 * DELETE TIME, but a blank-id row's underlying `notes.csv` line is still
 * unsaved and blank-id, so the NEXT parse mints a DIFFERENT id — one
 * `deletedIds` has never seen — and the deleted note comes back. Fixed the
 * same way as the add-side duplication: `deletedFingerprints` records the
 * CONTENT fingerprint of a note at delete time, alongside its id, and a
 * fresh note matching one is excluded regardless of what id it was minted
 * under this time. Session-scoped exactly like `deletedIds` — cleared on
 * a genuinely different folder — so a fingerprint deleted in one session
 * cannot suppress an unrelated, later note that merely happens to match.
 *
 * **A still later review asked to fix the ROOT CAUSE instead of patching a
 * third symptom** (an edited-then-deleted blank-id note resurrecting under
 * its PRE-edit text, because the tombstone fingerprint was taken from the
 * EDITED in-memory copy while the fresh re-parse still produced the
 * original). That fix is `NoteRowIdentity` (see `dedupeNotes` in
 * `core/notes.ts`): a blank-id row keeps the SAME id across every re-parse
 * of an unchanged file, for the lifetime of one open folder — PROVIDED the
 * row is distinguishable from every other row by content.
 *
 * **`sessionFingerprints` and `deletedFingerprints` are still load-bearing,
 * and are not a leftover from before that fix — they are its backstop for
 * the one case it cannot resolve by construction: two (or more) blank-id
 * rows in the SAME file whose PARSED CONTENT IS BYTE-IDENTICAL.** A
 * copy-pasted row, or two people logging the same minute with the same
 * words, are both plausible accidents, not edge cases to wave away.
 * `NoteRowIdentity` is a `Map` keyed by content fingerprint, so identical
 * rows collide on ONE slot: `dedupeNotes` gives the first such row in file
 * order that slot's stored id, and every other identical row in the same
 * parse mints a fresh one instead (see `seen.has(stable)` there) — and
 * because only ONE id can occupy that slot, WHICH physical row ends up
 * reusing it churns from ingest to ingest. Traced by hand and confirmed by
 * `tests/ingest.test.ts`'s "two byte-identical blank-id rows" case: without
 * these two checks, every re-ingest of such a file mints one more phantom
 * note, because the churned id is never the one `deletedIds`/`sessionIds`
 * has on record. With them, a fresh note whose CONTENT already has a
 * representative in `session` (add side) or was deleted (delete side) is
 * recognised regardless of which specific id it churned to this time — the
 * two rows are indistinguishable by content, so the two checks correctly
 * stop caring which physical row is which and cap the count by content
 * instead. Neither guard is removable while `NoteRowIdentity` remains
 * content-keyed, which it has to be — there is no OTHER handle on a
 * blank-id row to key it by.
 *
 * Pure and independent of `ingestFolder`'s file-reading, so it is directly
 * testable with plain `Note[]` — no `File` mocking needed.
 */
export function mergeSessionNotes(
  session: readonly Note[],
  fresh: readonly Note[],
  deletedIds: ReadonlySet<string>,
  eventTimezone?: string,
  deletedFingerprints: ReadonlySet<string> = new Set(),
): Note[] {
  const sessionIds = new Set(session.map((n) => n.id));
  const sessionFingerprints = new Set(session.map((n) => fingerprintNote(n, eventTimezone)));
  const notes = [
    ...session,
    ...fresh.filter((n) => {
      if (sessionIds.has(n.id) || deletedIds.has(n.id)) return false;
      const fingerprint = fingerprintNote(n, eventTimezone);
      return !sessionFingerprints.has(fingerprint) && !deletedFingerprints.has(fingerprint);
    }),
  ];
  notes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return notes;
}

/**
 * Convert one legacy `Note` (the shape `manifest.notes[]` still carries) into
 * the new CSV-backed shape.
 *
 * Exported for direct testing (see `tests/ingest.test.ts`) and used by
 * `migrateLegacyNotes` below, which is this function's only production
 * caller — App.tsx does not import it directly. `id` is reused as-is, which
 * is what lets an edit or delete made against the migrated note keep
 * finding the right `manifest.notes` entry.
 */
export function legacyNoteToNote(legacy: LegacyNote, people: readonly Person[]): Note {
  const nameOf = (id: string): string => {
    const p = people.find((p) => p.id === id);
    return p ? displayName(p) : id;
  };
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
    const nameOf = (id: string): string => {
      const p = manifest.people.find((p) => p.id === id);
      return p ? displayName(p) : id;
    };
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

/**
 * Report every note whose `people` or `author` names a string that resolves
 * to nobody on the roster — a hand-deleted `also_known_as` entry, a typo, or
 * simply a bystander nobody grouped media for. `resolvePersonNames` (the
 * same join `Swimlanes.tsx` uses to place a note in a lane, and the join
 * `PersonPicker` matches against) already tells "unknown" apart from
 * "known"; before this fix nothing surfaced that at ingest, so an alias
 * quietly deleted from `people.csv` orphaned a note with zero visible sign
 * anywhere in the report.
 *
 * Not an error — an unrecognised name is deliberately KEPT rather than
 * dropped (see `resolvePersonNames`'s own doc comment) — so this reports
 * every occurrence, the same "always loud, never blocking" rule
 * `resolveNotePhotos` already follows for an unmatched `photo`.
 *
 * Exported for direct testing with plain `Note[]`/`Person[]`, no `File` or
 * folder needed.
 */
export function reportUnresolvedNoteNames(notes: readonly Note[], people: readonly Person[]): string[] {
  const problems: string[] = [];
  for (const note of notes) {
    const { unknown: unknownPeople } = resolvePersonNames(note.people, people);
    const { unknown: unknownAuthors } = resolvePersonNames(note.author, people);
    const unknown = [...new Set([...unknownPeople, ...unknownAuthors])];
    if (unknown.length === 0) continue;
    problems.push(
      `note "${note.id}": ${unknown.length === 1 ? 'name' : 'names'} ` +
        `${unknown.map((n) => `"${n}"`).join(', ')} ${unknown.length === 1 ? "doesn't" : "don't"} match ` +
        `anyone in people.csv — kept as plain text, but won't sit in that person's lane`,
    );
  }
  return problems;
}

/**
 * Order candidates so the one closest to the top of the folder comes first,
 * ties broken by path so the choice is the same every time.
 *
 * `isManifestFile`/`isPeopleFile` match `manifest.json` and `people.csv`
 * ANYWHERE in the tree, which is deliberate — it is how dragging a subfolder
 * in works. What was not deliberate is that whichever copy sorted last then
 * won. Depth is the right tiebreak: the file the author put beside their
 * photographs is the folder's own, and anything nested inside came along with
 * somebody's working directory.
 */
function shallowestFirst<T extends { path: string }>(files: readonly T[]): T[] {
  const depth = (path: string): number => path.split('/').length;
  return [...files].sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
}

/** Plain words for "there were two of these and I used the other one". */
function ignoredCandidate(kind: 'manifest' | 'roster', ignored: string, used: string): string {
  const what =
    kind === 'manifest'
      ? 'the event name, timezone, time window, course and people in it'
      : 'the names, roles and clock offsets in it';
  return (
    `Ignored the extra ${kind === 'manifest' ? 'manifest' : 'people.csv'} "${ignored}": ` +
    `meanwhile reads one ${kind} per folder, the one closest to the top, and that is ` +
    `"${used}". So ${what} were not used. Move or delete the file if you meant that one instead.`
  );
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
