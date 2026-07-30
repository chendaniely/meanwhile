/**
 * Roster as CSV.
 *
 * Renaming a device to a person is exactly a spreadsheet job. Notes refer to
 * people by name, matched case-insensitively, and an unrecognised name is kept
 * rather than dropping the note it appears on.
 *
 * `also_known_as` is what keeps that join alive across a rename: `notes.csv`
 * cannot hold an id (it has to stay readable and editable as a plain
 * spreadsheet, which is the entire reason notes are CSV rather than JSON), so
 * when the owner renames "Google Pixel 8 Pro" to "Priya", the OLD name has to
 * keep resolving or every note already written under it orphans silently.
 * `applyRename` below is what populates this column, from the site's rename
 * UI (`App.tsx`'s `renamePerson`); `resolvePersonNames` is what reads it back.
 */

import { displayNameFor } from './assemble.ts';
import { parseCsv, formatCsv } from './csv.ts';
import type { Note } from './notes.ts';
import { ROLES, type Person, type PersonId, type Role } from './schema.ts';
import { parseDuration } from './time.ts';

export const PEOPLE_HEADERS = ['id', 'name', 'role', 'clock_offset', 'also_known_as'] as const;

/**
 * `;`-separated list convention, identical to `people`/`author` in
 * `notes*.csv` (see `splitList` in `core/notes.ts`) — not shared code, since
 * each module stays a small, independently-readable file per this project's
 * "no CSV library" choice, but deliberately the same behavior: trimmed,
 * blanks dropped, so a trailing `;` or doubled `;;` from a spreadsheet edit
 * does not produce a phantom empty alias.
 */
function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * A name or alias containing a literal `;` would silently split into two
 * entries the next time this file's `also_known_as` column (or a note's
 * `people`/`author` column) round-trips through `splitList` — the exact
 * corruption a 2026-07-30 review found live against real data. There is no
 * escaping scheme for it (that would change the file format, which is
 * currently being assessed for permanence elsewhere), so a `;` is refused at
 * the one place new data enters through a person, rather than allowed in and
 * silently mangled on the next save. See `applyRename` and
 * `PersonPicker.tsx`, the two entry points that call this.
 */
export function hasSemicolon(raw: string): boolean {
  return raw.includes(';');
}

/**
 * Drop any alias that case-insensitively equals the person's OWN `name` (a
 * name is not its own alias — `p,,Priya;PJ` must not parse to
 * `alsoKnownAs: ['Priya', 'PJ']` with `name: 'Priya'` already redundant in
 * it), and dedupe the rest case-insensitively, preserving the first-seen
 * spelling (`Sam;sam` keeps only `Sam`).
 *
 * Applied on both parse (`parsePeopleCsv`) and write (`formatPeopleCsv`), and
 * also by `applyRename` when it pushes a vacated name onto `alsoKnownAs` —
 * three different places an alias list can pick up a redundant or duplicate
 * entry, and all three must stay clean the same way.
 */
