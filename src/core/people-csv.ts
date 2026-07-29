/**
 * Roster as CSV.
 *
 * Renaming a device to a person is exactly a spreadsheet job. Notes refer to
 * people by name, matched case-insensitively, and an unrecognised name is kept
 * rather than dropping the note it appears on.
 */

import { parseCsv, formatCsv } from './csv.ts';
import type { Person, PersonId } from './schema.ts';

export const PEOPLE_HEADERS = ['id', 'name', 'role', 'clock_offset'] as const;

/**
 * Parse a CSV roster into Person objects.
 *
 * A row missing `id` or `name` becomes a problem string rather than a person.
 * Optional fields like `role` and `clockOffset` are omitted when blank — an
 * empty string would fail the manifest validator.
 */
export function parsePeopleCsv(text: string): { people: Person[]; problems: string[] } {
  const { rows } = parseCsv(text);
  const people: Person[] = [];
  const problems: string[] = [];

  rows.forEach((row, i) => {
    const id = row['id']?.trim();
    const name = row['name']?.trim();

    // Check for missing id or name
    if (!id || !name) {
      problems.push(`Row ${i + 2}: missing ${!id ? 'id' : ''} ${!name ? 'name' : ''}`.trim());
      return;
    }

    // Build object incrementally to omit optional fields when blank
    // (exactOptionalPropertyTypes forbids setting them to undefined).
    interface PersonBuilder {
      id: string;
      name: string;
      role?: any;
      clockOffset?: string;
    }
    const person: PersonBuilder = { id, name };

    // Add role if present
    const roleStr = row['role']?.trim();
    if (roleStr) {
      person.role = roleStr;
    }

    // Add clockOffset if present (mapped from clock_offset column)
    const clockOffset = row['clock_offset']?.trim();
    if (clockOffset) {
      person.clockOffset = clockOffset;
    }

    people.push(person as Person);
  });

  return { people, problems };
}

/**
 * Format Person objects into a CSV roster.
 *
 * Maps `clockOffset` to `clock_offset` column name for CSV spreadsheet use.
 */
export function formatPeopleCsv(people: readonly Person[]): string {
  const rows = people.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role ?? '',
    clock_offset: p.clockOffset ?? '',
  }));

  return formatCsv(PEOPLE_HEADERS, rows);
}

/**
 * Resolve person names to IDs, matching case-insensitively and trimming
 * surrounding whitespace.
 *
 * Returns matched IDs and a list of unrecognised names. Unrecognised names are
 * kept rather than dropped, so a note on an unknown person is not lost.
 */
export function resolvePersonNames(
  names: readonly string[],
  people: readonly Person[],
): { ids: PersonId[]; unknown: string[] } {
  const ids: PersonId[] = [];
  const unknown: string[] = [];

  // Build a case-insensitive lookup map
  const nameMap = new Map<string, PersonId>();
  for (const person of people) {
    const key = person.name.toLowerCase().trim();
    nameMap.set(key, person.id);
  }

  for (const name of names) {
    const normalized = name.toLowerCase().trim();
    const id = nameMap.get(normalized);
    if (id) {
      ids.push(id);
    } else {
      unknown.push(name);
    }
  }

  return { ids, unknown };
}
