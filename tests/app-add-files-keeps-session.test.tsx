// @vitest-environment jsdom
//
// `App.tsx` transitively pulls in `map/basemaps.ts`, which reads
// `import.meta.env`. `tsconfig.node.json` (which `tests/` compiles under)
// never includes `src/viewer/vite-env.d.ts`, so the reference is repeated
// here — see the same note at the top of `app-wiring.test.tsx`.
/// <reference types="vite/client" />
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/viewer/App.tsx';

/**
 * "Add files" must not throw away work that exists only in this session.
 *
 * `ingestFolder` takes the session's roster, crop, course and markers as
 * OPTIONS, and `tests/ingest.test.ts` pins what it does with them. This is
 * the other half, and the half the bug actually lived in: whether `App.tsx`
 * hands them over at all. It did not — so opening a folder, renaming a
 * device to a person in the ingest report, and then using "Add files" to drop
 * in a GPX (the documented way to add a track) reverted the roster to the
 * unsaved `people.csv` on disk. The `also_known_as` alias went with it, which
 * is worse than losing the name: every note the rename had rewritten then
 * matched nobody at all.
 *
 * Driven through the real controls rather than by calling `ingestFolder`,
 * because the options object is exactly what was wrong.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

class NoopIntersectionObserver implements IntersectionObserver {
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>)['IntersectionObserver'] =
    NoopIntersectionObserver;
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

async function waitFor(check: () => boolean, description: string, timeoutMs = 4000): Promise<void> {
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

/**
 * `.files` is read-only on a real `<input>`, so `defineProperty` plus a
 * bubbling `change` is the standard way to fake a pick.
 *
 * There is exactly ONE `[data-testid="file-input"]` on screen in either
 * stage: the empty state renders `FilePicker` as "Choose files" (which
 * REPLACES, since there is nothing to add to), and the loaded header renders
 * it as "Add files" (which ADDS). `FolderPicker`'s own fallback input
 * carries no test id. So the same query drives whichever of the two is
 * showing, and the assertion below keeps that true if a picker is ever
 * added.
 */
