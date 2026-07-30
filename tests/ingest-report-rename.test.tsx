// @vitest-environment jsdom
import { StrictMode, act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GroupingInfo } from '../src/core/assemble.ts';
import type { Manifest, PersonId } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { IngestReport } from '../src/viewer/components/IngestReport.tsx';

/**
 * Item 1 (the CRITICAL one) of the 2026-07-30 rename-corruption review:
 * `IngestReport.tsx`'s rename box called `onRename` on every `onChange`, so
 * renaming "Google Pixel 8 Pro" to "Priya" by typing ran `applyRename` about
 * 19 times — filling `also_known_as` with single- and two-character garbage,
 * and, while backspacing through empty, rewriting a note's `people` entry to
 * `""` with no way to heal. Fixed by making the rename box hold its own
 * local draft, committed to `onRename` only on blur or Enter; Escape reverts
 * without committing. This mounts the real component and drives real DOM
 * events — no faked timers, no calling internal functions directly — the
 * same style `tests/person-picker.test.tsx` uses for the sibling bug.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Sets a controlled input's value the way a real keystroke does — see
 * `tests/person-picker.test.tsx`'s helper of the same name and reasoning. */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** One character further than the current value — simulates a real
 * keystroke-by-keystroke typing session rather than a single `typeInto`. */
function typeCharacterByCharacter(input: HTMLInputElement, text: string) {
  let soFar = '';
  for (const ch of text) {
    soFar += ch;
    typeInto(input, soFar);
  }
}

function pressKey(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

const GROUPING: GroupingInfo = { by: 'device', byFamily: 0, byProximity: 0 };

function manifestWith(name: string): Manifest {
  return {
    schema: SCHEMA_VERSION,
    event: { title: 'Race', timezone: 'UTC' },
    people: [{ id: 'pixel8', name }],
    items: [],
  };
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

/**
 * Mounts `IngestReport` wired to REAL React state for `manifest.people` (a
 * `useState` inside the harness, the same "own its state, report changes via
 * a callback" shape `person-picker.test.tsx` uses) — a successful rename
 * flows back through a normal `setState`, exercising the sync-from-props
 * effect in `RenameInput` the way the real app does, rather than a manual
 * `root.render()` call fighting React's own batching. `onRename` also
 * records every call it received, so a test can assert on the exact number
 * and arguments — the crux of the keystroke bug.
 */
function mount(initialName: string) {
  const calls: Array<{ id: PersonId; name: string }> = [];

  function Harness() {
    const [manifest, setManifest] = useState<Manifest>(() => manifestWith(initialName));
    return (
      <IngestReport
        manifest={manifest}
        grouping={GROUPING}
        onRename={(id, name) => {
          calls.push({ id, name });
          const result = renameFor(manifest, id, name);
          if (result.refused) return result.refused;
          setManifest(result.manifest);
          return undefined;
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

  const input = container.querySelector('input.report__rename');
  if (!(input instanceof HTMLInputElement)) throw new Error('rename input not found');
  return { input, calls };
}

/**
 * A tiny stand-in for `applyRename` (`core/people-csv.ts`), just enough to
 * exercise `RenameInput`'s commit/refuse contract without importing the real
 * one: this test is about the UI's keystroke-safety, not the core rename
 * logic (covered directly in `tests/people-csv.test.ts`).
 */
function renameFor(
  manifest: Manifest,
  id: PersonId,
  name: string,
): { manifest: Manifest; refused?: string } {
  const trimmed = name.trim();
  if (trimmed === '') return { manifest, refused: 'A person must always have a name.' };
  return {
    manifest: { ...manifest, people: manifest.people.map((p) => (p.id === id ? { ...p, name: trimmed } : p)) },
  };
}

describe('IngestReport: renaming a person', () => {
  it('does not call onRename while typing — only on blur', () => {
    const { input, calls } = mount('Google Pixel 8 Pro');

    act(() => {
      input.focus();
    });
    act(() => typeCharacterByCharacter(input, 'Priya'));
    expect(calls).toHaveLength(0);

    act(() => {
      input.blur();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: 'pixel8', name: 'Priya' });
  });

  it('does not call onRename while backspacing through the name to empty', () => {
    const { input, calls } = mount('Google Pixel 8 Pro');
    act(() => input.focus());

    // Clear the field one character at a time, the exact sequence that used
    // to write `also_known_as` entries down to "G" and blank a note's
    // `people` entry to `""`.
    let value = 'Google Pixel 8 Pro';
    act(() => {
      while (value.length > 0) {
        value = value.slice(0, -1);
        typeInto(input, value);
      }
    });
    expect(calls).toHaveLength(0);
    expect(input.value).toBe('');
  });

  it('commits on Enter, not just blur', () => {
    const { input, calls } = mount('Google Pixel 8 Pro');
    act(() => input.focus());
    act(() => typeCharacterByCharacter(input, 'Priya'));
    act(() => pressKey(input, 'Enter'));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: 'pixel8', name: 'Priya' });
  });

  it('Escape reverts the draft to the current name without committing', () => {
    const { input, calls } = mount('Priya');
    act(() => input.focus());
    // Simulates typing more onto the end of the pre-filled value.
    act(() => typeCharacterByCharacter(input, 'Priyaoops'));
    expect(input.value).toBe('Priyaoops');

    act(() => pressKey(input, 'Escape'));

    expect(input.value).toBe('Priya');
    expect(calls).toHaveLength(0);
  });

  it('a refused rename (blank name) leaves the draft as typed, for one more edit', () => {
    const { input, calls } = mount('Priya');
    act(() => input.focus());
    // Clear the pre-filled value.
    act(() => typeInto(input, '   '));
    act(() => input.blur());

    expect(calls).toHaveLength(1);
    // The refusal did not clear or revert the box — it is one edit away from
    // being fixed, not silently discarded.
    expect(input.value).toBe('   ');
    expect(container.textContent).toContain('A person must always have a name.');
  });

  it('a successful rename is reflected back into the box once the roster updates', () => {
    const { input } = mount('Google Pixel 8 Pro');
    act(() => input.focus());
    act(() => typeCharacterByCharacter(input, 'Priya'));
    act(() => input.blur());

    expect(input.value).toBe('Priya');
  });

  it('blurring with the same name (e.g. only whitespace changed) does not call onRename', () => {
    const { input, calls } = mount('Priya');
    act(() => input.focus());
    act(() => typeInto(input, 'Priya  '));
    act(() => input.blur());

    expect(calls).toHaveLength(0);
    expect(input.value).toBe('Priya');
  });
});
