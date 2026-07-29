import { scaleTime } from 'd3-scale';
import { useMemo, useRef, useState } from 'react';
import { assignLaneColors, orderPeople } from '../../core/palette.ts';
import type { Manifest, PersonId } from '../../core/schema.ts';
import { isVisible, type AppState } from '../../core/state.ts';
import { laneBins, peopleAround } from '../../core/timeline.ts';
import { formatClock, formatDateTime, formatSpan } from '../../core/time.ts';
import type { Instant } from '../../core/time.ts';
import type { PlacedItem, TimeWindow } from '../../core/window.ts';

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

interface Props {
  manifest: Manifest;
  placed: readonly PlacedItem[];
  range: TimeWindow;
  state: AppState;
  onCursor: (instant: Instant | null) => void;
  onTogglePerson: (person: PersonId) => void;
}

const LANE_HEIGHT = 44;
/** Roughly one mark per two pixels at a typical width. */
const BINS = 480;
/** Two people shooting inside this window counts as "at the same time". */
const SIMULTANEITY_MS = 3 * 60_000;

export function Swimlanes({ manifest, placed, range, state, onCursor, onTogglePerson }: Props) {
  const zone = manifest.event.timezone;
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Instant | null>(null);

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

  const readout = hover ?? state.cursor;
  const together = readout === null ? null : peopleAround(placed, readout, SIMULTANEITY_MS);

  return (
    <section className="lanes" aria-label="Swimlanes">
      <header className="lanes__head">
        <div className="lanes__readout">
          {readout === null ? (
            <span className="lanes__hint">Move across the lanes to read a moment.</span>
          ) : (
            <>
              <time className="lanes__time mw-mono">{formatDateTime(readout, zone)}</time>
              {together && together.size > 1 && (
                <span className="lanes__together">{together.size} people at once</span>
              )}
            </>
          )}
        </div>
        {state.cursor !== null && (
          <button type="button" className="window__reset" onClick={() => onCursor(null)}>
            Clear cursor
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
          className="lanes__track"
          ref={track}
          onPointerMove={(e) => setHover(instantAt(e.clientX))}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(e) => onCursor(instantAt(e.clientX))}
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

          {hover !== null && (
            <span className="lanes__hover" style={{ left: `${percentOf(hover)}%` }} aria-hidden="true" />
          )}
          {state.cursor !== null && (
            <span className="lanes__cursor" style={{ left: `${percentOf(state.cursor)}%` }}>
              <span className="lanes__cursor-label mw-mono">{formatClock(state.cursor, zone)}</span>
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
