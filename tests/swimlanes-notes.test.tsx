// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../src/core/notes.ts';
import type { Manifest } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { INITIAL_STATE } from '../src/core/state.ts';
import type { Instant } from '../src/core/time.ts';
import type { PlacedItem, PlacedNote } from '../src/core/window.ts';
import { Swimlanes } from '../src/viewer/components/Swimlanes.tsx';

/**
 * CLAUDE.md documented, under "person is optional and does real work", that
 * a note with a `person` sits in that person's lane — which is what lets a
 * note explain a gap ("asleep at Cottonwood" captioning a six-hour hole).
 * That was never built: `Swimlanes.tsx` had no reference to notes at all
 * before this file, so a note the owner wrote never appeared in the
 * swimlanes. This covers the three shapes a note can take there — a
 * person's lane, the event-level row, and a span — plus the two things
 * that would otherwise silently duplicate or misfire: a caption (which
 * already has a mark, on its photo) and a click that should move the
 * cursor to the note's OWN time rather than the pixel clicked.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

// jsdom has no IntersectionObserver. `MediaTile` (rendered inside the moment
// strip once the strip is showing) uses one via `useInView`; a no-op stub is
// enough since none of these tests exercise lazy tile loading.
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

// 2026-07-25T15:00:00Z, well inside a 12-hour window.
const T0 = Date.UTC(2026, 6, 25, 15, 0);
const RANGE = { from: T0 - 6 * 3600_000, to: T0 + 6 * 3600_000 };

const MANIFEST: Manifest = {
  schema: SCHEMA_VERSION,
  event: { title: 'Race', timezone: 'UTC' },
  // No `role`, so `orderPeople` leaves manifest order alone: Sam first,
  // Dan second — the order the lane-lookup helper below relies on.
  people: [
    { id: 'sam', name: 'Sam' },
    { id: 'dan', name: 'Dan' },
  ],
  items: [],
};

const PLACED: PlacedItem[] = [];

function makeNote(overrides: Partial<Note> & { id: string }): Note {
  return {
    at: new Date(T0).toISOString(),
    people: [],
    author: [],
    text: 'a note',
    ...overrides,
  };
}

function place(note: Note, until?: Instant): PlacedNote {
  const instant = Date.parse(note.at);
  return until === undefined ? { note, instant } : { note, instant, until };
}

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

function mount(extra: { notes?: readonly PlacedNote[]; onCursor?: (i: Instant | null) => void } = {}) {
  act(() => {
    root.render(
      <StrictMode>
        <Swimlanes
          manifest={MANIFEST}
          placed={PLACED}
          range={RANGE}
          state={{ ...INITIAL_STATE, cursor: T0 }}
          onCursor={extra.onCursor ?? (() => {})}
          onTogglePerson={() => {}}
          notes={extra.notes ?? []}
        />
      </StrictMode>,
    );
  });
  return { container };
}

/** Person-lane rows, in `shown` order (Sam, then Dan) — the notes row, if
 * present, carries `lanes__notes-row` too and is excluded here on purpose. */
function personLanes(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('.lanes__track > .lanes__lane:not(.lanes__notes-row)'),
  );
}

describe('Swimlanes: notes appear in the lanes', () => {
  it('a note with one person renders a mark in that person’s lane and not in others’', () => {
    const note = makeNote({ id: 'n-sam', people: ['Sam'] });
    mount({ notes: [place(note)] });

    const [sam, dan] = personLanes();
    expect(sam).toBeDefined();
    expect(dan).toBeDefined();
    expect(sam!.querySelectorAll('.lanes__note')).toHaveLength(1);
    expect(dan!.querySelectorAll('.lanes__note')).toHaveLength(0);
  });

  it('a note with two people renders in both lanes', () => {
    const note = makeNote({ id: 'n-both', people: ['Sam', 'Dan'] });
    mount({ notes: [place(note)] });

    const [sam, dan] = personLanes();
    expect(sam!.querySelectorAll('.lanes__note')).toHaveLength(1);
    expect(dan!.querySelectorAll('.lanes__note')).toHaveLength(1);
  });

  it('an event-level note (empty people) renders in the notes row, not in any person lane', () => {
    const note = makeNote({ id: 'n-event', people: [] });
    mount({ notes: [place(note)] });

    const row = container.querySelector('.lanes__notes-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('.lanes__note')).toHaveLength(1);

    for (const lane of personLanes()) {
      expect(lane.querySelectorAll('.lanes__note')).toHaveLength(0);
    }
  });

  it('a note with a duration renders as a span wider than a point mark', () => {
    const point = makeNote({ id: 'n-point', people: ['Sam'] });
    const span = makeNote({ id: 'n-span', people: ['Sam'], duration: 'PT2H' });
    mount({ notes: [place(point), place(span, Date.parse(span.at) + 2 * 3600_000)] });

    const [sam] = personLanes();
    const marks = sam!.querySelectorAll<HTMLElement>('.lanes__note');
    expect(marks).toHaveLength(2);

    const pointMark = Array.from(marks).find((m) => !m.classList.contains('lanes__note--span'));
    const spanMark = Array.from(marks).find((m) => m.classList.contains('lanes__note--span'));
    expect(pointMark).toBeDefined();
    expect(spanMark).toBeDefined();

    // A point note is a fixed-size glyph with no explicit width — it relies
    // on the CSS default. A span note carries an EXPLICIT, non-zero
    // percentage width computed from its duration against the visible
    // range, which is what actually draws it as a bar rather than a dot.
    expect(pointMark!.style.width).toBe('');
    const spanWidthPercent = Number.parseFloat(spanMark!.style.width);
    expect(spanWidthPercent).toBeGreaterThan(0);
  });

  it('a caption (a note whose photo names an item) does not render as a lane mark', () => {
    const caption = makeNote({ id: 'n-caption', people: ['Sam'], photo: 'sam/one.jpg' });
    mount({ notes: [place(caption)] });

    // Not in Sam's lane, not in the event row, not anywhere — a caption
    // lives on its photo, discovered via the tile's glyph, so a lane mark
    // here would say the same thing twice.
    expect(container.querySelectorAll('.lanes__note')).toHaveLength(0);
    expect(container.querySelector('.lanes__notes-row')).toBeNull();
  });

  it('draws no notes row when there are no notes at all', () => {
    mount({ notes: [] });
    expect(container.querySelector('.lanes__notes-row')).toBeNull();
  });

  it('clicking a note mark moves the shared cursor to the note’s own time', () => {
    const onCursor = vi.fn();
    // Deliberately NOT exactly on state.cursor (T0), so a click that used
    // the CLICKED PIXEL instead of the note's own `instant` would be caught.
    const note = makeNote({ id: 'n-click', people: ['Sam'], at: new Date(T0 + 3600_000).toISOString() });
    mount({ notes: [place(note)], onCursor });

    const button = container.querySelector('.lanes__note');
    if (!(button instanceof HTMLButtonElement)) throw new Error('note mark not found');

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onCursor).toHaveBeenCalledWith(Date.parse(note.at));
  });
});
