// @vitest-environment jsdom
//
// No other test imports `App.tsx`, so this is the first to transitively pull
// in `CourseMap.tsx` -> `map/basemaps.ts`, which reads `import.meta.env`.
// `tsconfig.app.json` type-checks that fine via `src/viewer/vite-env.d.ts`'s
// `/// <reference types="vite/client" />` — but that file sits under
// `src/viewer/`, which `tsconfig.node.json` (the one `tests/` compiles
// under) never includes, since nothing there imports an ambient `.d.ts`.
// Repeating the reference here pulls the same global augmentation into
// THIS program instead, with no change to any production file.
/// <reference types="vite/client" />
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/viewer/App.tsx';

/**
 * Two regressions that only exist in how `App.tsx` WIRES its components
 * together — neither is catchable by testing a component in isolation, so
 * both need `<App>` actually mounted and driven through its real file input.
 *
 * 1. `UnplacedTray`'s thumbnails could never load. The tray used to render
 *    OUTSIDE the app's only `MediaProvider`, so `useMedia()` inside its
 *    `MediaTile`s always saw the default `{ store: null }` and the tile's
 *    load effect bailed at `if (!store || !inView) return;` before ever
 *    calling the store — every unplaced file showed a path and a reason,
 *    never the picture that is the whole point of the tray (recognising an
 *    undated shot is how you decide where it belongs). Fixed by lifting
 *    `MediaProvider` to wrap the entire loaded stage.
 *
 * 2. The feed discarded a note whenever no photograph shared its time
 *    window. `App.tsx` filters `items`/`moments` by BOTH the time window and
 *    which lanes are visible, but filtered `feedNotes` by the time window
 *    ALONE — so hiding every lane empties `moments` while a note is still
 *    in range, and `Feed`'s `if (moments.length === 0)` early return
 *    swallowed it. `tests/feed-notes-only.test.tsx` covers `Feed` alone with
 *    `items={[]}`, which is NOT this bug: that test can't see the asymmetric
 *    filtering that caused it, so a refactor that made App filter notes by
 *    visibility too (bringing the vanishing note straight back) would leave
 *    that test green. Fixed by rendering the empty state only when
 *    `moments.length === 0 && notes.length === 0`.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/**
 * jsdom has neither observer, and both are reached unconditionally once a
 * folder is loaded — not just by the two code paths under test:
 *
 *   - `ResizeObserver`: App's own sticky header (`useMeasuredHeight`) uses
 *     one from the very first render, even in the empty stage, so its
 *     absence would crash the app before a single file is ever picked.
 *   - `IntersectionObserver`: every `MediaTile` (`useInView`) and `Feed`'s
 *     scroll-spy use one.
 *
 * The `IntersectionObserver` stub reports every observed element as
 * intersecting IMMEDIATELY and SYNCHRONOUSLY inside `observe()`. That is
 * load-bearing for regression 1: the tray's `MediaTile` only calls the store
 * once BOTH `store` is non-null AND `inView` is true, and a stub that never
 * fires (the no-op pattern `tests/swimlanes-escape.test.tsx` uses, which is
 * fine for what that test checks) would make the tile bail on `inView`
 * instead — proving nothing about the provider fix under test.
 *
 * `createImageBitmap` and `URL.createObjectURL` are deliberately NOT
 * stubbed. `decodeThumbnail` (`src/viewer/media/thumbnails.ts`) already
 * treats a missing/throwing `createImageBitmap` as "this browser cannot
 * decode this file" and resolves `null` from inside its own try/catch
 * rather than throwing past it, which is exactly the real behaviour a HEIC
 * outside Safari gets — so leaving it undefined in jsdom exercises a real
 * code path (the tile ends in its "undecodable" state) rather than a fake
 * one. Nothing either test does reaches a path that calls
 * `URL.createObjectURL` (that only happens once a thumbnail decodes, or a
 * video plays, or Save is clicked).
 */
class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class NoopResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
    ImmediateIntersectionObserver;
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = NoopResizeObserver;
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.location.hash = '';
});

