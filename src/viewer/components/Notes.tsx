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
 * in the lanes, come here, and the new note is already at 3am; you type the
 * sentence and nothing else. Typing a timestamp by hand is possible but is
 * the fallback, not the path.
 *
 * A note can carry a person, and that is not decoration: it puts the note in
 * that person's lane, which is what lets one EXPLAIN A GAP. Six empty hours
 * in the runner's lane is the story of the night section, and "asleep at
 * Cottonwood" is the caption that gap never had.
 */

interface Props {
  manifest: Manifest;
  notes: readonly PlacedNote[];
  /** Where the timeline cursor is, used as the default time for a new note. */
  cursor: Instant | null;
  timezone?: string;
  onAdd: (note: Note) => void;
  onEdit: (id: string, change: Partial<Note>) => void;
  onDelete: (id: string) => void;
  onGo: (instant: Instant) => void;
}

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

/** Read a `datetime-local` value back as an instant in the event's zone. */
function fromLocalInput(value: string, timezone?: string): Instant | null {
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

export function Notes({
  manifest, notes, cursor, timezone, onAdd, onEdit, onDelete, onGo,
}: Props) {
  const colors = assignLaneColors(manifest.people);
  const names = new Map(manifest.people.map((p) => [p.id, p.name]));
  const [text, setText] = useState('');
  const [person, setPerson] = useState<PersonId | ''>('');
  const [when, setWhen] = useState('');
  const [span, setSpan] = useState('');

  // The cursor, unless the author has overridden it. Recomputed rather than
  // stored so scrubbing the timeline keeps the field in step.
  const defaultWhen = cursor === null ? '' : toLocalInput(cursor, timezone);
  const whenValue = when || defaultWhen;

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
  };

  return (
    <section className="notes" aria-label="Notes">
      <h2 className="notes__heading">Notes</h2>
      <p className="notes__lead">
        Something that happened with no photo of it &mdash; a wrong turn, a nap in
        the car, a rough patch. It lands on the timeline like everything else.
      </p>

      <div className="notes__compose">
        <textarea
          className="notes__text"
          value={text}
          rows={2}
          placeholder="What happened?"
          aria-label="What happened"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits; Shift+Enter is a new line. A note is usually one
            // sentence, so reaching for the mouse for every one would grate.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="notes__fields">
          <label className="notes__field">
            <span>When</span>
            <input
              type="datetime-local"
              className="mw-mono"
              value={whenValue}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <label className="notes__field">
            <span>Until (optional)</span>
            <input
              type="datetime-local"
              className="mw-mono"
              value={span}
              onChange={(e) => setSpan(e.target.value)}
            />
          </label>
          <label className="notes__field">
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
        {cursor !== null && !when && (
          <p className="notes__hint mw-mono">
            Using the cursor: {formatDateTime(cursor, timezone)}
          </p>
        )}
      </div>

      {notes.length === 0 ? (
        <p className="notes__empty">No notes yet.</p>
      ) : (
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
                  // Clearing the text deletes it: an empty note is not a note,
                  // and this is more discoverable than hunting for Remove.
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
      )}
    </section>
  );
}
