// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item, PersonId } from '../src/core/schema.ts';
import { Lightbox } from '../src/viewer/components/Lightbox.tsx';
import { MediaProvider } from '../src/viewer/media/MediaContext.tsx';
import type { MediaStore } from '../src/viewer/media/store.ts';

/**
 * `event.target === event.currentTarget` on `click` alone is not a drift
 * guard, though the old comment in Lightbox.tsx claimed it was: a pointer
 * that goes down on `.lightbox__media` (or any descendant) and is released
 * over the backdrop resolves the resulting `click`'s `target` to their
 * common ancestor — this very `.lightbox` div — so the old check passed and
 * a drag-to-select on the photo closed the viewer. Fixed by also requiring
 * the POINTERDOWN, not just the click, to have started on the backdrop (see
 * `downOnBackdrop` in Lightbox.tsx).
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const CURSOR = Date.UTC(2026, 6, 25, 15, 0);

const ITEM: Item = {
  id: 'sam/one.jpg',
  person: 'sam' as PersonId,
  type: 'photo',
  src: 'sam/one.jpg',
  at: new Date(CURSOR).toISOString(),
  timeSource: 'exif-offset',
};

const ITEMS = [{ item: ITEM, instant: CURSOR }];

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

/**
 * `.lightbox__media` only renders once `src` is set, and `src` comes from
 * `store.acquireOriginal()` — with no provider the store is null and the
 * failed-to-decode placeholder renders instead. Since the bug was reported
 * against a drag on the PHOTOGRAPH specifically, the test needs the real
 * element rather than a stand-in, so this supplies the two store methods
 * `Lightbox` actually calls. An object URL is never created, so nothing
 * needs revoking.
 */
const STUB_STORE = {
  acquireOriginal: () => 'blob:stub',
  releaseOriginal: () => {},
} as unknown as MediaStore;

function mount(onClose: () => void) {
  act(() => {
    root.render(
      <StrictMode>
        <MediaProvider store={STUB_STORE}>
          <Lightbox
            items={ITEMS}
            index={0}
            onIndex={() => {}}
            onClose={onClose}
            colors={new Map<PersonId, string>()}
            names={new Map<PersonId, string>()}
          />
        </MediaProvider>
      </StrictMode>,
    );
  });

  const backdrop = container.querySelector('.lightbox');
  // The photograph itself — the element the reported drag started on.
  const media = container.querySelector('.lightbox__media');
  if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
  if (!(media instanceof HTMLElement)) throw new Error('media not found');
  return { backdrop, media };
}

describe('Lightbox: only a gesture that both starts and ends on the backdrop closes it', () => {
  it('closes on a plain click that starts and ends on the backdrop', () => {
    const onClose = vi.fn();
    const { backdrop } = mount(onClose);

    act(() => {
      backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when a drag starts on the photo and is released over the backdrop', () => {
    const onClose = vi.fn();
    const { backdrop, media } = mount(onClose);

    // The drag: pointerdown on the photograph, as reported...
    act(() => {
      media.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    // ...released over the backdrop. A real browser fires `click` with
    // `target` resolved to the common ancestor of the down/up elements —
    // here that IS the backdrop — so it is dispatched directly on it to
    // model that resolution precisely, since jsdom does not compute it.
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on a plain click that starts and ends on the photo', () => {
    const onClose = vi.fn();
    const { media } = mount(onClose);

    act(() => {
      media.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      media.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
