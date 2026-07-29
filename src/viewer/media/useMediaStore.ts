import { useEffect, useState } from 'react';
import { MediaStore } from './store.ts';

/**
 * One MediaStore per set of files, created and disposed together.
 *
 * Extracted from `App` so its lifecycle can be tested directly, because this
 * is where the app's worst user-visible bug lived: every tile reporting
 * "this browser cannot display this file", because the store had been
 * disposed the instant it was created.
 *
 * BOTH HALVES MUST LIVE IN THE SAME EFFECT. Two other shapes were tried and
 * both broke under React's StrictMode, which deliberately double-invokes
 * things in development to surface exactly this:
 *
 *   1. Create in `useMemo`, dispose in an effect cleanup — StrictMode runs
 *      effect cleanups on mount, disposing the store just created.
 *   2. Create in `useMemo`, and dispose the previous store inside the same
 *      factory — StrictMode double-invokes memo factories, so the second
 *      invocation disposed what the first had made.
 *
 * Keyed on `files`, create and dispose are guaranteed to act on the same
 * instance, whatever order React runs them in.
 *
 * See tests/media-store-lifecycle.test.tsx.
 */
export function useMediaStore(files: ReadonlyMap<string, File> | null): MediaStore | null {
  const [store, setStore] = useState<MediaStore | null>(null);

  useEffect(() => {
    if (!files) {
      setStore(null);
      return;
    }
    const next = new MediaStore(files);
    setStore(next);
    return () => {
      // Nothing else revokes this folder's object URLs.
      next.dispose();
      setStore(null);
    };
  }, [files]);

  return store;
}
