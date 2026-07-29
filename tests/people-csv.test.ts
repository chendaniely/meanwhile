import { describe, expect, it } from 'vitest';
import {
  formatPeopleCsv, parsePeopleCsv, resolvePersonNames,
} from '../src/core/people-csv.ts';
import type { Person } from '../src/core/schema.ts';

const PEOPLE: Person[] = [
  { id: 'pixel8', name: 'Priya', role: 'runner' },
  { id: 'zflip4', name: 'Sam', clockOffset: 'PT-4S' },
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
