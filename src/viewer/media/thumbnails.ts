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
  /** Longest edge, in CSS pixels before device scaling. */
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
  video.preload = 'metadata';
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

/** Resolves once a frame is actually painted, or null if the seek never lands. */
function seekToFrame(video: HTMLVideoElement, duration?: number): Promise<boolean> {
  return new Promise((resolve) => {
    // A codec the browser cannot handle simply never fires `seeked`, so this
    // cannot rely on events alone.
    const timer = setTimeout(() => finish(false), 5000);

    const finish = (ok: boolean) => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      resolve(ok);
    };

    const onLoaded = () => {
      const length = duration ?? video.duration;
      const target = Number.isFinite(length) && length > 0 ? Math.min(0.15, length / 2) : 0;
      if (target === 0) finish(true);
      else video.currentTime = target;
    };
    const onSeeked = () => finish(true);
    const onError = () => finish(false);

    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}
