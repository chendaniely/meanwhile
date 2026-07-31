/**
 * `placements.csv` — the corrections somebody made by hand to what meanwhile
 * worked out from the files themselves.
 *
 * **A correction, not a record.** `assembleManifest` (`./assemble.ts`) re-derives
 * every item from the bytes on disk every time a folder is opened: who took it,
 * when it was taken, where its timestamp came from. Two of those facts cannot be
 * re-derived from a file that does not carry them, and this is where they live:
 *
 *   1. **A hand-placed time** — `timeSource: 'manual'` plus an `at` — for media
 *      whose file says nothing about when it was taken. Today that survives a
 *      re-ingest only through `AssembleOptions.existingItems`, i.e. only while a
 *      previous `manifest.json` is around to carry it; with no manifest, the
 *      placement is simply gone.
 *   2. **A corrected `person`.** Device grouping is a guess (see `groupByDevice`)
 *      and the author is the only one who knows whose phone was whose — but
 *      nothing carries that correction at all, so it is **destroyed silently on
 *      the next open**. Fixing that is half the reason this file exists.
 *
 * **One row per corrected item, never one per photograph.** The file starts
 * empty and stays empty until there is something to correct. It is not an
 * inventory: a folder of 231 photographs that nobody has argued with produces a
 * `placements.csv` with no rows in it.
 *
 * **The seven timestamp columns are `notes*.csv`'s, unprefixed** — `year, month,
 * day, hour, minute, tz, utc_offset_min` — resolved through `resolveZoned` in
 * `./wallclock.ts`, the one implementation of that ladder, so a placement's
 * 01:30 and a note's 01:30 cannot land an hour apart. Five bare integers because
 * no other format survives a spreadsheet (see CLAUDE.md, "the timestamp is five
 * integers, not one string"), and the `tz`/`utc_offset_min` pair because neither
 * is sufficient alone. There is no `second`: these are times a person types.
 *
 * **`person` is a NAME, not an id**, and it goes through `resolvePersonNames`
 * so aliases work. `notes*.csv` stores people as names deliberately — the whole
 * reason these files are CSV is that they stay editable by hand, and nobody
 * should have to look up `google-pixel-8-pro`, a slug the UI never shows. The
 * same argument applies here, and the same join: rename that device to "Priya"
 * and a `placements.csv` still saying "Google Pixel 8 Pro" keeps resolving,
 * because the old name lives on in `also_known_as`.
 *
 * **`schema` is per FILE**, the same call `event.csv` and `markers.csv` make.
 * The per-row argument in `csv.ts` is that a row-bound file lands a row from
 * somebody's older copy among newer rows, so each row must carry its own
 * version. Nothing lands here from anywhere else — `placements.csv` neither
 * globs the way `notes*.csv` does nor row-binds — so a version declared anywhere
 * in the file is a statement about the file, and a file this build cannot read
 * is refused whole. See `fileSchemaProblem`.
 *
 * **Nothing this build cannot interpret is ever dropped.** A row with a month of
 * 13, an unresolvable `tz`, no `item_id`, or nothing in it that corrects
 * anything is reported AND kept verbatim in `preserved`, then written straight
 * back by `formatPlacementsCsv`. That matters more here than almost anywhere
 * else in the set: a placement is the ONLY record of a decision somebody made by
 * hand, and there is no file on disk to re-derive it from. Refusing to READ a
 * row is not permission to DELETE it — see CLAUDE.md's section of that name.
 *
 * **Preserved rows go at the END of the file**, which is where `people.csv` and
 * `markers.csv` put them and NOT where `notes*.csv` does. A notes file is read
 * in chronological order, so a refused note is slotted back into its place in
 * time; this file is keyed by item and has no chronology worth defending, so the
 * bottom is simply where somebody repairing it will look.
 *
 * Pure: only relative core imports and ECMAScript globals.
 */

import { displayNameFor } from './assemble.ts';
import {
  CSV_SCHEMA,
  formatCsv,
  parseCsv,
  preservedHeaders,
  schemaCellProblem,
  type PreservedRow,
} from './csv.ts';
import { displayName, resolvePersonNames } from './people-csv.ts';
import type { Item, ItemId, Person, PersonId } from './schema.ts';
import { zoneOffsetMinutes } from './time.ts';
import { instantPartsInZone, nonEmpty, readCalendarParts, resolveZoned } from './wallclock.ts';

