// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '../src/core/notes.ts';
import type { Manifest } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { INITIAL_STATE } from '../src/core/state.ts';
import type { Instant } from '../src/core/time.ts';
import type { PlacedItem, PlacedNote } from '../src/core/window.ts';
import { Swimlanes } from '../src/viewer/components/Swimlanes.tsx';

/**
 * Item 6 of the 2026-07-30 rename-corruption review: `Swimlanes.tsx` used to
 * take only `.ids` from `resolvePersonNames`, so a note naming someone who
 * no longer resolves — a hand-deleted `also_known_as` alias is the real-world
 * case, but a typo does it too — silently dropped that half of who the note
 * was about with no output anywhere in the lanes. A fully-unresolved note
 * already landed in the event-level row (its `.ids` list is empty, same as a
 * note with no `people` at all); the bug was the PARTIAL case, where a note
 * naming one resolvable person and one unresolvable one rendered ONLY in the
 * resolved person's lane, and the unresolved name simply vanished. Fixed by
 * also drawing such a note in the event-level row, so the mention is never
 * completely invisible.
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
(globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] = StubIntersectionObserver;

const T0 = Date.UTC(2026, 6, 25, 15, 0);
const RANGE = { from: T0 - 6 * 3600_000, to: T0 + 6 * 3600_000 };

const MANIFEST: Manifest = {
  schema: SCHEMA_VERSION,
  event: { title: 'Race', timezone: 'UTC' },
  people: [{ id: 'sam', name: 'Sam' }],
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

function place(note: Note): PlacedNote {
  return { note, instant: Date.parse(note.at) };
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

function mount(notes: readonly PlacedNote[]) {
  act(() => {
    root.render(
      <StrictMode>
        <Swimlanes
          manifest={MANIFEST}
          placed={PLACED}
          range={RANGE}
          state={{ ...INITIAL_STATE, cursor: T0 as Instant }}
          onCursor={() => {}}
          onTogglePerson={() => {}}
          notes={notes}
        />
      </StrictMode>,
    );
  });
  return { container };
}

function personLanes(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('.lanes__track > .lanes__lane:not(.lanes__notes-row)'),
  );
}

describe('Swimlanes: a note naming someone who does not resolve', () => {
  it('a fully-unresolved note (no known name at all) renders in the event row, same as an empty people list', () => {
    const note = makeNote({ id: 'n-ghost', people: ['Ghost'] });
    mount([place(note)]);

    const row = container.querySelector('.lanes__notes-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('.lanes__note')).toHaveLength(1);
  });

  it('a PARTIALLY-resolved note (one known, one unknown name) renders in BOTH the resolved lane AND the event row', () => {
    const note = makeNote({ id: 'n-mixed', people: ['Sam', 'Ghost'] });
    mount([place(note)]);

    const [sam] = personLanes();
    expect(sam).toBeDefined();
    expect(sam!.querySelectorAll('.lanes__note')).toHaveLength(1);

    // Before the fix this row did not exist at all for a note that DID
    // resolve to a lane — "Ghost" simply had no output anywhere.
    const row = container.querySelector('.lanes__notes-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('.lanes__note')).toHaveLength(1);
  });

  it('the event-row mark for an unresolved name says so in its title, not just presence', () => {
    const note = makeNote({ id: 'n-ghost', people: ['Ghost'] });
    mount([place(note)]);

    const mark = container.querySelector('.lanes__notes-row .lanes__note');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('title')).toContain('Ghost');
  });

  it('a note where every name resolves does NOT also appear in the event row', () => {
    const note = makeNote({ id: 'n-clean', people: ['Sam'] });
    mount([place(note)]);

    expect(container.querySelector('.lanes__notes-row')).toBeNull();
    const [sam] = personLanes();
    expect(sam!.querySelectorAll('.lanes__note')).toHaveLength(1);
  });
});