function cleanAliases(name: string, aliases: readonly string[]): string[] {
  const nameKey = name.trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (key === nameKey || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

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
  const { rows, rowLines } = parseCsv(text);
  const people: Person[] = [];
  const problems: string[] = [];
  const seenIds = new Set<string>();

  rows.forEach((row, i) => {
    // The row's real file line, not `i + 2`: `parseCsv` drops blank lines
    // rather than emitting empty rows for them, so a blank line anywhere
    // above this one would make that arithmetic understate every message
    // below it. `rowLines[i]` is never actually missing — it is built in
    // lockstep with `rows` — the fallback only satisfies the type checker.
    const line = rowLines[i] ?? i + 2;
    const id = row['id']?.trim();
    const nameCell = row['name']?.trim();
    const rawAlsoKnownAs = splitList(row['also_known_as']);
    // A row that lost its `name` cell (a spreadsheet slip, or a row someone
    // hand-added with only an alias) still has something to call the person
    // by if it carries at least one alias — so it is not the same failure as
    // having neither. Row is kept, and `name` starts equal to that alias
    // (the same value `displayName` below would fall back to anyway) rather
    // than dropping a roster row, and the lane it owns, entirely.
    let name = nameCell || rawAlsoKnownAs[0];

    if (!id || !name) {
      const missing = [!id && 'id', !name && 'name'].filter(Boolean).join(' and ');
      problems.push(`Row ${line}: missing ${missing}`);
      return;
    }

    // A `;` in `name` is legal in this one cell on its own (a plain CSV
    // value, not a list), but it becomes dangerous the moment this name is
    // later used as an alias or matched against a note's `people`/`author`
    // column — both `;`-separated lists. Reported and repaired here, the
    // same way an unrecognised `role` is: the row survives, the one bad
    // field is degraded and named.
    if (hasSemicolon(name)) {
      const repaired = name.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
      problems.push(
        `Row ${line}: name "${name}" contains ";", which this file uses as a list separator; saved as "${repaired}"`,
      );
      name = repaired;
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

    // Dropped here rather than trusted from `splitList` alone: a hand-edited
    // row easily ends up with the name ALSO listed as its own alias (the
    // `name` fallback above does this on purpose when there is no `name`
    // cell), or the same alias typed twice under different casing. Both are
    // redundant, not wrong, but "the name is also an alias" is exactly the
    // self-alias bug a 2026-07-30 review found — see `cleanAliases`.
    const alsoKnownAs = cleanAliases(name, rawAlsoKnownAs);
    if (alsoKnownAs.length > 0) person.alsoKnownAs = alsoKnownAs;

    seenIds.add(id);
    people.push(person);
  });

  return { people, problems };
}

/**
 * Format Person objects into a CSV roster.
 *
 * Maps `clockOffset` to `clock_offset` column name for CSV spreadsheet use,
 * and `alsoKnownAs` to `also_known_as`, joined the same `;`-separated way
 * `notes*.csv` joins `people`/`author`. Run through `cleanAliases` on the way
 * out too, not just on the way in — a roster built up in memory (a rename, a
 * merge) can accumulate the same self-alias or duplicate a parsed file can,
 * and the write path is the last chance to keep the saved file clean.
 */
export function formatPeopleCsv(people: readonly Person[]): string {
  const rows = people.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role ?? '',
    clock_offset: p.clockOffset ?? '',
    also_known_as: cleanAliases(p.name, p.alsoKnownAs ?? []).join(';'),
  }));

  return formatCsv(PEOPLE_HEADERS, rows);
}

/**
 * The name to show for a person, in the order the owner asked for: their
 * current `name`; if that is blank, their first `also_known_as` entry (a
 * hand-added roster row with only an alias must still label its lane rather
 * than showing blank); if THAT is also absent, the same device-slug
 * prettifier `assembleManifest` uses for a person nobody has named yet.
 *
 * The one function this fallback chain lives in — every place a person's
 * name renders reads through here rather than `person.name` directly, so the
 * fallback cannot drift out of step between the swimlanes, the feed, the
 * note list, the map, and the roster editor.
 */
export function displayName(person: Person): string {
  const name = person.name.trim();
  if (name !== '') return name;
  const aka = (person.alsoKnownAs ?? []).find((a) => a.trim() !== '');
  if (aka !== undefined) return aka.trim();
  return displayNameFor(person.id);
}

