// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Note } from '../src/core/notes.ts';
import type { Manifest } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { NoteComposer } from '../src/viewer/components/Notes.tsx';

/**
 * `Notes.tsx:129`'s `until > at` guard had no test: the composer types an
 * end as a clock reading ("until 6:40") and stores a DURATION, but an end
 * equal to or before the start is not a span and must produce no `duration`
 * at all — writing a negative or zero one would be worse than omitting it.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const MANIFEST: Manifest = {
  schema: SCHEMA_VERSION,
  event: { title: 'Race', timezone: 'UTC' },
  people: [],
  items: [],
};

// 2026-07-25T15:00:00Z — the default "When" the composer pre-fills from cursor.
const CURSOR = Date.UTC(2026, 6, 25, 15, 0);

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

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Mounts the composer and returns handles to its fields plus the last note added. */
function mount() {
  let added: Note | null = null;

  act(() => {
    root.render(
      <StrictMode>
        <NoteComposer
          manifest={MANIFEST}
          cursor={CURSOR}
          timezone="UTC"
          defaultAuthor={[]}
          onAdd={(n) => {
            added = n;
          }}
        />
      </StrictMode>,
    );
  });

  const text = container.querySelector('textarea.compose__text');
  const fields = container.querySelectorAll<HTMLInputElement>('.compose__field input');
  const [when, until] = [fields[0], fields[1]];
  const submit = container.querySelector('.compose__fields button.button--primary');
  if (!(text instanceof HTMLTextAreaElement)) throw new Error('textarea not found');
  if (!(when instanceof HTMLInputElement) || !(until instanceof HTMLInputElement)) {
    throw new Error('When/Until inputs not found');
  }
  if (!(submit instanceof HTMLButtonElement)) throw new Error('submit button not found');

  return {
    text, when, until, submit,
    note: () => added,
  };
}

describe('NoteComposer duration guard', () => {
  it('produces a duration for a real span (end after the start)', () => {
    const { text, until, submit, note } = mount();
    act(() => typeInto(text, 'asleep in the car'));
    act(() => typeInto(until, '2026-07-25 16:00')); // one hour after the cursor
    act(() => submit.click());

    expect(note()?.duration).toBeDefined();
    expect(note()?.at).toBe(new Date(CURSOR).toISOString());
  });

  it('produces no duration when the end equals the start', () => {
    const { text, until, submit, note } = mount();
    act(() => typeInto(text, 'blip'));
    act(() => typeInto(until, '2026-07-25 15:00')); // same as the cursor
    act(() => submit.click());

    expect(note()).not.toBeNull();
    expect(Object.hasOwn(note() as Note, 'duration')).toBe(false);
  });

  it('produces no duration when the end is before the start', () => {
    const { text, until, submit, note } = mount();
    act(() => typeInto(text, 'muddled'));
    act(() => typeInto(until, '2026-07-25 14:00')); // before the cursor
    act(() => submit.click());

    expect(note()).not.toBeNull();
    expect(Object.hasOwn(note() as Note, 'duration')).toBe(false);
  });
});
