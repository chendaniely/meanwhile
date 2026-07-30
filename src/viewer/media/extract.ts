/**
 * Reading metadata out of a File, in the browser.
 *
 * This is the layer core cannot have: it turns a File into bytes. Everything
 * it does with those bytes lives in `src/core/`, so a future ingest CLI gets
 * identical results by swapping only this file.
 *
 * Nothing here reads a whole file. A 4GB clip would blow the tab up, and it
 * is unnecessary — metadata sits in a small, findable head, and the trick is
 * knowing where. In practice that is a 128KB head for JPEG, 256KB plus the
 * exact EXIF extent for HEIC, and for video a box-header walk to `moov`:
 * ~115KB per file on average, 1.3% of a real 2GB folder.
 */

import { Reader } from '../../core/bytes.ts';
import { parseJpegExif, parseTiffExif } from '../../core/exif.ts';
import {
  exifFromHeicItem,
  isHeic,
  locateBox,
  locateHeicExif,
  parseVideoMeta,
} from '../../core/isobmff.ts';
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
 * How much of the front of a file to read.
 *
 * A JPEG's EXIF lives in an APP1 segment right after the two-byte SOI, and
 * that segment's length field is 16-bit — so EXIF cannot extend beyond about
 * 64KB no matter how large the photo. 128KB is generous.
 *
 * This used to be 4MB, which read a quarter of a 2GB folder to find a few
 * kilobytes of metadata per file. Measured on the real race folder: 518MB
 * read before this change (25.5% of the folder), 26.6MB after (1.3%).
 */
const JPEG_HEAD_BYTES = 128 * 1024;

/**
 * HEIC needs more of the head, because its `meta` box carries the item table
 * rather than the data. The EXIF payload itself is fetched separately, at
 * whatever offset `iloc` gives.
 */
const HEIC_HEAD_BYTES = 256 * 1024;

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
    const isobmff = hasIsobmffContainer(path);
    const headSize = Math.min(isobmff ? HEIC_HEAD_BYTES : JPEG_HEAD_BYTES, file.size);
    const head = await read(0, headSize);
    if (!head) return photoMetadata(null, path, ctx);
    const r = new Reader(head);

    if (isobmff && isHeic(r)) {
      // Two-phase: the item table is at the head, but it can point the EXIF
      // payload anywhere in the file. Fetch exactly that range rather than
      // reading a large head and hoping it landed inside.
      const at = locateHeicExif(r);
      if (!at) return photoMetadata(null, path, ctx);
      const payload = await read(at.offset, at.length);
      const tiff = payload ? exifFromHeicItem(new Reader(payload)) : null;
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