/**
 * Resolve person names to IDs, matching case-insensitively and trimming
 * surrounding whitespace, against a person's current `name` OR any of their
 * `alsoKnownAs` entries.
 *
 * The alias match is what makes a rename non-destructive: `notes*.csv` from
 * before the rename — a crew member's own copy, or a note nobody has
 * re-saved yet — still says "Google Pixel 8 Pro", and that string keeps
 * resolving to the same person after they become "Priya" because the old
 * name lives on in `alsoKnownAs`.
 *
 * Returns matched IDs and a list of unrecognised names. Unrecognised names are
 * kept rather than dropped, so a note on an unknown person is not lost.
 *
 * **A name or alias claimed by more than one person is never guessed at.**
 * Two different people should not end up sharing a resolvable name — the
 * site's own rename tool checks for this before recording an alias (see
 * `renamePerson` in `App.tsx`) — but nothing stops two hand-edited
 * `people.csv` rows from doing it anyway, and the failure mode of GUESSING
 * which one a colliding name means is silently attaching a note to the wrong
 * person. That is worse than leaving it unresolved, the same call this
 * project already makes for an ambiguous `photo` filename in
 * `resolveNotePhotos` (`core/notes.ts`) — so a colliding key resolves to
 * neither id and the name is reported as unknown instead.
 */
