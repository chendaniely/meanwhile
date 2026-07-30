// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMeasuredHeight } from '../src/viewer/hooks/useMeasuredHeight.ts';

/**
 * `useMeasuredHeight` backs `App.tsx`'s `headerRef` and is the SECOND
 * attempt at that fix. The first published the measured height straight to
 * `--mw-header-h`, the same property `App.css` uses for `.app__header`'s own
 * `min-height` — and because `root.style.setProperty` writes an INLINE style
 * that outranks the `:root {}` rule, the header's own floor became whatever
 * it was last measured at: a self-locking ratchet where a header that once
 * wrapped at a narrow width could never shrink back. See the "THE RATCHET
 * REGRESSION" test below, which is the one that would have caught it.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// jsdom has no ResizeObserver. This stub records every instance so a test
// can trigger its callback on demand, the same shape as the
// StubIntersectionObserver in tests/swimlanes-escape.test.tsx.
class StubResizeObserver implements ResizeObserver {
  static instances: StubResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    StubResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve(target: Element) {
    this.observed = this.observed.filter((t) => t !== target);
  }

  disconnect() {
    this.disconnected = true;
  }

  // Test helper only: fire this observer's callback as if a resize happened.
  // The hook re-reads `getBoundingClientRect()` itself rather than using the
  // entries it's handed, so an empty entries array is enough to drive it.
  trigger() {
    this.callback([], this);
  }
}

let currentHeight = 0;

beforeEach(() => {
  StubResizeObserver.instances = [];
  currentHeight = 0;
  (globalThis as unknown as Record<string, unknown>)['ResizeObserver'] = StubResizeObserver;
  // jsdom does no layout, so getBoundingClientRect() always reads zero.
  // Stub it so the hook has a real number to publish.
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return {
      height: currentHeight,
      width: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
});

const PROPERTY = '--mw-header-measured';

function readProperty(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  document.documentElement.style.removeProperty('--mw-header-measured');
  document.documentElement.style.removeProperty('--mw-header-h');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.style.removeProperty('--mw-header-measured');
  document.documentElement.style.removeProperty('--mw-header-h');
});

function Harness({ property, strict }: { property: string; strict?: boolean }) {
  return strict ? (
    <StrictMode>
      <Measured property={property} />
    </StrictMode>
  ) : (
    <Measured property={property} />
  );
}

function Measured({ property }: { property: string }) {
  const ref = useMeasuredHeight(property);
  return <div ref={ref} />;
}

describe('useMeasuredHeight', () => {
  it('publishes synchronously on attach, before any observer callback fires', () => {
    currentHeight = 123;
    act(() => {
      root.render(<Harness property={PROPERTY} />);
    });

    expect(readProperty(PROPERTY)).toBe('123px');
    // Nothing has triggered the observer's callback yet — this value came
    // from the synchronous `publish()` call on attach.
    expect(StubResizeObserver.instances).toHaveLength(1);
  });

  it('re-publishes when the observer fires with a new height', () => {
    currentHeight = 100;
    act(() => {
      root.render(<Harness property={PROPERTY} />);
    });
    expect(readProperty(PROPERTY)).toBe('100px');

    currentHeight = 250;
    const observer = StubResizeObserver.instances[0];
    if (!observer) throw new Error('no observer created');
    act(() => {
      observer.trigger();
    });

    expect(readProperty(PROPERTY)).toBe('250px');
  });

  it('removes the property on detach/unmount', () => {
    currentHeight = 80;
    act(() => {
      root.render(<Harness property={PROPERTY} />);
    });
    expect(readProperty(PROPERTY)).toBe('80px');

    act(() => {
      root.unmount();
    });

    expect(readProperty(PROPERTY)).toBe('');
  });

  it('THE RATCHET REGRESSION: never writes --mw-header-h, through mount, resize, and unmount', () => {
    currentHeight = 40;
    act(() => {
      root.render(<Harness property={PROPERTY} />);
    });
    expect(readProperty('--mw-header-h')).toBe('');

    currentHeight = 400;
    const observer = StubResizeObserver.instances[0];
    if (!observer) throw new Error('no observer created');
    act(() => {
      observer.trigger();
    });
    expect(readProperty('--mw-header-h')).toBe('');

    act(() => {
      root.unmount();
    });
    expect(readProperty('--mw-header-h')).toBe('');

    // The measured property was the one actually touched.
    expect(readProperty(PROPERTY)).toBe('');
  });

  it('survives StrictMode double-invoke: mount, unmount, mount still ends with a correct, single-property publish', () => {
    currentHeight = 60;
    act(() => {
      root.render(<Harness property={PROPERTY} strict />);
    });

    expect(readProperty(PROPERTY)).toBe('60px');
    expect(readProperty('--mw-header-h')).toBe('');

    currentHeight = 90;
    const activeObservers = StubResizeObserver.instances.filter((o) => !o.disconnected);
    // Whatever StrictMode's synthetic double-invoke did internally, exactly
    // one observer should be left live and attached after settling.
    expect(activeObservers).toHaveLength(1);
    act(() => {
      activeObservers[0]!.trigger();
    });
    expect(readProperty(PROPERTY)).toBe('90px');

    act(() => {
      root.unmount();
    });
    expect(readProperty(PROPERTY)).toBe('');
  });
});