async function pickFiles(files: File[]): Promise<void> {
  const inputs = [...container.querySelectorAll('[data-testid="file-input"]')];
  expect(inputs).toHaveLength(1);
  const input = inputs[0];
  if (!(input instanceof HTMLInputElement)) throw new Error('file input not found');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function textFile(name: string, text: string): File {
  return new File([text], name);
}

const PEOPLE_CSV = ['id,name,role,clock_offset,also_known_as,schema', 'p1,Pixel 8 Pro,,,,'].join('\n');
const NOTES_CSV = [
  'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema',
  'n_1,2026,7,25,10,0,,UTC,0,Pixel 8 Pro,,,at the aid station,,,',
].join('\n');

function renameBox(): HTMLInputElement {
  const input = container.querySelector('.report__rename');
  if (!(input instanceof HTMLInputElement)) throw new Error('rename box not found');
  return input;
}

function problemsText(): string {
  return [...container.querySelectorAll('.callout--warn')].map((el) => el.textContent ?? '').join(' ');
}

describe('App: "Add files" keeps what only this session knows', () => {
  it('does not revert an in-session rename to the unsaved people.csv', async () => {
    act(() => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });

    await pickFiles([textFile('people.csv', PEOPLE_CSV), textFile('notes.csv', NOTES_CSV)]);
    await waitFor(
      () => container.querySelector('.panel__digest') !== null,
      'App to reach the loaded stage',
    );
    // The report opens the person's name box; the roster came from
    // people.csv, so it starts at the device name.
    await act(async () => {
      const details = container.querySelector('details.panel');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });
    expect(renameBox().value).toBe('Pixel 8 Pro');

    // Rename, COMMITTED — `RenameInput` deliberately only commits on Enter
    // or blur, never per keystroke, so typing alone changes nothing but its
    // own draft state. Enter is used here rather than a synthetic blur:
    // React delegates `onBlur` from the native `focusout` event, so
    // dispatching `blur` looks right and quietly commits nothing, which is
    // exactly how an earlier version of this test passed while testing
    // nothing at all.
    await act(async () => {
      const box = renameBox();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(box, 'Priya');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitFor(() => renameBox().value === 'Priya', 'the rename to land');
    // The note said the device name and the rename rewrote it, so if the
    // rename had not really committed this would already be complaining.
    expect(problemsText()).not.toContain("doesn't match anyone");

    // Now "Add files" — the second picker in the header — with a track, the
    // documented reason to reach for it. Nothing has been saved, so the
    // people.csv still on disk says "Pixel 8 Pro".
    await pickFiles(
      [textFile('people.csv', PEOPLE_CSV), textFile('notes.csv', NOTES_CSV), textFile('route.gpx', '<gpx></gpx>')],
    );
    await waitFor(
      () => container.querySelector('.panel__digest') !== null,
      'App to finish the second ingest',
    );
    await act(async () => {
      const details = container.querySelector('details.panel');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });

    expect(renameBox().value).toBe('Priya');
    // The alias is the load-bearing half: losing it orphans the note the
    // rename rewrote, which is how the bug announced itself.
    expect(problemsText()).not.toContain("doesn't match anyone");
    // And it is said out loud that the file on disk is behind.
    expect(problemsText()).toContain('Save to write them');
  });

  it('does not drop a Strava link set in the settings panel', async () => {
    act(() => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });

    await pickFiles([textFile('notes.csv', NOTES_CSV)]);
    await waitFor(
      () => container.querySelector('.panel__digest') !== null,
      'App to reach the loaded stage',
    );
    await act(async () => {
      const details = container.querySelector('details.panel');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });

    const courseField = [...container.querySelectorAll('input.field__input')].find((el) =>
      (el as HTMLInputElement).placeholder.includes('strava'),
    );
    if (!(courseField instanceof HTMLInputElement)) throw new Error('course field not found');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(courseField, 'https://www.strava.com/activities/12345');
      courseField.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The box holds a DRAFT and commits on blur or Enter, never per keystroke
    // — see `CourseUrlInput` in App.tsx, and the entry it reuses ("A rename is
    // TOTAL, and committed"). Typing alone therefore stores nothing, which is
    // the point: normalising on every character turned a typed URL into
    // `https://https://…`. React delegates onBlur from FOCUSOUT, so `blur`
    // (which does not bubble) would never reach the handler.
    await act(async () => {
      courseField.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    await pickFiles([textFile('notes.csv', NOTES_CSV), textFile('route.gpx', '<gpx></gpx>')]);
    await waitFor(
      () => container.querySelector('.panel__digest') !== null,
      'App to finish the second ingest',
    );
    await act(async () => {
      const details = container.querySelector('details.panel');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });

    const after = [...container.querySelectorAll('input.field__input')].find((el) =>
      (el as HTMLInputElement).placeholder.includes('strava'),
    ) as HTMLInputElement | undefined;
    expect(after?.value).toBe('https://www.strava.com/activities/12345');
  });
});

describe('App: a rename that hands the old name to somebody else', () => {
  it('says so in the problems callout instead of moving the note in silence', async () => {
    // p1 is "Bob"; p2 is "Rob" who also answers to "Bob". While both claim
    // the name, `resolvePersonNames` refuses to guess and the note sits in
    // neither lane — visible, and correct. Renaming p1 ends the contest, so
    // the note quietly becomes p2's. Nothing was written to make that happen,
    // which is exactly why it has to be said.
    const people = [
      'id,name,role,clock_offset,also_known_as,schema',
      'p1,Bob,,,,',
      'p2,Rob,,,Bob,',
    ].join('\n');
    const notes = [
      'id,year,month,day,hour,minute,duration,tz,utc_offset_min,people,photo,author,text,written,deleted,schema',
      'n_1,2026,7,25,10,0,,UTC,0,Bob,,,about the first Bob,,,',
    ].join('\n');

    act(() => {
      root.render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    await pickFiles([textFile('people.csv', people), textFile('notes.csv', notes)]);
    await waitFor(
      () => container.querySelector('.panel__digest') !== null,
      'App to reach the loaded stage',
    );
    await act(async () => {
      const details = container.querySelector('details.panel');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });

    const boxes = [...container.querySelectorAll('.report__rename')];
    const first = boxes[0];
    if (!(first instanceof HTMLInputElement)) throw new Error('rename box not found');
    expect(first.value).toBe('Bob');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(first, 'Robert');
      first.dispatchEvent(new Event('input', { bubbles: true }));
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitFor(() => problemsText().includes('Robert'), 'the reassignment to be reported');

    const said = problemsText();
    expect(said).toContain('"Bob"');
    expect(said).toContain('Rob');
    expect(said).toContain('lane');
  });
});
