// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Item, PersonId } from '../src/core/schema.ts';
import { Lightbox } from '../src/viewer/components/Lightbox.tsx';

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

function mount(onClose: () => void) {
  act(() => {
    root.render(
      <StrictMode>
        <Lightbox
          items={ITEMS}
          index={0}
          onIndex={() => {}}
          onClose={onClose}
          colors={new Map<PersonId, string>()}
          names={new Map<PersonId, string>()}
        />
      </StrictMode>,
    );
  });

  const backdrop = container.querySelector('.lightbox');
  const descendant = container.querySelector('.lightbox__bar');
  if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
  if (!(descendant instanceof HTMLElement)) throw new Error('descendant not found');
  return { backdrop, descendant };
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

  it('does not close when a drag starts on a descendant and is released over the backdrop', () => {
    const onClose = vi.fn();
    const { backdrop, descendant } = mount(onClose);

    // The drag: pointerdown on a descendant (the media, in the real app)...
    act(() => {
      descendant.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
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

  it('does not close on a plain click that starts and ends on a descendant', () => {
    const onClose = vi.fn();
    const { descendant } = mount(onClose);

    act(() => {
      descendant.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      descendant.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