/**
 * The columns, in the order `formatPlacementsCsv` writes them.
 *
 * `schema` is last, after any column somebody else added, so it is genuinely the
 * last column of the file rather than merely the last one this module owns — the
 * same rule `NOTE_HEADERS`, `PEOPLE_HEADERS` and `MARKER_HEADERS` follow.
 */
export const PLACEMENT_HEADERS: readonly string[] = [
  'item_id',
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'tz',
  'utc_offset_min',
  'person',
  'schema',
];

const KNOWN_PLACEMENT_KEYS = new Set<string>(PLACEMENT_HEADERS);

/** The five that must all be present and in range for a placement to have a time. */
const CALENDAR_FIELDS = ['year', 'month', 'day', 'hour', 'minute'] as const;

/**
 * Appended to every problem that quarantines a row, so the message says what
 * happened to the data as well as what was wrong with it. `parsePeopleCsv` and
 * `parseMarkersCsv` carry the same promise, and it is the sentence that makes
 * "reported" different from "lost".
 */
const KEPT_ROW =
  '. The row is kept exactly as it is and written back when you save, so nothing in it is lost.';

const KEPT_ROWS =
  ' The rows are kept exactly as they are and written back when you save, so nothing in ' +
  'them is lost.';

/**
 * One correction, as the file states it.
 *
 * `at` is an ISO instant and `person` is a NAME, not a `PersonId` — the cell as
 * written, resolved against the roster only when the correction is applied. See
 * `applyPlacements`, and the module doc for why a name rather than an id.
 *
 * At least one of the two is always present: a row carrying neither corrects
 * nothing, and `parsePlacementsCsv` preserves it rather than returning it here.
 */
export interface Placement {
  itemId: ItemId;
  /** ISO-8601 instant. Absent when the row overrides no time. */
  at?: string;
  /** A person's name or alias. Absent when the row overrides no person. */
  person?: string;
}

/**
 * Columns of `placements.csv` this module has no meaning for, **aligned by index
 * with the `placements` array** — `extra[i]` belongs to `placements[i]`, and
 * `parsePlacementsCsv` always returns exactly one entry per placement (an empty
 * object where a row carried nothing extra), so the two lengths agree.
 *
 * Indexed rather than keyed by `itemId`, matching `MarkersExtra`: nothing stops
 * a hand-edited file naming the same item twice (`applyPlacements` reports it
 * and lets the last row win), and a keyed map would silently merge the two rows'
 * spare columns into one.
 *
 * **A caller that reorders, inserts into or filters the placement list must do
 * the same to this array**, or a column somebody typed lands on the wrong row.
 */
export type PlacementsExtra = Array<Record<string, string>>;

export interface PlacementsCsv {
  placements: Placement[];
  /** One entry per placement, aligned by index. See `PlacementsExtra`. */
  extra: PlacementsExtra;
  /** Rows this build refused, kept verbatim. See `PreservedRow`. */
  preserved: PreservedRow[];
  problems: string[];
}

// ---------------------------------------------------------------------------
// parsePlacementsCsv
// ---------------------------------------------------------------------------

/**
 * Read `placements.csv`.
 *
 * **`eventTimezone` is a required parameter that accepts `undefined`**, rather
 * than an optional one. It is the zone a row's wall clock falls back to when the
 * row names none of its own — every row somebody adds by hand — so forgetting it
 * does not fail, it silently reads those rows as UTC and moves a hand-placed
 * photograph by up to fourteen hours. The type is what makes a caller decide.
 *
 * **The header row is not checked**, which is a considered difference from
 * `parseEventCsv`. That check exists because `event.csv` is two columns of
 * key/value, where the header is the one row that can be mistaken for data. This
 * file is row-shaped like `notes*.csv`, `people.csv` and `markers.csv`, none of
 * which checks either: a file that has lost its header row has its first line
 * read as column names, and every row after it then reports a missing `item_id`.
 *
 * **Nothing here knows what is in the folder.** Joining a row to an actual file
 * is `applyPlacements`'s job, so an `item_id` naming nothing is not a problem
 * this function can even see — which is exactly why a row it cannot join is
 * still returned rather than dropped.
 */
