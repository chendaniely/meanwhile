import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupingInfo } from '../core/assemble.ts';
import { simplify, type Course } from '../core/course.ts';
import type { Manifest, PersonId } from '../core/schema.ts';
import { isVisible, toggleVisible, VIEW_NAMES, type ViewName } from '../core/state.ts';
import { assignLaneColors } from '../core/palette.ts';
import {
  clampWindow,
  densestWindow,
  fullSpan,
  isWithin,
  placeItems,
  type PlacedItem,
  type TimeWindow,
} from '../core/window.ts';
import { CourseCharts } from './components/CourseCharts.tsx';
import { Feed } from './components/Feed.tsx';
import { Lightbox } from './components/Lightbox.tsx';
import { Swimlanes } from './components/Swimlanes.tsx';
import { FilePicker, FolderPicker } from './components/FolderPicker.tsx';
import { IngestReport } from './components/IngestReport.tsx';
import { TimeWindowSlider } from './components/TimeWindowSlider.tsx';
import { TimezoneField } from './components/TimezoneField.tsx';
import { UnplacedTray } from './components/UnplacedTray.tsx';
import { CourseMap } from './map/CourseMap.tsx';
import { MediaProvider } from './media/MediaContext.tsx';
import { useMediaStore } from './media/useMediaStore.ts';
import { useAppState } from './hooks/useAppState.ts';
import type { PickedFile } from './media/folder.ts';
import { downloadManifest, ingestFolder, type IngestProgress } from './media/ingest.ts';
import './App.css';

/** The browser's own zone is right far more often than not — it is where the
 * author lives, and usually where the race was. Editable either way. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The URL of whichever course variant is set, for the input's value. */
function courseUrlOf(manifest: Manifest): string {
  const course = manifest.course;
  if (!course) return '';
  return course.kind === 'gpx' ? course.src : course.url;
}

type Stage =
  | { name: 'empty' }
  | { name: 'reading'; progress: IngestProgress }
  | {
      name: 'loaded';
      manifest: Manifest;
      grouping: GroupingInfo;
      /** Null until a .gpx or .tcx turns up in the folder. */
      course: Course | null;
      courseFile: string | null;
    };

