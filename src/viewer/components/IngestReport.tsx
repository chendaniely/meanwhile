import { useEffect, useState } from 'react';
import { summarize, type GroupingInfo, type IngestSummary } from '../../core/assemble.ts';
import { assignLaneColors, isOvercrowded, MAX_DISTINCT_PEOPLE } from '../../core/palette.ts';
import { displayName } from '../../core/people-csv.ts';
import type { Manifest, Person, PersonId, TimeSource } from '../../core/schema.ts';
import { TIME_SOURCE_RANK } from '../../core/schema.ts';
import { formatDateTime, formatSpan } from '../../core/time.ts';
import { isWithin, placeItems, type TimeWindow } from '../../core/window.ts';

/**
 * What came out of the folder.
 *
 * The job of this screen is to answer one question before any timeline is
 * drawn: **can this data be trusted?** So the trustworthiness breakdown is
 * given as much room as the headline counts, and the two ways a timeline goes
 * quietly wrong — items with no time at all, and video times read from
 * `mvhd` — get named callouts rather than a number in a table.
 */

const SOURCE_LABEL: Record<TimeSource, string> = {
  gps: 'GPS satellites',
  manual: 'placed by hand',
  'exif-offset': 'camera clock, with timezone',
  'qt-offset': 'video clock, with timezone',
  'exif-naive': 'camera clock, no timezone',
  'qt-naive': 'video clock, no timezone',
  filename: 'filename',
  mvhd: 'video header (unreliable)',
  none: 'no timestamp',
};

interface Props {
  manifest: Manifest;
  grouping: GroupingInfo;
  /** Counts describe what is inside this, since that is the working set. */
  range?: TimeWindow;
  /**
   * Renaming a device to a person. The whole point of the callout below.
   *
   * Called on a COMMITTED edit only (blur or Enter — see `RenameInput`
   * below), never per keystroke: a 2026-07-30 review found that renaming
   * "Google Pixel 8 Pro" to "Priya" one keystroke at a time ran `applyRename`
   * ~19 times, filling `also_known_as` with single- and two-character
   * garbage and, while backspacing through empty, rewriting a note's
   * `people` entry to `""` — which never healed, because `applyRename`
   * treats a blank "previous name" as nothing to rewrite from.
   *
   * Returns a refusal message (blank name, a name containing `;`, or a name
   * already used by someone else) when `applyRename` (`core/people-csv.ts`)
   * refuses the rename outright, so `RenameInput` can show it instead of
   * quietly doing nothing.
   */
  onRename?: (person: PersonId, name: string) => string | undefined;
  onRole?: (person: PersonId, role: 'runner' | undefined) => void;
}

