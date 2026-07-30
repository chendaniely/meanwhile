import { useEffect, useRef } from 'react';
import type { Note } from '../../core/notes.ts';
import type { Manifest } from '../../core/schema.ts';
import type { Instant } from '../../core/time.ts';
import { NoteComposer } from './Notes.tsx';

/**
 * A note composer that floats over whichever view is showing.
 *
 * Rendered once in App.tsx, outside every view branch, so it is present in
 * the feed, the swimlanes and the course alike — writing a note is something
 * you do WHILE reading, not a feature of one page. It used to be inline
 * under the lanes and separately in the feed and the course: three
 * placements and two shapes for one action. See CLAUDE.md's "The note dock
 * is app chrome, not a feature of one view".
 *
 * The feed in particular is unbounded — two thousand photographs is a
 * normal folder — so anything placed after it is unreachable in practice.
 * "Scroll to the end to find the box" is exactly the wrong shape there, and
 * floating rather than sitting inline is why this is not a problem in any
 * of the three views.
 *
 * Collapsed to a button until wanted, because the view underneath is the
 * subject and a permanently open form over it would be noise. It opens with
 * the timeline cursor already filled in, so scrolling to the small hours and
 * writing a note about the small hours is two actions rather than a typed
 * timestamp.
 */

interface Props {
  manifest: Manifest;
  cursor: Instant | null;
  timezone?: string;
  /** The "you are" setting from the top bar — pre-fills the composer's "Written by". */
  author: readonly string[];
  onAdd: (note: Note) => void;
  /**
   * Notes already written, purely for the count on the button. Expected to
   * exclude captions (`excludingCaptions` in `core/window.ts`) — a caption
   * is discovered via the photo's own speech-bubble glyph, not this count,
   * so including it here would say the same thing twice.
   */
  count: number;
  /**
   * Shown when the note just written landed outside the visible window, with
   * the way to reveal it. Writing something and watching it vanish is the
   * worst outcome here, and silently widening the crop would be a surprise.
   */
  notice?: { text: string; action: string; onAction: () => void; onDismiss: () => void } | undefined;
  /**
   * Whether the panel is open. Always controlled by App.tsx — clicking the
   * course, for instance, opens the dock via `pickOnCourse` setting this
   * true, same as the button below does by hand.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NoteDock({
  manifest, cursor, timezone, author, onAdd, count, notice, open, onOpenChange,
}: Props) {
  const setOpen = onOpenChange;
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
