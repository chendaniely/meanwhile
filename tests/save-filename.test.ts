// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { filenameForSave } from '../src/viewer/App.tsx';

/**
 * The name of the file Save downloads. Saving is not a one-off — you write a
 * few notes, save, write more, save again — so every download carries the
 * moment it was made, or they collide in the browser's downloads folder and
 * you are left picking between `meanwhile-race (2).zip` and
 * `meanwhile-race (3).zip`.
 *
 * jsdom only because `App.tsx` pulls in the whole viewer on import; nothing
 * here touches the DOM.
 */

// 2026-07-30 09:12 LOCAL. Built from parts rather than parsed from a string
// so it means the same wall-clock time whatever zone the test runs in — a
// literal like '2026-07-30T09:12Z' would be 09:12 only in UTC, and this
// asserts on local-time output.
const AT = new Date(2026, 6, 30, 9, 12);

describe('filenameForSave', () => {
  it('carries the event name and the moment of saving', () => {
    expect(filenameForSave('Cascade Crest 100', AT)).toBe(
      'meanwhile-cascade-crest-100-2026-07-30-0912.zip',
    );
  });

  it('still produces a legal name when the event has no title', () => {
    expect(filenameForSave('', AT)).toBe('meanwhile-2026-07-30-0912.zip');
    expect(filenameForSave('   ', AT)).toBe('meanwhile-2026-07-30-0912.zip');
  });

  it('pads month, day, hour and minute so the names sort as plain text', () => {
    // A single-digit month/day/hour/minute is where an unpadded stamp stops
    // sorting: "2026-7-5-903" lands after "2026-10-...".
    const early = new Date(2026, 0, 5, 9, 3);
    expect(filenameForSave('Race', early)).toBe('meanwhile-race-2026-01-05-0903.zip');
  });

  it('uses a 24-hour clock, like the rest of the app', () => {
    const evening = new Date(2026, 6, 30, 21, 45);
    expect(filenameForSave('Race', evening)).toBe('meanwhile-race-2026-07-30-2145.zip');
  });

  it('reduces punctuation and accents in a title to a plain slug', () => {
    // Whatever someone types as an event name has to survive into a filename
    // every OS will accept, so anything outside a-z0-9 collapses to a hyphen.
    expect(filenameForSave("Sam's 100-miler!", AT)).toBe(
      'meanwhile-sam-s-100-miler-2026-07-30-0912.zip',
    );
  });

  it('never leaves a leading or trailing hyphen on the slug', () => {
    expect(filenameForSave('!!! Race !!!', AT)).toBe('meanwhile-race-2026-07-30-0912.zip');
  });

  it('produces a name .gitignore still keeps out of the repo', () => {
    // `.gitignore` matches these with `meanwhile-*.zip`. Event data must
    // never reach git, and the save zip carries notes.csv and people.csv.
    for (const title of ['Cascade Crest 100', '']) {
      expect(filenameForSave(title, AT)).toMatch(/^meanwhile-.*\.zip$/);
    }
  });
});
