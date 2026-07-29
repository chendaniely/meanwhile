import { useEffect, useRef, useState } from 'react';

/**
 * Whether an element is on screen, or close enough to be worth preparing.
 *
 * The generous default margin is the point: decoding a photo takes long
 * enough that starting when it enters the viewport means scrolling past a
 * grey box. Starting a screen early means it is usually ready on arrival.
 */
export function useInView<T extends Element>(rootMargin = '600px 0px'): {
  ref: (node: T | null) => void;
  inView: boolean;
} {
  const [inView, setInView] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const node = useRef<T | null>(null);

  useEffect(() => {
    return () => observer.current?.disconnect();
  }, []);

  const ref = (next: T | null) => {
    if (node.current === next) return;
    observer.current?.disconnect();
    node.current = next;
    if (!next) return;

    observer.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setInView(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.current.observe(next);
  };

  return { ref, inView };
}
