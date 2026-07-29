import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MediaStore } from './store.ts';

/**
 * The media store, plus whichever clip is playing.
 *
 * Playback is tracked centrally for one reason: **only one video plays at a
 * time.** A grid of clips that all start together is unusable, and on a phone
 * it is a good way to run out of decoders.
 */

interface MediaContextValue {
  store: MediaStore | null;
  playingId: string | null;
  setPlayingId: (id: string | null) => void;
}

const MediaContext = createContext<MediaContextValue>({
  store: null,
  playingId: null,
  setPlayingId: () => {},
});

export function MediaProvider({ store, children }: { store: MediaStore | null; children: ReactNode }) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const value = useMemo(() => ({ store, playingId, setPlayingId }), [store, playingId]);
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

export function useMedia(): MediaContextValue {
  return useContext(MediaContext);
}