export function App() {
  const [stage, setStage] = useState<Stage>({ name: 'empty' });
  // Cursor, view, visible lanes, and the crop — one object, mirrored in the
  // URL so any moment is a link.
  const [view, setView] = useAppState();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled event');
  const [timezone, setTimezone] = useState(guessTimezone);

  // Kept so re-reading the folder preserves names, clock offsets, captions,
  // and hand-placed times rather than starting over.
  const previous = useRef<Manifest | null>(null);

  /**
   * The actual File handles, kept for as long as the folder is loaded.
   *
   * Ingest only reads a few kilobytes of metadata per file; showing the
   * pictures needs the files themselves. Nothing is copied — a File is a
   * handle to bytes on disk, and they are only read when a tile asks.
   */
  const [files, setFiles] = useState<ReadonlyMap<string, File> | null>(null);

  /**
   * Read a set of files into the app.
   *
   * `mode` matters, and getting it wrong loses work. Opening a FOLDER replaces
   * what is loaded — "open a different folder" means exactly that. Picking
   * FILES adds to it, because the reason to reach for that button once a
   * folder is open is to drop in something the folder lacked, usually the
   * track. Replacing there silently discarded every photo, leaving a screen
   * of zeroes and no way back but re-opening the folder.
   */
  const handlePicked = useCallback(
    async (picked: PickedFile[], mode: 'replace' | 'add' = 'replace') => {
      setError(null);
      // Merge by path, so re-picking the same file updates rather than
      // duplicating it. An item's id IS its path, so a duplicate here would
      // become two timeline entries for one photo.
      const merged = new Map<string, File>(mode === 'add' && files ? files : []);
      for (const f of picked) merged.set(f.path, f.file);
      const all: PickedFile[] = [...merged].map(([path, file]) => ({ path, file }));

      setFiles(merged);
      setStage({ name: 'reading', progress: { done: 0, total: all.length, current: '' } });
      try {
        const { manifest, grouping, course, courseFile } = await ingestFolder(all, {
          title,
          timezone,
          ...(previous.current
            ? { existingPeople: previous.current.people, existingItems: previous.current.items }
            : {}),
          onProgress: (progress) => setStage({ name: 'reading', progress }),
        });
        previous.current = manifest;
        setStage({ name: 'loaded', manifest, grouping, course, courseFile });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong reading that folder.');
        setStage({ name: 'empty' });
      }
    },
    [title, timezone, files],
  );

  /**
   * Editing the title or timezone rewrites the manifest in place. The
   * timezone especially is not cosmetic: it is what turns a naive camera
   * timestamp into a real instant, so changing it can move items out of the
   * unplaced tray and onto the timeline.
   */
  const updateEvent = (next: { title?: string; timezone?: string }) => {
    if (next.title !== undefined) setTitle(next.title);
    if (next.timezone !== undefined) setTimezone(next.timezone);
    if (stage.name !== 'loaded') return;
    const event = { ...stage.manifest.event, title: next.title ?? stage.manifest.event.title };
    const zone = next.timezone ?? stage.manifest.event.timezone;
    // An empty box means "no timezone", which is a real state: naive
    // timestamps then cannot be placed at all. Drop the key rather than
    // storing an empty string that would fail to resolve.
    if (zone) event.timezone = zone;
    else delete event.timezone;
    const manifest: Manifest = { ...stage.manifest, event };
    previous.current = manifest;
    setStage({ ...stage, manifest });
  };

  /**
   * A Strava link is presentational: it cannot be queried for where the
   * runner was at 2am, because the embed token is not derivable from an
   * activity URL and the embed is an opaque iframe either way. Only a GPX
   * gives the spine. Setting one here at least records the reference.
   */
  const updateCourse = (url: string) => {
    if (stage.name !== 'loaded') return;
    const manifest: Manifest = { ...stage.manifest };
    const trimmed = url.trim();
    if (!trimmed) delete manifest.course;
    else if (/\/embed\//.test(trimmed)) manifest.course = { kind: 'strava-embed', url: trimmed };
    else manifest.course = { kind: 'strava-link', url: trimmed };
    previous.current = manifest;
    setStage({ ...stage, manifest });
  };

  const manifest = stage.name === 'loaded' ? stage.manifest : null;

  // Lifecycle lives in the hook, where it is tested under StrictMode. See
  // tests/media-store-lifecycle.test.tsx for why that matters.
  const store = useMediaStore(files);

  // One resolution pass per manifest, shared by the slider and the report, so
  // every part of the screen agrees about where things sit.
  const placement = useMemo(() => (manifest ? placeItems(manifest) : null), [manifest]);
  const bounds = useMemo(() => (placement ? fullSpan(placement.placed) : null), [placement]);

  /**
   * The track thinned once, for both the map and the charts.
   *
   * A real Strava export is 120,909 points. Simplified once here rather than
   * inside each component, so the expensive pass happens a single time and
   * both views draw exactly the same line. 8 metres is well under what a
   * screen can resolve at any zoom the whole course fits in.
   */
  const course = stage.name === 'loaded' ? stage.course : null;
  const track = useMemo(() => (course ? simplify(course.samples, 8) : []), [course]);

  /**
   * Which views have something to draw right now.
   *
   * The feed and the lanes need placed photos; the course needs a track. A
   * view with neither renders nothing at all, and the app looked broken:
   * a stale `#view=course` in the address bar — left over from a previous
   * session, since the view IS the URL — meant opening a folder of photos
   * with no track gave a blank page under the tabs. The state has to be
   * reconciled against what actually exists, not trusted.
   */
  const available = useMemo<ViewName[]>(() => {
    const names: ViewName[] = [];
    if (placement && placement.placed.length > 0) names.push('feed', 'lanes');
    if (course) names.push('course');
    return names;
  }, [placement, course]);

  useEffect(() => {
    if (available.length === 0) return;
    if (available.includes(view.view)) return;
    // Written in an effect, never during render: the URL is written from
    // state, and an impure updater is exactly what StrictMode double-invokes
    // to catch. This project has paid for that lesson once already.
    setView({ view: available[0] as ViewName });
  }, [available, view.view, setView]);

  /**
   * Where the reader is pointing along the course, in metres.
   *
   * Deliberately NOT in the URL alongside the cursor: a hover is a transient
   * pointer position, not a place in the event worth sharing, and writing it
   * to the address bar on every mouse move would be absurd.
   */
  const [focus, setFocus] = useState<number | null>(null);

  /**
   * The visible range: what the manifest says, or a sensible guess.
   *
   * The guess matters. A folder is rarely just the event — this one spans 46
   * days for a two-day race — so opening on the full span would show mostly
   * empty timeline. Falling back to the densest cluster lands on the race.
   */
  const range: TimeWindow | null = useMemo(() => {
    if (!manifest || !placement || !bounds) return null;
    // A shared link wins over the manifest: whoever sent it meant that crop.
    if (view.range) return clampWindow(view.range, bounds);
    const saved = manifest.event.range;
    if (saved) {
      const from = Date.parse(saved.from);
      const to = Date.parse(saved.to);
      if (!Number.isNaN(from) && !Number.isNaN(to)) return clampWindow({ from, to }, bounds);
    }
    return densestWindow(placement.placed) ?? bounds;
  }, [manifest, placement, bounds]);

  /**
   * The one set every view works from: inside the crop, and belonging to
   * someone whose lane is showing. Computed once here rather than per view,
   * so switching between them cannot show different things.
   */
  const items: readonly PlacedItem[] = useMemo(() => {
    if (!placement || !range) return [];
    return placement.placed.filter(
      (entry) => isWithin(entry.instant, range) && isVisible(view, entry.item.person),
    );
  }, [placement, range, view]);

  // The lightbox belongs to the app, not to a view: you can open a photo from
  // the feed or from the lanes, and stepping through it walks the same list.
  const [openId, setOpenId] = useState<string | null>(null);
  const openIndex = openId === null ? -1 : items.findIndex((e) => e.item.id === openId);

  const setWindow = (next: TimeWindow | null) => {
    // Kept in both places on purpose: the manifest so it survives export, the
    // URL so it survives being sent to someone.
    setView({ range: next });
    if (stage.name !== 'loaded') return;
    const event = { ...stage.manifest.event };
    if (next) {
      event.range = {
        from: new Date(next.from).toISOString(),
        to: new Date(next.to).toISOString(),
      };
    } else {
      // Clearing it means "work it out again", not "show everything".
      delete event.range;
    }
    const updated: Manifest = { ...stage.manifest, event };
    previous.current = updated;
    setStage({ ...stage, manifest: updated });
  };

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">meanwhile</h1>
        <p className="app__tagline">Many people&rsquo;s photos, one shared timeline.</p>
      </header>

      {error && (
        <p className="callout callout--error" role="alert">
          {error}
        </p>
      )}

      {stage.name === 'empty' && (
        <main className="app__empty">
          <p className="app__empty-lead">Nothing loaded yet.</p>
          <p>
            meanwhile is a renderer, not a locker. It stores no photos and no event data. Point it at
            a folder and it reads the files straight off your disk &mdash; nothing is uploaded, even
            though this site is public.
          </p>
          <p className="app__hint">
            Put each person&rsquo;s photos in their own subfolder. The folder name becomes their name
            on the timeline.
          </p>
          {/* There is no separate control for the track, and no way to guess
              that, so the empty state has to say it. */}
          <p className="app__hint">
            Drop a <strong>.gpx</strong> or <strong>.tcx</strong> in with the photos and the course
            map and elevation profile appear too. There is no separate step for it.
          </p>
          <div className="app__actions">
            <FolderPicker onPicked={(f) => void handlePicked(f)} onError={setError} />
            <FilePicker onPicked={(f) => void handlePicked(f)} onError={setError} />
          </div>
        </main>
      )}

      {stage.name === 'reading' && (
        <main className="app__reading">
          <p className="app__empty-lead">
            Reading {stage.progress.total.toLocaleString()} files&hellip;
          </p>
          <progress
            className="progress"
            value={stage.progress.done}
            max={stage.progress.total}
            aria-label="Reading files"
          />
          <p className="app__progress-detail mw-mono">
            {stage.progress.done.toLocaleString()} / {stage.progress.total.toLocaleString()}
            {stage.progress.current && ` · ${stage.progress.current}`}
          </p>
          <p className="app__hint">
            Only metadata is read &mdash; a few kilobytes per file, not the whole photo.
          </p>
        </main>
      )}

      {stage.name === 'loaded' && (
        <main className="app__loaded">
          <div className="event-fields">
            <label className="field">
              <span className="field__label">Event</span>
              <input
                className="field__input"
                value={stage.manifest.event.title}
                onChange={(e) => updateEvent({ title: e.target.value })}
              />
            </label>
            <TimezoneField
              value={stage.manifest.event.timezone ?? ''}
              onChange={(next) => updateEvent({ timezone: next })}
            />
            <label className="field">
              <span className="field__label">Strava activity (optional)</span>
              <input
                className="field__input mw-mono"
                value={courseUrlOf(stage.manifest)}
                placeholder="https://www.strava.com/activities/…"
                onChange={(e) => updateCourse(e.target.value)}
              />
            </label>
          </div>
          <p className="app__hint">
            A Strava link renders as a link and nothing more &mdash; it carries no
            time-and-distance data, so there is no elevation profile, no map, and no automatic
            clock alignment. Those need a <strong>GPX export</strong> from the activity
            (the &hellip; menu &rarr; Export GPX), which works the same from Garmin or COROS.
          </p>

          {placement && bounds && range && placement.placed.length > 0 && (
            <TimeWindowSlider
              placed={placement.placed}
              bounds={bounds}
              range={range}
              onChange={setWindow}
              onReset={() => setWindow(null)}
              {...(stage.manifest.event.timezone ? { timezone: stage.manifest.event.timezone } : {})}
            />
          )}

          {/* The course stands on its own: a GPX with no photos yet is a
              perfectly good thing to look at, and gating the tabs on a time
              range — which only photos produce — hid it completely. */}
          {available.length > 0 && (
            <nav className="views" aria-label="View">
              {VIEW_NAMES.filter((name) => available.includes(name)).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={view.view === name ? 'view-tab view-tab--on' : 'view-tab'}
                  aria-pressed={view.view === name}
                  onClick={() => setView({ view: name })}
                >
                  {name === 'feed' ? 'Feed' : name === 'lanes' ? 'Swimlanes' : 'Course'}
                </button>
              ))}
            </nav>
          )}

          {/* Outside the media gate on purpose: the map and profile need no
              photos and no time range, only the track. */}
          {view.view === 'course' && stage.course && (
            <>
              <CourseMap
                manifest={stage.manifest}
                course={stage.course}
                track={track}
                items={items}
                at={view.cursor}
                focus={focus}
                onFocus={setFocus}
                onCursor={(cursor) => setView({ cursor })}
              />
              <CourseCharts
                course={stage.course}
                track={track}
                {...(range ? { range } : {})}
                at={view.cursor}
                focus={focus}
                onFocus={setFocus}
                onCursor={(cursor) => setView({ cursor })}
                {...(stage.manifest.event.timezone
                  ? { timezone: stage.manifest.event.timezone }
                  : {})}
              />
            </>
          )}

          {placement && range && store && (
            <MediaProvider store={store}>
              {view.view === 'lanes' && (
                <Swimlanes
                  manifest={stage.manifest}
                  placed={placement.placed}
                  range={range}
                  state={view}
                  onCursor={(cursor) => setView({ cursor })}
                  onTogglePerson={(person: PersonId) =>
                    setView({
                      visible: toggleVisible(view, person, stage.manifest.people.map((p) => p.id)),
                    })
                  }
                  onOpen={(entry) => setOpenId(entry.item.id)}
                />
              )}

              {view.view === 'feed' && (
                <Feed
                  manifest={stage.manifest}
                  items={items}
                  onOpen={(entry) => setOpenId(entry.item.id)}
                />
              )}

              {openIndex >= 0 && (
                <Lightbox
                  items={items}
                  index={openIndex}
                  onIndex={(next) => setOpenId(items[next]?.item.id ?? null)}
                  onClose={() => setOpenId(null)}
                  colors={assignLaneColors(stage.manifest.people)}
                  names={new Map(stage.manifest.people.map((p) => [p.id, p.name]))}
                  {...(stage.manifest.event.timezone
                    ? { timezone: stage.manifest.event.timezone }
                    : {})}
                />
              )}
              <UnplacedTray manifest={stage.manifest} unplaced={placement.unplaced} />
            </MediaProvider>
          )}

          <IngestReport
            manifest={stage.manifest}
            grouping={stage.grouping}
            {...(range ? { range } : {})}
            onExport={() => downloadManifest(stage.manifest)}
          >
            <FolderPicker
              variant="quiet"
              label="Open a different folder"
              onPicked={(f) => void handlePicked(f, 'replace')}
              onError={setError}
            />
            <FilePicker
              onPicked={(f) => void handlePicked(f, 'add')}
              onError={setError}
              label="Add more files"
            />
          </IngestReport>
        </main>
      )}
    </div>
  );
}
