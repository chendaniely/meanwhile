import { describe, expect, it } from 'vitest';
import type { Note } from '../src/core/notes.ts';
import type { Item, Manifest } from '../src/core/schema.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import {
  clampWindow,
  clusters,
  densestWindow,
  fullSpan,
  histogram,
  isWithin,
  itemsInWindow,
  placeItems,
  placeNotes,
  shiftWindow,
  unionSpan,
  windowFromCourse,
  type PlacedItem,
} from '../src/core/window.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function manifestOf(items: Array<{ id: string; at?: string; person?: string }>): Manifest {
  return {
    schema: SCHEMA_VERSION,
    event: { title: 'x', timezone: 'UTC' },
    people: [
      { id: 'sam', name: 'Sam' },
      { id: 'dan', name: 'Dan', clockOffset: '-PT47S' },
    ],
    items: items.map((i) => ({
      id: i.id,
      person: i.person ?? 'sam',
      type: 'photo' as const,
      src: i.id,
      ...(i.at ? { at: i.at, timeSource: 'exif-offset' as const } : { timeSource: 'none' as const }),
    })) as Item[],
  };
}

/** Instants only, for the pure window functions. */
const at = (...instants: number[]): PlacedItem[] =>
  instants.map((instant, i) => ({
    instant,
    item: { id: `i${i}`, person: 'sam', type: 'photo', src: `i${i}`, timeSource: 'gps' },
  }));

describe('placeItems', () => {
  it('separates placed from unplaced and sorts by instant', () => {
    const { placed, unplaced } = placeItems(
      manifestOf([
        { id: 'late', at: '2026-07-24T12:00:00Z' },
        { id: 'nope' },
        { id: 'early', at: '2026-07-24T09:00:00Z' },
      ]),
    );
    expect(placed.map((p) => p.item.id)).toEqual(['early', 'late']);
    expect(unplaced.map((u) => u.item.id)).toEqual(['nope']);
    // The reason has to be actionable, not just "no timestamp".
    expect(unplaced[0]?.reason).toMatch(/metadata|filename|original/i);
  });

  it('applies each person clock offset before ordering', () => {
    // Dan's camera runs 47s fast, so his 12:00:30 is really 11:59:43 and
    // belongs BEFORE Sam's 12:00:00. Ordering must reflect the correction.
    const { placed } = placeItems(
      manifestOf([
        { id: 'sam-shot', at: '2026-07-24T12:00:00Z', person: 'sam' },
        { id: 'dan-shot', at: '2026-07-24T12:00:30Z', person: 'dan' },
      ]),
    );
    expect(placed.map((p) => p.item.id)).toEqual(['dan-shot', 'sam-shot']);
  });
});

describe('why an item could not be placed', () => {
  it('names WhatsApp specifically, because the fix is to ask for the original', () => {
    const { unplaced } = placeItems(manifestOf([{ id: 'IMG-20260722-WA0005.jpg' }]));
    expect(unplaced[0]?.reason).toMatch(/WhatsApp/);
  });

  it('distinguishes "no time at all" from "no timezone to read it in"', () => {
    // Different problems with different fixes: chase the person for the
    // original, versus set event.timezone.
    const noZone: Manifest = {
      schema: SCHEMA_VERSION,
      event: { title: 'x' },
      people: [{ id: 'sam', name: 'Sam' }],
      items: [
        {
          id: 'a.jpg',
          person: 'sam',
          type: 'photo',
          src: 'a.jpg',
          at: '2026-07-24T06:12:04',
          timeSource: 'exif-naive',
        },
      ],
    };
    expect(placeItems(noZone).unplaced[0]?.reason).toMatch(/timezone/i);
  });
});

