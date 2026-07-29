import { Fragment, useMemo, useRef } from 'react';
import { atDistance, atTime, type Course, type Sample } from '../../core/course.ts';
import { formatClock, type Instant } from '../../core/time.ts';
import type { TimeWindow } from '../../core/window.ts';

/**
 * The runner's numbers through the race: elevation, heart rate, cadence, pace.
 *
 * ONE MEASURE PER CHART, stacked, sharing an x-axis and a crosshair. The
 * tempting alternative — heart rate and elevation on one plot with two y-axes
 * — is the single most common charting mistake there is: the crossings are an
 * artefact of two arbitrary scales, and readers see relationships that are
 * not in the data. Stacked charts show the same comparison honestly.
 *
 * Only the series the file actually carries are drawn. A Strava GPX has no
 * heart rate, so the heart-rate chart is not rendered rather than drawn empty.
 *
 * TWO POSSIBLE X-AXES, and the file decides which. A timed track plots against
 * TIME, which is what lets the crosshair share the app's cursor. **An untimed
 * track plots against DISTANCE** — the only ordinate it has. That is not a
 * degraded mode so much as a different question: "how steep is mile 60"
 * instead of "how steep was it at 2am".
 *
 * THE FOCUS IS IN METRES, whichever axis is drawn. Distance is the one
 * quantity the map and these charts always share — an untimed course has no
 * clock to link them by — so hovering here moves the map's marker and hovering
 * the map moves this crosshair, both through the same number.
 *
 * Each chart is a plain SVG path. There is no chart library here: a polyline
 * over a linear scale is a dozen lines of code, and the alternative would be
 * the largest dependency in the project.
 */

interface Props {
  course: Course;
  /**
   * The track thinned for drawing. The full one can be 120k points, which is
   * more path data than the browser will happily push around, and finer than
   * a screen can resolve. Measurements still come from `course`.
   */
  track: readonly Sample[];
  /**
   * The visible slice, when there is one. Absent if no photos have been
   * loaded yet — an untimed course ignores it entirely, and a timed one
   * falls back to its own full span.
   */
  range?: TimeWindow;
  at: Instant | null;
  /** Metres along the course that the reader is pointing at, from anywhere. */
  focus: number | null;
  onFocus: (distance: number | null) => void;
  onCursor: (instant: Instant) => void;
  /**
   * Write a note about the point being pointed at. The time is interpolated
   * from the photographs either side of it — see `estimateInstant` — which is
   * what makes it possible to annotate a climb nobody photographed.
   */
  onNoteHere?: (() => void) | undefined;
  noteHereLabel?: string | undefined;
  timezone?: string;
}

interface Series {
  id: string;
  label: string;
  color: string;
  /** Null for a sample that has no value; the line breaks rather than lying. */
  value: (s: Sample, index: number, all: readonly Sample[]) => number | null;
  format: (v: number) => string;
  /** Pace reads better with slower at the bottom. */
  invert?: boolean;
  /** Pace cannot exist without time. */
  needsTime?: boolean;
}

