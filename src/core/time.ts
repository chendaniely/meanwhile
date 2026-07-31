/**
 * Clock math.
 *
 * Four devices disagree by seconds to minutes, and a point-to-point course
 * can cross a timezone. Without correction the timeline is subtly and
 * unfalsifiably wrong — which is the one failure mode this project cannot
 * tolerate, because nobody can spot it by looking.
 *
 * Pure: Date and Intl only, both of which exist identically in Node and in
 * every browser. No DOM, no packages.
 */

import type { EventInfo, Item, Person, TimeSource } from './schema.ts';
import { isDeviceClock } from './schema.ts';

/** Epoch milliseconds. The cursor and every comparison use this. */
export type Instant = number;

// ---------------------------------------------------------------------------
// ISO-8601 durations
// ---------------------------------------------------------------------------

/**
 * Years and months are deliberately unsupported: they have no fixed length in
 * milliseconds, and a camera clock offset measured in months is not a thing.
 */
const DURATION_RE =
  /^([+-])?P(?!$)(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?!$)(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parse an ISO-8601 duration into milliseconds. Returns null if unparseable.
 *
 * Accepts a leading sign, which ISO-8601 permits and which clock offsets need:
 * "-PT47S" is a camera running 47 seconds fast.
 */
export function parseDuration(iso: string): number | null {
  const m = DURATION_RE.exec(iso.trim());
  if (!m) return null;

  const [, sign, w, d, h, min, s] = m;
  // "P" and "PT" alone match the shape but carry no components.
  if (!w && !d && !h && !min && !s) return null;

  const ms =
    (w ? Number(w) * 604_800_000 : 0) +
    (d ? Number(d) * 86_400_000 : 0) +
    (h ? Number(h) * 3_600_000 : 0) +
    (min ? Number(min) * 60_000 : 0) +
    (s ? Number(s) * 1_000 : 0);

  return sign === '-' ? -ms : ms;
}

/** Render milliseconds as a canonical ISO-8601 duration, e.g. "-PT47S". */
export function formatDuration(ms: number): string {
  if (ms === 0) return 'PT0S';
  const sign = ms < 0 ? '-' : '';
  let rest = Math.abs(ms);

  const days = Math.floor(rest / 86_400_000);
  rest -= days * 86_400_000;
  const hours = Math.floor(rest / 3_600_000);
  rest -= hours * 3_600_000;
  const minutes = Math.floor(rest / 60_000);
  rest -= minutes * 60_000;
  const seconds = rest / 1_000;

  let out = `${sign}P`;
  if (days) out += `${days}D`;
  if (hours || minutes || seconds) {
    out += 'T';
    if (hours) out += `${hours}H`;
    if (minutes) out += `${minutes}M`;
    if (seconds) out += `${Number(seconds.toFixed(3))}S`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const ZONED_RE = /(Z|[+-]\d{2}:?\d{2})$/;
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

/** True when the string carries its own UTC offset and needs no zone lookup. */
export function hasZone(iso: string): boolean {
  return ZONED_RE.test(iso.trim());
}

/**
 * Parse an ISO-8601 string that carries a zone. Returns null for naive
 * strings — those need `zonedToInstant` and an IANA timezone.
 */
export function parseZonedInstant(iso: string): Instant | null {
  const s = iso.trim();
  if (!hasZone(s)) return null;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}

/**
 * The UTC offset, in milliseconds, that `timeZone` was using at `instant`.
 *
 * Implemented by formatting the instant in the target zone and diffing the
 * resulting wall-clock against UTC. This is the standard way to read IANA
 * zone data without shipping a timezone database.
 */
function zoneOffsetMs(instant: Instant, timeZone: string): number | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));
  } catch {
    return null; // unknown IANA zone
  }

  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  if (Number.isNaN(asUtc)) return null;

  // Round to the second: the formatted wall-clock has no sub-second part, so
  // the raw difference carries the instant's milliseconds as noise.
  return Math.round((asUtc - instant) / 1000) * 1000;
}

/**
 * The UTC offset, in whole minutes, that `timeZone` was using at `instant` —
 * `-360` for `America/Denver` in July. Null for a zone this runtime does not
 * know.
 *
 * Public because it is what `notes*.csv`'s `utc_offset_min` column is written
 * from, and what the row's zone is checked AGAINST on read. Minutes rather
 * than `-06:00`: a plain integer is the only thing a spreadsheet is
 * guaranteed not to reformat, which is the same reason a note's timestamp is
 * five integers rather than one string.
 */