describe('clusters', () => {
  it('splits at long quiet stretches', () => {
    // Two bursts a week apart.
    const week = 7 * DAY;
    const found = clusters(at(0, HOUR, 2 * HOUR, week, week + HOUR));
    expect(found).toHaveLength(2);
    expect(found[0]?.count).toBe(3);
    expect(found[1]?.count).toBe(2);
  });

  it('keeps a continuous run together', () => {
    expect(clusters(at(0, HOUR, 2 * HOUR, 3 * HOUR))).toHaveLength(1);
  });

  it('returns nothing for no items', () => {
    expect(clusters([])).toEqual([]);
  });
});

describe('densestWindow', () => {
  it('finds the event inside a folder that spans weeks', () => {
    // The real shape: a few planning photos six weeks early, a big cluster
    // for the race, a few the morning after.
    const planning = [0, 60_000];
    const race = Array.from({ length: 40 }, (_, i) => 42 * DAY + i * 20 * 60_000);
    const after = [45 * DAY, 45 * DAY + 60_000];
    const w = densestWindow(at(...planning, ...race, ...after));

    expect(w).not.toBeNull();
    // Covers the race and excludes both the planning photos and the morning
    // after — which is the whole point of the default.
    expect(w?.from).toBeLessThanOrEqual(race[0] as number);
    expect(w?.to).toBeGreaterThanOrEqual(race[race.length - 1] as number);
    expect(w?.from).toBeGreaterThan(planning[1] as number);
    expect(w?.to).toBeLessThan(after[0] as number);
  });

  it('gives a single lonely item some width to show', () => {
    const w = densestWindow(at(0));
    expect(w).not.toBeNull();
    expect((w as { to: number }).to).toBeGreaterThan((w as { from: number }).from);
  });

  it('returns null when nothing is placed', () => {
    expect(densestWindow([])).toBeNull();
  });
});

describe('windowFromCourse', () => {
  it('pads the course by ten minutes either side', () => {
    const w = windowFromCourse({ from: 1000 * HOUR, to: 1030 * HOUR });
    expect(w.from).toBe(1000 * HOUR - 10 * 60_000);
    expect(w.to).toBe(1030 * HOUR + 10 * 60_000);
  });

  it('takes a custom pad', () => {
    const w = windowFromCourse({ from: 0, to: HOUR }, 5 * 60_000);
    expect(w.from).toBe(-5 * 60_000);
  });
});

describe('unionSpan', () => {
  it('spans several chosen stretches', () => {
    const span = unionSpan([
      { from: 10 * HOUR, to: 12 * HOUR },
      { from: 30 * HOUR, to: 34 * HOUR },
    ]) as { from: number; to: number };
    expect(span.from).toBeLessThanOrEqual(10 * HOUR);
    expect(span.to).toBeGreaterThanOrEqual(34 * HOUR);
  });

  it('sweeps up whatever sits between non-adjacent choices', () => {
    // A range is contiguous by definition, so this is unavoidable. It is
    // handled by SHOWING it — the swept-up cluster gets its own chip state —
    // not by pretending it did not happen.
    const middle = { from: 20 * HOUR, to: 21 * HOUR };
    const span = unionSpan([
      { from: 10 * HOUR, to: 12 * HOUR },
      { from: 30 * HOUR, to: 34 * HOUR },
    ]) as { from: number; to: number };
    expect(isWithin(middle.from, span)).toBe(true);
  });

  it('accepts a single stretch', () => {
    const span = unionSpan([{ from: 10 * HOUR, to: 12 * HOUR }]) as { from: number; to: number };
    expect(span.from).toBeLessThan(10 * HOUR);
    expect(span.to).toBeGreaterThan(12 * HOUR);
  });

  it('gives a zero-width stretch some width', () => {
    const span = unionSpan([{ from: HOUR, to: HOUR }]) as { from: number; to: number };
    expect(span.to - span.from).toBeGreaterThan(0);
  });

  it('returns null for nothing chosen', () => {
    expect(unionSpan([])).toBeNull();
  });
});