export function resolvePersonNames(
  names: readonly string[],
  people: readonly Person[],
): { ids: PersonId[]; unknown: string[] } {
  const ids: PersonId[] = [];
  const unknown: string[] = [];

  // Build a case-insensitive lookup map from every name AND alias to a
  // person's id — `null` marks a key two different people have claimed, so
  // it is never matched to either.
  const nameMap = new Map<string, PersonId | null>();
  for (const person of people) {
    const keys = [person.name, ...(person.alsoKnownAs ?? [])];
    for (const raw of keys) {
      const key = raw.toLowerCase().trim();
      if (key === '') continue;
      const claimedBy = nameMap.get(key);
      if (claimedBy === undefined) {
        nameMap.set(key, person.id);
      } else if (claimedBy !== null && claimedBy !== person.id) {
        nameMap.set(key, null);
      }
      // claimedBy === person.id (e.g. name equals one of their own aliases)
      // or already null: no change needed either way.
    }
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

export interface RenameResult {
  people: Person[];
  notes: Note[];
  /**
   * True when the old name was already shared with a DIFFERENT person (their
   * current `name` or one of their own aliases), so the alias and the note
   * rewrite were both skipped. Recording the alias anyway would make that
   * other person's name ambiguous too — the exact case `resolvePersonNames`
   * above refuses to guess through — and rewriting notes under a name two
   * people share cannot tell which one a given note meant. The rename to
   * the new name always happens regardless; only the self-heal is skipped.
   *
   * Distinct from `refused` below: this is about the OLD name colliding,
   * which still lets the rename itself through. `refused` is about the NEW
   * name, and blocks everything.
   */
  collided: boolean;
  /**
   * Set — and `people`/`notes` returned byte-for-byte UNCHANGED — when the
   * rename could not be applied at all: a blank name, a name containing
   * `;` (the list separator `also_known_as` and `notes*.csv`'s
   * `people`/`author` columns all use), or a name already claimed by a
   * DIFFERENT person's `name` or `alsoKnownAs`.
   *
   * Found live against real race data (2026-07-30): a per-keystroke rename
   * with no blank-name guard put `also_known_as` through 19 single- and
   * two-character garbage aliases, and an unchecked new-name collision let
   * two people end up named "Bob" with `resolvePersonNames` then resolving
   * "Bob" to NEITHER — orphaning every note on both of them. This is the
   * fix: the operation is now total. It either applies in full (name, alias,
   * note rewrite) or does nothing, and says why via this string so the
   * rename UI (`IngestReport.tsx`) can show it instead of silently no-op'ing.
   */
  refused?: string;
}

/**
 * Rename a person everywhere a rename has to reach, non-destructively:
 *
 * 1. Sets the new `name`.
 * 2. Pushes the PREVIOUS name onto `alsoKnownAs` (cleaned via
 *    `cleanAliases` — no duplicates, and dropped outright if it equals the
 *    new name or the person had no name yet), so `resolvePersonNames` keeps
 *    resolving a `notes.csv` — a crew member's own copy, or one nobody has
 *    re-saved since the rename — that still uses it.
 * 3. Rewrites that exact name to the new one, case-insensitively, in every
 *    LOADED note's `people` and `author` lists, so `notes.csv` self-heals to
 *    current names on the next Save instead of freezing on the old one
 *    forever.
 *
 * Both (2) and (3) cover a different failure — a file the app has not
 * loaded yet, versus one already in memory — and neither substitutes for the
 * other; see the module-level rename record in CLAUDE.md.
 *
 * Before any of that, three checks can refuse the whole operation outright —
 * see `RenameResult.refused`. Callers MUST be prepared for a no-op: the
 * caller in this codebase (`renamePerson` in `App.tsx`) is only ever invoked
 * on a COMMITTED edit (blur or Enter in `IngestReport.tsx`'s rename box, not
 * on every keystroke), which is what makes "sometimes refuses and does
 * nothing" a normal, showable outcome rather than something a user would hit
 * mid-type.
 *
 * Pure and independent of React, so it is unit-testable with plain
 * `Person[]`/`Note[]` — `App.tsx`'s `renamePerson` is a thin wrapper that
 * calls this and writes the two results into `manifest.people` and the live
 * `notes` state respectively.
 */
export function applyRename(
  people: readonly Person[],
  notes: readonly Note[],
  id: PersonId,
  name: string,
): RenameResult {
  const unchanged = { people: [...people], notes: [...notes], collided: false };

  const person = people.find((p) => p.id === id);
  if (!person) return unchanged;

  const nextTrimmed = name.trim();

  if (nextTrimmed === '') {
    return { ...unchanged, refused: 'A person must always have a name.' };
  }
  if (hasSemicolon(nextTrimmed)) {
    return {
      ...unchanged,
      refused:
        'Names can’t contain ";" — that character separates names in notes.csv and ' +
        'people.csv, so one in a name would silently corrupt both the next time either is saved.',
    };
  }
  const newKey = nextTrimmed.toLowerCase();
  const newNameClaimedByOther = people.some(
    (p) =>
      p.id !== id &&
      (p.name.trim().toLowerCase() === newKey || (p.alsoKnownAs ?? []).some((a) => a.trim().toLowerCase() === newKey)),
  );
  if (newNameClaimedByOther) {
    return { ...unchanged, refused: `"${nextTrimmed}" is already someone else's name.` };
  }

  const previousName = person.name.trim();
  const previousKey = previousName.toLowerCase();
  const renamed = previousName !== '' && previousKey !== newKey;
  const collided =
    renamed &&
    people.some(
      (p) =>
        p.id !== id &&
        (p.name.trim().toLowerCase() === previousKey ||
          (p.alsoKnownAs ?? []).some((a) => a.trim().toLowerCase() === previousKey)),
    );
  const selfHeal = renamed && !collided;

  const nextPeople = people.map((p) => {
    if (p.id !== id) return p;
    const next: Person = { ...p, name: nextTrimmed };
    if (selfHeal) {
      const akas = cleanAliases(nextTrimmed, [...(p.alsoKnownAs ?? []), previousName]);
      if (akas.length > 0) next.alsoKnownAs = akas;
      else delete next.alsoKnownAs;
    }
    return next;
  });

  if (!selfHeal) return { people: nextPeople, notes: [...notes], collided };

  const rewrite = (list: readonly string[]): string[] =>
    list.map((v) => (v.trim().toLowerCase() === previousKey ? nextTrimmed : v));

  const nextNotes = notes.map((n) => {
    const nextPeopleList = rewrite(n.people);
    const nextAuthorList = rewrite(n.author);
    const same =
      nextPeopleList.every((v, i) => v === n.people[i]) &&
      nextAuthorList.every((v, i) => v === n.author[i]);
    return same ? n : { ...n, people: nextPeopleList, author: nextAuthorList };
  });

  return { people: nextPeople, notes: nextNotes, collided };
}
