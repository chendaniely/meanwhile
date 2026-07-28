import { describe, expect, it } from 'vitest';
import {
  appliesClockOffset,
  formatDuration,
  hasZone,
  parseDuration,
  parseZonedInstant,
  resolveItemInstant,
  zonedToInstant,
} from '../src/core/time.ts';

describe('parseDuration', () => {
  it('parses the shapes clock offsets actually use', () => {
    expect(parseDuration('PT0S')).toBe(0);
    expect(parseDuration('PT47S')).toBe(47_000);
    expect(parseDuration('-PT47S')).toBe(-47_000);
    expect(parseDuration('PT1H30M')).toBe(5_400_000);
    expect(parseDuration('-PT2M15S')).toBe(-135_000);
    expect(parseDuration('P1DT2H')).toBe(93_600_000);
    expect(parseDuration('PT0.5S')).toBe(500);
  });

  it('rejects durations with no fixed length in milliseconds', () => {
    // A camera clock offset measured in months is not a thing, and admitting
    // Y/M here would silently make offset arithmetic calendar-dependent.
    expect(parseDuration('P1Y')).toBeNull();
    expect(parseDuration('P3M')).toBeNull();
  });

  it('rejects malformed input rather than guessing', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('P')).toBeNull();
    expect(parseDuration('PT')).toBeNull();
    expect(parseDuration('47s')).toBeNull();
    expect(parseDuration('-47')).toBeNull();
  });

  it('round-trips through formatDuration', () => {
    for (const ms of [0, 1000, -47_000, 5_400_000, 93_600_000, -135_000, 500]) {
      expect(parseDuration(formatDuration(ms))).toBe(ms);
    }
  });
});

describe('hasZone / parseZonedInstant', () => {
  it('distinguishes zoned from naive timestamps', () => {
    expect(hasZone('2026-08-22T13:12:04Z')).toBe(true);
    expect(hasZone('2026-08-22T13:12:04-07:00')).toBe(true);
    expect(hasZone('2026-08-22T13:12:04')).toBe(false);
  });

  it('parses zoned timestamps and refuses naive ones', () => {
    expect(parseZonedInstant('2026-08-22T13:12:04Z')).toBe(Date.UTC(2026, 7, 22, 13, 12, 4));
    expect(parseZonedInstant('2026-08-22T06:12:04-07:00')).toBe(Date.UTC(2026, 7, 22, 13, 12, 4));
    // Naive strings must go through zonedToInstant with an IANA zone, never
    // be silently read as UTC or as the host's local time.
    expect(parseZonedInstant('2026-08-22T13:12:04')).toBeNull();
  });
});

describe('zonedToInstant', () => {
  it('resolves a naive local time through an IANA zone', () => {
    // 06:12 Pacific in August is UTC-7.
    expect(zonedToInstant('2026-08-22T06:12:04', 'America/Los_Angeles')).toBe(
      Date.UTC(2026, 7, 22, 13, 12, 4),
    );
  });

  it('uses the offset in force on that date, not today', () => {
    // Same wall clock in January is UTC-8, an hour off from the August case.
    expect(zonedToInstant('2026-01-22T06:12:04', 'America/Los_Angeles')).toBe(
      Date.UTC(2026, 0, 22, 14, 12, 4),
    );
  });

  it('handles a zone with a non-hour offset', () => {
    expect(zonedToInstant('2026-08-22T12:00:00', 'Asia/Kolkata')).toBe(
      Date.UTC(2026, 7, 22, 6, 30, 0),
    );
  });

  it('crosses a DST boundary correctly', () => {
    // 2026-11-01 in the US: clocks fall back at 02:00 local. 01:30 is the
    // ambiguous hour and resolves to the first (PDT, UTC-7) occurrence; 03:30
    // is unambiguously PST (UTC-8). The second refinement pass is what makes
    // this work.
    expect(zonedToInstant('2026-11-01T01:30:00', 'America/Los_Angeles')).toBe(
      Date.UTC(2026, 10, 1, 8, 30, 0),
    );
    expect(zonedToInstant('2026-11-01T03:30:00', 'America/Los_Angeles')).toBe(
      Date.UTC(2026, 10, 1, 11, 30, 0),
    );
  });

  it('returns null for an unknown zone or unparseable input', () => {
    expect(zonedToInstant('2026-08-22T06:12:04', 'Mars/Olympus_Mons')).toBeNull();
    expect(zonedToInstant('nonsense', 'America/Los_Angeles')).toBeNull();
  });
});

