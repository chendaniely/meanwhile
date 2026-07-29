import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { MediaStore } from './store.ts';

/**
 * The media store, reachable from any tile without threading it through
 * every view.
 *
 * It used to also track which clip was playing, because a grid of videos all
 * starting at once is unusable. The lightbox made that unnecessary: playback
 * only happens there, and there is only ever one of it. Enforcing an
 * invariant by construction beats enforcing it with state.
 */

interface MediaContextValue {
  store: MediaStore | null;
}

const MediaContext = createContext<MediaContextValue>({ store: null });

export function MediaProvider({ store, children }: { store: MediaStore | null; children: ReactNode }) {
  const value = useMemo(() => ({ store }), [store]);
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

export function useMedia(): MediaContextValue {
  return useContext(MediaContext);
}
