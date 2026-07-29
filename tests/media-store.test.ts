import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item } from '../src/core/schema.ts';

/**
 * The store's whole job is that every object URL it creates is eventually
 * revoked. Nothing else in the browser does that — not GC, not removing the
 * <img> — so a miss here is an unbounded leak that only shows up after
 * scrolling a few thousand files. Which makes it exactly the thing to assert
 * on rather than eyeball.
 */

const decodeThumbnail = vi.fn();
const decodeVideoPoster = vi.fn();

vi.mock('../src/viewer/media/thumbnails.ts', () => ({
  decodeThumbnail: (...args: unknown[]) => decodeThumbnail(...args),
  decodeVideoPoster: (...args: unknown[]) => decodeVideoPoster(...args),
}));

const { MediaStore } = await import('../src/viewer/media/store.ts');

/** Records every create/revoke so a leak is a failed assertion, not a hunch. */
let created: string[] = [];
let revoked: string[] = [];
let nextUrl = 0;

beforeEach(() => {
  created = [];
  revoked = [];
  nextUrl = 0;
  decodeThumbnail.mockReset();
  decodeVideoPoster.mockReset();

  const url = URL as unknown as {
    createObjectURL: (o: unknown) => string;
    revokeObjectURL: (u: string) => void;
  };
  url.createObjectURL = () => {
    const made = `blob:${nextUrl++}`;
    created.push(made);
    return made;
  };
  url.revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
});

afterEach(() => {
  // Anything created and never revoked is a leak.
  const leaked = created.filter((u) => !revoked.includes(u));
  expect(leaked, `object URLs never revoked: ${leaked.join(', ')}`).toEqual([]);
});

const photo = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  person: 'sam',
  type: 'photo',
  src: id,
  timeSource: 'exif-offset',
  at: '2026-07-24T12:00:00Z',
  ...over,
});

const fakeFile = (name: string) => new File([new Uint8Array(8)], name);
const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)]);

function storeOf(ids: string[], options = {}) {
  return new MediaStore(new Map(ids.map((id) => [id, fakeFile(id)])), options);
}

