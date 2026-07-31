import { describe, expect, it } from 'vitest';
import {
  readCalendarParts, resolveZoned, type Resolved,
} from '../src/core/wallclock.ts';

/**
 * `wallclock.ts` is the seven timestamp columns — `year, month, day, hour,
 * minute, tz, utc_offset_min` — lifted out of `notes.ts` so `event.csv`,
 * `markers.csv` and `placements.csv` resolve a wall clock to exactly the
 * instant `notes*.csv` does.
 *
 * The rest of the ladder's behaviour is pinned by `tests/notes.test.ts` and
 * `tests/note-identity-timezone.test.ts`, which go through `rowToNote` and
 * still pass unchanged — that unchanged-ness is the extraction's own test.
 * What is tested HERE is the one thing that is new: the noun in a problem
 * message, and the fact that leaving it off still says "note".
 */

const ZONE = 'America/Denver';
const PARTS = { y: 2026, mo: 7, d: 25, h: 15, mi: 45 };

/**
 * The `error` half of a reader's result, or a failure saying what came back
 * instead — so a mutation that stops reporting a problem at all shows up as a
 * named failure rather than as `undefined` quietly matching nothing.
 */
function errorOf<T extends object>(result: T | { error: string }): string {
  if (!('error' in result)) throw new Error(`expected a problem, got ${JSON.stringify(result)}`);
  return result.error as string;
}

describe('resolveZoned', () => {
  it('resolves the row own offset first, then its zone, then the event zone', () => {
    // The offset determines the instant: 15:45 at UTC+05:30 is 10:15Z, not
    // the 15:45Z the event's zone alone would have given.
    const byOffset = resolveZoned(PARTS, { utc_offset_min: '330' }, 'UTC', 'x') as Resolved;
    expect(new Date(byOffset.instant).toISOString()).toBe('2026-07-25T10:15:00.000Z');

    // No offset: the row's own zone. Denver in July is UTC-6.
    const byZone = resolveZoned(PARTS, { tz: ZONE }, 'UTC', 'x') as Resolved;
    expect(new Date(byZone.instant).toISOString()).toBe('2026-07-25T21:45:00.000Z');
    expect(byZone.tz).toBe(ZONE);

    // Neither: the event's zone, and `tz` reports that the row named none.
    const byEvent = resolveZoned(PARTS, {}, ZONE, 'x') as Resolved;
    expect(new Date(byEvent.instant).toISOString()).toBe('2026-07-25T21:45:00.000Z');
    expect(byEvent.tz).toBeUndefined();
  });

  describe('names the kind of row in a problem, so a marker is not called a note', () => {
    it('for an unreadable utc_offset_min cell', () => {
      const row = { utc_offset_min: '-6:00' };
      expect(errorOf(resolveZoned(PARTS, row, ZONE, 'Cottonwood', 'marker')))
        .toContain('marker "Cottonwood" has a utc_offset_min of "-6:00"');
      expect(errorOf(resolveZoned(PARTS, row, ZONE, 'Cottonwood')))
        .toContain('note "Cottonwood" has a utc_offset_min of "-6:00"');
    });

    it('for a utc_offset_min no real zone could have', () => {
      const row = { utc_offset_min: '5000' };
      expect(errorOf(resolveZoned(PARTS, row, ZONE, 'Cottonwood', 'marker')))
        .toContain('marker "Cottonwood" has a utc_offset_min of 5000');
      expect(errorOf(resolveZoned(PARTS, row, ZONE, 'Cottonwood')))
        .toContain('note "Cottonwood" has a utc_offset_min of 5000');
    });

    it('for a zone this runtime cannot resolve — the row own, or the event own', () => {
      // "MDT" is the obvious thing to type and `Intl` refuses it. With no
      // offset the wall clock has nothing else to go on, so the zone that
      // failed is the one named.
      expect(errorOf(resolveZoned(PARTS, { tz: 'MDT' }, ZONE, 'Cottonwood', 'marker')))
        .toBe('marker "Cottonwood" could not be resolved in timezone "MDT"');
      expect(errorOf(resolveZoned(PARTS, { tz: 'MDT' }, ZONE, 'Cottonwood')))
        .toBe('note "Cottonwood" could not be resolved in timezone "MDT"');

      // The second, separate failure: the offset resolved the instant fine,
      // and `tz` is still unusable for the cross-check below it.
      const withOffset = { tz: 'MDT', utc_offset_min: '-360' };
      expect(errorOf(resolveZoned(PARTS, withOffset, ZONE, 'Cottonwood', 'marker')))
        .toBe('marker "Cottonwood" could not be resolved in timezone "MDT"');
      expect(errorOf(resolveZoned(PARTS, withOffset, ZONE, 'Cottonwood')))
        .toBe('note "Cottonwood" could not be resolved in timezone "MDT"');
    });

    it('for a tz and a utc_offset_min that disagree', () => {
      // Denver is UTC-06:00 on 25 July; the row claims -07:00.
      const row = { tz: ZONE, utc_offset_min: '-420' };
      const asMarker = errorOf(resolveZoned(PARTS, row, undefined, 'Cottonwood', 'marker'));
      expect(asMarker).toContain(
        'marker "Cottonwood" says timezone "America/Denver" and utc_offset_min -420',
      );
      expect(asMarker).toContain('(UTC-07:00), but "America/Denver" is UTC-06:00 at that moment');
      expect(errorOf(resolveZoned(PARTS, row, undefined, 'Cottonwood'))).toContain(
        'note "Cottonwood" says timezone "America/Denver" and utc_offset_min -420',
      );
    });
  });
});

