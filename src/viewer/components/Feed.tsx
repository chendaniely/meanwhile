import { useMemo } from 'react';
import { assignLaneColors } from '../../core/palette.ts';
import type { Manifest, PersonId } from '../../core/schema.ts';
import { formatClock, formatDateTime } from '../../core/time.ts';
import type { PlacedItem } from '../../core/window.ts';
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
  /**
   * Already cropped to the range and to the visible people. Filtering happens
   * once, in App, so every view is looking at exactly the same set — which is
   * what makes switching between them mean anything.
   */
  items: readonly PlacedItem[];
  onOpen: (entry: PlacedItem) => void;
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

export function Feed({ manifest, items, onOpen }: Props) {
  const zone = manifest.event.timezone;
  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const names = useMemo(
    () => new Map(manifest.people.map((p) => [p.id, p.name])),
    [manifest.people],
  );

  const moments = useMemo(() => toMoments(items), [items]);

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
                  onOpen={() => onOpen({ item, instant })}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
