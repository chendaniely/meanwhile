import { useCallback, useEffect, useRef, useState } from 'react';
import type { Note } from '../../core/notes.ts';
import type { PersonId, TimeSource } from '../../core/schema.ts';
import { formatDateTime } from '../../core/time.ts';
import type { PlacedItem } from '../../core/window.ts';
import { useMedia } from '../media/MediaContext.tsx';

/**
 * One item, full size.
 *
 * Shows the ORIGINAL file rather than the thumbnail — that is the point of
 * opening it. Which is also why exactly one is ever loaded at a time and its
 * object URL is released the moment you move on: a full-size photo decodes to
 * tens of megabytes and a clip can be gigabytes.
 *
 * Video plays here rather than in the grid. That makes "only one clip plays
 * at a time" true by construction instead of something state has to enforce.
 */

interface Props {
  items: readonly PlacedItem[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  colors: ReadonlyMap<PersonId, string>;
  names: ReadonlyMap<PersonId, string>;
  /**
   * Notes, so the caption field can find and show the one already attached to
   * the open photo — a caption is a note whose `photo` names the item's id.
   */
  notes?: readonly Note[];
  /**
   * Write, update, or clear the caption note for the open item. Omit to make
   * the lightbox read-only.
   */
  onCaption?: (itemId: string, text: string) => void;
  timezone?: string;
}

/** Sources worth warning about when you are looking at the thing up close. */
const SHAKY: Partial<Record<TimeSource, string>> = {
  mvhd: 'Time read from the video header, which Apple writes in local time with no zone. This one could be hours off.',
  filename: 'Time recovered from the filename, because the metadata had been stripped.',
  gps: 'Time from the GPS fix, not the shutter — usually tens of seconds early, occasionally by several minutes or more.',
  'exif-naive': 'The camera recorded no timezone; this is placed using the event timezone.',
  'qt-naive': 'The camera recorded no timezone; this is placed using the event timezone.',
  manual: 'Placed by hand.',
};

export function Lightbox({ items, index, onIndex, onClose, colors, names, timezone, notes, onCaption }: Props) {
  const { store } = useMedia();
  const entry = items[index];
  const item = entry?.item;

  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);
  /**
   * Whether the gesture currently in progress actually STARTED on the
   * backdrop, not just where it ended up.
   *
   * `event.target === event.currentTarget` alone is not a drift guard: a
   * pointer that goes down on `.lightbox__media` and is released over the
   * backdrop resolves the resulting `click`'s target to their common
   * ancestor — this very `.lightbox` div — so that check alone passes and a
   * drag-to-select on the photo closes the viewer. Recording where the
   * POINTERDOWN landed and requiring that to have been the backdrop too is
   * what actually stops a drift from closing.
   */
  const downOnBackdrop = useRef(false);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) onIndex(next);
    },
    [index, items.length, onIndex],
  );

  // Hold exactly one original, and hand it back on every move.
  useEffect(() => {
    if (!store || !item) return;
    setFailed(false);
    setSrc(store.acquireOriginal(item.id));
    return () => {
      store.releaseOriginal(item.id);
      setSrc(null);
    };
  }, [store, item]);

  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    dialog.current?.focus();
    // Stops the feed scrolling behind the overlay, which is disorienting on a
    // trackpad and leaves you somewhere unexpected on close.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight') go(1);
      else if (event.key === 'ArrowLeft') go(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [go, onClose]);

  if (!entry || !item) return null;

  const name = item.src.slice(item.src.lastIndexOf('/') + 1);
  const caution = SHAKY[item.timeSource];
  const caption = notes?.find((n) => n.photo === item.id)?.text ?? '';

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      ref={dialog}
      // Only a click on the backdrop itself closes; one that started on the
      // image and drifted must not — see `downOnBackdrop` above for why
      // checking the click's target alone is not enough.
      onPointerDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const started = downOnBackdrop.current;
        downOnBackdrop.current = false;
        if (started && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="lightbox__stage">
        {item.type === 'video' && src && !failed ? (
          <video
            className="lightbox__media"
            src={src}
            controls
            autoPlay
            playsInline
            onError={() => setFailed(true)}
          />
        ) : src && !failed ? (
          // Unlike MediaTile's thumbnail — decorative because a wrapping
          // button already carries the name — this IS the dialog's entire
          // subject, with nothing else standing in for it. Prefer the
          // caption, a human description, and fall back to who shot it and
          // when.
          <img
            className="lightbox__media"
            src={src}
            alt={caption || `Photo by ${names.get(item.person) ?? item.person}, ${formatDateTime(entry.instant, timezone)}`}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="lightbox__failed">
            <p className="lightbox__failed-kind mw-mono">
              {name.slice(name.lastIndexOf('.') + 1).toUpperCase()}
            </p>
            <p>
              This browser cannot display this file. Its place on the timeline is still
              correct &mdash; only the picture is missing.
            </p>
          </div>
        )}
      </div>

      <div className="lightbox__bar">
        <div className="lightbox__meta">
          <span className="lightbox__person">
            <span
              className="lightbox__swatch"
              style={{ background: colors.get(item.person) }}
              aria-hidden="true"
            />
            {names.get(item.person) ?? item.person}
          </span>
          <time className="mw-mono">{formatDateTime(entry.instant, timezone)}</time>
          <span className="lightbox__name mw-mono">{name}</span>
          <span className="lightbox__position mw-mono">
            {index + 1} / {items.length}
          </span>
        </div>
        {caution && <p className="lightbox__caution">{caution}</p>}

        {onCaption && (
          <label className="lightbox__note">
            <span className="mw-visually-hidden">Caption</span>
            <input
              /* Keyed by item id so switching photos re-mounts the field with
                 the new caption. Without the key React reuses the input and
                 the previous photo's text stays on screen. */
              key={item.id}
              className="lightbox__note-input"
              defaultValue={caption}
              placeholder="Add a caption…"
              // Written on blur, not on every keystroke: each edit rebuilds
              // the note list and re-runs placement over every note.
              onBlur={(e) => onCaption(item.id, e.target.value)}
              onKeyDown={(e) => {
                // The lightbox closes on Escape and moves on the arrows.
                // While typing, those belong to the text field.
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </label>
        )}
      </div>

      <button
        type="button"
        className="lightbox__nav lightbox__nav--prev"
        onClick={() => go(-1)}
        disabled={index === 0}
        aria-label="Previous"
      >
        ‹
      </button>
      <button
        type="button"
        className="lightbox__nav lightbox__nav--next"
        onClick={() => go(1)}
        disabled={index === items.length - 1}
        aria-label="Next"
      >
        ›
      </button>
      <button type="button" className="lightbox__close" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}
