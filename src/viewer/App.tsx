import { useCallback, useRef, useState } from 'react';
import type { GroupingInfo } from '../core/assemble.ts';
import type { Manifest } from '../core/schema.ts';
import { FilePicker, FolderPicker } from './components/FolderPicker.tsx';
import { IngestReport } from './components/IngestReport.tsx';
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
  | { name: 'loaded'; manifest: Manifest; grouping: GroupingInfo };

export function App() {
  const [stage, setStage] = useState<Stage>({ name: 'empty' });
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled event');
  const [timezone, setTimezone] = useState(guessTimezone);

  // Kept so re-reading the folder preserves names, clock offsets, captions,
  // and hand-placed times rather than starting over.
  const previous = useRef<Manifest | null>(null);

  const handlePicked = useCallback(
    async (files: PickedFile[]) => {
      setError(null);
      setStage({ name: 'reading', progress: { done: 0, total: files.length, current: '' } });
      try {
        const { manifest, grouping } = await ingestFolder(files, {
          title,
          timezone,
          ...(previous.current
            ? { existingPeople: previous.current.people, existingItems: previous.current.items }
            : {}),
          onProgress: (progress) => setStage({ name: 'reading', progress }),
        });
        previous.current = manifest;
        setStage({ name: 'loaded', manifest, grouping });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong reading that folder.');
        setStage({ name: 'empty' });
      }
    },
    [title, timezone],
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
    setStage({ name: 'loaded', manifest, grouping: stage.grouping });
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
    setStage({ name: 'loaded', manifest, grouping: stage.grouping });
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
            <label className="field">
              <span className="field__label">Timezone</span>
              <input
                className="field__input mw-mono"
                value={stage.manifest.event.timezone ?? ''}
                placeholder="America/Los_Angeles"
                onChange={(e) => updateEvent({ timezone: e.target.value })}
              />
            </label>
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
            (&ctdot; &rarr; Export GPX), which works the same from Garmin or COROS.
          </p>

          <IngestReport
            manifest={stage.manifest}
            grouping={stage.grouping}
            onExport={() => downloadManifest(stage.manifest)}
          >
            <FolderPicker
              variant="quiet"
              label="Open a different folder"
              onPicked={(f) => void handlePicked(f)}
              onError={setError}
            />
            <FilePicker onPicked={(f) => void handlePicked(f)} onError={setError} />
          </IngestReport>
        </main>
      )}
    </div>
  );
}
