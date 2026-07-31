import { describe, expect, it } from 'vitest';
import {
  applyRename, displayName, displayRole, formatPeopleCsv, nameKey, parsePeopleCsv,
  pinLegacyRunners, resolvePersonNames,
} from '../src/core/people-csv.ts';
import {
  PEOPLE_CSV_BEFORE, PEOPLE_CSV_WITH_UNKNOWN_COLUMNS,
} from './fixtures/csv-before-2026-07-30.ts';
import type { Note } from '../src/core/notes.ts';
import type { Person } from '../src/core/schema.ts';
import { parseCsv } from '../src/core/csv.ts';

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
      'id,name,role,clock_offset,pinned\npixel8,Priya,runner,,\n',
    );
    // `pinned` is declared and blank, so the `runner` role pins nothing —
    // see `pinLegacyRunners` for the one case where a file with no `pinned`
    // column at all is migrated instead.
    expect(people[0]).toEqual({ id: 'pixel8', name: 'Priya', role: 'runner' });
  });

  it('reports a row with no id or name', () => {
    const { people, problems } = parsePeopleCsv('id,name\n,Nobody\npixel8,Priya\n');
    expect(people).toHaveLength(1);
    expect(problems).toHaveLength(1);
  });

  /**
   * A duplicated `id` still reaches `validateManifest` as an error that
   * refuses the WHOLE manifest — taking the crop, the course reference,
   * markers and every hand-placed time with it — so it is still caught here
   * and reported rather than passed through. See the duplicate-id tests
   * below.
   *
   * `role` used to be on that list and is not any more. It was checked
   * against a four-value enum and BLANKED when it did not match, which
   * against the owner's real roster meant `crew chief` and `pacer` were
   * erased by pressing Save. These pin the replacement: whatever is in the
   * cell is what comes back.
   */
  it('keeps a free-text role exactly as typed', () => {
    const { people, problems } = parsePeopleCsv(
      'id,name,role,pinned\np1,Dan,runner,1\np2,Ali,crew chief,\np3,Sam,pacer,\n',
    );
    expect(problems).toEqual([]);
    expect(people.map((p) => p.role)).toEqual(['runner', 'crew chief', 'pacer']);
  });

  /**
   * The exact file the owner had, and the exact failure: two of three roles
   * were refused to `undefined` with a problem reported, and ONE Save then
   * wrote both cells blank. The round trip is the assertion, not the read —
   * reading it correctly and writing it wrong is what actually happened.
   */
  it("round-trips the owner's own roles, 'crew chief' and 'pacer', through a save", () => {
    const csv = [
      'id,name,role,clock_offset,also_known_as,pinned,schema',
      'p1,Dan,runner,,,1,',
      'p2,Ali,crew chief,,,,',
      'p3,Sam,pacer,,,,',
      '',
    ].join('\n');
    const first = parsePeopleCsv(csv);
    expect(first.problems).toEqual([]);

    const written = formatPeopleCsv(first.people, first.extra, first.preserved);
    const rows = parseCsv(written).rows;
    expect(rows.map((r) => r['role'])).toEqual(['runner', 'crew chief', 'pacer']);
    expect(parsePeopleCsv(written).people).toEqual(first.people);
  });

  it('keeps a role no vocabulary would ever have listed', () => {
    const { people, problems } = parsePeopleCsv(
      'id,name,role,pinned\np1,Jo,mother of the bride,\n',
    );
    expect(problems).toEqual([]);
    expect(people[0]?.role).toBe('mother of the bride');
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
    const { people, problems } = parsePeopleCsv(
      'id,name,role,clock_offset,pinned\npixel8,Priya,runner,,\n',
    );
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

/**
 * `notes*.csv` has carried unknown columns since it was written
 * (`Note.extra`); `people.csv` did not, and a review verified a roster
 * carrying `pronouns`/`shirt` lost both on the next save. It matters more
 * than it looks: a build without this would delete the `schema` column too,
 * erasing the very marker the version check depends on.
 */
describe('people.csv keeps columns it does not understand', () => {
  it('carries them through a save, in the order first seen', () => {
    const { people, extra } = parsePeopleCsv(PEOPLE_CSV_WITH_UNKNOWN_COLUMNS);
    expect(extra.get('google-pixel-8-pro')).toEqual({ pronouns: 'she/her', shirt: 'M' });

    const written = formatPeopleCsv(people, extra);
    expect(parseCsv(written).headers)
      .toEqual([
        'id', 'name', 'role', 'clock_offset', 'also_known_as', 'pinned',
        'pronouns', 'shirt', 'schema',
      ]);
    const back = parsePeopleCsv(written);
    expect(back.extra.get('samsung-sm-f721w')).toEqual({ pronouns: 'they/them', shirt: 'L' });
    expect(back.people).toEqual(people);
  });

  it('never lets a stray column overwrite one this app owns', () => {
    const extra = new Map([['pixel8', { name: 'Impostor', schema: '99' }]]);
    const csv = formatPeopleCsv([{ id: 'pixel8', name: 'Priya' }], extra);
    const { people, problems } = parsePeopleCsv(csv);
    expect(problems).toEqual([]);
    expect(people[0]?.name).toBe('Priya');
  });

  it('drops nothing when no extras are passed at all', () => {
    // The common path: a roster assembled in memory, with no CSV behind it.
    expect(parsePeopleCsv(formatPeopleCsv(PEOPLE)).people).toEqual(PEOPLE);
  });
});

describe('the people.csv schema column', () => {
  it('is written last, after any columns someone else added', () => {
    const headers = parseCsv(formatPeopleCsv(PEOPLE)).headers;
    expect(headers[headers.length - 1]).toBe('schema');
    expect(parseCsv(formatPeopleCsv(PEOPLE)).rows[0]?.schema).toBe('1');
  });

  it('refuses a row written by a newer build, and keeps the rest of the file', () => {
    const { people, problems } = parsePeopleCsv(
      'id,name,schema\npixel8,Priya,\nzflip4,Sam,2\n',
    );
    expect(people.map((p) => p.id)).toEqual(['pixel8']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('people.csv');
    expect(problems[0]).toContain('Row 3');
  });

  it('reads a blank schema as "the version this reader knows"', () => {
    expect(parsePeopleCsv('id,name,schema\npixel8,Priya,\n').problems).toEqual([]);
  });
});

/**
 * `José` composed and `José` decomposed are visually identical and unequal as
 * strings. Verified failing in BOTH directions before this fix: a note naming
 * one form resolved to nobody when `people.csv` carried the other, so the
 * note silently left that person's lane.
 */
describe('names match across Unicode normalisation forms', () => {
  // Written as escapes, not as literal characters: the two are visually
  // identical, so a source file that got normalised by an editor would make
  // this whole block pass vacuously.
  const COMPOSED = 'Jos\u00e9';
  const DECOMPOSED = 'Jose\u0301';

  it('resolves a decomposed note name against a composed roster name', () => {
    const roster: Person[] = [{ id: 'p', name: COMPOSED }];
    expect(resolvePersonNames([DECOMPOSED], roster)).toEqual({ ids: ['p'], unknown: [] });
  });

  it('resolves a composed note name against a decomposed roster name', () => {
    const roster: Person[] = [{ id: 'p', name: DECOMPOSED }];
    expect(resolvePersonNames([COMPOSED], roster)).toEqual({ ids: ['p'], unknown: [] });
  });

  it('matches an alias across forms too', () => {
    const roster: Person[] = [{ id: 'p', name: 'Pixel 8', alsoKnownAs: [DECOMPOSED] }];
    expect(resolvePersonNames([COMPOSED], roster).ids).toEqual(['p']);
  });

  it('folds both forms to one key, which is what makes all of the above true', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    expect(nameKey(DECOMPOSED)).toBe(nameKey(COMPOSED));
  });

  it('still tells two genuinely different names apart', () => {
    const roster: Person[] = [{ id: 'p', name: COMPOSED }];
    expect(resolvePersonNames(['Jose'], roster)).toEqual({ ids: [], unknown: ['Jose'] });
  });
});

/**
 * Migration, pinned to a frozen copy of the file as it was written before the
 * 2026-07-30 change — see the fixture's header for why it must not be
 * regenerated.
 */
describe('a people.csv written before the schema column existed', () => {
  it('reads the same names, roles, aliases and clock offsets it always did', () => {
    const { people, problems, extra } = parsePeopleCsv(PEOPLE_CSV_BEFORE);
    expect(problems).toEqual([]);
    expect(extra.size).toBe(0);
    expect(people).toEqual([
      {
        id: 'google-pixel-8-pro',
        name: 'Priya',
        role: 'runner',
        alsoKnownAs: ['Google Pixel 8 Pro'],
        // The ONE thing that reads differently than it did, and deliberately:
        // this file predates the `pinned` column, so `role: runner` is the
        // only record it has of whose lane went on top. Dropping that would
        // silently demote the runner on a file nobody touched. See
        // `pinLegacyRunners`, and the two tests below for the boundary.
        pinned: true,
      },
      { id: 'samsung-sm-f721w', name: 'Sam', clockOffset: '-PT4S' },
    ]);
  });

  it('repairs itself into the new shape on the first save, losing nothing', () => {
    const { people, extra } = parsePeopleCsv(PEOPLE_CSV_BEFORE);
    const written = formatPeopleCsv(people, extra);
    expect(written).toContain('schema');
    // The migration is written down, not re-derived: `pinned` is now a real
    // column carrying `1`, so the roster no longer depends on the word
    // "runner" appearing in a role cell.
    expect(parseCsv(written).rows.map((r) => r['pinned'])).toEqual(['1', '']);
    expect(parsePeopleCsv(written).people).toEqual(people);
  });
});

/**
 * The migration boundary, both directions. Getting either wrong is silent:
 * one demotes the runner on every file written to date, the other overrides
 * an author who deliberately unpinned somebody.
 */
describe('pinned', () => {
  it('pins a legacy role: runner when the file has no pinned column at all', () => {
    const { people } = parsePeopleCsv('id,name,role\np1,Priya,Runner\np2,Sam,crew\n');
    // Case-insensitive: `Runner` in a sentence-cased column is the same
    // person as `runner`.
    expect(people.map((p) => p.pinned)).toEqual([true, undefined]);
  });

  it('does NOT pin a role: runner once the file declares a pinned column', () => {
    // An author who unpins the runner must not have it forced back on by
    // their own role cell. The decision is per FILE, never per row.
    const { people } = parsePeopleCsv('id,name,role,pinned\np1,Priya,runner,\np2,Sam,crew,1\n');
    expect(people.map((p) => p.pinned)).toEqual([undefined, true]);
  });

  it('writes the integer 1 and a blank, never true/false', () => {
    // No format survives a spreadsheet except a plain integer, and a
    // boolean-looking cell is exactly what Excel rewrites and localises.
    const written = formatPeopleCsv([
      { id: 'p1', name: 'Priya', pinned: true },
      { id: 'p2', name: 'Sam' },
    ]);
    expect(parseCsv(written).rows.map((r) => r['pinned'])).toEqual(['1', '']);
    expect(written).not.toMatch(/true/i);
  });

  it('reads a hand-typed flag rather than erasing it on the next save', () => {
    // Someone editing by hand writes whatever their spreadsheet offers. A
    // value this build could not interpret would be rewritten blank on the
    // next Save — the same loss the role column was just rescued from.
    const { people } = parsePeopleCsv(
      'id,name,pinned\np1,A,TRUE\np2,B,yes\np3,C,x\np4,D,0\np5,E,false\np6,F,\n',
    );
    expect(people.map((p) => p.pinned)).toEqual([true, true, true, undefined, undefined, undefined]);
  });

  it('migrates a roster taken from a manifest the same way, keyed on any pinned field', () => {
    // The second call site (`ingestFolder`): a manifest.json has no header
    // row, so "did this source say anything about pinning" is asked of the
    // objects instead. Same rule, same function.
    const legacy: Person[] = [
      { id: 'p1', name: 'Priya', role: 'runner' },
      { id: 'p2', name: 'Sam', role: 'crew' },
    ];
    expect(pinLegacyRunners(legacy, false).map((p) => p.pinned)).toEqual([true, undefined]);
    // Someone already unpinned in a manifest that knows about the field.
    const modern: Person[] = [
      { id: 'p1', name: 'Priya', role: 'runner' },
      { id: 'p2', name: 'Sam', role: 'crew', pinned: true },
    ];
    expect(pinLegacyRunners(modern, true).map((p) => p.pinned)).toEqual([undefined, true]);
  });

  it('round-trips several pinned people', () => {
    const wedding: Person[] = [
      { id: 'bride', name: 'Bride', role: 'bride', pinned: true },
      { id: 'groom', name: 'Groom', role: 'groom', pinned: true },
      { id: 'guest', name: 'Guest' },
    ];
    expect(parsePeopleCsv(formatPeopleCsv(wedding)).people).toEqual(wedding);
  });
});

describe('displayRole', () => {
  it('capitalises the first letter only, so "crew chief" is not "Crew Chief"', () => {
    expect(displayRole('crew chief')).toBe('Crew chief');
  });

  it('never lowercases the rest, so an initialism survives', () => {
    expect(displayRole('DJI operator')).toBe('DJI operator');
    expect(displayRole('MC')).toBe('MC');
  });

  it('is blank for a blank or absent role, so nothing renders', () => {
    expect(displayRole(undefined)).toBe('');
    expect(displayRole('   ')).toBe('');
  });

  it('trims, and leaves an already-capitalised role alone', () => {
    expect(displayRole('  pacer ')).toBe('Pacer');
    expect(displayRole('Pacer')).toBe('Pacer');
  });
});

/**
 * A roster row this build refuses is not a roster row it may delete.
 *
 * The same failure as `notes.csv`: a `people.csv` row carrying `schema,2` was
 * reported at load and then absent from the file the next Save wrote — so the
 * person it named was off disk entirely, clock offset and all, one button
 * press after being told to "update the site".
 */
describe('roster rows this build cannot read are kept, not dropped', () => {
  const HEADER = 'id,name,role,clock_offset,also_known_as,schema';

  it('keeps a row from a newer build, and writes it back after the roster', () => {
    const text = [HEADER, 'p1,Priya,,,,', 'p2,Sam,,,,2'].join('\n');
    const { people, preserved, problems } = parsePeopleCsv(text);

    expect(people.map((p) => p.id)).toEqual(['p1']);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.file).toBe('people.csv');
    expect(preserved[0]?.line).toBe(3);
    expect(preserved[0]?.cells['id']).toBe('p2');
    expect(preserved[0]?.cells['schema']).toBe('2');
    expect(problems[0]).toContain('kept exactly as it is');

    const written = formatPeopleCsv(people, undefined, preserved);
    const rows = parseCsv(written).rows;
    expect(rows.map((r) => r['id'])).toEqual(['p1', 'p2']);
    // Verbatim: the schema cell is NOT rewritten to this build's version,
    // which would be this build claiming it understood the row.
    expect(rows[1]?.['schema']).toBe('2');
    expect(rows[1]?.['name']).toBe('Sam');
  });

  it('keeps a row missing an id or a name, and a duplicated id', () => {
    const text = [HEADER, 'p1,Priya,,,,', ',Nobody,,,,', 'p1,Twin,,,,'].join('\n');
    const { people, preserved } = parsePeopleCsv(text);
    expect(people.map((p) => p.id)).toEqual(['p1']);
    expect(preserved.map((p) => p.cells['name'])).toEqual(['Nobody', 'Twin']);
  });

  it('does NOT preserve a row it kept and merely degraded', () => {
    // An unparseable clock_offset keeps the person and drops that one field,
    // so preserving the raw row too would write that person into the file
    // twice. (This used to be demonstrated with an unrecognised `role`;
    // there is no such thing now — a role is free text.)
    const text = [HEADER, 'p1,Priya,sherpa,forty-seven seconds,,'].join('\n');
    const { people, problems, preserved } = parsePeopleCsv(text);
    expect(people).toEqual([{ id: 'p1', name: 'Priya', role: 'sherpa' }]);
    expect(problems).toHaveLength(1);
    expect(preserved).toEqual([]);
  });

  it('carries a column only a preserved row has into the header row', () => {
    const text = ['id,name,role,clock_offset,also_known_as,schema,pace', 'p2,Sam,,,,2,slow'].join('\n');
    const { people, preserved } = parsePeopleCsv(text);
    const written = formatPeopleCsv(people, undefined, preserved);
    expect(parseCsv(written).headers).toContain('pace');
    expect(parseCsv(written).rows[0]?.['pace']).toBe('slow');
  });

  it('round-trips: reading what was written preserves it again, unchanged', () => {
    // The property that matters over months of saving: a row nobody has
    // repaired must survive every save, not just the first.
    const text = [HEADER, 'p1,Priya,,,,', 'p2,Sam,,,,2'].join('\n');
    const first = parsePeopleCsv(text);
    const once = formatPeopleCsv(first.people, undefined, first.preserved);
    const second = parsePeopleCsv(once);
    const twice = formatPeopleCsv(second.people, undefined, second.preserved);
    expect(twice).toBe(once);
    // Stable is not enough on its own — dropping the row on the first save is
    // also perfectly stable. The row has to still be there.
    expect(twice).toContain('Sam');
    expect(second.preserved).toHaveLength(1);
  });
});

describe('a rename that hands the old name to somebody else', () => {
  const contested = (): Person[] => [
    { id: 'p1', name: 'Bob' },
    { id: 'p2', name: 'Rob', alsoKnownAs: ['Bob'] },
  ];
  const note = (people: string[]): Note => ({
    id: 'n_1', at: '2026-07-25T10:00:00Z', people, author: [], text: 'x',
  });

  it('reports the reassignment rather than performing it silently', () => {
    // While both claim "Bob", `resolvePersonNames` refuses to guess and the
    // note resolves to neither — visible, and correct. Renaming p1 ends the
    // contest, so the note silently moves into p2's lane without anything
    // being written to make that happen.
    expect(resolvePersonNames(['Bob'], contested()).unknown).toEqual(['Bob']);

    const result = applyRename(contested(), [note(['Bob'])], 'p1', 'Robert');
    expect(result.collided).toBe(true);
    expect(result.reassigned).toBeDefined();
    expect(result.reassigned).toContain('Bob');
    expect(result.reassigned).toContain('Rob');
    expect(result.reassigned).toContain('Robert');

    // And the reassignment really does happen — which is why it is reported.
    expect(resolvePersonNames(['Bob'], result.people).ids).toEqual(['p2']);
  });

  it('says nothing when no loaded note refers to the contested name', () => {
    const result = applyRename(contested(), [note(['Rob'])], 'p1', 'Robert');
    expect(result.collided).toBe(true);
    expect(result.reassigned).toBeUndefined();
  });

  it('says nothing on an ordinary rename, where nobody else wanted the name', () => {
    const people: Person[] = [{ id: 'p1', name: 'Bob' }, { id: 'p2', name: 'Rob' }];
    const result = applyRename(people, [note(['Bob'])], 'p1', 'Robert');
    expect(result.collided).toBe(false);
    expect(result.reassigned).toBeUndefined();
    // The ordinary path still self-heals: alias recorded, note rewritten.
    expect(result.people[0]?.alsoKnownAs).toEqual(['Bob']);
    expect(result.notes[0]?.people).toEqual(['Robert']);
  });

  it('counts an author mention too, not only a people mention', () => {
    const authored: Note = {
      id: 'n_2', at: '2026-07-25T10:00:00Z', people: [], author: ['bob'], text: 'x',
    };
    expect(applyRename(contested(), [authored], 'p1', 'Robert').reassigned).toBeDefined();
  });
});
