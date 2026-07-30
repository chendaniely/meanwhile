import { useId, useMemo } from 'react';

/**
 * Pick one IANA timezone, by typing.
 *
 * There are ~420 of them, so a plain `<select>` is unusable and a free-text
 * box invites typos that silently unplace every naive timestamp. A native
 * `<input list>` with a `<datalist>` is searchable, keyboard-driven, single
 * -valued, and costs no dependency — which matters, because a combobox
 * library would be the largest thing in this project.
 *
 * The zone list comes from `Intl.supportedValuesOf`, so it is whatever the
 * browser actually knows rather than a list that ages.
 */

interface Props {
  value: string;
  onChange: (next: string) => void;
}

function zones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    if (supported) return supported('timeZone');
  } catch {
    /* falls through */
  }
  // Older browsers: at least offer the local zone and UTC rather than nothing.
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([local, 'UTC'].filter(Boolean))] as string[];
}

/**
 * Whether this runtime can actually resolve the zone — asked of `Intl`, not
 * of the datalist.
 *
 * `Intl.supportedValuesOf('timeZone')` returns only canonical named zones:
 * it contains neither `UTC` nor any `Etc/GMT±N`, both of which
 * `Intl.DateTimeFormat` resolves perfectly well and both of which this app
 * legitimately produces — `Etc/GMT+6` is what `inferEventTimezone` returns
 * when the photographs state an offset but nothing states a place. Checking
 * membership of that list therefore warned about zones that work.
 */
function isZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The zone's current offset, e.g. "UTC−06:00", to confirm the right pick. */
function offsetLabel(zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value;
    return name ? name.replace('GMT', 'UTC').replace('-', '−') : null;
  } catch {
    return null;
  }
}

export function TimezoneField({ value, onChange }: Props) {
  const listId = useId();
  const all = useMemo(zones, []);
  const known = value === '' || isZone(value);
  const offset = known && value ? offsetLabel(value) : null;

  return (
    <label className="field">
      <span className="field__label">
        Timezone
        {offset && <span className="field__note mw-mono"> {offset}</span>}
        {/*
          * Every note is written with this zone and its UTC offset in the
          * row (`tz` and `utc_offset_min` in notes.csv), so which zone is
          * showing here is not a setting to bury — it is part of what gets
          * saved. The list is searchable but names alone are not always
          * enough to choose between them, hence a way out to the full table.
          */}
        <a
          className="field__link"
          href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
          target="_blank"
          rel="noreferrer"
        >
          find a timezone
        </a>
      </span>
      <input
        className="field__input mw-mono"
        list={listId}
        value={value}
        placeholder="Start typing a city…"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!known}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {all.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
      {!known && (
        // Not an error to block on — it may simply be a zone this browser
        // does not carry — but a wrong zone silently unplaces every naive
        // timestamp, so it must not pass unremarked.
        <span className="field__warning">
          Not a timezone this browser recognises. Naive timestamps will stay unplaced until it
          is one.
        </span>
      )}
    </label>
  );
}
