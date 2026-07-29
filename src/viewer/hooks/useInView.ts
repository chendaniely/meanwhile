import { useCallback, useState } from 'react';

/**
 * Whether an element is on screen, or close enough to be worth preparing.
 *
 * The generous default margin is the point: decoding a photo takes long
 * enough that starting when it enters the viewport means scrolling past a
 * grey box. Starting a screen early means it is usually ready on arrival.
 *
 * THE OBSERVER IS CREATED AND TORN DOWN BY THE REF CALLBACK, deliberately.
 * The obvious alternative — observe in the ref, disconnect in a `useEffect`
 * with an empty dependency array — is broken, and broken in a way that only
 * shows up sometimes. StrictMode runs every effect mount / unmount / mount,
 * so that cleanup disconnects the observer immediately after the element is
 * attached, and the empty effect body has nothing to re-observe with. The
 * element then never reports as visible and its picture never loads.
 *
 * React 19 lets a ref callback return its own cleanup, which is exactly this
 * job: attach observes, detach disconnects, and the two cannot drift apart.
 * `useCallback` keeps the ref identity stable so React does not detach and
 * reattach on every render.
 */
export function useInView<T extends Element>(rootMargin = '600px 0px'): {
  ref: (node: T | null) => (() => void) | undefined;
  inView: boolean;
} {
  const [inView, setInView] = useState(false);

  const ref = useCallback(
    (node: T | null) => {
      if (!node) return undefined;
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) setInView(entry.isIntersecting);
        },
        { rootMargin },
      );
      observer.observe(node);
      return () => {
        observer.disconnect();
        setInView(false);
      };
    },
    [rootMargin],
  );

  return { ref, inView };
}