export function zoneOffsetMinutes(instant: Instant, timeZone: string): number | null {
  const ms = zoneOffsetMs(instant, timeZone);
  return ms === null ? null : Math.round(ms / 60_000);
}

/**
 * Guess the event's timezone from the media's OWN recorded UTC offsets.
 *
 * A phone that records `OffsetTimeOriginal` states the offset it was set to
 * when the shutter fired (`timeSource: 'exif-offset'`, see `metadata.ts`),
 * which is a measurement of where the event happened — far better than the
 * zone of whichever laptop the folder is later opened on. The modal offset
 * wins, because a folder can pick up a stray photo from the drive home.
 *
 * **No GPS→timezone lookup**, deliberately: that needs a boundary database,
 * which this project's dependency budget will not carry, and EXIF is both
 * already parsed and more accurate about what the camera actually meant.
 *
 * An offset is not a zone, so the result is honest about which one it has:
 *
 *   - `fallback` when nothing carries an offset — usually the browser's zone.
 *   - `fallback` when the browser's zone ALREADY has the modal offset at that
 *     moment. It is a real IANA zone with real DST rules, so it beats a fixed
 *     offset that happens to agree today.
 *   - `Etc/GMT±N` otherwise, which says exactly what is known (an offset) and
 *     nothing that is not (a place, or a DST rule). `Etc/GMT+6` is UTC−06:00
 *     — the sign is inverted, per POSIX, which is why it is written out here
 *     rather than derived at each call site.
 *   - `fallback` for an offset that is not a whole number of hours (India's
 *     +05:30), which `Etc/GMT` cannot express. Better a zone the reader can
 *     correct than one silently half an hour out.
 *
 * The field in Event settings shows the answer and lets it be changed — this
 * is a default, never a decision.
 */
export function inferEventTimezone(
  recorded: readonly { at?: string }[],
  fallback: string | undefined,
): string | undefined {
  // `Z` is deliberately not counted: a GPS timestamp is UTC because it came
  // from satellites, which says nothing about where the camera was.
  const counts = new Map<number, { count: number; instant: Instant }>();
  for (const entry of recorded) {
    const at = entry.at;
    if (!at) continue;
    const m = /([+-])(\d{2}):?(\d{2})$/.exec(at.trim());
    if (!m) continue;
    const minutes =
      (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    const instant = parseZonedInstant(at);
    if (instant === null) continue;
    const seen = counts.get(minutes);
    if (seen) seen.count++;
    else counts.set(minutes, { count: 1, instant });
  }

  let best: { minutes: number; count: number; instant: Instant } | null = null;
  for (const [minutes, seen] of counts) {
    if (!best || seen.count > best.count) best = { minutes, count: seen.count, instant: seen.instant };
  }
  if (!best) return fallback;

  if (fallback && zoneOffsetMinutes(best.instant, fallback) === best.minutes) return fallback;
  if (best.minutes % 60 !== 0) return fallback;

  const hours = best.minutes / 60;
  if (hours === 0) return 'UTC';
  return `Etc/GMT${hours < 0 ? '+' : '-'}${Math.abs(hours)}`;
}

/**
 * Resolve a naive local timestamp ("2026-08-22T13:12:04", no zone) into an
 * instant, using an IANA timezone.
 *
 * Two passes: guess the offset at the naive time read as UTC, correct, then
 * re-read the offset at the corrected instant. The second pass is what makes
 * this right across a DST transition.
 *
 * Ambiguous times during a fall-back hour resolve to the first (pre-shift)
 * occurrence. Times that do not exist at all — skipped over by a
 * spring-forward shift — resolve using the offset in effect BEFORE the
 * shift, which reads back an hour EARLIER than what was typed: a nonexistent
 * "02:30" resolves to 01:30, not to 03:30 or any other instant "the wall
 * clock jumped to" (verified against `America/Denver`'s 2026 transition,
 * every naive minute in the gap). Both outcomes are stable and neither is
 * worth more code for a single-day event. Now that `notes*.csv` rows can
 * carry `utc_offset_min`, this two-pass guess is only the fallback for a row
 * that has none (see `resolveZoned` in `wallclock.ts`) — a row that must be
 * exact through a DST boundary should carry the offset instead of relying on
 * this.
 */
export function zonedToInstant(naive: string, timeZone: string): Instant | null {
  const m = NAIVE_RE.exec(naive.trim());
  if (!m) return null;

  const [, y, mo, d, h, mi, s, ms] = m;
  const asIfUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    ms ? Number(ms.padEnd(3, '0')) : 0,
  );
  if (Number.isNaN(asIfUtc)) return null;

  const firstGuess = zoneOffsetMs(asIfUtc, timeZone);
  if (firstGuess === null) return null;

  const refined = zoneOffsetMs(asIfUtc - firstGuess, timeZone);
  if (refined === null) return null;

  return asIfUtc - refined;
}

