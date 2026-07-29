import { useId, useRef, useState } from 'react';
import type { Person } from '../../core/schema.ts';

/**
 * Pick any number of people, by typing.
 *
 * The multi-select sibling of `TimezoneField`, built on the same grounds the
 * owner gave for that control: a list you filter by typing beats a list you
 * scroll. A note's `people` (who it is about) and `author` (who wrote it)
 * are both lists of names now, so both use this rather than each inventing
 * their own chip picker.
 *
 * Two differences from `TimezoneField`, both because this is multi-valued:
 *
 * - Chosen names render as removable chips above the input, and the value
 *   the caller sees is that chip list, not the text currently being typed.
 * - **A typed name matching nobody in `people` is still accepted.** The
 *   roster handed in may be incomplete — someone can be mentioned in a note
 *   without ever having a file of their own to be grouped from — and
 *   refusing an unrecognised name would silently lose it. This mirrors
 *   `resolvePersonNames` in `src/core/people-csv.ts`, which keeps unknown
 *   names on a note rather than dropping them. So there is no native
 *   `<datalist>` here (which can only offer values, never accept a novel
 *   one alongside them): the dropdown is a hand-rolled listbox that filters
 *   the roster but never blocks the input.
 *
 * Matching and de-duplication are case-insensitive, same as
 * `resolvePersonNames`, but the name is stored exactly as typed or as it
 * appears in the roster — never normalised — so it stays a name a human
 * would recognise in a spreadsheet.
 */

interface Props {
  people: readonly Person[];
  /** Names, not ids — see the module comment for why. */
  value: readonly string[];
  onChange: (names: string[]) => void;
  label: string;
}

export function PersonPicker({ people, value, onChange, label }: Props) {
  const labelId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const chosen = new Set(value.map((name) => name.toLowerCase().trim()));
  const q = query.trim().toLowerCase();
  const matches = people.filter((p) => {
    const key = p.name.toLowerCase().trim();
    return !chosen.has(key) && (q === '' || key.includes(q));
  });
  const activeIndex = Math.min(highlight, Math.max(matches.length - 1, 0));

  function commit(name: string) {
    const trimmed = name.trim();
    if (trimmed && !chosen.has(trimmed.toLowerCase())) {
      onChange([...value, trimmed]);
    }
    setQuery('');
    setHighlight(0);
    setOpen(false);
  }

  function removeAt(name: string) {
    onChange(value.filter((v) => v !== name));
  }

  return (
    // Wraps chips, input, and the listbox together. The chips' remove
    // buttons and the listbox options are all interactive descendants, so a
    // click on any of them is handled by that control directly rather than
    // redirected to the input the way a plain-text click on the label
    // would be — the same reason `TimezoneField` wraps its input in
    // `<label>` works here even with siblings added.
    <label className="field picker">
      <span className="field__label" id={labelId}>
        {label}
      </span>
      {value.length > 0 && (
        <ul className="picker__chips">
          {value.map((name) => (
            <li key={name} className="chip chip--person">
              <span>{name}</span>
              <button
                type="button"
                className="chip__remove"
                aria-label={`Remove ${name}`}
                onClick={() => removeAt(name)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="text"
        className="field__input picker__input"
        role="combobox"
        aria-labelledby={labelId}
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches.length > 0 ? `${listId}-${activeIndex}` : undefined}
        value={query}
        placeholder="Add a name…"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, Math.max(matches.length - 1, 0)));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            // The highlighted roster match wins when the list has one; with
            // no matches (an unrecognised name, or an empty roster) the
            // typed text is accepted as-is.
            commit(matches[activeIndex]?.name ?? query);
          } else if (event.key === 'Escape') {
            // Closes the list without changing `value` — the typed text is
            // left alone too, so Escape is purely "stop suggesting".
            setOpen(false);
          } else if (event.key === 'Backspace' && query === '' && value.length > 0) {
            const last = value[value.length - 1];
            if (last !== undefined) removeAt(last);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul id={listId} role="listbox" aria-labelledby={labelId} className="picker__list">
          {matches.map((person, i) => (
            <li
              key={person.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={`picker__option${i === activeIndex ? ' picker__option--active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              // mousedown with preventDefault, not click: it fires before
              // the input would blur, so preventing the default keeps focus
              // (and the list) right where typing the next name needs it.
              onMouseDown={(event) => {
                event.preventDefault();
                commit(person.name);
              }}
            >
              {person.name}
            </li>
          ))}
        </ul>
      )}
    </label>
  );
}
