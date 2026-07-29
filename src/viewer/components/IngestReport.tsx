import { summarize, type GroupingInfo, type IngestSummary } from '../../core/assemble.ts';
import { assignLaneColors, isOvercrowded, MAX_DISTINCT_PEOPLE } from '../../core/palette.ts';
import type { Manifest, TimeSource } from '../../core/schema.ts';
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
  onExport: () => void;
  children?: React.ReactNode;
}

export function IngestReport({ manifest, grouping, range, onExport, children }: Props) {
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
        <Stat label={range ? 'files in window' : 'files'} value={summary.total.toLocaleString()} />
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
                <span className="report__name">
                  {person.name}
                  {person.role === 'runner' && <span className="report__tag">runner</span>}
                </span>
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
          these can land hours off with nothing on screen to warn you. Check one against a photo you
          know the time of before trusting them.
        </p>
      )}

      <div className="report__actions">
        <button type="button" className="button button--primary" onClick={onExport}>
          Export manifest.json
        </button>
        {children}
      </div>
    </section>
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
  return [...inside.map((p) => p.item), ...unplaced];
}
