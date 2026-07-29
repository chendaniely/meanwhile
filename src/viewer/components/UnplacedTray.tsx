import { useMemo, useState } from 'react';
import { assignLaneColors } from '../../core/palette.ts';
import type { Manifest, PersonId } from '../../core/schema.ts';
import type { UnplacedItem } from '../../core/window.ts';
import { MediaTile } from './MediaTile.tsx';

/**
 * The files that could not be placed, and what to do about each.
 *
 * Grouped by person, because that is the unit of action: the answer to a
 * stripped photo is to go back to whoever sent it and ask for the original.
 * So this shows the thumbnail (to recognise the shot), the file path (to name
 * it in a message), and the person (to know who to ask) — and offers the list
 * as copyable text, since that message is the actual next step.
 *
 * A picture with no time still has a thumbnail: the bytes are fine, it is
 * only the metadata that was lost. Showing it is what makes the file
 * identifiable to a human.
 */

interface Props {
  manifest: Manifest;
  unplaced: readonly UnplacedItem[];
}

export function UnplacedTray({ manifest, unplaced }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const colors = useMemo(() => assignLaneColors(manifest.people), [manifest.people]);
  const names = useMemo(
    () => new Map(manifest.people.map((p) => [p.id, p.name])),
    [manifest.people],
  );

  const byPerson = useMemo(() => {
    const groups = new Map<PersonId, UnplacedItem[]>();
    for (const entry of unplaced) {
      const list = groups.get(entry.item.person) ?? [];
      list.push(entry);
      groups.set(entry.item.person, list);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [unplaced]);

  if (unplaced.length === 0) return null;

  const copyList = async () => {
    const lines = byPerson.flatMap(([person, entries]) => [
      `${names.get(person) ?? person} (${entries.length}):`,
      ...entries.map((e) => `  ${e.item.src}`),
      '',
    ]);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="unplaced">
      <button
        type="button"
        className="unplaced__toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="unplaced__count mw-mono">{unplaced.length}</span>
        <span>
          file{unplaced.length === 1 ? '' : 's'} with no usable time
          {byPerson.length > 1 && `, across ${byPerson.length} people`}
        </span>
        <span className="unplaced__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open && (
        <div className="unplaced__body">
          <p className="unplaced__lead">
            These have no place on the timeline yet. The pictures are intact &mdash; only the
            timestamp was lost, almost always in transit. Each one below says what happened and
            who to ask.
          </p>

          <button type="button" className="button" onClick={() => void copyList()}>
            {copied ? 'Copied' : 'Copy the list'}
          </button>

          {byPerson.map(([person, entries]) => (
            <div key={person} className="unplaced__group">
              <h3 className="unplaced__person">
                <span
                  className="unplaced__swatch"
                  style={{ background: colors.get(person) }}
                  aria-hidden="true"
                />
                {names.get(person) ?? person}
                <span className="unplaced__person-count mw-mono">{entries.length}</span>
              </h3>

              <ul className="unplaced__list">
                {entries.map(({ item, reason }) => (
                  <li key={item.id} className="unplaced__row">
                    <div className="unplaced__thumb">
                      <MediaTile item={item} />
                    </div>
                    <div className="unplaced__detail">
                      <p className="unplaced__path mw-mono">{item.src}</p>
                      <p className="unplaced__reason">{reason}</p>
                      <p className="unplaced__facts mw-mono">
                        {item.type}
                        {item.bytes !== undefined && ` · ${formatBytes(item.bytes)}`}
                        {item.width && item.height && ` · ${item.width}×${item.height}`}
                        {item.gps && ` · ${item.gps[0].toFixed(4)}, ${item.gps[1].toFixed(4)}`}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
