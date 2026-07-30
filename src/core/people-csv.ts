/**
 * Roster as CSV.
 *
 * Renaming a device to a person is exactly a spreadsheet job. Notes refer to
 * people by name, matched case-insensitively, and an unrecognised name is kept
 * rather than dropping the note it appears on.
 */

import { parseCsv, formatCsv } from './csv.ts';
import { ROLES, type Person, type PersonId, type Role } from './schema.ts';
import { parseDuration } from './time.ts';

export const PEOPLE_HEADERS = ['id', 'name', 'role', 'clock_offset'] as const;

/**
 * Parse a CSV roster into Person objects.
 *
 * There is deliberately no local interface describing a "person row" —
 * `Person` from `schema.ts` is the one and only notion of what a person is,
 * per the project's architecture rule. A row that cannot satisfy that shape
 * becomes a problem string, or has the one bad field dropped and reported,
 * rather than a value the validator would later reject wholesale. That
 * matters because `validateManifest` refuses the ENTIRE manifest on one bad
 * `role` or one duplicated `id` — silently letting either through here would
 * corrupt `manifest.json` on the next save and lose the crop, the course
 * reference, and every hand-placed time on the next open.
 */
export function parsePeopleCsv(text: string): { people: Person[]; problems: string[] } {
  const { rows } = parseCsv(text);
  const people: Person[] = [];
  const problems: string[] = [];
  const seenIds = new Set<string>();

  rows.forEach((row, i) => {
    const line = i + 2; // header is row 1; spreadsheets are 1-indexed.
    const id = row['id']?.trim();
    const name = row['name']?.trim();

    if (!id || !name) {
      const missing = [!id && 'id', !name && 'name'].filter(Boolean).join(' and ');
      problems.push(`Row ${line}: missing ${missing}`);
      return;
    }
    // A duplicated id is the other way this file corrupts the manifest:
    // `validateManifest` refuses two people sharing an id, so letting a
    // second row with the same id through would take the whole manifest down
    // with it on the next save. Keep the first row, drop the rest, say so.
    if (seenIds.has(id)) {
      problems.push(`Row ${line}: id "${id}" is already used by an earlier row; this row was skipped`);
      return;
    }

    // Built incrementally to omit optional fields when blank or invalid
    // (exactOptionalPropertyTypes forbids setting them to undefined).
    const person: Person = { id, name };

    const roleStr = row['role']?.trim();
    if (roleStr) {
      if ((ROLES as readonly string[]).includes(roleStr)) {
        person.role = roleStr as Role;
      } else {
        problems.push(
          `Row ${line}: role "${roleStr}" is not one of ${ROLES.join(', ')}; left blank rather than saved wrong`,
        );
      }
    }

    const clockOffsetStr = row['clock_offset']?.trim();
    if (clockOffsetStr) {
      if (parseDuration(clockOffsetStr) !== null) {
        person.clockOffset = clockOffsetStr;
      } else {
        problems.push(
          `Row ${line}: clock_offset "${clockOffsetStr}" is not an ISO-8601 duration (e.g. "-PT47S"); left blank`,
        );
      }
    }

    seenIds.add(id);
    people.push(person);
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
