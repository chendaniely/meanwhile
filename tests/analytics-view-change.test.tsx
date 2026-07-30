// @vitest-environment jsdom
//
// Pulls in `App.tsx`, which transitively imports `CourseMap.tsx` ->
// `map/basemaps.ts`, which reads `import.meta.env`. See the identical
// comment in `tests/app-wiring.test.tsx` for why this reference is needed:
// `tsconfig.node.json` (what `tests/` compiles under) never includes
// `src/viewer/vite-env.d.ts`, so its ambient `ImportMetaEnv` augmentation
// has to be pulled in explicitly here too.
/// <reference types="vite/client" />
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/viewer/App.tsx';

/**
 * The seam under test is the `useEffect(() => trackView(view.view), [view.view])`
 * wired into `App.tsx` right after `useAppState()`. The property that
 * matters — and the one a careless refactor (depending on the whole `view`
 * object instead of `view.view`) would break silently — is that this fires
 * when the VIEW changes and does not fire when only the cursor changes,
 * even though both live on the same `AppState` object and both are mirrored
 * into the same URL hash. Driven entirely through `window.location.hash` +
 * `hashchange`, the same mechanism `tests/app-wiring.test.tsx` already uses
 * to exercise `useAppState`'s back-button/hand-edited-URL path — no folder
 * needs to be opened, since the effect depends only on `view.view`, which
 * `useAppState` seeds from the hash before any media exists.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// Same stubs as `tests/app-wiring.test.tsx`: `useMeasuredHeight`'s
// `ResizeObserver` runs from the very first render, even in the empty stage,
// so its absence crashes the app before this test gets anywhere near the
// effect under test.
class NoopResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let container: HTMLDivElement;
let root: Root;
let gtag: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = NoopResizeObserver;
  (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] = NoopIntersectionObserver;
  gtag = vi.fn();
  (window as unknown as { gtag?: unknown }).gtag = gtag;
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.location.hash = '';
  delete (window as unknown as { gtag?: unknown }).gtag;
});

function viewChangeCalls(): unknown[] {
  return gtag.mock.calls.filter(([, name]) => name === 'view_change').map(([, , payload]) => payload);
}

function setHash(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event('hashchange'));
  });
}

describe('App: analytics fires on a view change, not on a cursor change', () => {
  it('reports the initial view once settled, then nothing for a cursor-only hash change', () => {
    act(() => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });

    // The initial mount reports the starting view ('feed', the default —
    // see `core/state.ts#INITIAL_STATE` — since the hash was reset to empty
    // above). StrictMode's dev-only double-invoke of a fresh effect can
    // duplicate this specific call, so assert on the LAST call rather than
    // the count, then clear the mock before the real assertions.
    expect(viewChangeCalls().at(-1)).toEqual({ view: 'feed' });
    gtag.mockClear();

    // A cursor-only change: `t=` moves, `view=` is absent so it stays at
    // its default ('feed'). This is exactly what continuous scrubbing does
    // to the hash via `useAppState`'s `replaceState`, and it must not fire
    // `trackView` at all.
    setHash('t=2026-08-22T13%3A00%3A00Z');
    expect(gtag).not.toHaveBeenCalled();

    // Move the cursor again, still with no view change.
    setHash('t=2026-08-22T14%3A30%3A00Z');
    expect(gtag).not.toHaveBeenCalled();
  });

  it('fires exactly once per genuine view change, carrying only the view name', () => {
    act(() => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    gtag.mockClear();

    // The empty stage has no placed media and no course, so `available` is
    // empty and App's own view-reconciliation effect (`useEffect` guarded by
    // `if (available.length === 0) return;`) never overrides a view picked
    // via the hash — this is the same property `tests/app-wiring.test.tsx`
    // relies on when it sets `who=` without first loading a folder.
    setHash('view=course&t=2026-08-22T13%3A00%3A00Z');
    expect(viewChangeCalls()).toEqual([{ view: 'course' }]);
    gtag.mockClear();

    // A cursor-only change while parked on 'course': still nothing.
    setHash('view=course&t=2026-08-22T15%3A00%3A00Z');
    expect(gtag).not.toHaveBeenCalled();

    // Back to 'lanes': one more, and only one more.
    setHash('view=lanes&t=2026-08-22T15%3A00%3A00Z');
    expect(viewChangeCalls()).toEqual([{ view: 'lanes' }]);
  });
});
