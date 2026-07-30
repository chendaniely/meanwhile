// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { INITIAL_STATE } from '../src/core/state.ts';
import { Swimlanes } from '../src/viewer/components/Swimlanes.tsx';

/**
 * `Swimlanes.tsx`'s `onKeyDown` for Escape sat on a `role="presentation"`
 * div with no `tabIndex`, so it could never receive focus and Escape could
 * never reach it — CLAUDE.md's "Escape releases it too" was aspirational,
 * not true. Fixed by moving the listener to `document`, active only while
 * pinned, the same pattern the lightbox uses for its own Escape handling.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// jsdom has no IntersectionObserver. `MediaTile` (rendered inside the moment
// strip once the strip is showing) uses one via `useInView`; a no-op stub is
// enough since this test only exercises the pin/Escape behavior, not lazy
// loading.
class StubIntersectionObserver implements IntersectionObserver {
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
(globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] = StubIntersectionObserver;

// 2026-07-25T15:00:00Z
const CURSOR = Date.UTC(2026, 6, 25, 15, 0);
const RANGE = { from: CURSOR - 3600_000, to: CURSOR + 3600_000 };

const MANIFEST: Manifest = {
  schema: SCHEMA_VERSION,
  event: { title: 'Race', timezone: 'UTC' },
  people: [{ id: 'sam', name: 'Sam' }],
  items: [
    {
      id: 'sam/one.jpg',
      person: 'sam',
      type: 'photo',
      src: 'sam/one.jpg',
      at: new Date(CURSOR).toISOString(),
      timeSource: 'exif-offset',
    },
  ],
};

const PLACED = [{ item: MANIFEST.items[0]!, instant: CURSOR }];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount() {
  act(() => {
    root.render(
      <StrictMode>
        <Swimlanes
          manifest={MANIFEST}
          placed={PLACED}
          range={RANGE}
          state={{ ...INITIAL_STATE, cursor: CURSOR }}
          onCursor={() => {}}
          onTogglePerson={() => {}}
        />
      </StrictMode>,
    );
  });

  const track = container.querySelector('.lanes__track');
  if (!(track instanceof HTMLElement)) throw new Error('track not found');
  return { track };
}

function lockButton(): HTMLButtonElement {
  const button = container.querySelector('.moment-strip__lock');
  if (!(button instanceof HTMLButtonElement)) throw new Error('lock chip not found');
  return button;
}

describe('Swimlanes: Escape releases a pinned moment strip', () => {
  it('pins on click and releases on document-level Escape', () => {
    const { track } = mount();

    // Click pins the strip: a toggle, same gesture as releasing it.
    act(() => {
      track.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 10 }),
      );
    });
    expect(lockButton().getAttribute('aria-pressed')).toBe('true');
    expect(lockButton().textContent).toBe('pinned');

    // The div has no tabIndex and can never hold focus, so a handler on it
    // is unreachable — Escape must be caught globally instead.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(lockButton().getAttribute('aria-pressed')).toBe('false');
    expect(lockButton().textContent).toBe('following');
  });

  it('does not listen for Escape while not pinned', () => {
    mount();
    // No lock chip is rendered before the cursor produces an `at`... but the
    // cursor is pre-set here, so the strip is already visible and unpinned.
    expect(lockButton().getAttribute('aria-pressed')).toBe('false');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Still unpinned; nothing to release, and nothing should throw.
    expect(lockButton().getAttribute('aria-pressed')).toBe('false');
  });
});