describe('itemsInWindow', () => {
  const placed = at(0, HOUR, 2 * HOUR, 3 * HOUR);

  it('keeps only what falls inside, inclusive of the edges', () => {
    expect(itemsInWindow(placed, { from: HOUR, to: 2 * HOUR })).toHaveLength(2);
    expect(isWithin(HOUR, { from: HOUR, to: 2 * HOUR })).toBe(true);
    expect(isWithin(0, { from: HOUR, to: 2 * HOUR })).toBe(false);
  });

  it('keeps everything for the full span', () => {
    expect(itemsInWindow(placed, fullSpan(placed) as never)).toHaveLength(4);
  });
});

describe('clampWindow', () => {
  const bounds = { from: 0, to: 10 * HOUR };

  it('keeps a window inside the data', () => {
    expect(clampWindow({ from: -HOUR, to: 20 * HOUR }, bounds)).toEqual(bounds);
  });

  it('un-inverts a dragged-past window', () => {
    // The two handles can cross when you drag one past the other.
    const w = clampWindow({ from: 5 * HOUR, to: 2 * HOUR }, bounds);
    expect(w.from).toBeLessThan(w.to);
  });

  it('never collapses to zero width', () => {
    const w = clampWindow({ from: 5 * HOUR, to: 5 * HOUR }, bounds);
    expect(w.to - w.from).toBeGreaterThan(0);
  });

  it('handles a window pinned to the far edge', () => {
    const w = clampWindow({ from: 10 * HOUR, to: 10 * HOUR }, bounds);
    expect(w.to - w.from).toBeGreaterThan(0);
    expect(w.to).toBeLessThanOrEqual(bounds.to);
    expect(w.from).toBeGreaterThanOrEqual(bounds.from);
  });
});

describe('shiftWindow', () => {
  const bounds = { from: 0, to: 10 * HOUR };

  it('slides without resizing', () => {
    const moved = shiftWindow({ from: 2 * HOUR, to: 4 * HOUR }, HOUR, bounds);
    expect(moved).toEqual({ from: 3 * HOUR, to: 5 * HOUR });
  });

  it('stops at the edge rather than squashing', () => {
    // The difference from clampWindow: panning into the boundary must keep
    // the width, or the range silently narrows every time you overshoot.
    const moved = shiftWindow({ from: 8 * HOUR, to: 10 * HOUR }, 5 * HOUR, bounds);
    expect(moved).toEqual({ from: 8 * HOUR, to: 10 * HOUR });
    expect(moved.to - moved.from).toBe(2 * HOUR);
  });

  it('stops at the start edge too', () => {
    const moved = shiftWindow({ from: HOUR, to: 3 * HOUR }, -5 * HOUR, bounds);
    expect(moved).toEqual({ from: 0, to: 2 * HOUR });
  });

  it('pins a window wider than the data instead of drifting', () => {
    const moved = shiftWindow({ from: -5 * HOUR, to: 20 * HOUR }, 3 * HOUR, bounds);
    expect(moved.from).toBe(bounds.from);
    expect(moved.to - moved.from).toBe(25 * HOUR);
  });
});

describe('dragging a handle', () => {
  // Exactly what the slider does on each input event: merge one edge into the
  // current range, clamp, then re-filter. Covered here because the browser
  // interaction itself is thin wiring over these three calls.
  const placed = at(0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR);
  const bounds = fullSpan(placed) as { from: number; to: number };
  const drag = (range: typeof bounds, edge: Partial<typeof bounds>) =>
    clampWindow({ ...range, ...edge }, bounds);

  it('narrows the visible set as the end handle moves in', () => {
    let range = bounds;
    expect(itemsInWindow(placed, range)).toHaveLength(5);

    range = drag(range, { to: 2 * HOUR });
    expect(itemsInWindow(placed, range)).toHaveLength(3);

    range = drag(range, { from: HOUR });
    expect(itemsInWindow(placed, range)).toHaveLength(2);
  });

  it('survives dragging one handle straight past the other', () => {
    const range = drag({ from: 3 * HOUR, to: 4 * HOUR }, { to: HOUR });
    expect(range.from).toBeLessThan(range.to);
    expect(itemsInWindow(placed, range).length).toBeGreaterThan(0);
  });

  it('never leaves the data bounds', () => {
    const range = drag(bounds, { to: 99 * HOUR });
    expect(range.to).toBeLessThanOrEqual(bounds.to);
  });
});

