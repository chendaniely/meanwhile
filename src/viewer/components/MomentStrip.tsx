import { useMemo } from 'react';
import type { Person, PersonId } from '../../core/schema.ts';
import { formatClock, formatSpan, type Instant } from '../../core/time.ts';
import type { PlacedItem } from '../../core/window.ts';
import { MediaTile } from './MediaTile.tsx';

/**
 * What everyone was actually looking at, at one moment.
 *
 * The swimlanes on their own say *when* people were shooting. That is not
 * enough — marks on a track tell you activity happened without telling you
 * what it was. This puts the photographs back underneath, ONE ROW PER LANE
 * and aligned with the lane above, so the app's claim is made visible rather
 * than argued for: at 04:41 Sam was on the climb *while* Dan was at the aid
 * station.
 *
 * A person with nothing in this window gets a row saying so. That absence is
 * as much the story as the pictures, and hiding empty rows would quietly
 * delete it.
 */

interface Props {
  people: readonly Person[];
  colors: ReadonlyMap<PersonId, string>;
  /** Everything placed; filtered here rather than by the caller. */
  placed: readonly PlacedItem[];
  at: Instant;
  /** Half-width of the window, in milliseconds. */
  radiusMs: number;
  timezone?: string;
  onOpen?: (item: PlacedItem) => void;
  /** Pinned, so the strip stops following the pointer. See Swimlanes. */
  locked?: boolean;
  onUnlock?: () => void;
}

export function MomentStrip({
  people,
  colors,
  placed,
  at,
  radiusMs,
  timezone,
  onOpen,
  locked = false,
  onUnlock,
}: Props) {
  const rows = useMemo(() => {
    const near = placed.filter((entry) => Math.abs(entry.instant - at) <= radiusMs);
    return people.map((person) => ({
      person,
      items: near.filter((entry) => entry.item.person === person.id),
    }));
  }, [placed, people, at, radiusMs]);

  const active = rows.filter((row) => row.items.length > 0).length;

  return (
    <section className="moment-strip" aria-label="What was happening at the cursor">
      <header className="moment-strip__head">
        <time className="moment-strip__time mw-mono">{formatClock(at, timezone)}</time>
        <span className="moment-strip__window mw-mono">±{formatSpan(radiusMs)}</span>
        {/* Says which mode you are in, and gets you out. Without this, a pinned
            strip that stops following the pointer just looks broken. */}
        {locked ? (
          <button type="button" className="moment-strip__lock" onClick={onUnlock}>
            pinned &mdash; click to follow again
          </button>
        ) : (
          <span className="moment-strip__hint">click the lanes to pin</span>
        )}
        {active > 1 ? (
          <span className="moment__together">{active} people at once</span>
        ) : (
          <span className="moment-strip__hint">
            {active === 1 ? 'one person shooting' : 'nobody shooting'}
          </span>
        )}
      </header>

      <div className="moment-strip__rows">
        {rows.map(({ person, items }) => (
          <div key={person.id} className="moment-strip__row">
            <span className="moment-strip__who">
              <span
                className="lanes__swatch"
                style={{ background: colors.get(person.id) }}
                aria-hidden="true"
              />
              <span className="lanes__name-text">{person.name}</span>
            </span>

            {items.length === 0 ? (
              // Said plainly. An empty row is a fact about the race, not a
              // gap in the interface.
              <span className="moment-strip__quiet">nothing</span>
            ) : (
              <div className="moment-strip__tiles">
                {items.map((entry) => (
                  <div key={entry.item.id} className="moment-strip__tile">
                    <MediaTile
                      item={entry.item}
                      {...(colors.get(person.id) ? { color: colors.get(person.id) as string } : {})}
                      caption={formatClock(entry.instant, timezone)}
                      fit="square"
                      {...(onOpen ? { onOpen: () => onOpen(entry) } : {})}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * How wide a moment is, given how far you are zoomed out.
 *
 * A fixed radius fails at both ends: five minutes is an invisible sliver
 * across a two-day view, and half an hour swallows everything when you have
 * zoomed into a single climb. Scaling with the visible range keeps a
 * hover showing a handful of pictures at any zoom.
 */
export function momentRadius(rangeMs: number): number {
  const MIN = 60_000;
  const MAX = 30 * 60_000;
  return Math.min(MAX, Math.max(MIN, rangeMs / 200));
}
