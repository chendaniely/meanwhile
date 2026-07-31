// @vitest-environment jsdom
//
// `App.tsx` transitively pulls in `CourseMap.tsx` -> `map/basemaps.ts`, which
// reads `import.meta.env`. See the same note at the top of
// `tests/app-wiring.test.tsx` for why the reference is repeated per test
// program rather than added to a production file.
/// <reference types="vite/client" />
import { StrictMode, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroupingInfo } from '../src/core/assemble.ts';
import type { Manifest, Person, PersonId } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { INITIAL_STATE } from '../src/core/state.ts';
import { App } from '../src/viewer/App.tsx';
import { IngestReport } from '../src/viewer/components/IngestReport.tsx';
import { Swimlanes } from '../src/viewer/components/Swimlanes.tsx';

/**
 * A role is what somebody WAS; `pinned` is whose lane goes on top.
 *
 * They used to be one field, and that field was a four-value enum. Executed
 * against the owner's own `people.csv` — `crew chief`, `runner`, `pacer` —
 * two of the three were refused to `undefined` and ONE Save wrote both cells
 * blank. The enum survived because `runner` was quietly doing a second job:
 * deciding which lane pinned to the top. Splitting the two is what lets a
 * role be free text safely, and it is also what makes several pinned people
 * legal, which is the wedding case the owner asked for.
 *
 * The core rules are pinned in `tests/people-csv.test.ts` and
 * `tests/assemble.test.ts`. This file covers what only the UI can show:
 *
 *   1. a free-text role is DISPLAYED (an undisplayed role is a pointless
 *      field, and displaying it is the only reason to keep it);
 *   2. the roster toggle drives `pinned`, not `role`;
 *   3. pinning a second person does not unpin the first — the exclusivity
 *      `App.tsx` used to enforce is gone, and nothing below `App` can prove
 *      that, because the handler that used to clear everyone else lives
 *      there;
 *   4. a lane label shows the role and the pin as two separate things.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

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

class NoopResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const GROUPING: GroupingInfo = { by: 'device', byFamily: 0, byProximity: 0 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
    StubIntersectionObserver;
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

function manifestWith(people: Person[]): Manifest {
  return { schema: SCHEMA_VERSION, event: { title: 'Race', timezone: 'UTC' }, people, items: [] };
}

/** Every pin toggle in the roster, in roster order. */
function pinButtons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button.report__tag')].filter(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  );
}

function roleTexts(selector: string): string[] {
  return [...container.querySelectorAll(selector)].map((el) => el.textContent ?? '');
}

describe('the ingest report shows a free-text role', () => {
  function mountReport(people: Person[]) {
    const calls: Array<{ id: PersonId; pinned: boolean }> = [];
    function Harness() {
      const [manifest, setManifest] = useState<Manifest>(() => manifestWith(people));
      return (
        <IngestReport
          manifest={manifest}
          grouping={GROUPING}
          onPinned={(id, pinned) => {
            calls.push({ id, pinned });
            setManifest((m) => ({
              ...m,
              people: m.people.map((p) => (p.id === id ? { ...p, pinned } : p)),
            }));
          }}
        />
      );
    }
    act(() => {
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
    });
    return { calls };
  }

  it('renders the role beside the name, in sentence case', () => {
    // The two strings the enum threw away, verbatim.
    mountReport([
      { id: 'p1', name: 'Ali', role: 'crew chief' },
      { id: 'p2', name: 'Sam', role: 'pacer' },
    ]);
    expect(roleTexts('.report__role')).toEqual(['Crew chief', 'Pacer']);
  });

  it('renders nothing at all for a person with no role', () => {
    mountReport([{ id: 'p1', name: 'Ali' }]);
    expect(roleTexts('.report__role')).toEqual([]);
  });

  it('does not lowercase the rest of an already-capitalised role', () => {
    mountReport([{ id: 'p1', name: 'Ali', role: 'DJI operator' }]);
    expect(roleTexts('.report__role')).toEqual(['DJI operator']);
  });

  it('the toggle reports the FLIPPED pinned state, and reflects it back', () => {
    const { calls } = mountReport([{ id: 'p1', name: 'Ali', role: 'crew chief' }]);
    const button = pinButtons()[0];
    expect(button?.getAttribute('aria-pressed')).toBe('false');

    act(() => button?.click());
    expect(calls).toEqual([{ id: 'p1', pinned: true }]);
    expect(pinButtons()[0]?.getAttribute('aria-pressed')).toBe('true');

    act(() => pinButtons()[0]?.click());
    expect(calls[1]).toEqual({ id: 'p1', pinned: false });
  });

  it('does not offer to edit the role — that is what people.csv is for', () => {
    mountReport([{ id: 'p1', name: 'Ali', role: 'crew chief' }]);
    // Exactly one text input per person: the name. A role input here would
    // be a second place to author the same field, which is the "one action,
    // one name, one control" rule this project already paid for once.
    expect(container.querySelectorAll('input[type="text"], input:not([type])')).toHaveLength(1);
  });
});

