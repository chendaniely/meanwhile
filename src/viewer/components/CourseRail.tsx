import { useMemo } from 'react';
import { atDistance, atTime, type Course, type Sample } from '../../core/course.ts';
import type { Manifest } from '../../core/schema.ts';
import { formatClock, type Instant } from '../../core/time.ts';
import type { PlacedItem } from '../../core/window.ts';
import { CourseMap } from '../map/CourseMap.tsx';

/**
 * The course, riding along beside the photographs.
 *
 * The Course tab answers "what did the race look like". This answers the
 * question you actually have while scrolling a timeline: **where was this
 * taken?** It sticks to the top of the viewport so the map and the elevation
 * profile stay in view while the photos move past, and it follows whatever
 * moment is currently on screen.
 *
 * WHAT DRIVES IT, and why that is not obvious. On a timed track the answer is
 * simply position-at-time. **The owner's track has no times at all**, so
 * there is no such thing — and interpolating one would put the marker
 * confidently in the wrong place. Instead each photo is placed on the course
 * by ITS OWN GPS (see `anchorItems`), which is a measurement rather than a
 * guess, and works whether or not the track was ever timestamped.
 *
 * The profile is deliberately a slim strip here rather than the full stack of
 * charts: it is a reference while you read the photos, not the subject.
 */

interface Props {
  manifest: Manifest;
  course: Course;
  /** Thinned for drawing — see `simplify`. */
  track: readonly Sample[];
  items: readonly PlacedItem[];
  /** Metres along the course, from the scroll position or a hover. */
  focus: number | null;
  onFocus: (distance: number | null) => void;
  at: Instant | null;
  onCursor: (instant: Instant) => void;
  /**
   * True when something IS selected but cannot be put on the course. Distinct
   * from nothing being selected yet — saying "no position for this one"
   * before the reader has scrolled anywhere is simply false.
   */
  unplaceable?: boolean;
  /** Clicking the course picks that point — see CourseCharts for why click. */
  onPick?: ((distance: number) => void) | undefined;
  thumbnails?: {
    acquire: (item: PlacedItem['item']) => Promise<string | null>;
    release: (id: string) => void;
  };
  timezone?: string;
}

const STRIP_HEIGHT = 44;

export function CourseRail({
  manifest, course, track, items, focus, onFocus, at, onCursor,
  unplaceable = false, onPick, thumbnails, timezone,
}: Props) {
  const profile = useMemo(() => {
    const points = track
      .filter((s) => s.ele !== undefined)
      .map((s) => ({ x: s.distance, y: s.ele as number }));
    if (points.length < 2) return null;
    // One pass, not `Math.min(...)`: a real track is long enough to blow the
    // argument limit.
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    const span = hi - lo || 1;
    const total = course.length || 1;
    const d = points
      .map((p, i) =>
        `${i === 0 ? 'M' : 'L'}${((p.x / total) * 100).toFixed(3)},${(
          STRIP_HEIGHT - ((p.y - lo) / span) * STRIP_HEIGHT
        ).toFixed(2)}`,
      )
      .join(' ');
    return { d, lo, hi };
  }, [track, course.length]);

  // The point under the reader, from the scroll position if nothing is being
  // hovered. On a timed track a cursor with no anchor still resolves.
  const here =
    focus !== null
      ? atDistance(course, focus)
      : course.timed && at !== null
        ? atTime(course, at)
        : null;

  const pct = here ? (here.distance / (course.length || 1)) * 100 : null;

  return (
    <section className="rail" aria-label="Where on the course">
      <div className="rail__map">
        <CourseMap
          manifest={manifest}
          course={course}
          track={track}
          items={items}
          at={at}
          focus={focus}
          onFocus={onFocus}
          onCursor={onCursor}
          {...(onPick ? { onPick } : {})}
          {...(thumbnails ? { thumbnails } : {})}
          compact
        />
      </div>

      <div className="rail__side">
        <div className="rail__readout mw-mono">
          {here ? (
            <>
              <span className="rail__km">{(here.distance / 1000).toFixed(1)} km</span>
              {here.ele !== undefined && (
                <span className="rail__ele">{Math.round(here.ele)} m</span>
              )}
              {here.at !== undefined && (
                <span className="rail__at">{formatClock(here.at, timezone)}</span>
              )}
            </>
          ) : unplaceable ? (
            /* Says WHY rather than showing a dash. Some media carries no GPS
               at all — an action camera never does — and on an untimed track
               that is the only way to place it. */
            <span className="rail__hint">Not on the course</span>
          ) : (
            <span className="rail__hint">
              {course.timed ? 'Scroll, or move the cursor' : 'Scroll the photos'}
            </span>
          )}
        </div>

        {onPick && <span className="rail__note-hint">Click the course to add a note</span>}

        {profile && (
          <svg
            className="rail__profile"
            viewBox={`0 0 100 ${STRIP_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Elevation profile, ${Math.round(profile.lo)} to ${Math.round(profile.hi)} metres`}
            onPointerMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              if (box.width === 0) return;
              const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
              onFocus(ratio * course.length);
            }}
            onPointerLeave={() => onFocus(null)}
            onPointerDown={(e) => {
              if (!onPick) return;
              const box = e.currentTarget.getBoundingClientRect();
              if (box.width === 0) return;
              const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
              onPick(ratio * course.length);
            }}
          >
            <path d={profile.d} fill="none" stroke="#8a8378" strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke" />
            {pct !== null && (
              <line x1={pct} x2={pct} y1={0} y2={STRIP_HEIGHT} stroke="#f26522"
                    strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        )}
      </div>
    </section>
  );
}
