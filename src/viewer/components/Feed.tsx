import { useCallback, useEffect, useMemo, useRef } from 'react';
import { assignLaneColors } from '../../core/palette.ts';
import type { Manifest, PersonId } from '../../core/schema.ts';
import { formatClock, formatDateTime } from '../../core/time.ts';
import type { PlacedItem, PlacedNote } from '../../core/window.ts';
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
  /**
   * The moment currently at the top of the viewport, so the course rail can
   * follow the scroll. Optional: the feed is perfectly useful without one.
   */
  onActive?: (moment: readonly PlacedItem[]) => void;
  /**
   * Notes fall in the same chronological stream as the photographs. Keeping
   * them in a separate list would break the one thing the feed is for —
   * reading the event in the order it happened.
   */
  notes?: readonly PlacedNote[];
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

export function Feed({ manifest, items, onOpen, onActive, notes = [] }: Props) {
  const zone = manifest.event.timezone;
  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const names = useMemo(
    () => new Map(manifest.people.map((p) => [p.id, p.name])),
    [manifest.people],
  );

  const moments = useMemo(() => toMoments(items), [items]);

  /**
   * Report whichever moment is nearest the top of the viewport.
   *
   * The reading position is the TOP, not the middle: you look at the thing you
   * have just scrolled to. The margins keep only a thin band, so exactly one
   * moment qualifies at a time — with a full-height root the observer fires
   * for a whole screenful at once and whichever entry happens to come last
   * wins, which reads as the rail jumping around at random.
   */
  const byId = useMemo(() => new Map<string, Moment>(), [moments]);
  const active = useRef<string | null>(null);
  const report = useRef(onActive);
  report.current = onActive;

  const stamp = useCallback(
    (node: HTMLElement | null, moment: Moment) => {
      if (!node) return;
      node.dataset['at'] = String(moment.at);
      byId.set(String(moment.at), moment);
    },
    [byId],
  );

  useEffect(() => {
    if (!onActive) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = (entry.target as HTMLElement).dataset['at'] ?? '';
          if (active.current === key) continue;
          const moment = byId.get(key);
          if (!moment) continue;
          active.current = key;
          report.current?.(moment.items);
          break;
        }
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: 0 },
    );
    for (const node of document.querySelectorAll<HTMLElement>('.feed .moment')) {
      io.observe(node);
    }
    return () => io.disconnect();
  }, [onActive, byId, moments]);

  if (moments.length === 0) {
    return (
      <p className="callout">
        Nothing falls inside the current time range. Widen it above, or press Reset.
      </p>
    );
  }

  let lastDay = '';

  // One stream, ordered by time. A note between two moments reads as part of
  // the story rather than as an aside.
  type Entry =
    | { kind: 'moment'; at: number; moment: Moment }
    | { kind: 'note'; at: number; placed: PlacedNote };
  const stream: Entry[] = [
    ...moments.map((moment): Entry => ({ kind: 'moment', at: moment.at, moment })),
    ...notes.map((placed): Entry => ({ kind: 'note', at: placed.instant, placed })),
  ].sort((a, b) => a.at - b.at);

  return (
    <div className="feed">
      {stream.map((entry) => {
        const day = formatDateTime(entry.at, zone).replace(/,.*$/, '');
        const newDay = day !== lastDay;
        lastDay = day;

        if (entry.kind === 'note') {
          const { note, instant, until } = entry.placed;
          return (
            <section key={note.id} className="feed__note">
              {newDay && <h2 className="feed__day">{day}</h2>}
              <header className="feed__note-head">
                <time className="moment__time mw-mono">{formatClock(instant, zone)}</time>
                {until !== undefined && (
                  <span className="feed__note-until mw-mono">
                    &rarr; {formatClock(until, zone)}
                  </span>
                )}
                {note.person && (
                  <span className="moment__person">
                    <span
                      className="moment__swatch"
                      style={{ background: colors.get(note.person) }}
                      aria-hidden="true"
                    />
                    {names.get(note.person) ?? note.person}
                  </span>
                )}
              </header>
              <p className="feed__note-text">{note.text}</p>
            </section>
          );
        }

        const moment = entry.moment;
        return renderMoment(moment, newDay, day);
      })}
    </div>
  );

  function renderMoment(moment: Moment, newDay: boolean, day: string) {
    return (
      <section key={moment.at} className="moment" ref={(node) => stamp(node, moment)}>
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
  }
}