export function parsePlacementsCsv(
  text: string,
  eventTimezone: string | undefined,
  /** Named in every problem, so a caller can point at the file to repair. */
  file = 'placements.csv',
): PlacementsCsv {
  const { rows, rowLines } = parseCsv(text);
  const placements: Placement[] = [];
  const extra: PlacementsExtra = [];
  const preserved: PreservedRow[] = [];
  const problems: string[] = [];

  // The row's real file line, not `i + 2`: `parseCsv` drops blank lines rather
  // than emitting empty rows for them, so a blank line anywhere above this one
  // would make that arithmetic understate every message below it. `rowLines[i]`
  // is never actually missing — it is built in lockstep with `rows` — the
  // fallback only satisfies the type checker.
  const lineOf = (i: number): number => rowLines[i] ?? i + 2;

  const keep = (row: Record<string, string>, line: number, problem: string): void => {
    preserved.push({ file, line, cells: row });
    problems.push(problem + KEPT_ROW);
  };

  // Checked before any row is interpreted: a file written by a newer build may
  // mean something different by every column in it, so reading them anyway would
  // be guessing. Per FILE — see the module doc for why the per-row argument that
  // justifies `notes*.csv`'s column does not carry here.
  const schemaBad = fileSchemaProblem(rows, rowLines, file);
  if (schemaBad) {
    problems.push(schemaBad + KEPT_ROWS);
    // Every row, `schema` cells included. Writing `schema,1` back over a file
    // that declared 2 would both claim a version this build did not read and
    // destroy the only marker saying so.
    rows.forEach((row, i) => preserved.push({ file, line: lineOf(i), cells: row }));
    return { placements, extra, preserved, problems };
  }

  rows.forEach((row, i) => {
    const line = lineOf(i);
    const where = `${file} row ${line}`;

    // First, because everything below names the row by the file it corrects and
    // a row with no `item_id` cannot produce a legible message — and because
    // there is nothing to join it to either. An `item_id` naming a file this
    // folder does not hold is a different case entirely and is NOT refused here;
    // see `applyPlacements`.
    const itemId = (row['item_id'] ?? '').trim();
    if (itemId === '') {
      keep(row, line, `${where} has no item_id, so there is nothing to say which file it corrects`);
      return;
    }

    const time = readTime(row, eventTimezone, itemId);
    if ('error' in time) {
      keep(row, line, `${where}: ${time.error}`);
      return;
    }

    const person = nonEmpty(row['person']);

    // A blank timestamp block means "no time override" and a blank `person`
    // means "no person override" — both are ordinary, and a row carrying one of
    // them alone is the common case. A row carrying NEITHER corrects nothing at
    // all, so there is no `Placement` to make of it. Preserved rather than
    // silently skipped, exactly as `markers.csv` preserves a row that gives
    // neither a time nor a distance: the row is somebody's half-finished edit,
    // and dropping it on the next Save would delete the half they had done.
    if (time.instant === undefined && person === undefined) {
      keep(
        row,
        line,
        `${where}: the row for "${itemId}" gives neither a time nor a person, so it corrects ` +
          'nothing',
      );
      return;
    }

    const placement: Placement = { itemId };
    if (time.instant !== undefined) placement.at = new Date(time.instant).toISOString();
    if (person !== undefined) placement.person = person;

    placements.push(placement);
    extra.push(unknownColumns(row));
  });

  return { placements, extra, preserved, problems };
}

/**
 * What is wrong with the file's `schema` declaration, or null.
 *
 * Every row's cell is checked and the FIRST unreadable one decides, because a
 * newer build writes its own version into every row it writes — so a single
 * newer cell says the file came from that build, whatever the rows around it
 * say. A blank cell means "the version this reader knows" (see
 * `schemaCellProblem`), so a row somebody added by hand needs nothing typed
 * into it.
 */
function fileSchemaProblem(
  rows: ReadonlyArray<Record<string, string>>,
  rowLines: readonly number[],
  file: string,
): string | null {
  for (let i = 0; i < rows.length; i++) {
    const bad = schemaCellProblem(rows[i]?.['schema'], file);
    if (bad) {
      return (
        `${file} row ${rowLines[i] ?? i + 2} ${bad}. No placements were read from the file at ` +
        'all, because a version is a statement about the whole of it.'
      );
    }
  }
  return null;
}

/**
 * The instant a row names, `{ instant: undefined }` when it names none, or the
 * one thing wrong with it.
 *
 * **All five integers or none.** A row with three of them is a hand-edit that
 * went wrong, and there is no honest way to fill the rest in: defaulting an
 * absent `minute` to zero would place a photograph confidently at a time nobody
 * typed, which this project holds to be worse than a visible gap.
 */
