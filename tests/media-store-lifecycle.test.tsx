// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '../src/core/schema.ts';
import type { MediaStore } from '../src/viewer/media/store.ts';
import { useMediaStore } from '../src/viewer/media/useMediaStore.ts';

/**
 * THE REGRESSION THIS FILE EXISTS FOR:
 *
 * Every tile in the app once read "this browser cannot display this file" —
 * on perfectly good photos. The store was being disposed the moment it was
 * created, so every request returned null, and the UI rendered that null as
 * an unreadable file.
 *
 * It could only happen under React's StrictMode, which double-invokes effects
 * and memo factories in development to surface exactly this kind of mistake.
 * No amount of unit-testing MediaStore in isolation would have caught it: the
 * store was fine, its lifecycle was not. So this test renders for real, under
 * StrictMode, and asserts the store the app hands out is actually usable.
 */

// Without this React does not flush effects synchronously inside act(), and
// the assertions below would race the very lifecycle they are checking.
(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const item: Item = {
  id: 'a.jpg',
  person: 'sam',
  type: 'photo',
  src: 'a.jpg',
  timeSource: 'exif-offset',
  at: '2026-07-24T12:00:00Z',
};

const filesOf = (names: string[]) =>
  new Map(names.map((n) => [n, new File([new Uint8Array(4)], n)]));

let container: HTMLDivElement;
let root: Root;
let revoked: string[];

beforeEach(() => {
  revoked = [];
  // jsdom implements neither of these.
  const url = URL as unknown as {
    createObjectURL: (o: unknown) => string;
    revokeObjectURL: (u: string) => void;
  };
  let n = 0;
  url.createObjectURL = () => `blob:${n++}`;
  url.revokeObjectURL = (u) => revoked.push(u);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Renders the hook and reports the store it produced. */
function mount(files: ReadonlyMap<string, File> | null, onStore: (s: MediaStore | null) => void) {
  function Probe({ files: given }: { files: ReadonlyMap<string, File> | null }) {
    const store = useMediaStore(given);
    useEffect(() => {
      onStore(store);
    }, [store]);
    return null;
  }
  act(() => {
    root.render(
      <StrictMode>
        <Probe files={files} />
      </StrictMode>,
    );
  });
}

describe('useMediaStore under StrictMode', () => {
  it('hands out a store that actually works', () => {
    // The exact failure: the store existed but was already disposed, so every
    // request came back null and every tile claimed the photo was unreadable.
    let store: MediaStore | null = null;
    mount(filesOf(['a.jpg']), (s) => (store = s));

    expect(store).not.toBeNull();
    const usable = store as unknown as MediaStore;
    expect(() => usable.acquireOriginal('a.jpg')).not.toThrow();
    expect(usable.acquireOriginal('a.jpg')).toMatch(/^blob:/);
  });

  it('does not dispose the store it just created', async () => {
    let store: MediaStore | null = null;
    mount(filesOf(['a.jpg']), (s) => (store = s));

    const usable = store as unknown as MediaStore;
    // acquireThumbnail throws on a disposed store, which is the signal the
    // app was silently swallowing before.
    await expect(usable.acquireThumbnail(item)).resolves.not.toThrow();
  });

  it('disposes the old store when the file set changes', () => {
    let store: MediaStore | null = null;
    mount(filesOf(['a.jpg']), (s) => (store = s));
    const first = store as unknown as MediaStore;
    first.acquireOriginal('a.jpg');

    mount(filesOf(['b.jpg']), (s) => (store = s));
    const second = store as unknown as MediaStore;

    // The outgoing store is torn down — otherwise every object URL from the
    // previous folder leaks, since nothing else revokes them.
    expect(() => first.acquireOriginal('a.jpg')).toThrow(/after dispose/);
    expect(second).not.toBe(first);
    expect(() => second.acquireOriginal('b.jpg')).not.toThrow();
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('disposes on unmount', () => {
    let store: MediaStore | null = null;
    mount(filesOf(['a.jpg']), (s) => (store = s));
    const made = store as unknown as MediaStore;
    made.acquireOriginal('a.jpg');

    act(() => root.render(<StrictMode />));

    expect(() => made.acquireOriginal('a.jpg')).toThrow(/after dispose/);
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('gives no store when there are no files', () => {
    let store: MediaStore | null = null;
    mount(null, (s) => (store = s));
    expect(store).toBeNull();
  });
});
