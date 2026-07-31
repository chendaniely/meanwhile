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
function mount(initial = ''): {
  stored: () => string;
  input: () => HTMLInputElement;
  commits: string[];
} {
  let stored = initial;
  const commits: string[] = [];

  function Harness() {
    const [value, setValue] = useState(initial);
    stored = value;
    return (
      <CourseUrlInput
        value={value}
        onCommit={(url) => {
          // Mirrors `updateCourse`: normalise, store, and return what was
          // stored so the box can resync even when nothing re-renders.
          const stored = normalizeCourseUrl(url);
          setValue(stored);
          commits.push(url);
          return stored;
        }}
      />
    );
  }

  act(() => root.render(<StrictMode><Harness /></StrictMode>));
  const input = () => {
    const el = container.querySelector('input');
    if (!(el instanceof HTMLInputElement)) throw new Error('input not found');
    return el;
  };
  return { stored: () => stored, input, commits };
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

function focus(el: HTMLInputElement) {
  act(() => el.focus());
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

    // FOCUS FIRST. Without it this test could not see the thing it names:
    // `.blur()` on an unfocused element is a no-op in jsdom, so planting
    // `e.currentTarget.blur()` in the Escape handler passed the whole suite.
    // Focused, the planted call fires a real focusout, React's onBlur runs
    // `commit` in the same event-handling pass, and — because React batches
    // the `setDraft` this handler just queued — `commit` reads the ABANDONED
    // draft from this render's closure and commits exactly what Escape was
    // meant to discard. That is the trap `RenameInput` documents.
    focus(input());
    typeText(input(), '/oops');
    press(input(), 'Escape');
    expect(input().value).toBe('https://strava.com/x');
    expect(stored()).toBe('https://strava.com/x');

    // A blur arriving afterwards commits the reverted value, which is a
    // no-op — and must not re-fire `onCommit` either.
    blur(input());
    expect(stored()).toBe('https://strava.com/x');
  });

  it('leaves a GPX course alone when focused and blurred with no edit', () => {
    /*
     * `courseUrlOf` puts a GPX `src` into this same box, so the value sitting
     * in it is often `route.gpx` — which contains a dot, and therefore
     * normalises to `https://route.gpx`. Without `commit`'s
     * `draft === value` guard, merely tabbing through the field replaces the
     * whole GPX course with a Strava link:
     *   {kind:'gpx', src:'route.gpx'} -> {kind:'strava-link', url:'https://route.gpx'}
     * Removing that guard passed all 869 tests before this one existed.
     */
    const { stored, input, commits } = mount('route.gpx');

    focus(input());
    blur(input());
    press(input(), 'Enter');

    expect(commits).toEqual([]);
    expect(stored()).toBe('route.gpx');
    expect(input().value).toBe('route.gpx');
  });

  it('resyncs the box when the committed value normalises to what is stored', () => {
    /*
     * The resync effect watches `value`, so it only runs when `value`
     * CHANGES. When a commit normalises back to the value already held,
     * nothing re-renders — and the box kept the un-normalised text
     * permanently, with `draft !== value` true forever so every later
     * focusout re-fired `onCommit`. Not lossy, but the field misreported what
     * Save would write.
     */
    const { stored, input, commits } = mount();

    // Case B from the report: trailing whitespace, which normalises away.
    typeText(input(), 'https://www.strava.com/activities/1');
    blur(input());
    expect(stored()).toBe('https://www.strava.com/activities/1');

    typeText(input(), '   ');
    blur(input());
    expect(stored()).toBe('https://www.strava.com/activities/1');
    expect(input().value).toBe('https://www.strava.com/activities/1');

    // Two distinct edits, two commits — not four.
    expect(commits).toHaveLength(2);

    // And a further blur with nothing changed adds none.
    blur(input());
    expect(commits).toHaveLength(2);
  });

  it('resyncs after retyping a value that normalises to the stored one', () => {
    // Case A from the report: retype `strava.com/x` over `https://strava.com/x`.
    const { stored, input, commits } = mount();
    typeText(input(), 'strava.com/x');
    blur(input());
    expect(stored()).toBe('https://strava.com/x');

    act(() => setValue(input(), 'strava.com/x'));
    blur(input());
    expect(input().value).toBe('https://strava.com/x');
    expect(stored()).toBe('https://strava.com/x');

    blur(input());
    expect(commits).toHaveLength(2);
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
