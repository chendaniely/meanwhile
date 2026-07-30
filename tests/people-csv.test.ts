import { describe, expect, it } from 'vitest';
import {
  applyRename, displayName, formatPeopleCsv, parsePeopleCsv, resolvePersonNames,
} from '../src/core/people-csv.ts';
import type { Note } from '../src/core/notes.ts';
import type { Person } from '../src/core/schema.ts';

const PEOPLE: Person[] = [
  { id: 'pixel8', name: 'Priya', role: 'runner' },
  // A valid ISO-8601 duration: the sign precedes "P", not "T" — "PT-4S" is
  // not actually parseable by `parseDuration` and used to round-trip here
  // unvalidated. Now that `parsePeopleCsv` validates with `parseDuration`
  // (finding 4), an invalid one is dropped and reported rather than kept.
  { id: 'zflip4', name: 'Sam', clockOffset: '-PT4S' },
];

/** Bare-minimum valid note, so each test only overrides what it cares about. */
function note(overrides: Partial<Note>): Note {
  return {
    id: 'n_1',
    at: '2026-08-22T13:00:00.000Z',
    people: [],
    author: [],
    text: 'hello',
    ...overrides,
  };
}

describe('people.csv', () => {
  it('round-trips a roster', () => {
    expect(parsePeopleCsv(formatPeopleCsv(PEOPLE)).people).toEqual(PEOPLE);
  });

  it('reads role and clock offset, leaving blanks absent rather than empty', () => {
    const { people } = parsePeopleCsv(
      'id,name,role,clock_offset\npixel8,Priya,runner,\n',
    );
    expect(people[0]).toEqual({ id: 'pixel8', name: 'Priya', role: 'runner' });
  });

  it('reports a row with no id or name', () => {
    const { people, problems } = parsePeopleCsv('id,name\n,Nobody\npixel8,Priya\n');
    expect(people).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  /**
   * IMPORTANT 4 from the whole-branch review: an invalid `role` used to be
   * cast straight through to `Person`, so a typo like "runer" reached
   * `manifest.json` and failed `validateManifest` on the NEXT open — taking
   * the crop, the course reference, markers, and every hand-placed time down
   * with it, because a refused manifest is refused wholesale. Same for a
   * duplicated `id`. Neither was reported. These pin the fix: the bad field
   * is dropped and reported, the person (and the rest of the file) survives.
   */
  it('keeps the person but drops and reports an unrecognised role', () => {
    const { people, problems } = parsePeopleCsv('id,name,role\npixel8,Priya,runer\n');
    expect(people).toEqual([{ id: 'pixel8', name: 'Priya' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('runer');
  });

  it('keeps the person but drops and reports an unparseable clock_offset', () => {
    const { people, problems } = parsePeopleCsv(
      'id,name,role,clock_offset\npixel8,Priya,,forty-seven seconds\n',
    );
    expect(people).toEqual([{ id: 'pixel8', name: 'Priya' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('forty-seven seconds');
  });

  it('accepts a valid clock_offset', () => {
    const { people } = parsePeopleCsv('id,name,role,clock_offset\npixel8,Priya,,-PT47S\n');
    expect(people[0]).toEqual({ id: 'pixel8', name: 'Priya', clockOffset: '-PT47S' });
  });

  it('drops and reports a row whose id repeats an earlier row, rather than producing a duplicate', () => {
    const { people, problems } = parsePeopleCsv(
      'id,name\npixel8,Priya\npixel8,Priya Again\n',
    );
    expect(people).toEqual([{ id: 'pixel8', name: 'Priya' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pixel8');
  });

  /**
   * `parseCsv` drops blank lines rather than emitting empty rows for them
   * (see `tests/csv.test.ts`), so a row's position in the parsed `rows`
   * array is NOT its line in the file whenever a blank line sits above it.
   * Line 1 is the header, line 2 is "pixel8,Priya", line 3 is blank, line 4
   * is the bad row — so the message must say "Row 4", not "Row 3".
   */
  it('reports the true file line, not the row\'s position after blank lines are dropped', () => {
    const { problems } = parsePeopleCsv('id,name\npixel8,Priya\n\n,Nobody\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Row 4');
  });

  /**
   * Item 4 of the 2026-07-30 rename-corruption review: a `;` in `name` is
   * legal in this one CSV cell on its own, but becomes dangerous the moment
   * this name is later pushed onto `also_known_as` (a rename) or matched
   * against a note's `people`/`author` column — both `;`-separated lists.
   * The rename UI refuses one going IN; a hand-edited file that already has
   * one is repaired and reported, the same as an unrecognised `role`, rather
   * than let through to corrupt the next save silently.
   */
  it('repairs and reports a name cell containing ";"', () => {
    const { people, problems } = parsePeopleCsv('id,name\npixel8,Jo; Chen\n');
    expect(people).toEqual([{ id: 'pixel8', name: 'Jo Chen' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Jo; Chen');
    expect(problems[0]).toContain(';');
  });

  // --- also_known_as -------------------------------------------------------

  it('reads a file with no also_known_as column at all, unchanged', () => {
    const { people, problems } = parsePeopleCsv('id,name,role,clock_offset\npixel8,Priya,runner,\n');
    expect(problems).toEqual([]);
    expect(people).toEqual([{ id: 'pixel8', name: 'Priya', role: 'runner' }]);
    expect(people[0]).not.toHaveProperty('alsoKnownAs');
  });

  it('round-trips also_known_as, including multiple aliases, through parse/format', () => {
    const withAliases: Person[] = [
      { id: 'pixel8', name: 'Priya', role: 'runner', alsoKnownAs: ['Google Pixel 8 Pro', 'P'] },
      { id: 'zflip4', name: 'Sam', clockOffset: '-PT4S' },
    ];
    expect(parsePeopleCsv(formatPeopleCsv(withAliases)).people).toEqual(withAliases);
  });

  it('splits also_known_as on ";", trimming and dropping blanks, same as notes.csv', () => {
    const { people } = parsePeopleCsv(
      'id,name,also_known_as\npixel8,Priya, Google Pixel 8 Pro ;;P;\n',
    );
    expect(people[0]?.alsoKnownAs).toEqual(['Google Pixel 8 Pro', 'P']);
  });

  it('keeps a row with a blank name cell if it carries an alias, using the alias as name', () => {
    const { people, problems } = parsePeopleCsv(
      'id,name,also_known_as\ncrew1,,Jo Chen\n',
    );
    expect(problems).toEqual([]);
    // The alias becomes the name (see the "name" fallback above), so it is
    // now the person's OWN name, not an alias of it — `cleanAliases` drops
    // it rather than round-tripping a self-alias (item 5 of the 2026-07-30
    // rename-corruption review: `p,,Priya;PJ` must not parse to
    // `alsoKnownAs: ['Priya', 'PJ']` with `name: 'Priya'` already redundant
    // in it). A row with only ONE alias and no name cell therefore ends up
    // with none at all once that alias is promoted to `name`.
    expect(people).toEqual([{ id: 'crew1', name: 'Jo Chen' }]);
  });

  /**
   * Item 5 of the 2026-07-30 rename-corruption review: `p,,Priya;PJ` parsed
   * to `{name: 'Priya', alsoKnownAs: ['Priya', 'PJ']}` — the name was also
   * its own alias. Here the name comes from a `name` CELL (not the
   * also_known_as fallback covered above), so this pins the general case:
   * any alias matching the name, case-insensitively, is dropped on parse.
   */
  it('drops an alias that case-insensitively equals the name, on parse', () => {
    const { people } = parsePeopleCsv('id,name,also_known_as\npixel8,Priya,priya;PJ\n');
    expect(people[0]?.alsoKnownAs).toEqual(['PJ']);
  });

  /** `Sam;sam` keeps only the first spelling. */
  it('dedupes also_known_as case-insensitively, keeping the first-seen spelling, on parse', () => {
    const { people } = parsePeopleCsv('id,name,also_known_as\npixel8,Priya,Sam;sam;SAM\n');
    expect(people[0]?.alsoKnownAs).toEqual(['Sam']);
  });

  /**
   * The write side needs its own coverage: a roster built up in memory (by
   * `applyRename`, or by several merged `people.csv` files) can carry the
   * same self-alias or duplicate without ever having gone through
   * `parsePeopleCsv` — `formatPeopleCsv` is the last chance to keep the
   * saved file clean.
   */
  it('drops a self-alias and dedupes case-insensitively, on write', () => {
    const dirty: Person[] = [{ id: 'pixel8', name: 'Priya', alsoKnownAs: ['priya', 'Sam', 'sam', 'PJ'] }];
    const csv = formatPeopleCsv(dirty);
    expect(csv).toContain('Sam;PJ');
    expect(parsePeopleCsv(csv).people[0]?.alsoKnownAs).toEqual(['Sam', 'PJ']);
  });

  it('still reports missing name when both name and also_known_as are blank', () => {
    const { people, problems } = parsePeopleCsv('id,name,also_known_as\ncrew1,,\n');
    expect(people).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('missing name');
  });
});

describe('displayName', () => {
  it('prefers the current name when present', () => {
    expect(displayName({ id: 'pixel8', name: 'Priya', alsoKnownAs: ['Google Pixel 8 Pro'] })).toBe(
      'Priya',
    );
  });

  it('falls back to the first also_known_as entry when name is blank', () => {
    expect(displayName({ id: 'pixel8', name: '', alsoKnownAs: ['Google Pixel 8 Pro', 'Priya'] })).toBe(
      'Google Pixel 8 Pro',
    );
  });

  it('falls back to displayNameFor(id) when neither name nor an alias is usable', () => {
    expect(displayName({ id: 'google-pixel-8-pro', name: '' })).toBe('Google Pixel 8 Pro');
    // A blank-string alias is not usable either — must not surface it.
    expect(displayName({ id: 'google-pixel-8-pro', name: '', alsoKnownAs: ['  '] })).toBe(
      'Google Pixel 8 Pro',
    );
  });
});

describe('resolvePersonNames', () => {
  it('matches names case-insensitively, ignoring surrounding space', () => {
    expect(resolvePersonNames([' priya ', 'SAM'], PEOPLE).ids).toEqual(['pixel8', 'zflip4']);
  });

  it('keeps an unrecognised name rather than dropping the note it is on', () => {
    const { ids, unknown } = resolvePersonNames(['Priya', 'Ghost'], PEOPLE);
    expect(ids).toEqual(['pixel8']);
    expect(unknown).toEqual(['Ghost']);
  });

  it('resolves a person by an also_known_as alias, not just their current name', () => {
    const renamed: Person[] = [
      { id: 'pixel8', name: 'Priya', role: 'runner', alsoKnownAs: ['Google Pixel 8 Pro'] },
      { id: 'zflip4', name: 'Sam' },
    ];
    const { ids, unknown } = resolvePersonNames(['Google Pixel 8 Pro', 'Priya'], renamed);
    expect(ids).toEqual(['pixel8', 'pixel8']);
    expect(unknown).toEqual([]);
  });

  it('never guesses when a name/alias is claimed by two different people', () => {
    const clashing: Person[] = [
      { id: 'pixel8', name: 'Priya', alsoKnownAs: ['Sam'] },
      { id: 'zflip4', name: 'Sam' },
    ];
    const { ids, unknown } = resolvePersonNames(['Sam'], clashing);
    expect(ids).toEqual([]);
    expect(unknown).toEqual(['Sam']);
  });
});

describe('applyRename', () => {
  it('sets the new name and records the old one as an alias', () => {
    const { people, collided } = applyRename(PEOPLE, [], 'pixel8', 'Priya Actual');
    expect(collided).toBe(false);
    expect(people.find((p) => p.id === 'pixel8')).toEqual({
      id: 'pixel8',
      name: 'Priya Actual',
      role: 'runner',
      alsoKnownAs: ['Priya'],
    });
    // The other person is untouched.
    expect(people.find((p) => p.id === 'zflip4')).toEqual(PEOPLE[1]);
  });

  it('rewrites the old name to the new one in loaded notes, case-insensitively, in both people and author', () => {
    const notes = [note({ people: ['priya'], author: ['Someone Else'] })];
    const { notes: rewritten } = applyRename(PEOPLE, notes, 'pixel8', 'Priya Actual');
    expect(rewritten[0]?.people).toEqual(['Priya Actual']);
    expect(rewritten[0]?.author).toEqual(['Someone Else']);
  });

  it('does not touch a note that never mentioned the renamed person', () => {
    const notes = [note({ people: ['Sam'], author: ['Sam'] })];
    const { notes: rewritten } = applyRename(PEOPLE, notes, 'pixel8', 'Priya Actual');
    expect(rewritten[0]).toEqual(notes[0]);
  });

  it('is a no-op (still non-destructive) when the "new" name is the same as the old one', () => {
    const notes = [note({ people: ['Priya'] })];
    const { people, notes: rewritten } = applyRename(PEOPLE, notes, 'pixel8', 'Priya');
    expect(people.find((p) => p.id === 'pixel8')?.alsoKnownAs).toBeUndefined();
    expect(rewritten[0]).toEqual(notes[0]);
  });

  it('accumulates aliases across two renames, and a note using the ORIGINAL name still resolves', () => {
    const first = applyRename(PEOPLE, [note({ people: ['Priya'] })], 'pixel8', 'P. Sharma');
    const second = applyRename(first.people, first.notes, 'pixel8', 'Priya Sharma');

    const person = second.people.find((p) => p.id === 'pixel8');
    expect(person?.name).toBe('Priya Sharma');
    expect(person?.alsoKnownAs).toEqual(['Priya', 'P. Sharma']);

    // The note itself self-heals to the CURRENT name on every rename...
    expect(second.notes[0]?.people).toEqual(['Priya Sharma']);

    // ...but a note that still says the very first name (a crew member's
    // untouched copy of notes.csv, never loaded into this session) resolves
    // via the accumulated alias trail rather than becoming unknown.
    const { ids, unknown } = resolvePersonNames(['Priya'], second.people);
    expect(ids).toEqual(['pixel8']);
    expect(unknown).toEqual([]);
  });

  /**
   * The chosen behaviour for a colliding rename: renaming pixel8's "Priya"
   * to "Sam" — zflip4's EXISTING name — must not make "Priya" (the vacated
   * name) resolve into limbo, but it especially must not push "Priya" as an
   * alias of nobody nor let the rename silently merge two people. What is
   * tested here is the OTHER direction, which is the actually dangerous one:
   * renaming AWAY FROM a name matches an already-existing person exactly
   * when the OLD name collides with someone else's current name/alias —
   * skip the alias and the note rewrite entirely, so neither person's
   * identity is disturbed by the other's edit.
   */
  it('on a colliding rename, skips the alias and the note rewrite rather than guessing', () => {
    const collidingPeople: Person[] = [
      { id: 'pixel8', name: 'Sam' }, // already named "Sam" before zflip4 is renamed to it below
      { id: 'zflip4', name: 'Sam' },
    ];
    const notes = [note({ people: ['Sam'] })];
    const { people, notes: rewritten, collided } = applyRename(collidingPeople, notes, 'zflip4', 'Samantha');

    expect(collided).toBe(true);
    // The rename itself still happens...
    expect(people.find((p) => p.id === 'zflip4')?.name).toBe('Samantha');
    // ...but no alias was recorded, because "Sam" already named someone else.
    expect(people.find((p) => p.id === 'zflip4')?.alsoKnownAs).toBeUndefined();
    // ...and the pre-existing note is untouched: it is ambiguous which "Sam"
    // it meant, so guessing (rewriting it to "Samantha") would silently
    // reattribute a note that may have belonged to pixel8's Sam.
    expect(rewritten[0]).toEqual(notes[0]);
  });

  // --- 2026-07-30 URGENT rename-corruption review -------------------------

  /**
   * Item 1 (keystroke safety) is a UI-layer fix in `IngestReport.tsx`
   * (`RenameInput` commits only on blur/Enter) — covered by
   * `tests/ingest-report-rename.test.tsx`, which mounts the real component.
   * The data-layer half pinned here is that `applyRename` itself refuses a
   * blank name outright, so even a caller that DID call it on every
   * keystroke could never write `also_known_as` garbage or blank out a
   * note's `people` entry the way the per-keystroke bug did.
   */
  it('refuses a blank or whitespace-only name, leaving people and notes untouched', () => {
    const notes = [note({ people: ['Priya'] })];

    for (const blank of ['', '   ', '\t']) {
      const result = applyRename(PEOPLE, notes, 'pixel8', blank);
      expect(result.refused).toBeDefined();
      expect(result.people).toEqual(PEOPLE);
      expect(result.notes).toEqual(notes);
    }
  });

  /**
   * Item 2: the original `applyRename` only ever checked the OLD name for a
   * collision (see the colliding-rename test above) — nothing stopped the
   * NEW name from being claimed too. `applyRename([{a,'Alice'},{b,'Bob'}],
   * ..., 'a', 'Bob')` used to return `collided: false` and produce two
   * people named "Bob", after which `resolvePersonNames(['Bob'])` resolves
   * to NEITHER (two claimants — see `resolvePersonNames`'s own "never
   * guesses" rule) — orphaning every note that ever mentioned either of
   * them, including ones that never involved the renamed person at all.
   */
  it('refuses a new name already claimed by a DIFFERENT person, leaving people and notes untouched', () => {
    const twoPeople: Person[] = [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
    ];
    const notes = [note({ id: 'n_a', people: ['Alice'] }), note({ id: 'n_b', people: ['Bob'] })];

    const result = applyRename(twoPeople, notes, 'a', 'Bob');

    expect(result.refused).toBeDefined();
    expect(result.people).toEqual(twoPeople);
    expect(result.notes).toEqual(notes);
    // Neither note orphaned: both names still resolve to exactly the right
    // person, which is the whole point of refusing rather than colliding.
    expect(resolvePersonNames(['Alice'], result.people).ids).toEqual(['a']);
    expect(resolvePersonNames(['Bob'], result.people).ids).toEqual(['b']);
  });

  /** Refusing must also cover a claim through an ALIAS, not just a current name. */
  it('refuses a new name already claimed by another person\'s also_known_as', () => {
    const aliased: Person[] = [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob', alsoKnownAs: ['Bobby'] },
    ];
    const result = applyRename(aliased, [], 'a', 'Bobby');
    expect(result.refused).toBeDefined();
    expect(result.people).toEqual(aliased);
  });

  /**
   * Item 3: the two-step swap `a -> Bob` then `b -> Alice` used to corrupt
   * both notes irreversibly — the first step rewrote person b's note to
   * "Bob" (self-heal, since "Bob" wasn't yet claimed), and the SECOND step
   * then reported `collided: true` (because "Alice" was now also nobody's
   * problem to detect) and skipped its own self-heal, leaving
   * `notes: [["Bob"], ["Bob"]]` with "Alice" resolving to nobody. Fixed by
   * item 2: the swap's first half is refused outright, so the second half
   * is never reached with corrupted state to build on.
   */
  it('refuses a name swap (a -> Bob, b -> Alice) outright rather than corrupting both notes', () => {
    const swapPeople: Person[] = [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
    ];
    const notes = [note({ id: 'n_a', people: ['Alice'] }), note({ id: 'n_b', people: ['Bob'] })];

    const first = applyRename(swapPeople, notes, 'a', 'Bob');
    expect(first.refused).toBeDefined();
    expect(first.people).toEqual(swapPeople);
    expect(first.notes).toEqual(notes);

    // Even attempting the second half against the ORIGINAL (unchanged)
    // state — the only state reachable, since the first half never
    // applied — it is refused too: "Alice" is still a's name.
    const second = applyRename(swapPeople, notes, 'b', 'Alice');
    expect(second.refused).toBeDefined();
    expect(second.people).toEqual(swapPeople);

    // Nothing corrupted: both names still resolve to the right person, and
    // neither note was rewritten to the other's name.
    expect(resolvePersonNames(['Alice'], swapPeople).ids).toEqual(['a']);
    expect(resolvePersonNames(['Bob'], swapPeople).ids).toEqual(['b']);
    expect(notes[0]?.people).toEqual(['Alice']);
    expect(notes[1]?.people).toEqual(['Bob']);
  });

  /**
   * Item 4: `;` is the list separator `also_known_as` and `notes*.csv`'s
   * `people`/`author` columns all use. A name containing one would silently
   * split into two entries the next time either file round-trips, so it is
   * refused at the point of entry rather than let in and mangled later.
   */
  it('refuses a new name containing ";"', () => {
    const result = applyRename(PEOPLE, [], 'pixel8', 'Jo; Chen');
    expect(result.refused).toBeDefined();
    expect(result.people).toEqual(PEOPLE);
  });

  /**
   * Item 5: pushing the vacated name onto `alsoKnownAs` must go through the
   * same self-alias/dedupe cleaning `parsePeopleCsv`/`formatPeopleCsv` apply
   * — renaming back and forth between the same two names must not pile up
   * duplicate aliases.
   */
  it('does not accumulate a duplicate alias when renaming back to a name already recorded as one', () => {
    const withAlias: Person[] = [{ id: 'pixel8', name: 'P. Sharma', alsoKnownAs: ['Priya'] }];
    // Renaming "P. Sharma" -> "Priya" would normally push "P. Sharma" onto
    // alsoKnownAs, but "Priya" (the destination) is also NOT its own alias —
    // and nothing here should duplicate the existing "Priya" entry either.
    const { people } = applyRename(withAlias, [], 'pixel8', 'Priya');
    const person = people.find((p) => p.id === 'pixel8');
    expect(person?.alsoKnownAs).toEqual(['P. Sharma']);
  });
});