// ---------------------------------------------------------------------------
// Clock offsets
// ---------------------------------------------------------------------------

/**
 * Whether a person's `clockOffset` applies to a timestamp from this source.
 *
 * This distinction is the whole point of tracking `timeSource`. `clockOffset`
 * corrects a DEVICE CLOCK. A GPS timestamp came from satellites and a manual
 * placement came from the author's own judgement — neither is affected by the
 * camera's clock being wrong, and applying the offset to them would introduce
 * exactly the error the offset exists to remove.
 */
export function appliesClockOffset(source: TimeSource): boolean {
  return isDeviceClock(source);
}

export interface ResolvedTime {
  /** Corrected epoch milliseconds, or null if the item cannot be placed. */
  instant: Instant | null;
  source: TimeSource;
  /**
   * True when the timestamp did NOT come from the device's own clock, so no
   * `clockOffset` was applied. Provenance, not accuracy — a GPS time is
   * device-independent but can still be stale by minutes.
   */
  deviceIndependent: boolean;
  /** Milliseconds of clockOffset actually applied. */
  offsetApplied: number;
  /**
   * Present in two cases, not just one: when `instant` is null — the item
   * cannot be placed at all, and this is shown in the unplaced tray — and
   * also when `instant` resolved fine but a `clockOffset` on the person could
   * not be parsed and was silently ignored, in which case `instant` is the
   * uncorrected recorded time. Check `instant === null` to tell which one
   * happened; do not assume this field's presence alone means unplaceable.
   */
  reason?: string;
}

/**
 * Turn an item's recorded timestamp into the instant it belongs at on the
 * shared timeline.
 *
 * `item.at` is always the time AS RECORDED. Correction happens here, at read
 * time, so that adjusting one person's clock is a one-line manifest edit
 * rather than a rewrite of every item they shot.
 */
export function resolveItemInstant(
  item: Pick<Item, 'at' | 'timeSource'>,
  person: Pick<Person, 'clockOffset'> | undefined,
  event: Pick<EventInfo, 'timezone'>,
): ResolvedTime {
  const source = item.timeSource;
  const base: Omit<ResolvedTime, 'instant'> = {
    source,
    deviceIndependent: !isDeviceClock(source),
    offsetApplied: 0,
  };

  if (source === 'none' || item.at === undefined) {
    return { ...base, instant: null, reason: 'no timestamp found in this file' };
  }

  let recorded: Instant | null;
  if (hasZone(item.at)) {
    recorded = parseZonedInstant(item.at);
  } else if (event.timezone) {
    recorded = zonedToInstant(item.at, event.timezone);
    if (recorded === null) {
      return {
        ...base,
        instant: null,
        reason: `could not read "${item.at}" in timezone "${event.timezone}"`,
      };
    }
  } else {
    return {
      ...base,
      instant: null,
      reason:
        `"${item.at}" has no timezone, and the event has no "timezone" set. ` +
        `Add event.timezone (e.g. "America/Los_Angeles") to place this item.`,
    };
  }

  if (recorded === null) {
    return { ...base, instant: null, reason: `could not read the timestamp "${item.at}"` };
  }

  if (!appliesClockOffset(source) || !person?.clockOffset) {
    return { ...base, instant: recorded };
  }

  const offset = parseDuration(person.clockOffset);
  if (offset === null) {
    return {
      ...base,
      instant: recorded,
      reason: `ignored unparseable clockOffset "${person.clockOffset}"`,
    };
  }

  return { ...base, instant: recorded + offset, offsetApplied: offset };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Every view shows times in the EVENT's timezone, not the reader's.
 *
 * A crew member opening this from another timezone must still see "2am on the
 * climb", because 2am is what the story is about. Showing their local time
 * would silently renumber the whole race.
 */
function formatIn(instant: Instant, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-GB', timeZone ? { ...opts, timeZone } : opts).format(
      new Date(instant),
    );
  } catch {
    // An unknown zone should degrade to UTC rather than blank the timeline.
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(instant));
  }
}

/** "06:12" — the lane and cursor label. */
export function formatClock(instant: Instant, timeZone?: string): string {
  return formatIn(instant, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** "Sat 22 Aug, 06:12" — for feed entries and tooltips. */
export function formatDateTime(instant: Instant, timeZone?: string): string {
  return formatIn(instant, timeZone, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** "4h 12m", "12s" — for an event span or a clip length. */
export function formatSpan(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
