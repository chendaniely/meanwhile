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
import { isManifestFile, isTrackFile } from '../../core/metadata.ts';
import {
  validateManifest,
  type Item,
  type Manifest,
  type Note,
  type Person,
} from '../../core/schema.ts';
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
   */
  existingNotes?: readonly Note[];
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
}

export async function ingestFolder(
  files: readonly PickedFile[],
  opts: IngestOptions,
): Promise<IngestResult> {
  // Whether naive timestamps can be resolved changes which source wins per
  // file, so it is decided once here and passed down.
  const ctx = { hasTimezone: Boolean(opts.timezone) };
  // Neither track files nor a manifest are media; both take their own path.
  const tracks = files.filter((f) => isTrackFile(f.path));
  const manifests = files.filter((f) => isManifestFile(f.path));
  const media = files.filter((f) => !isTrackFile(f.path) && !isManifestFile(f.path));

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
  // A manifest from the folder outranks whatever is in memory: the author
  // just handed it over on purpose.
  const existingPeople = imported?.people ?? opts.existingPeople;
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
  const notes = imported?.notes ?? opts.existingNotes;
  if (notes?.length) manifest.notes = [...notes];

  return {
    manifest,
    grouping: describeGrouping(ingested),
    course,
    courseFile,
    importedFrom,
    importError,
  };
}

/** How many optional series a track carries, for choosing between files. */
function richness(course: Course): number {
  return Number(course.has.elevation) + Number(course.has.hr) + Number(course.has.cadence);
}

/**
 * Offer the manifest as a download.
 *
 * The whole app stores nothing, so "save" means handing the user a file. The
 * object URL is revoked immediately after the click; leaving them around is
 * how a long authoring session slowly eats memory.
 */
export function downloadManifest(manifest: Manifest, filename = 'manifest.json'): void {
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
