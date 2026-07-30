import { scaleTime } from 'd3-scale';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assignLaneColors, orderPeople } from '../../core/palette.ts';
import type { Manifest, PersonId } from '../../core/schema.ts';
import { isVisible, type AppState } from '../../core/state.ts';
import { laneBins } from '../../core/timeline.ts';
import { formatClock, formatDateTime, formatSpan } from '../../core/time.ts';
import type { Instant } from '../../core/time.ts';
import type { PlacedItem, TimeWindow } from '../../core/window.ts';
import { MomentStrip, momentRadius } from './MomentStrip.tsx';

/**
 * One lane per person on a shared clock.
 *
 * The view the project is named for, and the encoding is built around a
 * single idea: **the gaps are the point.** A lane is not a summary of what
 * someone shot — the feed does that — it is a record of when they were and
 * were not shooting, laid against everyone else's.
 *
 * So an empty lane is drawn, never omitted; the longest silence in each lane
 * is called out in words; and a lane's marks are binned by SCREEN POSITION,
 * so a gap you can see is a gap in the data at whatever zoom you are at.
 *
 * D3 is used for tick placement only — `scaleTime` knows that "every 3 hours"
 * is a nicer set of gridlines than "every 2.8 hours". Nothing else about the
 * drawing goes through it.
 */

/** How much one wheel notch changes the span. Gentle enough to aim with. */
const ZOOM_STEP = 1.2;

/** Zooming in past ten seconds shows one instant and no context. */
const MIN_SPAN_MS = 10_000;

interface Props {
  manifest: Manifest;
  placed: readonly PlacedItem[];
  range: TimeWindow;
  state: AppState;
  onCursor: (instant: Instant | null) => void;
  onTogglePerson: (person: PersonId) => void;
  onOpen?: (entry: PlacedItem) => void;
  /** The whole timeline, so zooming out cannot go past the data. */
  bounds?: TimeWindow;
  /** Zooming the lanes changes the crop everything else is showing. */
  onRange?: (next: TimeWindow) => void;
  /** Forwarded to the moment strip's tiles — see `Feed`'s prop of the same name. */
  captionByItem?: ReadonlyMap<string, string>;
}

const LANE_HEIGHT = 44;
/** Roughly one mark per two pixels at a typical width. */
const BINS = 480;

