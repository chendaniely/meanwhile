import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDateTime, formatSpan } from '../../core/time.ts';
import {
  clampWindow,
  clusters as findClusters,
  histogram,
  isWithin,
  shiftWindow,
  unionSpan,
  type PlacedItem,
  type TimeWindow,
} from '../../core/window.ts';

/**
 * Two handles over a density histogram, plus one chip per cluster.
 *
 * The histogram is not decoration — it is what makes the handles usable,
 * because across a mostly-empty span there is no other way to see where the
 * photos are.
 *
 * THE SCALE PROBLEM, and why the chips exist:
 *
 *   The real folder spans 46 days for a two-day race, and 42 of those days
 *   are one empty gap. Drawn linearly over the whole span, that gap eats 90%
 *   of the track: the handles crowd into the last few pixels, one pixel is
 *   about seven hours, and zooming *within* the race is impossible.
 *
 *   So the slider covers an EXTENT that is normally just the part you are
 *   looking at, not the whole folder. The chips jump between the clusters the
 *   data actually forms, and "Whole folder" widens the extent when you need
 *   to reach outside. Handles then fine-tune at a scale where a pixel is
 *   minutes rather than hours.
 *
 * Built from two overlaid native range inputs rather than a custom drag
 * implementation, which gets keyboard operation, screen-reader announcement,
 * and sane touch targets for free.
 */

interface Props {
  /** Every placed item, so the histogram shows what is being cropped away. */
  placed: readonly PlacedItem[];
  /** The full extent of the data. */
  bounds: TimeWindow;
  range: TimeWindow;
  onChange: (next: TimeWindow) => void;
  onReset: () => void;
  timezone?: string;
}

/** Enough bars to resolve a few minutes across a couple of days. */
const BINS = 180;

/** How much context to keep around the range when framing the slider. */
const EXTENT_PAD = 0.3;

function framedAround(range: TimeWindow, bounds: TimeWindow): TimeWindow {
  const pad = Math.max((range.to - range.from) * EXTENT_PAD, 60_000);
  return {
    from: Math.max(bounds.from, range.from - pad),
    to: Math.min(bounds.to, range.to + pad),
  };
}

