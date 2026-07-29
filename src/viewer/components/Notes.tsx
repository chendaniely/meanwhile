import { useState } from 'react';
import { assignLaneColors } from '../../core/palette.ts';
import type { Manifest, Note, PersonId } from '../../core/schema.ts';
import { formatDateTime, type Instant } from '../../core/time.ts';
import type { PlacedNote } from '../../core/window.ts';

/**
 * Things that happened, with or without a photograph.
 *
 * Every other annotation in the app hangs off a file, so anything nobody
 * photographed could not be recorded at all — and an ultra is mostly those
 * things. The owner: *"either because we forgot to take a photo or it was
 * something that we remembered happening during some point of time."*
 *
 * **The cursor is the default time**, which is the whole trick. Scrub to 3am
 * in the lanes, or scroll the feed to the small hours, and the new note is
 * already there; you type the sentence and nothing else. Typing a timestamp
 * by hand is possible but is the fallback, not the path.
 *
 * A note can carry a person, and that is not decoration: it puts the note in
 * that person's lane, which is what lets one EXPLAIN A GAP. Six empty hours in
 * the runner's lane is the story of the night section, and "asleep at
 * Cottonwood" is the caption that gap never had.
 *
 * **The composer and the list are separate exports on purpose.** Writing a
 * note is something you do constantly while reading, so it has to sit within
 * reach of whatever view you are in — under the lanes, floating over the feed.
 * Re-reading the whole list is reference, and belongs with the other reference
 * material. Keeping them one component forced both to live in the same place,
 * which is how the composer ended up below two thousand photographs.
 */