export function Swimlanes({
  manifest,
  placed,
  range,
  state,
  onCursor,
  onTogglePerson,
  onOpen,
  bounds,
  onRange,
  captionByItem,
}: Props) {
  const zone = manifest.event.timezone;
  const track = useRef<HTMLDivElement>(null);

  /**
   * Where the scrub is. Deliberately NOT cleared when the pointer leaves the
   * track: the photographs for that moment appear below, and you have to be
   * able to move down to them without the thing you were looking at vanishing
   * on the way.
   *
   * Clicking pins it into the shared cursor, which is what goes in the URL and
   * survives a view switch.
   */
  const [scrub, setScrub] = useState<Instant | null>(state.cursor);
  const [overTrack, setOverTrack] = useState(false);
  /**
   * Whether the moment is pinned.
   *
   * Hovering alone was too eager to be usable: you find the moment you want,
   * then start moving down to click one of its photographs, and the pointer
   * crosses the track on the way — dragging the moment somewhere else before
   * you arrive. Clicking pins it, so the strip below holds still while you
   * reach for it.
   *
   * **The click is a TOGGLE**, so the same gesture that pinned it releases it.
   * That gives two ways out — the chip in the strip, or clicking the lanes
   * again — and they are the same state rather than two modes. Escape works
   * too.
   */
  const [locked, setLocked] = useState(false);

  const people = useMemo(() => orderPeople(manifest.people), [manifest.people]);
  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const shown = useMemo(() => people.filter((p) => isVisible(state, p.id)), [people, state]);

  const lanes = useMemo(
    () => laneBins(placed, shown.map((p) => p.id), range, BINS),
    [placed, shown, range],
  );

  // Ticks only. d3-scale picks round numbers a human would have chosen.
  const ticks = useMemo(() => {
    const scale = scaleTime().domain([new Date(range.from), new Date(range.to)]);
    return scale.ticks(8).map((date) => ({
      at: date.getTime(),
      percent: ((date.getTime() - range.from) / (range.to - range.from)) * 100,
    }));
  }, [range]);

  const total = range.to - range.from;
  const percentOf = (instant: Instant) => ((instant - range.from) / total) * 100;

  const instantAt = (clientX: number): Instant | null => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return range.from + ratio * total;
  };

  /**
   * The wheel zooms the crop, about whatever the pointer is over.
   *
   * Anchored on the pointer, like a map: the instant under the cursor stays
   * put, so you zoom into the thing you are looking at rather than into the
   * middle. It writes the shared range, which is why the slider at the top
   * follows — there is one crop, not one per view.
   *
   * Bound with `passive: false` on the element, because React's `onWheel` is
   * registered passively at the root and `preventDefault` there is ignored:
   * the page would scroll away underneath the zoom.
   */
  useEffect(() => {
    const node = track.current;
    if (!node || !onRange) return;

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();

      const box = node.getBoundingClientRect();
      if (box.width === 0) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const span = range.to - range.from;
      const anchor = range.from + ratio * span;

      const factor = event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const limit = bounds ? bounds.to - bounds.from : span * 64;
      const next = Math.min(limit, Math.max(MIN_SPAN_MS, span * factor));

      let from = anchor - ratio * next;
      let to = from + next;
      // Slide back inside the data rather than clamping the ends, which would
      // silently change the zoom you asked for.
      if (bounds) {
        if (from < bounds.from) {
          from = bounds.from;
          to = from + next;
        }
        if (to > bounds.to) {
          to = bounds.to;
          from = to - next;
        }
      }
      onRange({ from, to });
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [range, bounds, onRange]);

  /**
   * Escape releases the pin, same as the chip in the strip or clicking the
   * lanes again.
   *
   * The track is `role="presentation"` with no `tabIndex`, so it can never
   * hold focus and a `keydown` handler on the div itself would never fire.
   * Bound on `document` instead — the same pattern the lightbox uses for its
   * own Escape-to-close — and only while pinned, so it is not listening for
   * no reason the rest of the time.
   */
  useEffect(() => {
    if (!locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLocked(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [locked]);

  const at = scrub ?? state.cursor;
  const radius = momentRadius(total);

  return (
    <section className="lanes" aria-label="Swimlanes">
      <header className="lanes__head">
        <div className="lanes__readout">
          {at === null ? (
            <span className="lanes__hint">
              Move across the lanes to see what everyone was looking at.
            </span>
          ) : (
            <time className="lanes__time mw-mono">{formatDateTime(at, zone)}</time>
          )}
        </div>
        {at !== null && (
          <button
            type="button"
            className="window__reset"
            onClick={() => {
              setScrub(null);
              onCursor(null);
              // Also let go of the pin: a cleared cursor that is still pinned
              // is a state with nothing on screen to explain it.
              setLocked(false);
            }}
          >
            Clear
          </button>
        )}
      </header>

      <div className="lanes__grid">
        <div className="lanes__labels">
          {shown.map((person) => {
            const lane = lanes.find((l) => l.person === person.id);
            // One row, exactly the height of its lane. Anything taller drifts
            // out of alignment with the marks it labels, which for a chart of
            // WHO was shooting WHEN is not a cosmetic problem.
            return (
              <div key={person.id} className="lanes__label" style={{ height: LANE_HEIGHT }}>
                <button
                  type="button"
                  className="lanes__name"
                  onClick={() => onTogglePerson(person.id)}
                  title="Hide this lane"
                >
                  <span
                    className="lanes__swatch"
                    style={{ background: colors.get(person.id) }}
                    aria-hidden="true"
                  />
                  <span className="lanes__name-text">{person.name}</span>
                  {person.role === 'runner' && <span className="report__tag">runner</span>}
                </button>
                {/* The headline number for a lane. A six-hour hole is the
                    story of the night section, so it is stated, not left to
                    be spotted. */}
                {lane && lane.longestGap > 0 && (
                  <span className="lanes__gap mw-mono" title="Longest stretch with nothing in it">
                    {formatSpan(lane.longestGap)} quiet
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div
          className={locked ? 'lanes__track lanes__track--pinned' : 'lanes__track'}
          ref={track}
          onPointerMove={(e) => {
            setOverTrack(true);
            if (locked) return;
            setScrub(instantAt(e.clientX));
          }}
          onPointerLeave={() => setOverTrack(false)}
          onPointerDown={(e) => {
            const next = instantAt(e.clientX);
            setScrub(next);
            onCursor(next);
            // A toggle, not a latch: clicking the lanes again lets go, which
            // is the same thing the chip in the strip does. Escape also lets
            // go — see the `useEffect` above; this div cannot hold focus so
            // it cannot catch that key itself.
            setLocked((was) => !was);
          }}
          role="presentation"
        >
          <div className="lanes__gridlines" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick.at} className="lanes__gridline" style={{ left: `${tick.percent}%` }} />
            ))}
          </div>

          {lanes.map((lane) => (
            <div key={lane.person} className="lanes__lane" style={{ height: LANE_HEIGHT }}>
              {lane.bins.map((count, i) =>
                count === 0 ? null : (
                  <span
                    key={i}
                    className="lanes__mark"
                    style={{
                      left: `${(i / lane.bins.length) * 100}%`,
                      width: `${100 / lane.bins.length}%`,
                      // Anchored to the lane floor and never thinner than a
                      // quarter, so a single photo is as visible as a burst.
                      // Presence must never be mistakable for absence.
                      height: `${25 + (lane.peak > 1 ? (count / lane.peak) * 75 : 75)}%`,
                      background: colors.get(lane.person),
                    }}
                  />
                ),
              )}
            </div>
          ))}

          {markerLines(manifest, range).map((marker) => (
            <span
              key={`${marker.at}-${marker.label}`}
              className="lanes__marker"
              style={{ left: `${percentOf(marker.at)}%` }}
              title={marker.label}
            />
          ))}

          {/* The window the strip below is showing, so the connection between
              "here" and "these photographs" is visible rather than implied. */}
          {at !== null && (
            <span
              className="lanes__band"
              style={{
                left: `${percentOf(at - radius)}%`,
                width: `${(radius * 2 * 100) / total}%`,
              }}
              aria-hidden="true"
            />
          )}
          {at !== null && (
            <span
              className={overTrack ? 'lanes__cursor lanes__cursor--live' : 'lanes__cursor'}
              style={{ left: `${percentOf(at)}%` }}
            >
              <span className="lanes__cursor-label mw-mono">{formatClock(at, zone)}</span>
            </span>
          )}
        </div>
      </div>

      <div className="lanes__axis" aria-hidden="true">
        {ticks.map((tick) => (
          <span key={tick.at} className="lanes__tick mw-mono" style={{ left: `${tick.percent}%` }}>
            {formatClock(tick.at, zone)}
          </span>
        ))}
      </div>

      {at !== null && (
        <MomentStrip
          locked={locked}
          onToggleLock={() => setLocked((was) => !was)}
          people={shown}
          colors={colors}
          placed={placed}
          at={at}
          radiusMs={radius}
          {...(zone ? { timezone: zone } : {})}
          {...(onOpen ? { onOpen } : {})}
          {...(captionByItem ? { captionByItem } : {})}
        />
      )}

      {shown.length < people.length && (
        <p className="lanes__hidden">
          {people.length - shown.length} lane(s) hidden.{' '}
          {people
            .filter((p) => !isVisible(state, p.id))
            .map((p) => (
              <button
                key={p.id}
                type="button"
                className="chip"
                onClick={() => onTogglePerson(p.id)}
              >
                {p.name}
              </button>
            ))}
        </p>
      )}
    </section>
  );
}

/** Markers given in wall-clock, inside the window. Distance needs the spine. */
function markerLines(manifest: Manifest, range: TimeWindow): Array<{ at: number; label: string }> {
  return (manifest.markers ?? [])
    .flatMap((marker) => {
      if (!marker.at) return [];
      const at = Date.parse(marker.at);
      return Number.isNaN(at) ? [] : [{ at, label: marker.label }];
    })
    .filter((m) => m.at >= range.from && m.at <= range.to);
}
