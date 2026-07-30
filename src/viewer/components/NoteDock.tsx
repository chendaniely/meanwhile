import { useEffect, useRef, useState } from 'react';
import type { Note } from '../../core/notes.ts';
import type { Manifest } from '../../core/schema.ts';
import type { Instant } from '../../core/time.ts';
import { NoteComposer } from './Notes.tsx';

/**
 * A note composer that floats over a scrolling view.
 *
 * The feed is unbounded — two thousand photographs is a normal folder — so
 * anything placed after it is unreachable in practice. Writing a note is
 * something you do WHILE reading, which makes "scroll to the end to find the
 * box" exactly the wrong shape. This stays put instead.
 *
 * Collapsed to a button until wanted, because the feed is the subject and a
 * permanently open form over it would be noise. It opens with the timeline
 * cursor already filled in, so scrolling to the small hours and writing a note
 * about the small hours is two actions rather than a typed timestamp.
 */

interface Props {
  manifest: Manifest;
  cursor: Instant | null;
  timezone?: string;
  /** The "you are" setting from the top bar — pre-fills the composer's "Written by". */
  author: readonly string[];
  onAdd: (note: Note) => void;
  /** Notes already written, purely for the count on the button. */
  count: number;
  /**
   * Shown when the note just written landed outside the visible window, with
   * the way to reveal it. Writing something and watching it vanish is the
   * worst outcome here, and silently widening the crop would be a surprise.
   */
  notice?: { text: string; action: string; onAction: () => void; onDismiss: () => void } | undefined;
  /** Opened from elsewhere — "Note here" on the course, for instance. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function NoteDock({
  manifest, cursor, timezone, author, onAdd, count, notice, open: openProp, onOpenChange,
}: Props) {
  const [ownOpen, setOwnOpen] = useState(false);
  // Controlled when a parent supplies `open`, self-managed otherwise, so the
  // dock works standalone in the feed and can also be thrown open from the
  // course view.
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the panel when it opens — it is a
  // dialog in everything but name.
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('textarea')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="dock">
      {notice && (
        <div className="dock__notice" role="status">
          <span>{notice.text}</span>
          <button type="button" className="dock__notice-action" onClick={notice.onAction}>
            {notice.action}
          </button>
          <button
            type="button"
            className="dock__close"
            onClick={notice.onDismiss}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {open && (
        <div className="dock__panel" ref={panel} role="dialog" aria-label="Add a note">
          <div className="dock__head">
            <strong>Add a note</strong>
            <button
              type="button"
              className="dock__close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <NoteComposer
            manifest={manifest}
            cursor={cursor}
            defaultAuthor={author}
            onAdd={onAdd}
            onDone={() => setOpen(false)}
            {...(timezone ? { timezone } : {})}
          />
        </div>
      )}

      <button
        type="button"
        className={open ? 'dock__button dock__button--on' : 'dock__button'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">✎</span>
        Note
        {count > 0 && <span className="dock__count mw-mono">{count}</span>}
      </button>
    </div>
  );
}
