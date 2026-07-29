import { describe, expect, it } from 'vitest';
import { itemsAround, laneBins, nearestItem, peopleAround } from '../src/core/timeline.ts';
import type { PlacedItem } from '../src/core/window.ts';

const HOUR = 3_600_000;

const at = (person: string, ...instants: number[]): PlacedItem[] =>
  instants.map((instant, i) => ({
    instant,
    item: {
      id: `${person}-${i}`,
      person,
      type: 'photo' as const,
      src: `${person}-${i}`,
      timeSource: 'gps' as const,
    },
  }));

const range = { from: 0, to: 10 * HOUR };

describe('laneBins', () => {
  it('gives every person a lane, including one who shot nothing', () => {
    // An empty lane is not an omission — it is the whole point. Someone who
    // was asleep in a car for six hours must still have a visible lane.
    const lanes = laneBins(at('sam', HOUR), ['sam', 'dan'], range, 10);
    expect(lanes.map((l) => l.person)).toEqual(['sam', 'dan']);
    expect(lanes[1]?.items).toEqual([]);
    expect(lanes[1]?.bins.every((b) => b === 0)).toBe(true);
  });

  it('keeps the lane order it was given, so the runner stays pinned', () => {
    const lanes = laneBins([], ['sam', 'dan', 'ali'], range, 4);
    expect(lanes.map((l) => l.person)).toEqual(['sam', 'dan', 'ali']);
  });

  it('bins by screen position, so a gap on screen is a gap in the data', () => {
    const lanes = laneBins(at('sam', 0, HOUR, 9 * HOUR), ['sam'], range, 10);
    const bins = lanes[0]?.bins as number[];
    expect(bins).toHaveLength(10);
    expect(bins[0]).toBe(1);
    expect(bins[1]).toBe(1);
    expect(bins[9]).toBe(1);
    // Everything between is empty, and that emptiness is the story.
    expect(bins.slice(2, 9).every((b) => b === 0)).toBe(true);
  });

  it('puts an item exactly on the right edge in the last bin', () => {
    const bins = laneBins(at('sam', 10 * HOUR), ['sam'], range, 10)[0]?.bins as number[];
    expect(bins[9]).toBe(1);
  });

  it('ignores items outside the window', () => {
    const lane = laneBins(at('sam', -HOUR, 5 * HOUR, 50 * HOUR), ['sam'], range, 10)[0];
    expect(lane?.items).toHaveLength(1);
  });

  it('reports the busiest bin, for scaling marks within the lane', () => {
    const lane = laneBins(at('sam', 0, 60_000, 120_000, 5 * HOUR), ['sam'], range, 10)[0];
    expect(lane?.peak).toBe(3);
  });
});

describe('longestGap', () => {
  it('measures the longest silence', () => {
    const lane = laneBins(at('sam', HOUR, 2 * HOUR, 8 * HOUR), ['sam'], range, 10)[0];
    expect(lane?.longestGap).toBe(6 * HOUR);
  });

  it('counts silence from the START of the window, not the first photo', () => {
    // Someone who shot twice at the end was absent for the whole race up to
    // then. Measuring only between items would report no gap at all.
    const lane = laneBins(at('sam', 9 * HOUR, 10 * HOUR), ['sam'], range, 10)[0];
    expect(lane?.longestGap).toBe(9 * HOUR);
  });

  it('counts silence to the END of the window too', () => {
    const lane = laneBins(at('sam', 0, HOUR), ['sam'], range, 10)[0];
    expect(lane?.longestGap).toBe(9 * HOUR);
  });

  it('treats a lane with nothing in it as one long gap', () => {
    const lane = laneBins([], ['sam'], range, 10)[0];
    expect(lane?.longestGap).toBe(10 * HOUR);
  });
});

describe('nearestItem', () => {
  const placed = [...at('sam', 0, 5 * HOUR), ...at('dan', 2 * HOUR)];

  it('finds the closest in either direction', () => {
    expect(nearestItem(placed, 2 * HOUR + 60_000)?.item.person).toBe('dan');
    expect(nearestItem(placed, 4 * HOUR)?.item.person).toBe('sam');
  });

  it('returns nothing when everything is too far away', () => {
    expect(nearestItem(placed, 100 * HOUR, HOUR)).toBeNull();
  });

  it('handles an empty set', () => {
    expect(nearestItem([], 0)).toBeNull();
  });
});

describe('simultaneity', () => {
  const placed = [...at('sam', 5 * HOUR), ...at('dan', 5 * HOUR + 60_000), ...at('ali', 9 * HOUR)];

  it('finds everything around an instant', () => {
    expect(itemsAround(placed, 5 * HOUR, 5 * 60_000)).toHaveLength(2);
  });

  it('counts the people, which is the premise of the whole app', () => {
    // Two lanes active at one moment is simultaneity; that is what this view
    // exists to make visible.
    expect(peopleAround(placed, 5 * HOUR, 5 * 60_000)).toEqual(new Set(['sam', 'dan']));
    expect(peopleAround(placed, 9 * HOUR, 60_000)).toEqual(new Set(['ali']));
    expect(peopleAround(placed, 20 * HOUR, 60_000).size).toBe(0);
  });
});
