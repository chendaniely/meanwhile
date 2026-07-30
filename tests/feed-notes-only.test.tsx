// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import type { Note } from '../src/core/notes.ts';
import type { PlacedNote } from '../src/core/window.ts';
import { Feed } from '../src/viewer/components/Feed.tsx';

/**
 * REGRESSION: `Feed.tsx` returned "Nothing to show" whenever `moments`
 * (derived from `items`, the PHOTOGRAPHS in range) was empty — without
 * checking whether a NOTE still fell inside the window. `App.tsx` filters
 * `feedNotes` by the time range alone, never by which lanes are visible, so
 * hiding every lane (or narrowing the window past the last photo) leaves
 * `moments` empty while a note is still very much in range. CLAUDE.md's
 * "The timeline's bounds include NOTES" section treats "write a note and
 * watch it vanish" as the one outcome worth spending UI on — this is that
 * outcome, for the feed specifically.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MANIFEST: Manifest = {
  schema: SCHEMA_VERSION,
  event: { title: 'Race', timezone: 'UTC' },
  people: [{ id: 'sam', name: 'Sam' }],
  items: [],
};

const NOTE: Note = {
  id: 'note-1',
  at: '2026-07-25T15:00:00Z',
  people: [],
  author: [],
  text: 'Asleep at Cottonwood.',
};

const PLACED_NOTES: PlacedNote[] = [{ note: NOTE, instant: Date.parse(NOTE.at) }];

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

describe('Feed: notes do not disappear when no photo falls in the window', () => {
  it('renders a note even when there are zero media moments', () => {
    act(() => {
      root.render(
        <StrictMode>
          <Feed manifest={MANIFEST} items={[]} onOpen={() => {}} notes={PLACED_NOTES} />
        </StrictMode>,
      );
    });

    expect(container.textContent).toContain('Asleep at Cottonwood.');
    expect(container.textContent).not.toContain('Nothing to show');
  });

  it('still shows the empty-state callout when there are no moments AND no notes', () => {
    act(() => {
      root.render(
        <StrictMode>
          <Feed manifest={MANIFEST} items={[]} onOpen={() => {}} notes={[]} />
        </StrictMode>,
      );
    });

    expect(container.textContent).toContain('Nothing to show');
  });
});
