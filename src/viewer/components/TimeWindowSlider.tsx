import { useEffect, useMemo, useState } from 'react';
import { formatDateTime, formatSpan } from '../../core/time.ts';
import {
  clampWindow,
  clusters as findClusters,
  histogram,
  isWithin,
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

  // Re-frame when a different folder is loaded, but not on every drag — the
  // extent must hold still while the handles move inside it.
  useEffect(() => {
    setExtent(framedAround(range, bounds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.from, bounds.to]);

  const counts = useMemo(() => histogram(placed, extent, BINS), [placed, extent]);
  const peak = Math.max(1, ...counts);

  const total = extent.to - extent.from;
  const ratio = (t: number) => (total > 0 ? ((t - extent.from) / total) * 100 : 0);
  const clamp01 = (n: number) => Math.min(100, Math.max(0, n));

  // A thousand steps across the extent: fine enough to land on a given
  // minute, coarse enough that a keyboard arrow does something visible.
  const step = Math.max(1, Math.round(total / 1000));

  const set = (next: Partial<TimeWindow>) => onChange(clampWindow({ ...range, ...next }, extent));

  const pick = (next: TimeWindow) => {
    setExtent(framedAround(next, bounds));
    onChange(clampWindow(next, bounds));
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
        <div className="chips" role="group" aria-label="Jump to a stretch of time">
          {clusters.map((cluster) => {
            const active = range.from <= cluster.from && range.to >= cluster.to;
            return (
              <button
                key={cluster.from}
                type="button"
                className={active ? 'chip chip--active' : 'chip'}
                onClick={() => pick(cluster)}
              >
                <span className="chip__count mw-mono">{cluster.count}</span>
                <span className="chip__when">{formatDateTime(cluster.from, timezone)}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={showingWholeFolder ? 'chip chip--active' : 'chip'}
            onClick={() => setExtent(bounds)}
          >
            <span className="chip__when">Whole folder</span>
          </button>
        </div>
      )}

      <div className="window__track">
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
          aria-hidden="true"
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