function readTime(
  row: Record<string, string>,
  eventTimezone: string | undefined,
  label: string,
): { instant: number | undefined } | { error: string } {
  // Per field, before `Number` ever sees a blank: `Number('')` is 0, which is
  // finite and therefore invisible to a range check, so a blank `minute` would
  // resolve silently to :00 instead of being refused.
  const missing = CALENDAR_FIELDS.filter((f) => nonEmpty(row[f]) === undefined);
  if (missing.length === CALENDAR_FIELDS.length) return { instant: undefined };
  if (missing.length > 0) {
    return {
      error:
        `placement "${label}" is missing ${missing.join(', ')} — a hand-placed time needs all ` +
        'five of year, month, day, hour and minute, or none of them',
    };
  }
  // `nonEmpty` rather than the raw cell: it trims, and `readCalendarParts`
  // matches `/^\d{4}$/` against `year` — so a cell a spreadsheet left as " 2026"
  // would be refused as "not a whole number" for a value that is one. The
  // `as string` is safe because `missing` above is empty.
  const parts = readCalendarParts(
    {
      year: nonEmpty(row['year']) as string,
      month: nonEmpty(row['month']) as string,
      day: nonEmpty(row['day']) as string,
      hour: nonEmpty(row['hour']) as string,
      minute: nonEmpty(row['minute']) as string,
    },
    label,
    'placement',
  );
  if ('error' in parts) return parts;

  // `resolveZoned` reads `row.tz` and `row.utc_offset_min` by literal name —
  // deliberately not parameterised, so `utc_offset_min` has one spelling across
  // every file in the set. This file uses those exact names, so the row goes in
  // as it was read.
  const resolved = resolveZoned(parts, row, eventTimezone, label, 'placement');
  if ('error' in resolved) return resolved;
  return { instant: resolved.instant };
}

/** Columns this module has no meaning for, verbatim. Empty when there are none. */
function unknownColumns(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!KNOWN_PLACEMENT_KEYS.has(key)) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// formatPlacementsCsv
// ---------------------------------------------------------------------------

/**
 * Write the placements back out.
 *
 * **The zone written is the EVENT's**, not whatever `tz` a row was read with:
 * `Placement` is `{ itemId, at?, person? }` and has nowhere to keep a zone name.
 * The instant round-trips exactly either way — `utc_offset_min` is computed from
 * the instant in this zone, so reading it back gives the same moment — but a
 * hand-typed `tz` naming a different zone is rewritten to the event's on the
 * next save, and the five integers with it. `formatEventCsv` and
 * `formatMarkersCsv` make the same trade for the same reason.
 *
 * `tz` and `utc_offset_min` are ALWAYS written for a placement that has a time,
 * even when the zone matches the event's. Blanking it looked free and is not:
 * change `event.timezone` afterwards and every hand-placed photograph silently
 * MOVES, with nothing on the row to say which zone was meant. See CLAUDE.md,
 * "The format hardening".
 *
 * `person` is written exactly as it was read — a name, never resolved to an id
 * on the way out. Resolving it would put a slug the UI never shows into a file
 * whose entire point is being editable by hand.
 *
 * `preserved` holds the rows `parsePlacementsCsv` refused, written back verbatim
 * AFTER the placements — see the module doc for why the end of the file is the
 * right place here and the wrong one in `notes*.csv`.
 *
 * **Throws, legibly, rather than writing a wrong placement.** A timezone `Intl`
 * cannot resolve (`MDT` is the obvious thing for a person to type) or an `at`
 * that is not a date stops the save with words instead of writing something
 * false. A save that dies inside a click handler leaves no file, no message, and
 * a whole session's work in a tab — so callers must be ready to show the
 * message, exactly as `saveEvent` in `App.tsx` already does for `noteToRow`'s
 * matching throw.
 */