/** Repeatedly flushes React + microtasks until `check()` is true, or throws. */
async function waitFor(check: () => boolean, description: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out: ${description}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

/**
 * Drives the real "Choose files" input the empty state renders
 * (`FilePicker`'s `data-testid="file-input"`) exactly the way a user would:
 * `.files` is read-only on a real `<input>`, so `Object.defineProperty` is
 * the standard way to fake a pick, then a bubbling `change` event reaches
 * React's listener the same way a native pick would.
 */
async function pickFiles(files: File[]): Promise<void> {
  const input = container.querySelector('[data-testid="file-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function mountApp(): void {
  act(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}

async function waitForLoaded(): Promise<void> {
  await waitFor(
    () => container.querySelector('.panel__digest') !== null,
    'App to reach the loaded stage',
  );
}

/**
 * `.callout` is not unique to `Feed`'s empty state — `IngestReport` uses the
 * same class for its own, unrelated "grouped by device, not by person"
 * notice (which our single loose file with no subfolder always triggers,
 * and has nothing to do with the bug under test). Both would match a bare
 * `container.querySelector('.callout')`, so this scopes to callouts OUTSIDE
 * the settings/report `<details className="panel">`, which is the only
 * place `IngestReport` ever renders. Still an element query, not a copy
 * assertion — just correctly scoped to the one `.callout` this test is
 * actually about.
 */
function calloutsOutsidePanel(): Element[] {
  return [...container.querySelectorAll('.callout')].filter((el) => !el.closest('.panel'));
}

describe('App: the unplaced tray can reach the media store', () => {
  it('lets an unplaced file\'s tile actually attempt a thumbnail, not sit inert', async () => {
    mountApp();

    // A photo extension with no date pattern in its name and no EXIF
    // container (see `core/metadata.ts`'s `PHOTO_EXTENSIONS`/`EXIF_EXTENSIONS`)
    // never gets a candidate timestamp at all, so it lands in the unplaced
    // tray with `timeSource: 'none'` — see CLAUDE.md's "Media with no usable
    // timestamp goes to an unplaced tray".
    await pickFiles([
      new File([new Uint8Array([1, 2, 3, 4])], 'mystery.png', { type: 'image/png' }),
    ]);
    await waitForLoaded();

    // Confirm the scenario landed the way it's supposed to before asserting
    // anything about the tray's internals.
    const digest = container.querySelector('.panel__digest');
    expect(digest?.textContent).toContain('1 unplaced');

    const toggle = container.querySelector('.unplaced__toggle');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('unplaced tray toggle not found');
    await act(async () => {
      toggle.click();
    });

    const tile = container.querySelector('.unplaced__thumb .tile');
    if (!tile) throw new Error('unplaced tray did not render a MediaTile');

    // THE ASSERTION: `MediaTile` starts in an 'idle' state that renders
    // nothing but the open button (see `MediaTile.tsx`) — that is exactly
    // what it looks like, forever, when `store` is null (the bug: the tray
    // sat outside `MediaProvider`, so `useMedia()` returned the default
    // `{ store: null }` and the tile's load effect bailed immediately,
    // before ever calling `setState('loading')`). With the provider
    // correctly wrapping the tray, and the store reached, this file cannot
    // decode in jsdom (no `createImageBitmap`) — a real HEIC-outside-Safari
    // situation, handled by `MediaTile`'s own 'undecodable' state — so the
    // tile settles there once the store has actually run it through
    // `decodeThumbnail`. Reaching 'undecodable' is the proof: it can only
    // happen after `store.acquireThumbnail` was called and resolved, which
    // requires a non-null store.
    await waitFor(
      () => tile.querySelector('.tile__undecodable') !== null,
      'the tray tile to reach the store and settle on "undecodable"',
    );

    const kind = tile.querySelector('.tile__undecodable-kind');
    expect(kind?.textContent).toBe('PNG');
  });
});

describe('App: a note survives every lane being hidden', () => {
  it('keeps the note visible in the feed once every lane is toggled off', async () => {
    mountApp();

    // One photo with a filename-encoded timestamp (no real EXIF needed —
    // `.png` skips EXIF parsing entirely, see `core/metadata.ts`), so there
    // is a real placed item and the feed/lanes tabs exist at all.
    const photo = new File([new Uint8Array([1, 2, 3, 4])], 'IMG_20260725_150000.png', {
      type: 'image/png',
    });
    // A notes.csv row, in the five-integer shape `core/notes.ts` writes and
    // reads — `tz=UTC` makes the note's instant independent of whatever
    // timezone `guessTimezone()` picks in this environment. Its time has no
    // relationship to the photo's on purpose: `windowIncludingNotes`
    // (`core/window.ts`) widens the computed default window to cover every
    // note regardless of how far it falls from the photo cluster, so this
    // note is guaranteed to be in range without depending on the two
    // matching.
    const notesCsv = [
      'id,year,month,day,hour,minute,duration,tz,people,photo,author,text',
      'note1,2026,7,25,15,5,,UTC,,,,Asleep at Cottonwood.',
    ].join('\n');
    const notes = new File([notesCsv], 'notes.csv', { type: 'text/csv' });

    await pickFiles([photo, notes]);
    await waitForLoaded();

    const digest = container.querySelector('.panel__digest');
    expect(digest?.textContent).toContain('1 placed');
    expect(digest?.textContent).toContain('1 note');

    // Sanity check the starting state: with the lane visible, both the
    // photo's moment and the note render in the feed.
    await waitFor(() => container.querySelector('.feed .moment') !== null, 'the photo to appear in the feed');
    expect(container.querySelector('.feed__note')).not.toBeNull();

    // Hide every lane. `AppState.visible` is mirrored straight into the URL
    // (`who=`), and an EXPLICIT empty `who=` is "every lane hidden" — see
    // `core/state.ts`'s `fromHash`. This sets the exact same `view.visible`
    // Swimlanes' own per-person toggle buttons would, without needing to
    // switch to the lanes view first — and it is a real path a user can
    // reach this from too, since a shared link can carry `who=`.
    await act(async () => {
      window.location.hash = 'who=';
      window.dispatchEvent(new Event('hashchange'));
    });

    await waitFor(
      () => container.querySelector('.feed .moment') === null,
      'the photo\'s moment to disappear once its lane is hidden',
    );

    // THE ASSERTION: the note is still there, and the empty-state callout
    // — which is what used to show instead, per the regression — is not.
    // Queried by element, not by copy: the empty-state wording has already
    // been rewritten twice (see CLAUDE.md), and a text assertion rots.
    const note = container.querySelector('.feed__note');
    expect(note).not.toBeNull();
    expect(note?.querySelector('.feed__note-text')?.textContent).toBe('Asleep at Cottonwood.');
    expect(calloutsOutsidePanel()).toHaveLength(0);
  });
});
