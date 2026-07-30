import { useCallback } from 'react';

/**
 * Measures a rendered element's height with a `ResizeObserver` and publishes
 * it to a CSS custom property on `document.documentElement`, live, for the
 * element's whole mounted lifetime.
 *
 * Extracted from `App` (where it backed `--mw-header-measured` for the
 * sticky header) so its lifecycle can be tested directly — the same
 * precedent as `useMediaStore`, whose own header explains why: this is
 * exactly the kind of thing that looks right, runs fine by eye, and still
 * hides a real bug in its mount/unmount order.
 *
 * PUBLISHES ONLY TO THE PROPERTY NAME PASSED IN — never to `--mw-header-h`.
 * That distinction is not incidental, it is the whole reason this hook
 * exists in its current form. The first attempt at the header measurement
 * published straight to `--mw-header-h`, which `App.css` also uses for
 * `.app__header`'s own `min-height`. `root.style.setProperty` writes an
 * INLINE style on `<html>`, which outranks the `:root {}` rule for every
 * consumer of that custom property — so the header's floor became whatever
 * it was last measured at. Measure wide (say, wrapped to two rows at a
 * narrow viewport) and the header can never report shorter again: the
 * `min-height` pins the rendered height at the old measurement, and the
 * `ResizeObserver` just reads back the number it wrote. A self-locking
 * ratchet. Publishing to a caller-supplied, separate property keeps a
 * static floor (if the caller's CSS has one) forever a true floor, and only
 * whoever actually reads the live property sees the measured value.
 *
 * PUBLISHES SYNCHRONOUSLY ON ATTACH, before the observer has ever fired —
 * `ResizeObserver` only calls back on a *change*, and the first paint needs
 * the real number too, not just the CSS fallback.
 *
 * THE OBSERVER IS CREATED AND TORN DOWN BY THE REF CALLBACK, per
 * `useInView.ts` (see its comment for why): disconnecting from a bare
 * `useEffect(..., [])` cleanup fires on StrictMode's synthetic
 * mount/unmount/mount and leaves nothing left to re-observe with.
 */
export function useMeasuredHeight(
  property: string,
): (node: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (node: HTMLElement | null) => {
      if (!node) return undefined;
      const root = document.documentElement;
      const publish = () => {
        root.style.setProperty(property, `${node.getBoundingClientRect().height}px`);
      };
      const observer = new ResizeObserver(publish);
      observer.observe(node);
      publish();
      return () => {
        observer.disconnect();
        root.style.removeProperty(property);
      };
    },
    [property],
  );
}
