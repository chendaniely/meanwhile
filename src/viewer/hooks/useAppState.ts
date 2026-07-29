import { useCallback, useEffect, useState } from 'react';
import { fromHash, toHash, type AppState } from '../../core/state.ts';

/**
 * The app's state, mirrored into the URL.
 *
 * Any moment becomes a link you can text to someone, and the back button
 * works. Both fall out of keeping the state serializable rather than being
 * features that had to be built.
 *
 * THE URL IS WRITTEN IN AN EFFECT, not inside the state updater. Writing it
 * during an update would make the updater impure, and React deliberately
 * double-invokes those in development to catch exactly that — a lesson this
 * project has already paid for once with a screen full of photos that read
 * "cannot display this file". An effect is idempotent and runs after the
 * state has settled.
 */
export function useAppState(): [AppState, (patch: Partial<AppState>) => void] {
  const [state, setState] = useState<AppState>(() => fromHash(window.location.hash));

  // The back button, and anyone editing the address bar by hand.
  useEffect(() => {
    const onHashChange = () => setState(fromHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const hash = toHash(state);
    if (window.location.hash.replace(/^#/, '') === hash) return;
    // replaceState, not pushState: scrubbing a cursor would otherwise stack
    // up hundreds of history entries and make the back button useless.
    const url = hash ? `#${hash}` : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', url);
  }, [state]);

  const update = useCallback((patch: Partial<AppState>) => {
    setState((previous) => ({ ...previous, ...patch }));
  }, []);

  return [state, update];
}