/** Local ISO (`2026-07-25T21:43`) for `<input type="datetime-local">`. */
function toLocalInput(instant: Instant, timezone?: string): string {
  // Reuse the app's zone-aware formatter rather than the browser's zone: the
  // event's timezone is what every other time on screen is shown in, and a
  // note that reads an hour out from the photo beside it is worse than none.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone ?? 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  // `en-CA` gives 24-hour time but renders midnight as 24; normalise it.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Read a typed local time back as an instant in the event's zone.
 *
 * Accepts either separator, so `2026-07-25 15:45` and `2026-07-25T15:45` both
 * work — the field shows a space because it reads better, but a value pasted
 * from anywhere else in the app will carry the T.
 */
function fromLocalInput(raw: string, timezone?: string): Instant | null {
  const value = raw.trim().replace(' ', 'T');
  if (!value) return null;
  if (!timezone) {
    const direct = Date.parse(`${value}:00Z`);
    return Number.isNaN(direct) ? null : direct;
  }
  // Find the UTC instant whose rendering in `timezone` matches what was typed.
  // Guessing the offset once and correcting is exact for every zone except
  // within the hour a DST change repeats, where either answer is defensible.
  const guess = Date.parse(`${value}:00Z`);
  if (Number.isNaN(guess)) return null;
  const rendered = Date.parse(`${toLocalInput(guess, timezone)}:00Z`);
  return guess + (guess - rendered);
}

interface ComposerProps {
  manifest: Manifest;
  /** Where the timeline cursor is, used as the default time for a new note. */
  cursor: Instant | null;
  timezone?: string;
  onAdd: (note: Note) => void;
  /** Called after a note is added, so a popover can close itself. */
  onDone?: () => void;
}

export function NoteComposer({ manifest, cursor, timezone, onAdd, onDone }: ComposerProps) {
  const [text, setText] = useState('');
  const [person, setPerson] = useState<PersonId | ''>('');
  const [when, setWhen] = useState('');
  const [span, setSpan] = useState('');

  // The cursor, unless the author has overridden it. Recomputed rather than
  // stored so scrubbing the timeline keeps the field in step.
  const defaultWhen = cursor === null ? '' : toLocalInput(cursor, timezone);
  const whenValue = when || defaultWhen;

  // Shown while typing rather than only on submit, so a half-typed date is
  // visibly not-yet-valid instead of a button that silently does nothing.
  const whenOk = whenValue === '' || fromLocalInput(whenValue, timezone) !== null;
  const spanOk = span === '' || fromLocalInput(span, timezone) !== null;

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    const at = fromLocalInput(whenValue, timezone);
    if (at === null) return;
    const note: Note = {
      // Time plus a random suffix: stable once written, and unique even for
      // two notes typed into the same minute.
      id: `note-${at}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date(at).toISOString(),
      text: body,
    };
    if (person) note.person = person;
    const until = span ? fromLocalInput(span, timezone) : null;
    if (until !== null && until > at) note.until = new Date(until).toISOString();
    onAdd(note);
    setText('');
    setSpan('');
    setWhen('');
    onDone?.();
  };

  return (
    <div className="compose">
      <textarea
        className="compose__text"
        value={text}
        rows={2}
        placeholder="Something that happened — a wrong turn, a nap in the car…"
        aria-label="What happened"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter is a new line. A note is usually one
          // sentence, so reaching for the mouse every time would grate.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="compose__fields">
        {/*
          * A plain text field rather than `<input type="datetime-local">`.
          *
          * Chrome renders that control in the BROWSER's locale and ignores the
          * element's `lang`, so on a US machine it shows 3:45 PM — the only
          * 12-hour clock in an app that is `hourCycle: 'h23'` everywhere else.
          * A time that reads differently from the photo beside it is worse
          * than a lost date picker, and the value is usually pre-filled from
          * the cursor anyway, so what is left is editing minutes.
          */}
        <label className="compose__field">
          <span>When</span>
          <input
            type="text"
            className={`mw-mono${whenOk ? '' : ' compose__input--bad'}`}
            value={whenValue.replace('T', ' ')}
            placeholder="YYYY-MM-DD HH:MM"
            aria-invalid={!whenOk}
            onChange={(e) => setWhen(e.target.value)}
          />
        </label>
        <label className="compose__field">
          <span>Until (optional)</span>
          <input
            type="text"
            className={`mw-mono${spanOk ? '' : ' compose__input--bad'}`}
            value={span.replace('T', ' ')}
            placeholder="YYYY-MM-DD HH:MM"
            aria-invalid={!spanOk}
            onChange={(e) => setSpan(e.target.value)}
          />
        </label>
        <label className="compose__field">
          <span>Whose</span>
          <select value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">Everyone</option>
            {manifest.people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <button type="button" className="button button--primary" onClick={submit}>
          Add note
        </button>
      </div>
      {!whenOk || !spanOk ? (
        <p className="compose__hint compose__hint--bad">
          Times go in as <span className="mw-mono">YYYY-MM-DD HH:MM</span>, on a
          24-hour clock.
        </p>
      ) : cursor !== null && !when ? (
        <p className="compose__hint mw-mono">
          Using the cursor: {formatDateTime(cursor, timezone)}
        </p>
      ) : null}
    </div>
  );
}

interface ListProps {
  manifest: Manifest;
  notes: readonly PlacedNote[];
  timezone?: string;
  onEdit: (id: string, change: Partial<Note>) => void;
  onDelete: (id: string) => void;
  onGo: (instant: Instant) => void;
}

export function NoteList({ manifest, notes, timezone, onEdit, onDelete, onGo }: ListProps) {
  const colors = assignLaneColors(manifest.people);
  const names = new Map(manifest.people.map((p) => [p.id, p.name]));

  if (notes.length === 0) {
    return <p className="notes__empty">No notes yet.</p>;
  }

  return (
    <ul className="notes__list">
      {notes.map(({ note, instant, until }) => (
        <li key={note.id} className="notes__row">
          <button
            type="button"
            className="notes__when mw-mono"
            onClick={() => onGo(instant)}
            title="Jump the timeline here"
          >
            {formatDateTime(instant, timezone)}
            {until !== undefined && ' →'}
          </button>
          {note.person && (
            <span className="notes__person">
              <span
                className="notes__swatch"
                style={{ background: colors.get(note.person) }}
                aria-hidden="true"
              />
              {names.get(note.person) ?? note.person}
            </span>
          )}
          <input
            className="notes__edit"
            defaultValue={note.text}
            aria-label="Note text"
            onBlur={(e) => {
              const next = e.target.value.trim();
              // Clearing the text deletes it: an empty note is not a note, and
              // this is more discoverable than hunting for a Remove button.
              if (!next) onDelete(note.id);
              else if (next !== note.text) onEdit(note.id, { text: next });
            }}
          />
          <button
            type="button"
            className="notes__delete"
            onClick={() => onDelete(note.id)}
            aria-label={`Delete note: ${note.text}`}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
