import { useCallback, useRef, useState } from 'react';
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

type Stage =
  | { name: 'empty' }
  | { name: 'reading'; progress: IngestProgress }
  | { name: 'loaded'; manifest: Manifest };

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
        const manifest = await ingestFolder(files, {
          title,
          timezone,
          ...(previous.current
            ? { existingPeople: previous.current.people, existingItems: previous.current.items }
            : {}),
          onProgress: (progress) => setStage({ name: 'reading', progress }),
        });
        previous.current = manifest;
        setStage({ name: 'loaded', manifest });
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
    setStage({ name: 'loaded', manifest });
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
          </div>

          <IngestReport
            manifest={stage.manifest}
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
