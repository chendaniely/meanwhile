/**
 * Laying people out as lanes on one clock.
 *
 * This is the view the project is named for. Its job is not to show what
 * everyone photographed — the feed does that — but to show **when each person
 * was and was not shooting, side by side**. So the encoding is built around
 * absence as much as presence:
 *
 *   > the six-hour hole in the runner's lane while three crew lanes are busy
 *   > IS the story of the night section
 *
 * Which is why a lane is binned by SCREEN POSITION rather than by clock time.
 * Fixed-duration bins would leave the pixel-level gaps up to the accident of
 * where a bin boundary fell; binning to the pixel means a gap on screen is a
 * gap in the data, at whatever zoom you are looking at.
 */

import type { PersonId } from './schema.ts';
import type { Instant } from './time.ts';
import type { PlacedItem, TimeWindow } from './window.ts';

export interface Lane {
  person: PersonId;
  /** One entry per screen bin; the number of items that fall in it. */
  bins: number[];
  /** Items in the window, in time order. */
  items: PlacedItem[];
  /** The busiest bin, for scaling the marks within this lane. */
  peak: number;
  /**
   * Longest stretch with nothing in it, in milliseconds. The headline number
   * for a lane: this is the gap that tells the story.
   */
  longestGap: number;
}

export function laneBins(
  placed: readonly PlacedItem[],
  people: readonly PersonId[],
  range: TimeWindow,
  bins: number,
): Lane[] {
  const width = range.to - range.from;
  const count = Math.max(1, bins);

  const byPerson = new Map<PersonId, Lane>();
  for (const person of people) {
    byPerson.set(person, {
      person,
      bins: new Array<number>(count).fill(0),
      items: [],
      peak: 0,
      longestGap: 0,
    });
  }

  for (const entry of placed) {
    if (entry.instant < range.from || entry.instant > range.to) continue;
    const lane = byPerson.get(entry.item.person);
    if (!lane) continue;
    lane.items.push(entry);
    if (width <= 0) continue;
    const index = Math.min(count - 1, Math.floor(((entry.instant - range.from) / width) * count));
    lane.bins[index] = (lane.bins[index] as number) + 1;
  }

  for (const lane of byPerson.values()) {
    lane.peak = Math.max(0, ...lane.bins);
    lane.longestGap = longestGapOf(lane.items, range);
  }
  return people.map((p) => byPerson.get(p) as Lane);
}

/**
 * The longest silence in a lane, measured from the edges of the window rather
 * than from the first and last item.
 *
 * Measuring only between items would report no gap at all for someone who
 * shot twice at the start and then stopped for six hours — which is exactly
 * the case worth surfacing.
 */
function longestGapOf(items: readonly PlacedItem[], range: TimeWindow): number {
  if (items.length === 0) return range.to - range.from;
  let longest = 0;
  let previous = range.from;
  for (const entry of items) {
    longest = Math.max(longest, entry.instant - previous);
    previous = entry.instant;
  }
  return Math.max(longest, range.to - previous);
}

/** The item nearest an instant, within a tolerance. For the cursor readout. */
export function nearestItem(
  placed: readonly PlacedItem[],
  instant: Instant,
  withinMs = Number.POSITIVE_INFINITY,
): PlacedItem | null {
  let best: PlacedItem | null = null;
  let bestGap = withinMs;
  for (const entry of placed) {
    const gap = Math.abs(entry.instant - instant);
    if (gap <= bestGap) {
      bestGap = gap;
      best = entry;
    }
  }
  return best;
}

/** Everything within a window either side of an instant — the moment grid. */
export function itemsAround(
  placed: readonly PlacedItem[],
  instant: Instant,
  radiusMs: number,
): PlacedItem[] {
  return placed.filter((entry) => Math.abs(entry.instant - instant) <= radiusMs);
}

/**
 * How many people were shooting within a window of an instant.
 *
 * The app's whole premise, as a number: two or more means simultaneity, and
 * that is the thing worth pointing at.
 */
export function peopleAround(
  placed: readonly PlacedItem[],
  instant: Instant,
  radiusMs: number,
): Set<PersonId> {
  const out = new Set<PersonId>();
  for (const entry of itemsAround(placed, instant, radiusMs)) out.add(entry.item.person);
  return out;
}