describe('readCalendarParts', () => {
  const cells = (over: Record<string, string> = {}) => ({
    year: '2026', month: '7', day: '25', hour: '15', minute: '45', ...over,
  });

  it('reads the five integers when they are all in range', () => {
    expect(readCalendarParts(cells(), 'Cottonwood', 'marker'))
      .toEqual({ y: 2026, mo: 7, d: 25, h: 15, mi: 45 });
  });

  it('names the kind of row for a year that is not four digits', () => {
    expect(errorOf(readCalendarParts(cells({ year: '26' }), 'Cottonwood', 'marker')))
      .toContain('marker "Cottonwood" has a year of "26"');
    expect(errorOf(readCalendarParts(cells({ year: '26' }), 'Cottonwood')))
      .toContain('note "Cottonwood" has a year of "26"');
  });

  it('names the kind of row for a field that is not a whole number', () => {
    expect(errorOf(readCalendarParts(cells({ minute: '45.7' }), 'Cottonwood', 'marker')))
      .toBe('marker "Cottonwood" has a minute of "45.7", which is not a whole number');
    expect(errorOf(readCalendarParts(cells({ minute: '45.7' }), 'Cottonwood')))
      .toBe('note "Cottonwood" has a minute of "45.7", which is not a whole number');
  });

  it('names the kind of row for a field outside its range', () => {
    expect(errorOf(readCalendarParts(cells({ month: '13' }), 'Cottonwood', 'marker')))
      .toBe('marker "Cottonwood" has a month of 13; month runs 1–12');
    expect(errorOf(readCalendarParts(cells({ month: '13' }), 'Cottonwood')))
      .toBe('note "Cottonwood" has a month of 13; month runs 1–12');
  });

  it('names the kind of row for a day the month does not have', () => {
    expect(errorOf(readCalendarParts(cells({ month: '2', day: '30' }), 'Cottonwood', 'marker')))
      .toBe('marker "Cottonwood" has a day of 30, but February 2026 has 28 days');
    expect(errorOf(readCalendarParts(cells({ month: '2', day: '30' }), 'Cottonwood')))
      .toBe('note "Cottonwood" has a day of 30, but February 2026 has 28 days');
  });
});