export function TimeWindowSlider({
  placed,
  bounds,
  range,
  onChange,
  onReset,
  timezone,
}: Props) {
  const clusters = useMemo(() => findClusters(placed), [placed]);
  const [extent, setExtent] = useState<TimeWindow>(() => framedAround(range, bounds));

  /**
   * Which chips the author actually clicked.
   *
   * `null` means "nobody has clicked yet, work it out from the range" — which
   * is also what dragging a handle returns us to, since after a free drag the
   * range no longer corresponds to any set of clusters.
   */
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null);

  // Re-frame when a different folder is loaded, but not on every drag — the
  // extent must hold still while the handles move inside it.
  useEffect(() => {
    setExtent(framedAround(range, bounds));
    setPicked(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.from, bounds.to]);

  /** Clusters wholly inside the range, i.e. the ones actually being shown. */
  const inRange = useMemo(
    () => new Set(clusters.filter((c) => c.from >= range.from && c.to <= range.to).map((c) => c.from)),
    [clusters, range],
  );
  const chosen = picked ?? inRange;

  const counts = useMemo(() => histogram(placed, extent, BINS), [placed, extent]);
  const peak = Math.max(1, ...counts);

  const total = extent.to - extent.from;
  const ratio = (t: number) => (total > 0 ? ((t - extent.from) / total) * 100 : 0);
  const clamp01 = (n: number) => Math.min(100, Math.max(0, n));

  // A thousand steps across the extent: fine enough to land on a given
  // minute, coarse enough that a keyboard arrow does something visible.
  const step = Math.max(1, Math.round(total / 1000));

  const set = (next: Partial<TimeWindow>) => {
    // A free drag no longer matches any set of chips, so hand the chip state
    // back to being derived from wherever the handles ended up.
    setPicked(null);
    onChange(clampWindow({ ...range, ...next }, extent));
  };

  /**
   * Chips are toggles, so several stretches can be spanned at once — the
   * pre-race night plus the race, say.
   *
   * The resulting range is the union SPAN of what is chosen, because a range
   * is contiguous by definition. Picking two non-adjacent stretches therefore
   * sweeps up whatever sits between them; that is why a swept-up cluster gets
   * its own "included" chip state rather than looking unselected. Nothing is
   * shown without a chip saying so.
   */
  const toggle = (key: number) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // Deselecting the last one would show nothing at all; keep it selected.
    if (next.size === 0) return;

    const united = unionSpan(clusters.filter((c) => next.has(c.from)));
    if (!united) return;

    setPicked(next);
    setExtent(framedAround(united, bounds));
    onChange(clampWindow(united, bounds));
  };

  /**
   * Dragging the selected band slides the whole range, keeping its width.
   *
   * The handles set the edges; this moves the thing as a unit, which is what
   * you want once you have the right duration and just need it somewhere
   * else. Pointer capture means the drag survives the cursor leaving the
   * band, which it will.
   */
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; startX: number; startFrom: number } | null>(null);

  const msPerPixel = () => {
    const width = track.current?.clientWidth ?? 0;
    return width > 0 ? total / width : 0;
  };

  const onPanStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const perPixel = msPerPixel();
    if (perPixel === 0) return;
    drag.current = { pointer: event.pointerId, startX: event.clientX, startFrom: range.from };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    const byMs = (event.clientX - state.startX) * msPerPixel();
    // Measured from where the drag STARTED, not the last frame, so rounding
    // cannot accumulate into drift over a long drag.
    const width = range.to - range.from;
    onChange(shiftWindow({ from: state.startFrom, to: state.startFrom + width }, byMs, extent));
    setPicked(null);
  };

  const onPanEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  };

  const shown = placed.filter((p) => isWithin(p.instant, range)).length;
  const cropped = placed.length - shown;
  const showingWholeFolder = extent.from <= bounds.from && extent.to >= bounds.to;

  return (
    <section className="window" aria-label="Visible time range">
      <div className="window__head">
        <div>
          <span className="window__count mw-mono">{shown.toLocaleString()}</span>
          <span> of {placed.length.toLocaleString()} shown</span>
          {cropped > 0 && (
            <span className="window__cropped"> · {cropped.toLocaleString()} cropped out</span>
          )}
        </div>
        <button type="button" className="window__reset" onClick={onReset}>
          Reset
        </button>
      </div>

      {clusters.length > 1 && (
        <div className="chips" role="group" aria-label="Stretches of time to show">
          {clusters.map((cluster) => {
            const selected = chosen.has(cluster.from);
            // Not chosen, but sitting between two that were, so it is on
            // screen regardless. Saying so beats a chip that looks off while
            // its photos are visible.
            const swept = !selected && inRange.has(cluster.from);
            return (
              <button
                key={cluster.from}
                type="button"
                aria-pressed={selected}
                className={
                  selected ? 'chip chip--active' : swept ? 'chip chip--swept' : 'chip'
                }
                onClick={() => toggle(cluster.from)}
                title={
                  swept
                    ? 'Shown because it falls between the stretches you picked'
                    : `${cluster.count} items · ${formatSpan(cluster.to - cluster.from)}`
                }
              >
                <span className="chip__count mw-mono">{cluster.count}</span>
                <span className="chip__when">{formatDateTime(cluster.from, timezone)}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="chip chip--plain"
            aria-pressed={showingWholeFolder}
            onClick={() => setExtent(bounds)}
            title="Widen the slider to cover the whole folder, without changing what is shown"
          >
            <span className="chip__when">Whole folder</span>
          </button>
        </div>
      )}

      <div className="window__track" ref={track}>
        <div className="window__bars" aria-hidden="true">
          {counts.map((count, i) => {
            const binStart = extent.from + (total * i) / counts.length;
            const binEnd = extent.from + (total * (i + 1)) / counts.length;
            const inside = binEnd >= range.from && binStart <= range.to;
            return (
              <span
                key={i}
                className={inside ? 'window__bar' : 'window__bar window__bar--out'}
                style={{
                  // A floor so a bin holding a single photo is still visible;
                  // an empty bin stays empty.
                  height: count === 0 ? 0 : `${Math.max(12, (count / peak) * 100)}%`,
                }}
              />
            );
          })}
        </div>

        <div
          className="window__selection"
          style={{ left: `${clamp01(ratio(range.from))}%`, right: `${clamp01(100 - ratio(range.to))}%` }}
          onPointerDown={onPanStart}
          onPointerMove={onPanMove}
          onPointerUp={onPanEnd}
          onPointerCancel={onPanEnd}
          role="presentation"
          title="Drag to move the whole range"
        />

        <input
          type="range"
          className="window__handle"
          min={extent.from}
          max={extent.to}
          step={step}
          value={Math.max(extent.from, Math.min(range.from, extent.to))}
          onChange={(e) => set({ from: Number(e.target.value) })}
          aria-label="Start of visible range"
          aria-valuetext={formatDateTime(range.from, timezone)}
        />
        <input
          type="range"
          className="window__handle"
          min={extent.from}
          max={extent.to}
          step={step}
          value={Math.max(extent.from, Math.min(range.to, extent.to))}
          onChange={(e) => set({ to: Number(e.target.value) })}
          aria-label="End of visible range"
          aria-valuetext={formatDateTime(range.to, timezone)}
        />
      </div>

      <div className="window__labels mw-mono">
        <span>{formatDateTime(range.from, timezone)}</span>
        <span className="window__duration">{formatSpan(range.to - range.from)}</span>
        <span>{formatDateTime(range.to, timezone)}</span>
      </div>
    </section>
  );
}
