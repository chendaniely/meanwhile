/**
 * `notes.csv` and `people.csv` EXACTLY as meanwhile wrote them before the
 * 2026-07-30 format change — byte for byte, BOM included.
 *
 * The point is not that these strings are interesting. It is that the owner
 * is about to commit a real race's written record to a private repo, and from
 * that moment every reading of every file here is a promise: **a file written
 * before the change must still produce the same instants, the same ids and
 * the same text it always did.** Migration matters more than the new writes,
 * so it is pinned to a frozen copy rather than to whatever the current writer
 * happens to emit — a test that regenerates its own input cannot catch a
 * reader and a writer drifting together.
 *
 * Do not regenerate these. If a future change makes them read differently,
 * that IS the finding.
 */

const BOM = '﻿';

/**
 * Five integers, a blank `tz` meaning "the event's zone", no
 * `utc_offset_min`, no `written`, no `deleted`, no `schema` — and one
 * unknown column (`tags`) that the reader has always carried through.
 *
 * Row 3 leaves `id` blank, the documented way to hand-add a note.
 */
export const NOTES_CSV_BEFORE =
  BOM +
  'id,year,month,day,hour,minute,duration,tz,people,photo,author,text,tags\n' +
  'n_k3f9x2,2026,7,25,15,45,,,Priya,,Dan,wrong turn on the ridge,\n' +
  'n_p1a7m4,2026,7,25,15,53,,UTC,Priya;Sam,PXL_20260725_215331309.jpg,Dan,the buckle,night\n' +
  ',2026,7,26,3,0,PT3H40M,,Sam,,Dan;Priya,asleep in the car,\n';

/** The roster as written before the change: five columns, no `schema`. */
export const PEOPLE_CSV_BEFORE =
  BOM +
  'id,name,role,clock_offset,also_known_as\n' +
  'google-pixel-8-pro,Priya,runner,,Google Pixel 8 Pro\n' +
  'samsung-sm-f721w,Sam,,-PT4S,\n';

/**
 * A `people.csv` carrying a column meanwhile has never known the meaning of.
 *
 * Verified by review to be LOST on the next save before this change, which is
 * why it is pinned here: the same failure would have deleted the `schema`
 * column itself.
 */
export const PEOPLE_CSV_WITH_UNKNOWN_COLUMNS =
  BOM +
  'id,name,role,clock_offset,also_known_as,pronouns,shirt\n' +
  'google-pixel-8-pro,Priya,runner,,,she/her,M\n' +
  'samsung-sm-f721w,Sam,crew,,,they/them,L\n';
