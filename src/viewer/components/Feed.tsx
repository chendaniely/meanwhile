import { useCallback, useEffect, useMemo, useRef } from 'react';
import { assignLaneColors } from '../../core/palette.ts';
import { displayName, resolvePersonNames } from '../../core/people-csv.ts';
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
   *
   * Expected to already be filtered through `excludingCaptions` (see
   * `core/window.ts`) by the caller: a caption lives on its photo — the
   * tile's speech-bubble glyph is how it is discovered — so interleaving it
   * here too would show it a second time and make that glyph's
   * "otherwise invisible" justification false.
   */
  notes?: readonly PlacedNote[];
  /**
   * Caption text for items that carry one, keyed by item id. A caption is a
   * note whose `photo` names the item — this is what lets a tile show the
   * discoverability glyph without every call site re-deriving the lookup.
   */
  captionByItem?: ReadonlyMap<string, string>;
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

export function Feed({ manifest, items, onOpen, onActive, notes = [], captionByItem }: Props) {
  const zone = manifest.event.timezone;
  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const names = useMemo(
    () => new Map(manifest.people.map((p) => [p.id, displayName(p)])),
    [manifest.people],
  );

  const moments = useMemo(() => toMoments(items), [items]);

  /**
   * Report whichever moment sits at the CENTRE of the screen.
   *
   * The obvious implementation — an IntersectionObserver over a thin band,
   * reporting the first intersecting entry — is subtly and badly wrong, and
   * shipped once. **The `entries` array is not ordered by position on the
   * page.** Scroll quickly and several moments cross the band between
   * callbacks, so "the first one" is effectively arbitrary among them. On a
   * folder spanning days that means the reported time jumps by hours, which is
   * exactly what it looked like.
   *
   * So the observer is used only for what it is good at — knowing cheaply
   * which sections are on screen at all — and the choice among those is made
   * by measuring. Distance is to the centre LINE rather than to the section's
   * own midpoint, so a tall grid taller than the viewport still counts as the
   * thing you are looking at.
   *
   * The measuring pass touches only the handful of sections currently
   * visible, never all two thousand, and is throttled to one animation frame.
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

    const onScreen = new Set<HTMLElement>();
    let frame = 0;

    const pick = () => {
      frame = 0;
      const centre = window.innerHeight / 2;
      let best: HTMLElement | null = null;
      let bestGap = Number.POSITIVE_INFINITY;
      for (const node of onScreen) {
        const box = node.getBoundingClientRect();
        // Zero when the centre line falls inside the section, so a section
        // taller than the screen wins outright rather than losing to a short
        // neighbour whose midpoint happens to be nearer.
        const gap =
          box.top > centre ? box.top - centre : box.bottom < centre ? centre - box.bottom : 0;
        if (gap < bestGap) {
          bestGap = gap;
          best = node;
        }
      }
      if (!best) return;
      const key = best.dataset['at'] ?? '';
      if (key === active.current) return;
      const moment = byId.get(key);
      if (!moment) return;
      active.current = key;
      report.current?.(moment.items);
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(pick);
    };

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        if (entry.isIntersecting) onScreen.add(node);
        else onScreen.delete(node);
      }
      schedule();
    });
    for (const node of document.querySelectorAll<HTMLElement>('.feed .moment')) {
      io.observe(node);
    }

    // The observer only fires when something enters or leaves the viewport.
    // Scrolling WITHIN a long moment fires nothing, so the centre would go
    // stale exactly where the sections are biggest.
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      io.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [onActive, byId, moments]);

  // Notes are not items: `App.tsx` filters `feedNotes` by the time window
  // alone, never by which lanes are visible, so a note can be the only
  // thing left in range once every lane is hidden or the window is narrowed
  // past the last photograph. Returning early on `moments.length === 0`
  // alone discarded that note and showed "Nothing to show" while it was
  // sitting right there — the exact "write a note and watch it vanish"
  // outcome CLAUDE.md calls out as the one worth spending UI on.
  if (moments.length === 0 && notes.length === 0) {
    return (
      <p className="callout">
        Nothing to show &mdash; either the time window is too narrow or every
        lane is hidden. Widen the window above, press Reset, or turn lanes
        back on in Swimlanes.
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
          // `note.people` is names, not ids — resolved against the roster so
          // a recognised one still carries its lane color; an unrecognised
          // name is shown plainly rather than dropped.
          const { ids: knownIds, unknown: unknownNames } = resolvePersonNames(
            note.people,
            manifest.people,
          );
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
                {(knownIds.length > 0 || unknownNames.length > 0) && (
                  <span className="moment__who">
                    {knownIds.map((id) => (
                      <span key={id} className="moment__person">
                        <span
                          className="moment__swatch"
                          style={{ background: colors.get(id) }}
                          aria-hidden="true"
                        />
                        {names.get(id) ?? id}
                      </span>
                    ))}
                    {unknownNames.map((name) => (
                      <span key={name} className="moment__person">{name}</span>
                    ))}
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
              {...(captionByItem?.get(item.id) ? { note: captionByItem.get(item.id) as string } : {})}
              onOpen={() => onOpen({ item, instant })}
            />
          ))}
        </div>
      </section>
    );
  }
}