describe('a lane label shows the role and the pin as two different things', () => {
  function mountLanes(people: Person[]) {
    const t0 = Date.UTC(2026, 6, 25, 15, 0);
    act(() => {
      root.render(
        <StrictMode>
          <Swimlanes
            manifest={manifestWith(people)}
            placed={[]}
            range={{ from: t0 - 3600_000, to: t0 + 3600_000 }}
            state={{ ...INITIAL_STATE, cursor: t0 }}
            onCursor={() => {}}
            onTogglePerson={() => {}}
            notes={[]}
          />
        </StrictMode>,
      );
    });
  }

  it('shows a sentence-cased role and a "pinned" marker, not the word "runner"', () => {
    mountLanes([
      { id: 'p1', name: 'Priya', role: 'runner', pinned: true },
      { id: 'p2', name: 'Ali', role: 'crew chief' },
    ]);
    // Roster order is preserved here because Priya is already first; what
    // matters is which label each lane carries.
    expect(roleTexts('.lanes__label .lanes__role')).toEqual(['Runner', 'Crew chief']);
    // Exactly one lane is marked, and the marker names the behaviour rather
    // than a role that no longer carries any.
    expect(roleTexts('.lanes__label .report__tag')).toEqual(['pinned']);
  });

  it('marks every pinned lane, and puts them all at the top', () => {
    mountLanes([
      { id: 'guest', name: 'Guest' },
      { id: 'bride', name: 'Bride', role: 'bride', pinned: true },
      { id: 'groom', name: 'Groom', role: 'groom', pinned: true },
    ]);
    // Scoped to `.lanes__label`: `MomentStrip` renders a `.lanes__name-text`
    // per person too, one row per lane, aligned underneath.
    expect(roleTexts('.lanes__label .lanes__name-text')).toEqual(['Bride', 'Groom', 'Guest']);
    expect(roleTexts('.lanes__label .report__tag')).toEqual(['pinned', 'pinned']);
  });
});

/**
 * The one rule no component can be asked about on its own: `App.tsx`'s
 * handler used to clear every OTHER person's `runner` role when marking one,
 * because `orderPeople` could only pin a single lane. Several pinned lanes
 * are the point now, so that exclusivity had to go — and nothing below `App`
 * would notice if it came back.
 */
describe('App: pinning a second person does not unpin the first', () => {
  const PEOPLE_CSV = [
    'id,name,role,clock_offset,also_known_as,pinned,schema',
    'p1,Ali,crew chief,,,,',
    'p2,Sam,pacer,,,,',
  ].join('\n');

  async function waitFor(check: () => boolean, description: string, timeoutMs = 4000) {
    const start = Date.now();
    for (;;) {
      if (check()) return;
      if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${description}`);
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  it('leaves both pinned, and keeps both free-text roles', async () => {
    act(() => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });

    const input = container.querySelector('[data-testid="file-input"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('file input not found');
    Object.defineProperty(input, 'files', {
      value: [new File([PEOPLE_CSV], 'people.csv')],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(
      () => container.querySelector('.panel__digest') !== null,
      'App to reach the loaded stage',
    );
    await act(async () => {
      const details = container.querySelector('details.panel');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });

    // The roles the enum used to blank, straight off a real people.csv.
    expect(roleTexts('.report__role')).toEqual(['Crew chief', 'Pacer']);

    const buttons = pinButtons();
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]?.click());
    await act(async () => pinButtons()[1]?.click());

    expect(pinButtons().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    // The roles are untouched by pinning — they are different fields now.
    expect(roleTexts('.report__role')).toEqual(['Crew chief', 'Pacer']);
  });
});
