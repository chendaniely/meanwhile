// @vitest-environment jsdom
import { StrictMode, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CourseUrlInput } from '../src/viewer/App.tsx';
import { normalizeCourseUrl } from '../src/core/course-url.ts';

/**
 * The event-settings URL box, MOUNTED and typed into.
 *
 * This file exists because `tests/course-url-guard.test.tsx` exercised
 * `normalizeCourseUrl` as a pure function only, and so proved nothing about
 * the component that calls it. The box was a controlled input whose
 * `onChange` wrote straight through the normaliser and fed the rewritten
 * value back into the field, so typing an address by hand ended at
 * `https://https://www.strava.com/activities/123` — refused by the guard, no
 * link rendered, and saved to `manifest.json` that way. Pasting worked and
 * typing did not, which is the inverse of what normalising was added for.
 *
 * It is the same defect CLAUDE.md already records under "A rename is TOTAL,
 * and committed — never per-keystroke", in a different field. A pure-function
 * test cannot see it. Only typing can.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

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
 * The box wired the way `App.tsx` wires it: the committed value is stored,
 * normalised on the way in, and fed back as the input's value. That feedback
 * loop is the whole mechanism of the bug, so the harness has to reproduce it
 * rather than stub it out.
 */
function mount(): { stored: () => string; input: () => HTMLInputElement } {
  let stored = '';

  function Harness() {
    const [value, setValue] = useState('');
    stored = value;
    return <CourseUrlInput value={value} onCommit={(url) => setValue(normalizeCourseUrl(url))} />;
  }

  act(() => root.render(<StrictMode><Harness /></StrictMode>));
  const input = () => {
    const el = container.querySelector('input');
    if (!(el instanceof HTMLInputElement)) throw new Error('input not found');
    return el;
  };
  return { stored: () => stored, input };
}

/**
 * Set the field's value the way a real keystroke does.
 *
 * Assigning `el.value` directly is not enough: React tracks the last value it
 * wrote on the DOM node and skips the change event when the property looks
 * unchanged to it, so a naive assignment silently does nothing. Going through
 * the native setter updates the node without touching React's tracker, which
 * is what makes the dispatched `input` event land.
 */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('no native value setter');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** One character, the way a browser delivers it: value set, then `input`. */
function typeChar(el: HTMLInputElement, ch: string) {
  act(() => setValue(el, el.value + ch));
}

function typeText(el: HTMLInputElement, text: string) {
  for (const ch of text) typeChar(el, ch);
}

/**
 * React delegates `onBlur` from the FOCUSOUT event, not from `blur` — `blur`
 * does not bubble, so React cannot delegate it. Dispatching `blur` looks
 * right and never reaches the handler.
 */
function blur(el: HTMLInputElement) {
  act(() => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
}

function press(el: HTMLInputElement, key: string) {
  act(() => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
}

describe('the course URL box', () => {
  it('does not rewrite the value while it is being typed', () => {
    // The regression itself. Every character must land in the box exactly as
    // it was pressed; nothing is normalised until the edit is committed.
    const { stored, input } = mount();
    typeText(input(), 'https://www.strava.com/activities/123');
    expect(input().value).toBe('https://www.strava.com/activities/123');
    // And nothing has been committed yet.
    expect(stored()).toBe('');
  });

  it('commits what was typed, once, on blur', () => {
    const { stored, input } = mount();
    typeText(input(), 'https://www.strava.com/activities/123');
    blur(input());
    expect(stored()).toBe('https://www.strava.com/activities/123');
    expect(input().value).toBe('https://www.strava.com/activities/123');
  });

  it('commits on Enter too', () => {
    const { stored, input } = mount();
    typeText(input(), 'https://www.strava.com/activities/9');
    press(input(), 'Enter');
    expect(stored()).toBe('https://www.strava.com/activities/9');
  });

  it('normalises a scheme-less paste at COMMIT, not per keystroke', () => {
    const { stored, input } = mount();
    typeText(input(), 'strava.com/activities/123');
    // Untouched while typing...
    expect(input().value).toBe('strava.com/activities/123');
    blur(input());
    // ...and repaired exactly once, on commit.
    expect(stored()).toBe('https://strava.com/activities/123');
    expect(input().value).toBe('https://strava.com/activities/123');
  });

  it('is idempotent: committing again does not re-prefix', () => {
    // The failure mode was self-feeding, so committing twice has to be safe.
    const { stored, input } = mount();
    typeText(input(), 'strava.com/x');
    blur(input());
    blur(input());
    press(input(), 'Enter');
    expect(stored()).toBe('https://strava.com/x');
  });

  it('can be cleared back to empty, which removes the course', () => {
    // Unreachable before: backspacing converged on `https://h` and never hit
    // empty, so `updateCourse`'s "blank means delete the course" branch could
    // not be triggered by a person using the box.
    const { stored, input } = mount();
    typeText(input(), 'strava.com/x');
    blur(input());
    expect(stored()).toBe('https://strava.com/x');

    act(() => setValue(input(), ''));
    blur(input());
    expect(stored()).toBe('');
  });

  it('reverts on Escape and commits nothing', () => {
    const { stored, input } = mount();
    typeText(input(), 'strava.com/x');
    blur(input());

    typeText(input(), '/oops');
    press(input(), 'Escape');
    expect(input().value).toBe('https://strava.com/x');
    expect(stored()).toBe('https://strava.com/x');

    // The trap `RenameInput` documents: Escape must not blur, or the blur
    // handler commits the abandoned draft from the stale closure. A blur
    // arriving afterwards commits the reverted value, which is a no-op.
    blur(input());
    expect(stored()).toBe('https://strava.com/x');
  });

  it('leaves placeholder words alone rather than making them links', () => {
    // `none` used to become `https://none` and render as an anchor reading
    // "Open the activity on none".
    for (const placeholder of ['none', 'n/a', 'TBD', '-']) {
      const { stored, input } = mount();
      typeText(input(), placeholder);
      blur(input());
      expect(stored(), placeholder).toBe(placeholder);
    }
  });
});
