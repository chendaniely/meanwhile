/**
 * Running metadata extraction across a whole folder.
 *
 * Two things matter here at 2,000 files: don't freeze the tab, and tell the
 * user what is happening. A bounded pool does both — it keeps several file
 * reads in flight without queueing thousands of promises at once, and it
 * yields often enough for progress to paint.
 */

import { assembleManifest, type IngestedFile } from '../../core/assemble.ts';
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

export async function ingestFolder(
  files: readonly PickedFile[],
  opts: IngestOptions,
): Promise<Manifest> {
  const results = new Array<IngestedFile | null>(files.length);
  let done = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      if (opts.signal?.aborted) throw new DOMException('Ingest cancelled', 'AbortError');

      const picked = files[index] as PickedFile;
      try {
        results[index] = {
          path: picked.path,
          metadata: await extractMetadata(picked.path, picked.file),
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
      opts.onProgress?.({ done, total: files.length, current: picked.path });
      // Yield to the event loop so progress actually paints.
      if (done % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  const ingested = results.filter((r): r is IngestedFile => r !== null);
  const assembleOpts: Parameters<typeof assembleManifest>[1] = { title: opts.title };
  if (opts.timezone !== undefined) assembleOpts.timezone = opts.timezone;
  if (opts.existingPeople !== undefined) assembleOpts.existingPeople = opts.existingPeople;
  if (opts.existingItems !== undefined) assembleOpts.existingItems = opts.existingItems;

  return assembleManifest(ingested, assembleOpts);
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