describe('histogram', () => {
  it('counts items into equal-width bins', () => {
    const counts = histogram(at(0, 0, 0, 2 * HOUR), { from: 0, to: 4 * HOUR }, 4);
    expect(counts).toEqual([3, 0, 1, 0]);
  });

  it('puts an item exactly on the right edge in the last bin', () => {
    // Otherwise the final photo silently vanishes from the density backdrop.
    expect(histogram(at(4 * HOUR), { from: 0, to: 4 * HOUR }, 4)).toEqual([0, 0, 0, 1]);
  });

  it('ignores items outside the window', () => {
    expect(histogram(at(-HOUR, 10 * HOUR), { from: 0, to: 4 * HOUR }, 4)).toEqual([0, 0, 0, 0]);
  });

  it('survives a zero-width window', () => {
    expect(histogram(at(0), { from: 0, to: 0 }, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe('placeNotes', () => {
  // people/author default empty, matching what mergeNotes/rowToNote produce.
  const note = (over: Partial<Note> & { id: string; at: string; text: string }): Note => ({
    people: [],
    author: [],
    ...over,
  });

  it('places a note at the instant it was written for', () => {
    const placed = placeNotes([note({ id: 'n1', at: '2026-07-25T09:00:00Z', text: 'left the trailhead' })]);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.instant).toBe(Date.UTC(2026, 6, 25, 9));
  });

  it('sorts notes into timeline order', () => {
    const placed = placeNotes([
      note({ id: 'b', at: '2026-07-25T12:00:00Z', text: 'second' }),
      note({ id: 'a', at: '2026-07-25T09:00:00Z', text: 'first' }),
    ]);
    expect(placed.map((p) => p.note.id)).toEqual(['a', 'b']);
  });

  it('keeps a span, given as an ISO-8601 duration', () => {
    const placed = placeNotes([
      note({ id: 'n', at: '2026-07-26T09:00:00Z', duration: 'PT3H30M', text: 'asleep in the car' }),
    ]);
    expect(placed[0]?.until).toBe(Date.UTC(2026, 6, 26, 12, 30));
  });

  it('drops a negative duration, keeping the moment', () => {
    // A span that ends before it starts is not a span.
    const placed = placeNotes([
      note({ id: 'n', at: '2026-07-26T12:00:00Z', duration: '-PT3H', text: 'muddled' }),
    ]);
    expect(placed[0]?.until).toBeUndefined();
    expect(placed[0]?.instant).toBe(Date.UTC(2026, 6, 26, 12));
  });

  it('drops an unparseable time rather than placing it at the epoch', () => {
    // 1970 would put the note an eternity from the race and drag the whole
    // timeline with it.
    expect(placeNotes([note({ id: 'n', at: 'sometime tuesday', text: 'x' })])).toHaveLength(0);
  });

  it('applies no clock offset — a note carries no such field to apply', () => {
    // A note's time is authored, not a device clock's, so Note has no
    // clockOffset at all: correctness here is structural, not behavioral.
    const placed = placeNotes([
      note({ id: 'n', at: '2026-07-25T09:00:00Z', text: 'x', people: ['Priya'] }),
    ]);
    expect(placed[0]?.instant).toBe(Date.UTC(2026, 6, 25, 9));
  });

  it('is empty when there are no notes at all', () => {
    expect(placeNotes([])).toEqual([]);
  });
});