describe('appliesClockOffset', () => {
  it('applies to device-clock sources only', () => {
    expect(appliesClockOffset('exif-offset')).toBe(true);
    expect(appliesClockOffset('exif-naive')).toBe(true);
    expect(appliesClockOffset('qt-offset')).toBe(true);
    expect(appliesClockOffset('mvhd')).toBe(true);
    expect(appliesClockOffset('filename')).toBe(true);
  });

  it('does NOT apply to satellite time or author intent', () => {
    // Correcting these would introduce the very error clockOffset removes.
    expect(appliesClockOffset('gps')).toBe(false);
    expect(appliesClockOffset('manual')).toBe(false);
    expect(appliesClockOffset('none')).toBe(false);
  });
});

describe('resolveItemInstant', () => {
  const event = { timezone: 'America/Los_Angeles' };
  const fastCamera = { clockOffset: '-PT47S' };

  it('applies the offset to a device timestamp', () => {
    const r = resolveItemInstant(
      { at: '2026-08-22T13:12:04Z', timeSource: 'exif-offset' },
      fastCamera,
      event,
    );
    expect(r.instant).toBe(Date.UTC(2026, 7, 22, 13, 11, 17));
    expect(r.offsetApplied).toBe(-47_000);
    expect(r.exact).toBe(false);
  });

  it('leaves a GPS timestamp alone even when the person has an offset', () => {
    const r = resolveItemInstant(
      { at: '2026-08-22T13:12:04Z', timeSource: 'gps' },
      fastCamera,
      event,
    );
    expect(r.instant).toBe(Date.UTC(2026, 7, 22, 13, 12, 4));
    expect(r.offsetApplied).toBe(0);
    expect(r.exact).toBe(true);
  });

  it('leaves a manual placement alone', () => {
    const r = resolveItemInstant(
      { at: '2026-08-22T13:12:04Z', timeSource: 'manual' },
      fastCamera,
      event,
    );
    expect(r.instant).toBe(Date.UTC(2026, 7, 22, 13, 12, 4));
    expect(r.offsetApplied).toBe(0);
  });

  it('resolves a naive timestamp through the event timezone', () => {
    const r = resolveItemInstant(
      { at: '2026-08-22T06:12:04', timeSource: 'exif-naive' },
      undefined,
      event,
    );
    expect(r.instant).toBe(Date.UTC(2026, 7, 22, 13, 12, 4));
  });

  it('refuses to place a naive timestamp with no event timezone', () => {
    const r = resolveItemInstant(
      { at: '2026-08-22T06:12:04', timeSource: 'exif-naive' },
      undefined,
      {},
    );
    // Guessing UTC or host-local here is exactly the silent, unfalsifiable
    // error the design exists to prevent.
    expect(r.instant).toBeNull();
    expect(r.reason).toMatch(/event\.timezone/);
  });

  it('reports timeSource "none" as unplaced with a reason', () => {
    const r = resolveItemInstant({ timeSource: 'none' }, undefined, event);
    expect(r.instant).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it('keeps the item placed but flags an unparseable clockOffset', () => {
    const r = resolveItemInstant(
      { at: '2026-08-22T13:12:04Z', timeSource: 'exif-offset' },
      { clockOffset: 'about a minute' },
      event,
    );
    expect(r.instant).toBe(Date.UTC(2026, 7, 22, 13, 12, 4));
    expect(r.offsetApplied).toBe(0);
    expect(r.reason).toMatch(/clockOffset/);
  });
});
