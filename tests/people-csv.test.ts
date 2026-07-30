import { describe, expect, it } from 'vitest';
import {
  formatPeopleCsv, parsePeopleCsv, resolvePersonNames,
} from '../src/core/people-csv.ts';
import type { Person } from '../src/core/schema.ts';

const PEOPLE: Person[] = [
  { id: 'pixel8', name: 'Priya', role: 'runner' },
  // A valid ISO-8601 duration: the sign precedes "P", not "T" — "PT-4S" is
  // not actually parseable by `parseDuration` and used to round-trip here
  // unvalidated. Now that `parsePeopleCsv` validates with `parseDuration`
  // (finding 4), an invalid one is dropped and reported rather than kept.
  { id: 'zflip4', name: 'Sam', clockOffset: '-PT4S' },
];

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
});
