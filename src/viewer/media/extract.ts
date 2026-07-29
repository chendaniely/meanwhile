/**
 * Reading metadata out of a File, in the browser.
 *
 * This is the layer core cannot have: it turns a File into bytes. Everything
 * it does with those bytes lives in `src/core/`, so a future ingest CLI gets
 * identical results by swapping only this file.
 *
 * Nothing here reads a whole file. A 4GB clip would blow the tab up, and it
 * is unnecessary — metadata lives in a few kilobytes, the trick is knowing
 * where.
 */

import { Reader } from '../../core/bytes.ts';
import { parseJpegExif, parseTiffExif } from '../../core/exif.ts';
import { findHeicExif, isHeic, locateBox, parseVideoMeta } from '../../core/isobmff.ts';
import type { RangeReader } from '../../core/isobmff.ts';
import {
  classify,
  hasExifContainer,
  hasIsobmffContainer,
  photoMetadata,
  videoMetadata,
  type ExtractedMetadata,
  type ResolveContext,
} from '../../core/metadata.ts';

/**
 * Enough for any EXIF block and for the `meta` box at the head of a HEIC.
 * `File.slice()` is lazy, so this reads 4MB at most, not the whole file.
 */
const HEAD_BYTES = 4 * 1024 * 1024;

function rangeReaderFor(file: File): RangeReader {
  return async (offset, length) => {
    if (offset >= file.size) return null;
    const end = Math.min(offset + length, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();
    return buffer.byteLength > 0 ? new Uint8Array(buffer) : null;
  };
}

export async function extractMetadata(
  path: string,
  file: File,
  ctx: ResolveContext,
): Promise<ExtractedMetadata> {
  const kind = classify(path);
  // The caller filters by extension, so this is belt-and-braces.
  if (!kind) return { type: 'photo', timeSource: 'none' };

  const read = rangeReaderFor(file);

  if (kind === 'photo') {
    // PNG, WebP, and GIF carry no timestamp we read; fall through to the
    // filename rather than pretending to parse them.
    if (!hasExifContainer(path) && !hasIsobmffContainer(path)) {
      return photoMetadata(null, path, ctx);
    }
    const head = await read(0, Math.min(HEAD_BYTES, file.size));
    if (!head) return photoMetadata(null, path, ctx);
    const r = new Reader(head);

    if (hasIsobmffContainer(path) && isHeic(r)) {
      const tiff = findHeicExif(r);
      return photoMetadata(tiff ? parseTiffExif(tiff) : null, path, ctx);
    }
    return photoMetadata(parseJpegExif(r), path, ctx);
  }

  if (!hasIsobmffContainer(path)) return videoMetadata(null, path, ctx);

  // `moov` is commonly at the END of a phone recording, since its size is not
  // known until recording stops. Hop the top-level box headers to find it —
  // usually about three 16-byte reads even on a multi-gigabyte file.
  const moov = await locateBox(read, file.size, 'moov');
  if (!moov) return videoMetadata(null, path, ctx);
  const bytes = await read(moov.offset, moov.length);
  return videoMetadata(bytes ? parseVideoMeta(new Reader(bytes)) : null, path, ctx);
}
