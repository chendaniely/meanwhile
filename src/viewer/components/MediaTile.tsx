import { useEffect, useRef, useState } from 'react';
import type { Item } from '../../core/schema.ts';
import { formatSpan } from '../../core/time.ts';
import { useInView } from '../hooks/useInView.ts';
import { useMedia } from '../media/MediaContext.tsx';

/**
 * One photo or clip.
 *
 * Loads its picture only when it comes near the viewport and hands it back
 * when it leaves, which is what keeps a 2,000-file grid inside a memory
 * budget. Reserves its aspect ratio up front so the layout does not jump
 * around as images arrive.
 */

interface Props {
  item: Item;
  color?: string;
  /** Overlaid on the tile. Usually the time. */
  caption?: string;
  /** Opens the item full size. Video plays there rather than in the grid. */
  onOpen?: () => void;
}

/**
 * The shape to reserve for a tile, before its picture arrives.
 *
 * Two things this has to get right:
 *
 *   - **EXIF orientations 5-8 rotate by a quarter turn**, so the displayed
 *     image is taller than the stored dimensions say. Ignore that and every
 *     portrait photo reserves a landscape box and the grid jolts on load.
 *   - **The ratio is clamped.** A 9:16 phone video next to a 4:3 photo makes
 *     a grid row nearly twice as tall as its neighbours, which reads as
 *     broken. Clamping keeps the shape recognisable while the rows stay even;
 *     `object-fit: cover` takes a centre crop of the difference.
 */
const MIN_ASPECT = 0.75; // 3:4 portrait
const MAX_ASPECT = 1.78; // 16:9 landscape

function displayAspect(item: Item): number {
  const fallback = 4 / 3;
  if (!item.width || !item.height) return fallback;
  const quarterTurned = item.orientation !== undefined && item.orientation >= 5;
  const raw = quarterTurned ? item.height / item.width : item.width / item.height;
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, raw));
}

type State = 'idle' | 'loading' | 'ready' | 'undecodable';

export function MediaTile({ item, color, caption, onOpen }: Props) {
  const { store } = useMedia();
  const { ref, inView } = useInView<HTMLDivElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<State>('idle');
  const held = useRef<string | null>(null);

  useEffect(() => {
    if (!store || !inView) return;
    let cancelled = false;
    setState('loading');

    void store
      .acquireThumbnail(item)
      .then((next) => {
        if (cancelled) {
          // Scrolled away mid-decode: hand it straight back rather than
          // holding a reference no tile is showing.
          if (next) store.release(item.id);
          return;
        }
        held.current = item.id;
        setUrl(next);
        setState(next ? 'ready' : 'undecodable');
      })
      .catch((error: unknown) => {
        // A thrown error means the store is unusable, which is OUR bug — not
        // a file the browser cannot read. Saying "cannot display this file"
        // here would blame the user's photo for our mistake.
        if (!cancelled) setState('idle');
        console.error('meanwhile: could not load a thumbnail', error);
      });

    return () => {
      cancelled = true;
      if (held.current) {
        store.release(held.current);
        held.current = null;
      }
      setUrl(null);
      setState('idle');
    };
  }, [store, inView, item]);

  const aspect = displayAspect(item);
  const label = `${item.type === 'video' ? 'Play' : 'Open'} ${item.src.slice(item.src.lastIndexOf('/') + 1)}`;

  return (
    <figure className="tile" ref={ref}>
      <div className="tile__frame" style={{ aspectRatio: String(aspect) }}>
        {url && <img className="tile__image" src={url} alt="" loading="lazy" decoding="async" />}
        {state === 'undecodable' && <Undecodable item={item} />}
        {state === 'loading' && !url && <div className="tile__pending" aria-hidden="true" />}

        {item.type === 'video' && (
          <span className="tile__play-glyph" aria-hidden="true">
            ▶
          </span>
        )}
        {item.type === 'video' && item.duration !== undefined && (
          <span className="tile__duration mw-mono">{formatSpan(item.duration * 1000)}</span>
        )}

        {/* Captions ride INSIDE the frame. Below it they would sit at
            different heights across a row of mixed-aspect tiles, which reads
            as misalignment rather than as variety. */}
        {caption && <figcaption className="tile__caption mw-mono">{caption}</figcaption>}
        {color && <span className="tile__lane" style={{ background: color }} aria-hidden="true" />}

        {/* One hit target covering the whole tile, added last so it sits above
            the caption and badges. Undecodable items open too — the full-size
            view explains what happened and still shows the metadata. */}
        {onOpen && (
          <button type="button" className="tile__open" onClick={onOpen} aria-label={label} />
        )}
      </div>
    </figure>
  );
}

/**
 * What a HEIC looks like outside Safari.
 *
 * The item is still placed correctly on the timeline — its timestamp read
 * fine — so this says which file it is rather than pretending it is missing.
 */
function Undecodable({ item }: { item: Item }) {
  const name = item.src.slice(item.src.lastIndexOf('/') + 1);
  const extension = name.slice(name.lastIndexOf('.') + 1).toUpperCase();
  return (
    <div className="tile__undecodable">
      <span className="tile__undecodable-kind mw-mono">{extension}</span>
      <span className="tile__undecodable-note">
        {extension === 'HEIC' || extension === 'HEIF'
          ? 'Only Safari can show HEIC. Its place on the timeline is right.'
          : 'This browser cannot display this file.'}
      </span>
    </div>
  );
}

