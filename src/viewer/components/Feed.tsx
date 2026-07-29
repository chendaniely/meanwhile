import { useMemo, useState } from 'react';
import { assignLaneColors } from '../../core/palette.ts';
import type { Manifest, PersonId } from '../../core/schema.ts';
import { isVisible, type AppState } from '../../core/state.ts';
import { formatClock, formatDateTime } from '../../core/time.ts';
import { isWithin, type PlacedItem, type TimeWindow } from '../../core/window.ts';
import { Lightbox } from './Lightbox.tsx';
import { MediaTile } from './MediaTile.tsx';

/**
 * Everyone's media, interleaved on one clock.
 *
 * This is the view that answers the question the project exists for: not
 * "what did Sam shoot" but "what was happening at 2am". So it is strictly
 * chronological across all people, and each tile carries its person's lane
 * color — identity travels with the picture rather than requiring a heading.
 *
 * Grouped into MOMENTS rather than a flat list. A run of photos taken within
 * a few minutes of each other is one thing that happened, and when two people
 * appear in the same moment, that is simultaneity showing up directly in the
 * scroll.
 */

interface Props {
  manifest: Manifest;
  placed: readonly PlacedItem[];
  range: TimeWindow;
  /** Shared with every other view: hiding a lane hides it here too. */
  state: AppState;
}

/** Gap that separates one moment from the next. */
const MOMENT_GAP_MS = 6 * 60_000;

interface Moment {
  at: number;
  items: PlacedItem[];
  people: Set<PersonId>;
}

function toMoments(placed: readonly PlacedItem[]): Moment[] {
  const out: Moment[] = [];
  for (const entry of placed) {
    const current = out[out.length - 1];
    if (current && entry.instant - (current.items[current.items.length - 1] as PlacedItem).instant <= MOMENT_GAP_MS) {
      current.items.push(entry);
      current.people.add(entry.item.person);
    } else {
      out.push({ at: entry.instant, items: [entry], people: new Set([entry.item.person]) });
    }
  }
  return out;
}

export function Feed({ manifest, placed, range, state }: Props) {
  const zone = manifest.event.timezone;
  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const names = useMemo(
    () => new Map(manifest.people.map((p) => [p.id, p.name])),
    [manifest.people],
  );

  /**
   * The flat, in-order list the lightbox steps through.
   *
   * Kept separate from the moment grouping on purpose: arrow keys should walk
   * the whole event, not stop at the edge of whichever moment you opened
   * from.
   */
  const visible = useMemo(
    () => placed.filter((p) => isWithin(p.instant, range) && isVisible(state, p.item.person)),
    [placed, range, state],
  );
  const moments = useMemo(() => toMoments(visible), [visible]);

  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const indexOf = useMemo(
    () => new Map(visible.map((entry, i) => [entry.item.id, i])),
    [visible],
  );

  if (moments.length === 0) {
    return (
      <p className="callout">
        Nothing falls inside the current time range. Widen it above, or press Reset.
      </p>
    );
  }

  let lastDay = '';

  return (
    <div className="feed">
      {openIndex !== null && (
        <Lightbox
          items={visible}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          colors={colors}
          names={names}
          {...(zone ? { timezone: zone } : {})}
        />
      )}

      {moments.map((moment) => {
        const day = formatDateTime(moment.at, zone).replace(/,.*$/, '');
        const newDay = day !== lastDay;
        lastDay = day;

        return (
          <section key={moment.at} className="moment">
            {newDay && <h2 className="feed__day">{day}</h2>}

            <header className="moment__head">
              <time className="moment__time mw-mono">{formatClock(moment.at, zone)}</time>
              <span className="moment__who">
                {[...moment.people].map((id) => (
                  <span key={id} className="moment__person">
                    <span
                      className="moment__swatch"
                      style={{ background: colors.get(id) }}
                      aria-hidden="true"
                    />
                    {names.get(id) ?? id}
                  </span>
                ))}
              </span>
              {/* The whole point, stated: two lanes in one moment means two
                  people were doing something at the same time. */}
              {moment.people.size > 1 && (
                <span className="moment__together">{moment.people.size} at once</span>
              )}
            </header>

            <div className="moment__grid">
              {moment.items.map(({ item, instant }) => (
                <MediaTile
                  key={item.id}
                  item={item}
                  {...(colors.get(item.person) ? { color: colors.get(item.person) as string } : {})}
                  caption={formatClock(instant, zone)}
                  onOpen={() => setOpenIndex(indexOf.get(item.id) ?? 0)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