describe('MediaStore thumbnails', () => {
  it('decodes once and hands the same URL to a second holder', async () => {
    decodeThumbnail.mockResolvedValue(blobOf(1000));
    const store = storeOf(['a.jpg']);

    const first = await store.acquireThumbnail(photo('a.jpg'));
    const second = await store.acquireThumbnail(photo('a.jpg'));

    expect(first).toBe(second);
    expect(decodeThumbnail).toHaveBeenCalledTimes(1);

    store.release('a.jpg');
    store.release('a.jpg');
    store.dispose();
  });

  it('does not decode twice when two tiles ask at the same time', async () => {
    // Two tiles scrolling into view together must share one decode, or the
    // work doubles for every visible item.
    let settle: (b: Blob) => void = () => {};
    decodeThumbnail.mockReturnValue(new Promise<Blob>((r) => (settle = r)));
    const store = storeOf(['a.jpg']);

    const both = Promise.all([
      store.acquireThumbnail(photo('a.jpg')),
      store.acquireThumbnail(photo('a.jpg')),
    ]);
    settle(blobOf(1000));
    const [one, two] = await both;

    expect(one).toBe(two);
    expect(decodeThumbnail).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('uses the video poster path for clips', async () => {
    decodeVideoPoster.mockResolvedValue(blobOf(1000));
    const store = storeOf(['a.mp4']);

    await store.acquireThumbnail(photo('a.mp4', { type: 'video', duration: 12 }));

    expect(decodeVideoPoster).toHaveBeenCalledTimes(1);
    expect(decodeThumbnail).not.toHaveBeenCalled();
    // The clip length is passed through so the seek target stays in range.
    expect(decodeVideoPoster.mock.calls[0]?.[1]).toMatchObject({ duration: 12 });
    store.dispose();
  });

  it('returns null when the browser cannot decode the file', async () => {
    // A HEIC outside Safari. The item keeps its place on the timeline.
    decodeThumbnail.mockResolvedValue(null);
    const store = storeOf(['a.heic']);
    expect(await store.acquireThumbnail(photo('a.heic'))).toBeNull();
    store.dispose();
  });

  it('returns null for a file it was never given', async () => {
    const store = storeOf([]);
    expect(await store.acquireThumbnail(photo('missing.jpg'))).toBeNull();
    store.dispose();
  });
});

describe('MediaStore memory discipline', () => {
  it('evicts released thumbnails once over budget', async () => {
    decodeThumbnail.mockResolvedValue(blobOf(400));
    const ids = ['a', 'b', 'c', 'd'].map((n) => `${n}.jpg`);
    const store = storeOf(ids, { budgetBytes: 1000 });

    for (const id of ids) {
      await store.acquireThumbnail(photo(id));
      store.release(id);
    }

    // 4 x 400 bytes against a 1000-byte budget: the oldest must go.
    expect(revoked.length).toBeGreaterThan(0);
    expect(store.stats().bytes).toBeLessThanOrEqual(1000);
    store.dispose();
  });

  it('never evicts a thumbnail a tile is still showing', async () => {
    // Revoking under a live <img> blanks it. Held entries are off limits even
    // when that means exceeding the budget.
    decodeThumbnail.mockResolvedValue(blobOf(400));
    const ids = ['a', 'b', 'c', 'd'].map((n) => `${n}.jpg`);
    const store = storeOf(ids, { budgetBytes: 500 });

    for (const id of ids) await store.acquireThumbnail(photo(id));

    expect(revoked).toEqual([]);
    expect(store.stats().cached).toBe(4);
    store.dispose();
  });

  it('keeps a released thumbnail cached while there is room', async () => {
    // Scrolling back up should not mean decoding again.
    decodeThumbnail.mockResolvedValue(blobOf(10));
    const store = storeOf(['a.jpg']);

    await store.acquireThumbnail(photo('a.jpg'));
    store.release('a.jpg');
    await store.acquireThumbnail(photo('a.jpg'));

    expect(decodeThumbnail).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('revokes everything on dispose', async () => {
    // Loading a different folder must not strand the previous one's URLs.
    decodeThumbnail.mockResolvedValue(blobOf(10));
    const store = storeOf(['a.jpg', 'b.jpg']);
    await store.acquireThumbnail(photo('a.jpg'));
    await store.acquireThumbnail(photo('b.jpg'));
    store.acquireOriginal('a.jpg');

    expect(created.length).toBe(3);
    store.dispose();
    expect(revoked.length).toBe(3);
    expect(store.stats()).toMatchObject({ cached: 0, originals: 0, bytes: 0 });
  });
});

describe('MediaStore use after dispose', () => {
  it('throws rather than quietly returning null', async () => {
    // Returning null would be indistinguishable from "the browser cannot
    // decode this file", which is exactly how a lifecycle bug once made
    // every tile claim the photo was unreadable.
    decodeThumbnail.mockResolvedValue(blobOf(10));
    const store = storeOf(['a.jpg']);
    store.dispose();

    await expect(store.acquireThumbnail(photo('a.jpg'))).rejects.toThrow(/after dispose/);
    expect(() => store.acquireOriginal('a.jpg')).toThrow(/after dispose/);
  });
});

describe('MediaStore originals', () => {
  it('revokes as soon as the last holder lets go', async () => {
    // Unlike thumbnails these are NOT cached: one multi-gigabyte clip pinned
    // in memory is a different order of problem.
    const store = storeOf(['a.mp4']);

    const url = store.acquireOriginal('a.mp4');
    expect(url).not.toBeNull();
    expect(revoked).toEqual([]);

    store.releaseOriginal('a.mp4');
    expect(revoked).toEqual([url]);
    expect(store.stats().originals).toBe(0);
    store.dispose();
  });

  it('holds while more than one viewer wants it', async () => {
    const store = storeOf(['a.mp4']);
    const url = store.acquireOriginal('a.mp4');
    store.acquireOriginal('a.mp4');

    store.releaseOriginal('a.mp4');
    expect(revoked).toEqual([]); // still one holder

    store.releaseOriginal('a.mp4');
    expect(revoked).toEqual([url]);
    store.dispose();
  });

  it('ignores a release for something never acquired', () => {
    const store = storeOf(['a.mp4']);
    expect(() => store.releaseOriginal('a.mp4')).not.toThrow();
    expect(() => store.release('nope.jpg')).not.toThrow();
    store.dispose();
  });
});
