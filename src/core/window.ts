/**
 * Cropping the timeline to the part you care about.
 *
 * A folder is almost never just the event. The real race folder held 231
 * files spanning **46.6 days** — planning photos from six weeks earlier, the
 * drive out, the race itself, and everyone together the morning after. Drawn
 * end to end, the race is a 4% sliver and the rest is empty space.
 *
 * So the visible window is part of the app's state, not a view detail, and it
 * does double duty: it crops away the irrelevant, and it zooms into stretches
 * where too much happened at once.
 */

import { diagnoseMissingTime } from './metadata.ts';
import type { Note } from './notes.ts';
import type { Item, Manifest } from './schema.ts';
import { parseDuration, resolveItemInstant, type Instant } from './time.ts';

export interface TimeWindow {
  from: Instant;
  to: Instant;
}

export interface PlacedItem {
  item: Item;
  instant: Instant;
}

export interface UnplacedItem {
  item: Item;
  /** What to do about it, not just what went wrong. */
  reason: string;
}

export interface PlacementResult {
  /** Items with a resolvable instant, in time order. */
  placed: PlacedItem[];
  /** Items with no usable time, each with a reason worth acting on. */
  unplaced: UnplacedItem[];
}

/**
 * Resolve every item to an instant on the shared clock.
 *
 * Done once per manifest and reused by every view, because it applies each
 * person's clock offset and every view must agree about where things sit.
 */
export function placeItems(manifest: Manifest): PlacementResult {
  const peopleById = new Map(manifest.people.map((p) => [p.id, p]));
  const placed: PlacedItem[] = [];
  const unplaced: UnplacedItem[] = [];

  for (const item of manifest.items) {
    const resolved = resolveItemInstant(item, peopleById.get(item.person), manifest.event);
    if (resolved.instant !== null) {
      placed.push({ item, instant: resolved.instant });
      continue;
    }
    // A file with a time we cannot interpret is a different problem from one
    // with no time at all, and the fix is different: set a timezone versus
    // go and ask someone for the original.
    unplaced.push({
      item,
      reason:
        item.timeSource === 'none'
          ? diagnoseMissingTime(item.src)
          : (resolved.reason ?? 'Its timestamp could not be interpreted.'),
    });
  }

  placed.sort((a, b) => a.instant - b.instant);
  return { placed, unplaced };
}

/** Everything, end to end. Null when nothing could be placed. */
export function fullSpan(placed: readonly PlacedItem[]): TimeWindow | null {
  const first = placed[0];
  const last = placed[placed.length - 1];
  if (!first || !last) return null;
  return { from: first.instant, to: last.instant };
}

export interface ClusterOptions {
  /**
   * Split wherever consecutive items are further apart than this. Defaults to
   * 0.5% of the total span, clamped to between 1 and 12 hours.
   *
   * That default was chosen against the real folder, whose gap distribution
   * is a cliff: one gap of 1021 hours (the six weeks before the race) and
   * nothing else above 12.5. Any threshold in a wide band gives the same
   * answer, which is what makes this safe to do automatically.
   */
  gapMs?: number;
}

export interface Cluster extends TimeWindow {
  count: number;
}

/** Split the timeline wherever there is a long quiet stretch. */
export function clusters(placed: readonly PlacedItem[], opts: ClusterOptions = {}): Cluster[] {
  const span = fullSpan(placed);
  if (!span || placed.length === 0) return [];

  const gap = opts.gapMs ?? defaultGap(span.to - span.from);
  const out: Cluster[] = [];
  let start = 0;

  for (let i = 0; i < placed.length; i++) {
    const here = placed[i] as PlacedItem;
    const next = placed[i + 1];
    if (!next || next.instant - here.instant > gap) {
      out.push({
        from: (placed[start] as PlacedItem).instant,
        to: here.instant,
        count: i - start + 1,
      });
      start = i + 1;
    }
  }
  return out;
}

function defaultGap(spanMs: number): number {
  const HOUR = 3_600_000;
  return Math.min(12 * HOUR, Math.max(HOUR, spanMs * 0.005));
}

/**
 * The window to open on, when there is no course to take it from.
 *
 * The cluster holding the most items — which for a race folder is the race,
 * because that is when everyone was shooting. Padded slightly so the first
 * and last photos are not flush against the edge.
 */
export function densestWindow(placed: readonly PlacedItem[], opts: ClusterOptions = {}): TimeWindow | null {
  const found = clusters(placed, opts);
  if (found.length === 0) return null;

  let best = found[0] as Cluster;
  for (const c of found) if (c.count > best.count) best = c;

  // A cluster of one has no width; give it something to show.
  const pad = Math.max((best.to - best.from) * 0.02, 60_000);
  return { from: best.from - pad, to: best.to + pad };
}

/**
 * The single range covering several chosen stretches.
 *
 * A range is contiguous by definition, so choosing two non-adjacent clusters
 * necessarily sweeps up whatever sits between them. That is a real
 * consequence rather than a bug — but it must be visible, so the UI marks
 * swept-up clusters distinctly instead of letting them look excluded while
 * their photos are on screen.
 */
