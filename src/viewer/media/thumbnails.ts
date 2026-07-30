/**
 * Turning a File into something small enough to put on screen.
 *
 * THE NUMBER THAT DRIVES THIS FILE: a 12-megapixel photo decodes to about
 * **48MB** of RGBA in memory, whatever its file size on disk. Fifty of them
 * in a grid is 2.4GB and a dead tab. So nothing is ever handed to an <img>
 * at full size — every image is decoded DOWNSCALED, off the main thread, and
 * the full-size bitmap is closed the moment it has been drawn.
 *
 * Everything here returns null rather than throwing. A file the browser
 * cannot decode — a HEIC outside Safari, most obviously — should cost one
 * placeholder tile, not the whole grid.
 */

export interface ThumbnailOptions {
  /**
   * Width, in CSS pixels before device scaling — passed straight through to
   * `createImageBitmap` as `resizeWidth`, which bounds WIDTH only. Height is
   * not separately capped; it scales to preserve aspect ratio, so a
   * portrait photo's long edge (its height) can exceed `maxWidth`. Not
   * "longest edge" despite an earlier version of this comment saying so.
   */
  maxWidth: number;
  /** Natural width from EXIF, when known, to avoid upscaling small images. */
  naturalWidth?: number;
  quality?: number;
}

/**
 * Decode an image at a fraction of its real size.
 *
 * `createImageBitmap` does the resize during decode on a worker thread, so
 * the full-size buffer never exists on the main thread at all. That is the
 * whole reason to use it rather than an <img> plus a canvas.
 */
export async function decodeThumbnail(
  file: Blob,
  options: ThumbnailOptions,
): Promise<Blob | null> {
  const { maxWidth, naturalWidth, quality = 0.82 } = options;

  let bitmap: ImageBitmap;
  try {
    // Upscaling a small photo would waste memory for no visible gain, so the
    // resize is only requested when the source is known to be bigger — or
    // when its size is unknown and guessing down is the safer bet.
    const resize = naturalWidth !== undefined && naturalWidth <= maxWidth ? {} : { resizeWidth: maxWidth };
    bitmap = await createImageBitmap(file, {
      ...resize,
      resizeQuality: 'high',
      // Applies the EXIF rotation during decode, so portrait photos are not
      // silently laid on their side.
      imageOrientation: 'from-image',
    });
  } catch {
    return null; // undecodable in this browser; the caller shows a placeholder
  }

  try {
    return await bitmapToBlob(bitmap, quality);
  } finally {
    // Without this the decoded buffer lives until GC gets round to it, which
    // at 2,000 files is far too late.
    bitmap.close();
  }
}

async function bitmapToBlob(bitmap: ImageBitmap, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

export interface PosterOptions extends ThumbnailOptions {
  /** Clip length in seconds, if known, so the seek target stays in range. */
  duration?: number;
}

/**
 * Grab a still from a video to use as its tile.
 *
 * Seeks slightly into the clip rather than to zero: the first frame of a
 * phone recording is very often black or mid-autoexposure, which makes a
 * grid of clips look broken.
 */
export async function decodeVideoPoster(
  file: Blob,
  options: PosterOptions,
): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // 'auto', not 'metadata'. With 'metadata' the browser is entitled to stop
  // before it has a decoded frame, so `loadeddata` may never fire and the
  // poster times out into a false "cannot display this file". The source is a
  // local blob, so there is no bandwidth argument for holding back.
  video.preload = 'auto';
  video.src = url;

  try {
    const frame = await seekToFrame(video, options.duration);
    if (!frame) return null;

    const scale = Math.min(1, options.maxWidth / (video.videoWidth || options.maxWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    return await new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', options.quality ?? 0.82);
    });
  } catch {
    return null;
  } finally {
    // Order matters: detach the source before revoking, or the element may
    // keep the blob alive and hold the file handle open.
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** The bit of `HTMLVideoElement` this needs, so a test can stand in for one. */
export interface SeekableVideo {
  readyState: number;
  videoWidth: number;
  currentTime: number;
  duration: number;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

/**
 * Resolves once a frame is actually painted, or false if it never arrives.
 *
 * ONCE A SEEK HAS BEEN REQUESTED, ONLY `seeked` MAY REPORT SUCCESS. This is
 * the whole subtlety, and getting it wrong broke every video thumbnail:
 *
 *   Setting `currentTime` updates the property IMMEDIATELY, while the seek
 *   itself is still in flight — and Chrome drops `readyState` back to 1 in
 *   the meantime, because it is re-buffering at the new position. So a
 *   second ready-signal (`canplay` arriving after `loadeddata`) would find
 *   "we are already at the target" and report on a readyState that was
 *   momentarily too low. Result: `finish=false ... rs=1`, and a perfectly
 *   good clip labelled unplayable.
 *
 * Several ready signals are still listened for, because which one arrives
 * first varies by container and browser; they just cannot conclude anything
 * once a seek is under way. A codec the browser truly cannot handle never
 * fires `seeked` at all, which is what the deadline is for.
 */
export function seekToFrame(video: SeekableVideo, duration?: number, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let seekRequested = false;
    const timer = setTimeout(() => finish(false), timeoutMs);

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [event, handler] of listeners) video.removeEventListener(event, handler);
      resolve(ok);
    };

    // HAVE_CURRENT_DATA or better means there is something on the frame.
    const readyToDraw = () => video.readyState >= 2 && video.videoWidth > 0;

    const seek = () => {
      if (settled || seekRequested) return;
      const length = duration ?? video.duration;
      // A little way in: the first frame of a phone recording is often black
      // or mid-autoexposure. Never past the halfway point of a short clip.
      const target = Number.isFinite(length) && length > 0 ? Math.min(0.15, length / 2) : 0;
      if (target <= 0) {
        finish(readyToDraw());
        return;
      }
      seekRequested = true;
      video.currentTime = target;
    };

    const listeners: Array<[string, () => void]> = [
      ['loadeddata', seek],
      ['canplay', seek],
      ['seeked', () => finish(readyToDraw())],
      ['error', () => finish(false)],
    ];
    for (const [event, handler] of listeners) video.addEventListener(event, handler);

    // Already buffered — the events above may have fired before we attached.
    if (readyToDraw()) seek();
  });
}
