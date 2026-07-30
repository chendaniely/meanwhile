/**
 * Report what meanwhile reads out of a folder of real media.
 *
 * This is a verification tool, not the deferred ingest CLI. It exists because
 * synthetic fixtures cannot prove the parsers are right: a builder and a
 * parser written together can share the same misunderstanding of a format and
 * agree with each other while both being wrong. Only real files off real
 * phones settle that.
 *
 * It runs the SAME `src/core` code the viewer will run, so what it prints is
 * what the timeline will do.
 *
 *   make inspect DIR=~/path/to/race-photos
 *
 * Reads nothing but metadata, writes nothing, and uploads nothing.
 */

import { open, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Reader } from '../src/core/bytes.ts';
import { parseJpegExif, parseTiffExif } from '../src/core/exif.ts';
import {
  exifFromHeicItem,
  isHeic,
  locateBox,
  locateHeicExif,
  parseVideoMeta,
  type RangeReader,
} from '../src/core/isobmff.ts';
import {
  classify,
  hasExifContainer,
  hasIsobmffContainer,
  photoMetadata,
  videoMetadata,
  type ExtractedMetadata,
} from '../src/core/metadata.ts';
import type { TimeSource } from '../src/core/schema.ts';

/** See the note in src/viewer/media/extract.ts: EXIF cannot exceed ~64KB. */
const JPEG_HEAD_BYTES = 128 * 1024;
const HEIC_HEAD_BYTES = 256 * 1024;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (classify(entry.name)) out.push(full);
  }
  return out;
}

/** The viewer defaults event.timezone to the browser's zone, so naive
 * timestamps are normally resolvable. Mirror that here. */
const CTX = { hasTimezone: true };

async function inspect(path: string): Promise<ExtractedMetadata | null> {
  const kind = classify(path);
  if (!kind) return null;

  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const read: RangeReader = async (offset, length) => {
      if (offset >= size) return null;
      const want = Math.min(length, size - offset);
      const buf = new Uint8Array(want);
      const { bytesRead } = await handle.read(buf, 0, want, offset);
      return bytesRead > 0 ? buf.subarray(0, bytesRead) : null;
    };

    if (kind === 'photo') {
      if (!hasExifContainer(path) && !hasIsobmffContainer(path)) {
        return photoMetadata(null, path, CTX); // e.g. PNG: no metadata to read
      }
      const isobmff = hasIsobmffContainer(path);
      const head = await read(0, Math.min(isobmff ? HEIC_HEAD_BYTES : JPEG_HEAD_BYTES, size));
      if (!head) return photoMetadata(null, path, CTX);
      const r = new Reader(head);

      if (isobmff && isHeic(r)) {
        const at = locateHeicExif(r);
        if (!at) return photoMetadata(null, path, CTX);
        const payload = await read(at.offset, at.length);
        const tiff = payload ? exifFromHeicItem(new Reader(payload)) : null;
        return photoMetadata(tiff ? parseTiffExif(tiff) : null, path, CTX);
      }
      return photoMetadata(parseJpegExif(r), path, CTX);
    }

    if (!hasIsobmffContainer(path)) return videoMetadata(null, path, CTX);
    // `moov` is commonly at the END of a phone recording, so hop the top-level
    // headers to find it rather than reading the file body.
    const moov = await locateBox(read, size, 'moov');
    if (!moov) return videoMetadata(null, path, CTX);
    const bytes = await read(moov.offset, moov.length);
    return videoMetadata(bytes ? parseVideoMeta(new Reader(bytes)) : null, path, CTX);
  } finally {
    await handle.close();
  }
}

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/inspect-media.ts <folder>');
    process.exit(2);
  }
  if (!(await stat(dir).catch(() => null))?.isDirectory()) {
    console.error(`not a folder: ${dir}`);
    process.exit(2);
  }

  const files = (await walk(dir)).sort();
  if (files.length === 0) {
    console.error(`no photos or videos found under ${dir}`);
    process.exit(1);
  }

  const counts = new Map<TimeSource, number>();
  const unplaced: string[] = [];
  let withGps = 0;

  console.log(`${pad('file', 34)} ${pad('kind', 5)} ${pad('timeSource', 12)} ${pad('at', 26)} gps duration`);
  console.log('-'.repeat(90));

  for (const file of files) {
    const meta = await inspect(file);
    if (!meta) continue;
    counts.set(meta.timeSource, (counts.get(meta.timeSource) ?? 0) + 1);
    if (meta.gps) withGps++;
    if (meta.timeSource === 'none') unplaced.push(relative(dir, file));

    const gps = meta.gps ? `${meta.gps[0].toFixed(4)},${meta.gps[1].toFixed(4)}` : '-';
    const duration = meta.duration ? ` ${meta.duration.toFixed(1)}s` : '';
    console.log(
      `${pad(relative(dir, file), 34)} ${pad(meta.type, 5)} ${pad(meta.timeSource, 12)} ` +
        `${pad(meta.at ?? '-', 26)} ${gps}${duration}`,
    );
  }

  console.log('\n--- summary ---');
  console.log(`${files.length} files, ${withGps} with GPS`);
  for (const source of [...counts.keys()].sort()) {
    console.log(`  ${pad(source, 12)} ${counts.get(source)}`);
  }

  const none = counts.get('none') ?? 0;
  if (none > 0) {
    console.log(
      `\n${none} file(s) have no usable timestamp and would go to the unplaced tray:`,
    );
    for (const f of unplaced.slice(0, 20)) console.log(`  ${f}`);
    if (unplaced.length > 20) console.log(`  ... and ${unplaced.length - 20} more`);
  }
  if ((counts.get('mvhd') ?? 0) > 0) {
    console.log(
      `\nWARNING: ${counts.get('mvhd')} file(s) fell back to mvhd. Apple writes LOCAL\n` +
        `time there with no zone, so those may be off by the UTC offset. Check one\n` +
        `against a photo you know the time of before trusting them.`,
    );
  }
}

await main();
