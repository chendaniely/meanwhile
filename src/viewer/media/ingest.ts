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
import { isTrackFile } from '../../core/metadata.ts';
import type { Manifest, Person, Item } from '../../core/schema.ts';
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
}

export async function ingestFolder(
  files: readonly PickedFile[],
  opts: IngestOptions,
): Promise<IngestResult> {
  // Whether naive timestamps can be resolved changes which source wins per
  // file, so it is decided once here and passed down.
  const ctx = { hasTimezone: Boolean(opts.timezone) };
  // Track files are not media and take a different path entirely.
  const tracks = files.filter((f) => isTrackFile(f.path));
  const media = files.filter((f) => !isTrackFile(f.path));

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
  const assembleOpts: Parameters<typeof assembleManifest>[1] = { title: opts.title };
  if (opts.timezone !== undefined) assembleOpts.timezone = opts.timezone;
  if (opts.existingPeople !== undefined) assembleOpts.existingPeople = opts.existingPeople;
  if (opts.existingItems !== undefined) assembleOpts.existingItems = opts.existingItems;

  return {
    manifest: assembleManifest(ingested, assembleOpts),
    grouping: describeGrouping(ingested),
    course,
    courseFile,
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