export function unionSpan(
  windows: readonly TimeWindow[],
  padRatio = 0.02,
): TimeWindow | null {
  if (windows.length === 0) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const w of windows) {
    if (w.from < from) from = w.from;
    if (w.to > to) to = w.to;
  }
  // A little air so the first and last items are not flush against an edge.
  const pad = Math.max((to - from) * padRatio, 60_000);
  return { from: from - pad, to: to + pad };
}

/**
 * The window a GPX implies: the ride itself, plus a margin either side to
 * catch the start line and the finish.
 */
export function windowFromCourse(course: TimeWindow, padMs = 10 * 60_000): TimeWindow {
  return { from: course.from - padMs, to: course.to + padMs };
}

export function isWithin(instant: Instant, w: TimeWindow): boolean {
  return instant >= w.from && instant <= w.to;
}

export function itemsInWindow(placed: readonly PlacedItem[], w: TimeWindow): PlacedItem[] {
  return placed.filter((p) => isWithin(p.instant, w));
}

/**
 * Slide a window along without changing how wide it is.
 *
 * Distinct from `clampWindow` on purpose. That one keeps a window legal after
 * an edge moves, and will happily narrow it at a boundary. Panning must NOT
 * narrow: dragging the selected range up against the end of the data should
 * stop it, not squash it.
 */
export function shiftWindow(w: TimeWindow, byMs: number, bounds: TimeWindow): TimeWindow {
  const width = w.to - w.from;
  // A window wider than the data cannot move at all; pin it and keep its size.
  if (width >= bounds.to - bounds.from) return { from: bounds.from, to: bounds.from + width };

  let from = w.from + byMs;
  if (from < bounds.from) from = bounds.from;
  if (from + width > bounds.to) from = bounds.to - width;
  return { from, to: from + width };
}

/** Keep a window inside the data's bounds, and never inverted or zero-width. */
export function clampWindow(w: TimeWindow, bounds: TimeWindow): TimeWindow {
  const min = bounds.from;
  const max = bounds.to;
  // A minute of width, or the whole span if the data is narrower than that.
  const minWidth = Math.min(60_000, Math.max(1, max - min));

  let from = Math.min(Math.max(w.from, min), max);
  let to = Math.min(Math.max(w.to, min), max);
  if (to < from) [from, to] = [to, from];
  if (to - from < minWidth) {
    if (from + minWidth <= max) to = from + minWidth;
    else from = Math.max(min, to - minWidth);
  }
  return { from, to };
}

/**
 * Counts per equal-width bin across `w`.
 *
 * This is the backdrop behind the window handles, and it is the load-bearing
 * part of the control: across six weeks of mostly-nothing you cannot know
 * where to drag without seeing where the photos actually are.
 */
export function histogram(
  placed: readonly PlacedItem[],
  w: TimeWindow,
  bins: number,
): number[] {
  const counts = new Array<number>(Math.max(1, bins)).fill(0);
  const width = w.to - w.from;
  if (width <= 0) return counts;

  for (const p of placed) {
    if (!isWithin(p.instant, w)) continue;
    const ratio = (p.instant - w.from) / width;
    const index = Math.min(counts.length - 1, Math.floor(ratio * counts.length));
    counts[index] = (counts[index] as number) + 1;
  }
  return counts;
}

/** A note resolved onto the timeline. */
export interface PlacedNote {
  note: Note;
  instant: Instant;
  /** End of the span, for a note that covers a stretch of time. */
  until?: Instant;
}

/**
 * Resolve notes onto the timeline, in order.
 *
 * Deliberately much simpler than `placeItems`: a note carries a real ISO
 * instant because a person typed it, so there is no timezone to apply, no
 * source to rank, and — importantly — **no `clockOffset`**. The offset exists
 * to correct a device's clock; an author is not a device, and correcting them
 * would introduce the error the offset removes.
 *
 * A note whose timestamp will not parse is dropped rather than placed at the
 * epoch, which would put it an eternity from the race.
 *
 * Takes the notes list directly rather than a `Manifest` — notes now live in
 * `notes*.csv` files merged by `mergeNotes`, not in `manifest.notes`. See
 * `ingestFolder` for where a legacy manifest's notes (and captions) are
 * migrated into this shape.
 */
export function placeNotes(notes: readonly Note[]): PlacedNote[] {
  const out: PlacedNote[] = [];
  for (const note of notes) {
    const instant = Date.parse(note.at);
    if (Number.isNaN(instant)) continue;
    const placed: PlacedNote = { note, instant };
    if (note.duration !== undefined) {
      const span = parseDuration(note.duration);
      // A span that ends before it starts is not a span. Keep the moment.
      if (span !== null && span > 0) placed.until = instant + span;
    }
    out.push(placed);
  }
  out.sort((a, b) => a.instant - b.instant);
  return out;
}

/**
 * Drop notes that are photo captions (`note.photo` set).
 *
 * A caption lives ON its photo: the tile's speech-bubble glyph is how you
 * discover it, and the lightbox and the Notes panel are where you read it.
 * Interleaving it into the feed's chronological stream too, or counting it
 * on the note-dock button, would say the same thing three times over and
 * make the glyph's "otherwise invisible" justification false — so both call
 * sites share this one filter rather than each re-deriving it. The Notes
 * panel does NOT use this: it is the reference list, and a caption belongs
 * there same as any other note.
 */
export function excludingCaptions(notes: readonly PlacedNote[]): PlacedNote[] {
  return notes.filter((n) => n.note.photo === undefined);
}