export function formatPlacementsCsv(
  placements: readonly Placement[],
  /** Required, and accepts `undefined` — see `parsePlacementsCsv` for why. */
  eventTimezone: string | undefined,
  /** Aligned by index with `placements`. See `PlacementsExtra`. */
  extra?: ReadonlyArray<Record<string, string>>,
  preserved: readonly PreservedRow[] = [],
): string {
  const headers = PLACEMENT_HEADERS.filter((h) => h !== 'schema');
  const seen = new Set<string>(PLACEMENT_HEADERS);
  for (const columns of extra ?? []) {
    for (const key of Object.keys(columns)) {
      if (seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  headers.push(...preservedHeaders(headers.concat('schema'), preserved));
  headers.push('schema');

  const rows: Array<Record<string, string>> = placements.map((placement, i) => ({
    // Spread first so a known column always wins over a stray one wearing the
    // same name. `parsePlacementsCsv` cannot produce one; a caller can.
    ...(extra?.[i] ?? {}),
    item_id: placement.itemId,
    ...timeCells(placement, eventTimezone),
    person: placement.person ?? '',
    schema: String(CSV_SCHEMA),
  }));
  for (const row of preserved) rows.push(row.cells);

  return formatCsv(headers, rows);
}

/** The seven timestamp cells, all blank for a placement that only fixes a person. */
function timeCells(
  placement: Placement,
  eventTimezone: string | undefined,
): Record<string, string> {
  const blank = {
    year: '', month: '', day: '', hour: '', minute: '', tz: '', utc_offset_min: '',
  };
  if (placement.at === undefined) return blank;

  const instant = Date.parse(placement.at);
  if (Number.isNaN(instant)) {
    throw new Error(
      `The placement for "${placement.itemId}" is at "${placement.at}", which is not a date ` +
        'and time meanwhile can read, so it cannot be written to placements.csv.',
    );
  }
  const zone = eventTimezone?.trim() || 'UTC';
  // Asked BEFORE `Intl` is told to format anything: `instantPartsInZone` throws
  // a bare `RangeError: Invalid time zone specified: MDT` otherwise. Same guard
  // `noteToRow`, `formatEventCsv` and `formatMarkersCsv` make for the same
  // reason.
  const offset = zoneOffsetMinutes(instant, zone);
  if (offset === null) {
    throw new Error(
      `The event's timezone is "${zone}", which is not a name meanwhile recognises, so the ` +
        `placement for "${placement.itemId}" cannot be written to placements.csv. Write the ` +
        'full zone, like "America/Denver", not an abbreviation like "MDT".',
    );
  }
  const parts = instantPartsInZone(instant, zone);
  return {
    // `String()` over the numbers is what writes `7` rather than `07` — the
    // format options do not control padding, see `instantPartsInZone`. Unpadded
    // is what a spreadsheet leaves alone.
    year: String(parts.year),
    month: String(parts.month),
    day: String(parts.day),
    hour: String(parts.hour),
    minute: String(parts.minute),
    tz: zone,
    utc_offset_min: String(offset),
  };
}

// ---------------------------------------------------------------------------
// applyPlacements
// ---------------------------------------------------------------------------

export interface ApplyPlacementsOptions {
  /** Named in every problem, so a caller can point at the file to repair. */
  file?: string;
}

export interface AppliedPlacements {
  /** A new list. The input items are never mutated. */
  items: Item[];
  problems: string[];
}

/**
 * Apply the corrections to the derived items.
 *
 * Pure, and it never mutates: an item nothing corrects comes back by reference,
 * and a corrected one is a fresh object.
 *
 * **The join is: exact `item_id`, then an unambiguous basename, then a report.**
 * An item's id is its path relative to the folder root (`assembleManifest` sets
 * `id: file.path`), which is what makes it stable across re-ingests of the same
 * folder — and what makes it move the moment somebody reorganises the folder.
 * CLAUDE.md records the consequence: a reorganisation orphans every manual
 * placement, while notes survive one precisely because they join photographs by
 * BASENAME (see `resolveNotePhotos` in `./notes.ts`). This closes the same hole
 * the same way, under the same condition: **an ambiguous basename is reported,
 * never guessed at.** Two phones both produce `PXL_20260822_131204.jpg`, and
 * attaching somebody's hand-placed time to the wrong photograph is worse than
 * leaving the row unapplied. The fallback is reported even when it succeeds,
 * because a correction landing on a file the row does not name is exactly the
 * kind of thing that should not happen quietly.
 *
 * **An `item_id` matching nothing is reported, and the row survives.** It is not
 * an error: the photograph may simply not be in the folder that happens to be
 * open. Deleting somebody's correction because they opened the wrong folder is
 * the failure this project keeps legislating against — and nothing here can
 * delete a row anyway, since the row lives in the `Placement[]` the writer is
 * handed.
 *
 * **A `person` must resolve to somebody this event names.** The candidate set is
 * the roster UNION every person the items were derived onto — which is exactly
 * the set `assembleManifest` puts in `manifest.people`, and exactly the set
 * `validateManifest` checks `items[].person` against. The roster alone would be
 * too narrow: correcting a photograph onto a device lane that `people.csv` has
 * never been told about is an ordinary thing to want, and that lane's name is
 * `displayNameFor(id)` — the label the UI shows. A name that resolves to nobody,
 * or to more than one person, leaves the DERIVED person standing and is
 * reported. Carrying an unresolved name through as an id was tried and is what
 * this rule exists to prevent: it produces a manifest `validateManifest` refuses
 * outright, and a photograph with no lane colour at all, since `assignLaneColors`
 * has no entry for an id that is not in `manifest.people`.
 *
 * **A redundant correction is reported, never deleted.** A corrections file
 * should tend towards holding only real corrections rather than accumulating
 * fossils as the derivation improves — but which fossils are worth keeping is
 * the author's call, not this function's.
 */
export function applyPlacements(
  items: readonly Item[],
  placements: readonly Placement[],
  people: readonly Person[],
  opts: ApplyPlacementsOptions = {},
): AppliedPlacements {
  const file = opts.file ?? 'placements.csv';
  const problems: string[] = [];

  const byId = new Map<ItemId, Item>();
  const byBasename = new Map<string, ItemId[]>();
  for (const item of items) {
    byId.set(item.id, item);
    const base = basename(item.id);
    const list = byBasename.get(base);
    if (list) list.push(item.id);
    else byBasename.set(base, [item.id]);
  }

  const roster = rosterFor(items, people);
  const rosterById = new Map<PersonId, Person>(roster.map((p) => [p.id, p]));

  const corrections = new Map<ItemId, { at?: string; person?: PersonId }>();
  /** How many rows named an item, once more than one did. */
  const duplicates = new Map<ItemId, number>();
  /** Items whose correction changed nothing at all. */
  const redundant: ItemId[] = [];

  for (const placement of placements) {
    const targetId = resolveTarget(placement, byId, byBasename, file, problems);
    if (targetId === null) continue;
    const item = byId.get(targetId) as Item;

    const correction: { at?: string; person?: PersonId } = {};
    // A row can carry both corrections, and they are independent: an
    // unresolvable name must not throw away a perfectly good hand-placed time
    // sitting in the same row.
    let complete = true;
    if (placement.at !== undefined) correction.at = placement.at;
    if (placement.person !== undefined) {
      const { ids } = resolvePersonNames([placement.person], roster);
      const id = ids[0];
      if (id === undefined) {
        complete = false;
        const derived = rosterById.get(item.person);
        problems.push(
          `${file}: the person "${placement.person}" on the row for "${targetId}" does not ` +
            `name exactly one person in this event, so that file stays with ` +
            `${derived ? displayName(derived) : item.person}. Check the spelling against ` +
            'people.csv — a name two people both answer to is never guessed at either.',
        );
      } else {
        correction.person = id;
      }
    }

    // Only reachable when the row's sole correction was a person who did not
    // resolve; `parsePlacementsCsv` never returns a placement with neither.
    if (correction.at === undefined && correction.person === undefined) continue;

    if (corrections.has(targetId)) duplicates.set(targetId, (duplicates.get(targetId) ?? 1) + 1);
    corrections.set(targetId, correction);

    if (complete && !changesAnything(item, correction)) redundant.push(targetId);
  }

  for (const [itemId, count] of duplicates) {
    problems.push(
      `${file}: ${count} rows correct "${itemId}", and the last of them wins. Delete the ` +
        'others so the file says one thing.',
    );
  }

  if (redundant.length > 0) {
    const unique = [...new Set(redundant)];
    const one = redundant.length === 1;
    problems.push(
      `${file}: ${one ? 'one row corrects' : `${redundant.length} rows correct`} nothing, ` +
        `because meanwhile already reads ${one ? 'that file' : 'those files'} exactly that ` +
        `way (${unique.join(', ')}). ${one ? 'It is' : 'They are'} kept and written back — ` +
        `delete ${one ? 'it' : 'them'} if you like; meanwhile will not do it for you.`,
    );
  }

  const next = items.map((item) => {
    const correction = corrections.get(item.id);
    if (correction === undefined) return item;
    const out: Item = { ...item };
    if (correction.at !== undefined) {
      out.at = correction.at;
      // The whole point of a hand-placed time: it is the author's, so it must
      // outrank every device source (`TIME_SOURCE_RANK`) and must never have
      // that person's `clockOffset` applied to it (`appliesClockOffset`). A
      // person typing a time is not a device with a wrong clock.
      out.timeSource = 'manual';
    }
    if (correction.person !== undefined) out.person = correction.person;
    return out;
  });

  return { items: next, problems };
}

/**
 * The item a row corrects, or null when it names none this build will act on.
 *
 * Reports on every path except the exact one, including the successful basename
 * fallback — see `applyPlacements` for why a quiet fallback is the wrong kind of
 * quiet.
 */
function resolveTarget(
  placement: Placement,
  byId: ReadonlyMap<ItemId, Item>,
  byBasename: ReadonlyMap<string, ItemId[]>,
  file: string,
  problems: string[],
): ItemId | null {
  if (byId.has(placement.itemId)) return placement.itemId;

  const base = basename(placement.itemId);
  const candidates = byBasename.get(base) ?? [];

  if (candidates.length === 1) {
    const only = candidates[0] as ItemId;
    problems.push(
      `${file}: nothing in this folder is at "${placement.itemId}", but exactly one file is ` +
        `called "${base}" ("${only}"), so the correction was applied to it. Reorganising a ` +
        'folder changes a file’s path but not its name, which is what this fallback is for.',
    );
    return only;
  }
  if (candidates.length > 1) {
    problems.push(
      `${file}: nothing in this folder is at "${placement.itemId}", and ${candidates.length} ` +
        `files are called "${base}" (${candidates.join(', ')}) — meanwhile will not guess ` +
        'which one you meant, so that row was not applied. Write the full path, relative to ' +
        'the folder you open. The row is kept and written back when you save.',
    );
    return null;
  }
  problems.push(
    `${file}: nothing in this folder matches "${placement.itemId}", so that row corrects ` +
      'nothing. It is kept and written back when you save — the file may simply not be in ' +
      'the folder you opened.',
  );
  return null;
}

/**
 * Everybody a `person` cell may name: the roster, plus a stand-in for every
 * person the items were derived onto that the roster does not already list.
 *
 * The stand-in's name is `displayNameFor(id)`, which is the label the swimlanes
 * show for a device nobody has renamed — so the name somebody reads off the
 * screen is the name they can type into the file. Ids are not accepted: a slug
 * like `google-pixel-8-pro` is not something this file should ever ask anyone to
 * look up. See `applyPlacements` for why the union rather than the roster alone.
 */
function rosterFor(items: readonly Item[], people: readonly Person[]): Person[] {
  const out = [...people];
  const known = new Set<PersonId>(people.map((p) => p.id));
  for (const item of items) {
    if (known.has(item.person)) continue;
    known.add(item.person);
    out.push({ id: item.person, name: displayNameFor(item.person) });
  }
  return out;
}

/**
 * Whether applying this correction would change the item at all.
 *
 * **The time half deliberately requires `timeSource` to ALREADY be `'manual'`,
 * not just the same `at`.** An item whose EXIF happens to name the same instant
 * is not the same item: applying the placement flips its source to `manual`,
 * which stops that person's `clockOffset` being applied to it
 * (`appliesClockOffset` in `./time.ts`). So deleting such a row would move the
 * photograph, and telling its author it corrects nothing would be false.
 *
 * The comparison is a plain string comparison, and that is deliberately narrow.
 * `Item.at` is the timestamp AS RECORDED and may be naive (`2026-08-22T13:12:04`
 * with no zone); `Date.parse` reads a naive string in the HOST's zone, which
 * would make this function's answer depend on the machine it runs on. A
 * hand-placed `at` is always written by this module as a full UTC ISO, so
 * comparing strings is exact for the case that matters and merely misses a few
 * spellings of the same instant elsewhere — a false "this is a real correction",
 * which costs nothing, rather than a false "you can delete this".
 */
function changesAnything(item: Item, correction: { at?: string; person?: PersonId }): boolean {
  if (correction.at !== undefined && (item.at !== correction.at || item.timeSource !== 'manual')) {
    return true;
  }
  if (correction.person !== undefined && item.person !== correction.person) return true;
  return false;
}

/**
 * The last path segment. Private rather than shared with `notes.ts`'s identical
 * helper: each of these small codecs stays an independently readable file, the
 * same call `people-csv.ts`'s own `splitList` makes.
 */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
