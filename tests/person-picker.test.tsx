// @vitest-environment jsdom
import { StrictMode, act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Person } from '../src/core/schema.ts';
import { PersonPicker } from '../src/viewer/components/PersonPicker.tsx';

/**
 * Pins the three behaviours the brief calls out explicitly, so a later
 * refactor breaking any of them fails loudly instead of silently:
 *
 * - an unrecognised name is still accepted (the roster may be incomplete)
 * - adding the same name twice, differently cased, does not duplicate it
 * - Escape closes the suggestion list without touching the chosen value
 */

// Without this React does not flush effects synchronously inside act(), and
// the assertions below would race the render they are checking.
(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const ROSTER: Person[] = [
  { id: 'p1', name: 'Amy Chen' },
  { id: 'p2', name: 'Ben Ortiz' },
];

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

/**
 * Sets a controlled input's value the way a real keystroke does. Writing
 * `input.value = text` directly does not notify React — it patches the
 * property with its own tracked setter, so the change has to go through the
 * original prototype setter for the following `input` event to be seen as a
 * real change rather than a no-op.
 */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/**
 * Mounts `PersonPicker` wired to its own controlled state (a note field
 * would own this, but the control doesn't care) and reports the committed
 * value on every change via an effect, the same shape as
 * `media-store-lifecycle.test.tsx`'s `mount` helper.
 */
function mount(initial: string[] = []) {
  let latest: string[] = initial;

  function Harness() {
    const [value, setValue] = useState<string[]>(initial);
    useEffect(() => {
      latest = value;
    }, [value]);
    return <PersonPicker people={ROSTER} value={value} onChange={setValue} label="People" />;
  }

  act(() => {
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
  });

  const input = container.querySelector('input.picker__input');
  if (!(input instanceof HTMLInputElement)) throw new Error('PersonPicker input not found');
  return { input, value: () => latest };
}

describe('PersonPicker', () => {
  it('accepts a typed name that matches nobody in the roster', () => {
    const { input, value } = mount();

    act(() => typeInto(input, 'Zephyr Nobody'));
    // Nothing in the roster contains this substring, so no suggestion list
    // — and Enter must still commit the typed text rather than refuse it.
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    act(() => pressKey(input, 'Enter'));

    expect(value()).toEqual(['Zephyr Nobody']);
  });

  it('does not add a duplicate when the same name is typed in a different case', () => {
    const { input, value } = mount(['Amy Chen']);

    act(() => typeInto(input, 'amy chen'));
    act(() => pressKey(input, 'Enter'));

    expect(value()).toEqual(['Amy Chen']);
  });

  it('Escape closes the list without changing the chosen value', () => {
    const { input, value } = mount();

    act(() => typeInto(input, 'Amy'));
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();

    act(() => pressKey(input, 'Escape'));

    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(value()).toEqual([]);
  });

  /**
   * Item 4 of the 2026-07-30 rename-corruption review: `people`/`author` —
   * what this picker edits — are `;`-separated lists in `notes*.csv`, the
   * same convention `also_known_as` uses in `people.csv`. A typed name
   * containing `;` would silently split into two names the next time the
   * file round-trips, so it is refused here too, not just in the roster
   * rename box (`IngestReport.tsx`'s `RenameInput`).
   */
  it('refuses a typed name containing ";", leaving the value unchanged', () => {
    const { input, value } = mount();

    act(() => typeInto(input, 'Jo; Chen'));
    act(() => pressKey(input, 'Enter'));

    expect(value()).toEqual([]);
    expect(container.textContent).toContain('can’t contain ";"');
    // Left as typed, not cleared, so it is one edit away from being fixed.
    expect(input.value).toBe('Jo; Chen');
  });

  it('accepts the same name once the ";" is fixed', () => {
    const { input, value } = mount();

    act(() => typeInto(input, 'Jo; Chen'));
    act(() => pressKey(input, 'Enter'));
    expect(value()).toEqual([]);

    act(() => typeInto(input, 'Jo, Chen'));
    act(() => pressKey(input, 'Enter'));

    expect(value()).toEqual(['Jo, Chen']);
  });
});