export function IngestReport({ manifest, grouping, range,
  onRename,
  onRole,
}: Props) {
  const summary = summarize(manifest, range);
  const colors = assignLaneColors(manifest.people);
  const zone = manifest.event.timezone;

  // Per-person counts follow the window too, so the numbers beside each lane
  // match what that lane will actually show.
  const visible = visibleItems(manifest, range);
  const perPerson = new Map<string, number>();
  for (const item of visible) {
    perPerson.set(item.person, (perPerson.get(item.person) ?? 0) + 1);
  }

  return (
    <section className="report">
      <div className="report__stats">
        <Stat label="files" value={summary.total.toLocaleString()} />
        <Stat label="on the timeline" value={summary.placed.toLocaleString()} />
        <Stat
          label="unplaced"
          value={summary.unplaced.toLocaleString()}
          tone={summary.unplaced > 0 ? 'warn' : 'plain'}
        />
        <Stat
          label="event span"
          value={summary.span ? formatSpan(summary.span.to - summary.span.from) : '—'}
        />
      </div>

      {summary.span && (
        <p className="report__span mw-mono">
          {formatDateTime(summary.span.from, zone)} → {formatDateTime(summary.span.to, zone)}
          {zone ? ` (${zone})` : ' (UTC — no event timezone set)'}
        </p>
      )}

      <div className="report__columns">
        <div>
          <h2 className="report__heading">People</h2>
          <ul className="report__list">
            {manifest.people.map((person) => (
              <li key={person.id} className="report__row">
                <span
                  className="report__swatch"
                  style={{ background: colors.get(person.id) }}
                  aria-hidden="true"
                />
                {/* Editable in place. The callout below tells the author to
                    rename these, and for a long time there was nowhere to do
                    it — an instruction with no control is worse than neither. */}
                <RenameInput person={person} {...(onRename ? { onRename } : {})} />
                <button
                  type="button"
                  className={person.role === 'runner' ? 'report__tag report__tag--on' : 'report__tag'}
                  aria-pressed={person.role === 'runner'}
                  // `role` carries behaviour, not decoration: the runner's
                  // lane pins to the top and owns the course spine.
                  title={
                    person.role === 'runner'
                      ? 'Runner — pins their lane to the top. Click to unmark.'
                      : 'Mark as the runner — pins their lane to the top'
                  }
                  onClick={() => onRole?.(person.id, person.role === 'runner' ? undefined : 'runner')}
                >
                  runner
                </button>
                <span className="report__count mw-mono">
                  {(perPerson.get(person.id) ?? 0).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
          {grouping.by === 'device' && (
            <p className="callout">
              No subfolders, so these are <strong>devices, not people</strong> &mdash; that&rsquo;s
              what a Google Photos album download looks like. Rename each one to whoever was
              carrying it.
              {grouping.byFamily + grouping.byProximity > 0 && (
                <>
                  {' '}
                  {grouping.byFamily + grouping.byProximity} file(s) carried no device of their own
                  &mdash; Android videos usually don&rsquo;t.
                  {grouping.byFamily > 0 &&
                    ` ${grouping.byFamily} were matched by how the phone names its files, which is reliable.`}
                  {grouping.byProximity > 0 &&
                    ` ${grouping.byProximity} could only be matched by what was shooting nearby in time, which is a guess — worth a glance.`}
                </>
              )}
            </p>
          )}
          {isOvercrowded(manifest.people) && (
            <p className="callout callout--warn">
              More than {MAX_DISTINCT_PEOPLE} people. Beyond that, lane colors stop being reliably
              distinguishable and the extra lanes share a neutral gray.
            </p>
          )}
        </div>

        <div>
          <h2 className="report__heading">Where the times came from</h2>
          <SourceBreakdown summary={summary} />
        </div>
      </div>

      {summary.unplaced > 0 && (
        <p className="callout callout--warn">
          <strong>{summary.unplaced.toLocaleString()} file(s) have no usable time</strong> and can&rsquo;t
          sit on the timeline yet.{' '}
          {(summary.bySource['exif-naive'] ?? 0) + (summary.bySource['qt-naive'] ?? 0) + (summary.bySource['filename'] ?? 0) > 0 &&
          !manifest.event.timezone
            ? 'Some of them only need an event timezone — set one above.'
            : 'A large number usually means iMessage or WhatsApp stripped the metadata in transit. Ask for the originals.'}
        </p>
      )}

      {summary.mvhdCount > 0 && (
        <p className="callout callout--warn">
          <strong>{summary.mvhdCount.toLocaleString()} video(s) fell back to the file header.</strong>{' '}
          That field is supposed to be UTC, but Apple writes local time into it with no timezone, so
          these can land hours off. They're marked here (the bar above is shaded differently) and
          again when you open one full-size, but check one against a photo you know the time of
          before trusting them.
        </p>
      )}

      {/* No buttons here. Opening, adding and saving all live in the top bar,
          which is always reachable — two controls for one action, under two
          names, is how "Save manifest" and "Export manifest.json" ended up
          side by side once before. There is exactly one save control now:
          "Save", which downloads notes.csv, people.csv, and manifest.json
          together as a zip. */}
    </section>
  );
}

/**
 * A person's name box: local draft state, committed to `onRename` only on
 * blur or Enter. Fixes the data-corruption bug described on the `onRename`
 * prop above — every keystroke used to call `applyRename` directly, so
 * typing "Priya" one letter at a time ran a real rename per letter.
 *
 * Escape reverts the draft to the person's current name without committing —
 * "stop editing, I didn't mean that" needs to be a real option distinct from
 * blurring, which commits.
 *
 * A refusal (blank name, a `;`, or a name already in use — see
 * `applyRename`) is shown inline and the draft is LEFT AS TYPED, so it is one
 * edit away from being fixed rather than silently reverted; a successful
 * rename instead flows back in through the `person` prop once the parent
 * re-renders, and the effect below picks that up.
 */
function RenameInput({
  person,
  onRename,
}: {
  person: Person;
  onRename?: (id: PersonId, name: string) => string | undefined;
}) {
  const canonical = displayName(person);
  const [draft, setDraft] = useState(canonical);
  const [issue, setIssue] = useState<string | null>(null);

  // Picks up a rename that landed successfully (the `person` prop changed)
  // or a re-ingest that replaced the roster. Does NOT fire on every
  // keystroke — `canonical` only changes from OUTSIDE this component.
  useEffect(() => {
    setDraft(canonical);
    setIssue(null);
  }, [canonical]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === canonical) {
      // Nothing to rename — e.g. only whitespace was added/removed. Snap
      // the box back to the canonical spelling rather than leaving stray
      // whitespace displayed.
      setDraft(canonical);
      setIssue(null);
      return;
    }
    const refused = onRename?.(person.id, draft);
    setIssue(refused ?? null);
    // On success `canonical` changes on the next render and the effect
    // above syncs `draft`; on refusal `draft` is deliberately left alone.
  }

  return (
    <span className="report__rename-wrap">
      <input
        className="report__rename"
        value={draft}
        aria-label="Person name"
        aria-invalid={issue !== null}
        onChange={(e) => {
          setDraft(e.target.value);
          if (issue) setIssue(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            // Revert only — deliberately does NOT also call `.blur()`. That
            // would fire `onBlur` (`commit`) synchronously, in the SAME
            // event-handling pass, before this `setDraft` has been applied —
            // React batches the state update, so `commit` would still read
            // the OLD (abandoned) `draft` from this render's closure and
            // commit exactly the text Escape was meant to discard. Found by
            // a test that pressed Escape and got the abandoned edit renamed
            // anyway. Leaving focus in the field after Escape is harmless:
            // a later blur commits the (already-reverted) canonical value,
            // which is a no-op.
            setDraft(canonical);
            setIssue(null);
          }
        }}
      />
      {issue && (
        <span className="report__rename-issue" role="alert">
          {issue}
        </span>
      )}
    </span>
  );
}

function Stat({ label, value, tone = 'plain' }: { label: string; value: string; tone?: 'plain' | 'warn' }) {
  return (
    <div className="stat">
      <div className={tone === 'warn' ? 'stat__value stat__value--warn' : 'stat__value'}>{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

/**
 * A single-hue bar list, deliberately.
 *
 * Coloring nine rows by nine hues would spend the identity channel
 * re-encoding what the row label already says. The two rows that matter are
 * called out in prose below the chart instead.
 */
function SourceBreakdown({ summary }: { summary: IngestSummary }) {
  const present = TIME_SOURCE_RANK.filter((source) => (summary.bySource[source] ?? 0) > 0);
  const max = Math.max(...present.map((s) => summary.bySource[s] ?? 0), 1);

  return (
    <ul className="report__list">
      {present.map((source) => {
        const count = summary.bySource[source] ?? 0;
        const suspect = source === 'mvhd' || source === 'none';
        return (
          <li key={source} className="bars__row">
            <span className="bars__label">{SOURCE_LABEL[source]}</span>
            <span className="bars__track">
              <span
                className={suspect ? 'bars__fill bars__fill--suspect' : 'bars__fill'}
                style={{ width: `${Math.max(2, (count / max) * 100)}%` }}
              />
            </span>
            <span className="bars__count mw-mono">{count.toLocaleString()}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Items inside the range, plus every unplaced item regardless. */
function visibleItems(manifest: Manifest, range?: TimeWindow) {
  const { placed, unplaced } = placeItems(manifest);
  const inside = range ? placed.filter((p) => isWithin(p.instant, range)) : placed;
  return [...inside.map((p) => p.item), ...unplaced.map((u) => u.item)];
}