/** Slots 1-4 of the validated lane palette. */
const SERIES: Series[] = [
  {
    id: 'ele',
    label: 'Elevation',
    color: '#8a8378',
    value: (s) => s.ele ?? null,
    format: (v) => `${Math.round(v)} m`,
  },
  {
    id: 'hr',
    label: 'Heart rate',
    color: '#e66767',
    value: (s) => s.hr ?? null,
    format: (v) => `${Math.round(v)} bpm`,
  },
  {
    id: 'cadence',
    label: 'Cadence',
    color: '#199e70',
    value: (s) => s.cadence ?? null,
    format: (v) => `${Math.round(v)} spm`,
  },
  {
    id: 'pace',
    label: 'Pace',
    color: '#3987e5',
    needsTime: true,
    // Derived from the segment: no file stores pace.
    value: (s, i, all) => {
      const previous = all[i - 1];
      if (!previous || s.at === undefined || previous.at === undefined) return null;
      const seconds = (s.at - previous.at) / 1000;
      const metres = s.distance - previous.distance;
      if (seconds <= 0 || metres < 1) return null;
      const perKm = (seconds / metres) * 1000;
      // A stopped runner produces enormous values that flatten the whole
      // chart; anything over 20 min/km is a stop, not a pace.
      return perKm > 1200 ? null : perKm;
    },
    format: (v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')} /km`,
    invert: true,
  },
];

const CHART_HEIGHT = 56;

export function CourseCharts({
  course, track, range, at, focus, onFocus, onCursor, onNoteHere, noteHereLabel, timezone,
}: Props) {
  // Measured on the PLOT column, not the whole row: the labels sit in their
  // own grid column, and hit-testing against the full width was exactly what
  // put the crosshair away from the pointer.
  const plotArea = useRef<HTMLDivElement>(null);

  const timed = course.timed;

  // A timed course with no photos loaded still has its own span to plot.
  const span: TimeWindow | null = timed
    ? (range ?? { from: course.from as number, to: course.to as number })
    : null;

  const visible = useMemo(
    () =>
      span
        ? track.filter((s) => s.at !== undefined && s.at >= span.from && s.at <= span.to)
        : track,
    [track, span],
  );

  // One accessor decides the whole axis, so nothing below needs to branch.
  const xOfSample = useMemo(
    () => (timed ? (s: Sample) => s.at ?? 0 : (s: Sample) => s.distance),
    [timed],
  );
  const domain = span
    ? { min: span.from as number, max: span.to as number }
    : { min: 0, max: course.length };

  const charts = useMemo(() => {
    return SERIES.filter((series) => timed || !series.needsTime)
      .map((series) => {
        const points = visible.map((s, i) => ({
          x: xOfSample(s),
          value: series.value(s, i, visible),
        }));
        // Min/max in one pass: `Math.min(...values)` on a long track throws
        // RangeError, because every argument becomes a stack slot.
        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        for (const p of points) {
          if (p.value === null) continue;
          if (p.value < min) min = p.value;
          if (p.value > max) max = p.value;
          count++;
        }
        return count < 2 ? null : { series, points, min, max };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [visible, xOfSample, timed]);

  if (charts.length === 0) return null;

  const width = domain.max - domain.min;
  const pctOf = (x: number) => (width > 0 ? ((x - domain.min) / width) * 100 : 0);

  /** Axis units under the pointer, measured against the plot column. */
  const xAt = (clientX: number): number | null => {
    const rect = plotArea.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return domain.min + ratio * width;
  };

  // Everything crossing a component boundary is in metres — see the note at
  // the top — so these two convert at the edges.
  const distanceOfX = (x: number): number | null =>
    timed ? (atTime(course, x)?.distance ?? null) : x;
  const xOfDistance = (metres: number): number | null =>
    timed ? (atDistance(course, metres)?.at ?? null) : metres;

  // What the reader is pointing at, falling back to the shared time cursor so
  // the profile still marks the moment the rest of the app is showing.
  const focusX =
    focus !== null
      ? xOfDistance(focus)
      : timed && at !== null && at >= domain.min && at <= domain.max
        ? at
        : null;

  const point =
    focus !== null
      ? atDistance(course, focus)
      : timed && at !== null
        ? atTime(course, at)
        : null;

  return (
    <section className="charts" aria-label="Course statistics">
      <div
        className="charts__body"
        onPointerMove={(e) => {
          const x = xAt(e.clientX);
          if (x !== null) onFocus(distanceOfX(x));
        }}
        // The focus is shared, so clearing it on the way out is what stops the
        // map's marker being stranded wherever the pointer last was.
        onPointerLeave={() => onFocus(null)}
        onPointerDown={(e) => {
          // Only a timed course has a cursor to move. On an untimed one there
          // is no instant to scrub to, so a click sets nothing.
          if (!timed) return;
          const x = xAt(e.clientX);
          if (x !== null) onCursor(x);
        }}
        role="presentation"
      >
        {charts.map(({ series, points, min, max }) => {
          const extent = max - min || 1;
          const yOf = (v: number) => {
            const t = (v - min) / extent;
            return CHART_HEIGHT - (series.invert ? 1 - t : t) * CHART_HEIGHT;
          };
          // Breaks in the data break the line, rather than being bridged with
          // a segment that was never run.
          const d = points
            .map((p, i) =>
              p.value === null
                ? null
                : `${points[i - 1]?.value == null ? 'M' : 'L'}${pctOf(p.x).toFixed(3)},${yOf(p.value).toFixed(2)}`,
            )
            .filter(Boolean)
            .join(' ');

          const here = focusX === null ? null : valueAt(points, focusX);

          return (
            <Fragment key={series.id}>
              <div className="chart__label">
                <span className="chart__name">{series.label}</span>
                <span className="chart__value mw-mono" style={{ color: series.color }}>
                  {here === null ? '—' : series.format(here)}
                </span>
              </div>
              <svg
                className="chart__plot"
                viewBox={`0 0 100 ${CHART_HEIGHT}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path d={d} fill="none" stroke={series.color} strokeWidth="1.5"
                      vectorEffect="non-scaling-stroke" />
              </svg>
            </Fragment>
          );
        })}

        <div className="charts__overlay" ref={plotArea}>
          {focusX !== null && (
            <span
              className="charts__crosshair"
              style={{ left: `${pctOf(focusX)}%` }}
              aria-hidden="true"
            />
          )}
        </div>
      </div>

      <footer className="charts__foot mw-mono">
        {point ? (
          <>
            {point.at !== undefined && <span>{formatClock(point.at, timezone)}</span>}
            <span>{(point.distance / 1000).toFixed(2)} km in</span>
            {point.grade !== undefined && <span>{point.grade.toFixed(1)}% grade</span>}
          </>
        ) : (
          <span className="charts__hint">
            {timed ? 'Move across to read the race.' : 'Move across to read the course.'}
          </span>
        )}
        {onNoteHere && (
          <button type="button" className="charts__note" onClick={onNoteHere}>
            Note here
            {noteHereLabel && <span className="mw-mono"> {noteHereLabel}</span>}
          </button>
        )}
        <span className="charts__total">
          {(course.length / 1000).toFixed(1)} km · {Math.round(course.ascent)} m climb
        </span>
      </footer>
    </section>
  );
}

/** The plotted value nearest an x position, for the readout. */
function valueAt(
  points: ReadonlyArray<{ x: number; value: number | null }>,
  x: number,
): number | null {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const p of points) {
    if (p.value === null) continue;
    const gap = Math.abs(p.x - x);
    if (gap < bestGap) {
      bestGap = gap;
      best = p.value;
    }
  }
  return best;
}
