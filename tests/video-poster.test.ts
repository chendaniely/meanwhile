import { describe, expect, it } from 'vitest';
import { seekToFrame, type SeekableVideo } from '../src/viewer/media/thumbnails.ts';

/**
 * THE REGRESSION THIS FILE EXISTS FOR:
 *
 * Every video thumbnail in the app started reporting "this browser cannot
 * display this file" on perfectly good clips.
 *
 * The cause is a genuine subtlety of HTMLVideoElement. Setting `currentTime`
 * updates the property IMMEDIATELY, while the seek is still in flight, and
 * Chrome drops `readyState` back to 1 in the meantime because it is
 * re-buffering at the new position. So a second ready-signal — `canplay`
 * arriving after `loadeddata` — found "already at the target" and reported on
 * a readyState that was momentarily too low.
 *
 * The fake below reproduces exactly that sequence, taken from the browser
 * trace of the failure:
 *
 *   finish=false via loadeddata,canplay rs=1 w=480
 */

interface FakeOptions {
  duration?: number;
  videoWidth?: number;
  /** Chrome drops to 1 while seeking. Set false for a browser that does not. */
  dipsWhileSeeking?: boolean;
  /** Fire `canplay` after `loadeddata`, as Chrome does. */
  emitCanplay?: boolean;
  /** Never deliver `seeked` — a codec the browser cannot actually decode. */
  neverSeeks?: boolean;
}

/** A stand-in for HTMLVideoElement that behaves the way Chrome actually does. */
function fakeVideo(options: FakeOptions = {}) {
  const {
    duration = 6,
    videoWidth = 480,
    dipsWhileSeeking = true,
    emitCanplay = true,
    neverSeeks = false,
  } = options;

  const handlers = new Map<string, Set<() => void>>();
  const video = {
    readyState: 0,
    videoWidth: 0,
    currentTime: 0,
    duration: Number.NaN,
    addEventListener(type: string, handler: () => void) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type: string, handler: () => void) {
      handlers.get(type)?.delete(handler);
    },
  } satisfies SeekableVideo;

  const emit = (type: string) => {
    for (const handler of [...(handlers.get(type) ?? [])]) handler();
  };

  // Assigning currentTime starts a seek. The property reflects the target at
  // once; the frame does not arrive until `seeked`.
  let target = 0;
  let seekWrites = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => target,
    set: (next: number) => {
      seekWrites++;
      target = next;
      if (dipsWhileSeeking) video.readyState = 1;
      if (neverSeeks) return;
      queueMicrotask(() => {
        video.readyState = 4;
        emit('seeked');
      });
    },
  });

  /** The load sequence Chrome produces for a local blob. */
  const load = () => {
    video.duration = duration;
    video.videoWidth = videoWidth;
    video.readyState = 4;
    emit('loadeddata');
    if (emitCanplay) emit('canplay');
  };

  return {
    video,
    load,
    emit,
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    /** How many times `currentTime` was WRITTEN — i.e. how many seeks were requested. */
    seekWrites: () => seekWrites,
  };
}

describe('seekToFrame', () => {
  it('succeeds when canplay follows loadeddata mid-seek', async () => {
    // The exact failure. Before the fix this resolved false, because the
    // second seek() call read readyState while the seek was still in flight.
    const { video, load } = fakeVideo();
    const result = seekToFrame(video);
    load();
    await expect(result).resolves.toBe(true);
  });

  it('seeks a little way in, not to zero', async () => {
    // The first frame of a phone recording is usually black or
    // mid-autoexposure, which makes a grid of clips look broken.
    const { video, load } = fakeVideo({ duration: 6 });
    const result = seekToFrame(video);
    load();
    await result;
    expect(video.currentTime).toBeCloseTo(0.15, 5);
  });

  it('never seeks past the middle of a very short clip', async () => {
    const { video, load } = fakeVideo({ duration: 0.2 });
    const result = seekToFrame(video);
    load();
    await result;
    expect(video.currentTime).toBeCloseTo(0.1, 5);
  });

  it('only ever requests one seek, however many ready signals arrive', async () => {
    const { video, load, emit, seekWrites } = fakeVideo();
    const result = seekToFrame(video);
    load();
    emit('canplay');
    emit('loadeddata');
    await expect(result).resolves.toBe(true);
    // `load()` itself already fires loadeddata and canplay once each; the two
    // extra emits above must not trigger a second `currentTime` write.
    expect(seekWrites()).toBe(1);
  });

  it('gives up on a clip whose seek never lands', async () => {
    // A codec the browser cannot decode fires no `seeked` at all, so events
    // alone would hang forever.
    const { video, load } = fakeVideo({ neverSeeks: true });
    const result = seekToFrame(video, undefined, 20);
    load();
    await expect(result).resolves.toBe(false);
  });

  it('reports failure on an error event', async () => {
    const { video, emit } = fakeVideo();
    const result = seekToFrame(video);
    emit('error');
    await expect(result).resolves.toBe(false);
  });

  it('takes the frame as-is when there is no duration to seek within', async () => {
    const { video, load } = fakeVideo({ duration: Number.NaN });
    const result = seekToFrame(video);
    load();
    await expect(result).resolves.toBe(true);
  });

  it('detaches every listener when it finishes', async () => {
    // Left-behind listeners on a detached <video> keep it alive, and there is
    // one of these per clip.
    const { video, load, listenerCount } = fakeVideo();
    const result = seekToFrame(video);
    load();
    await result;
    expect(listenerCount()).toBe(0);
  });

  it('prefers the duration it was given over the one on the element', async () => {
    // The container's own duration can be wrong or missing; the manifest's
    // came from parsing the file.
    const { video, load } = fakeVideo({ duration: 100 });
    const result = seekToFrame(video, 0.1);
    load();
    await result;
    expect(video.currentTime).toBeCloseTo(0.05, 5);
  });
});
