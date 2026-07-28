import './App.css';

/**
 * Shell only. Folder ingest lands in M3, views in M6-M8.
 *
 * The empty state is real, not a placeholder: meanwhile ships no event data,
 * so "nothing loaded" is the state every visitor starts in and it has to
 * explain itself.
 */
export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">meanwhile</h1>
        <p className="app__tagline">
          Many people&rsquo;s photos, one shared timeline.
        </p>
      </header>

      <main className="app__empty">
        <p className="app__empty-lead">Nothing loaded yet.</p>
        <p>
          meanwhile is a renderer, not a locker. It stores no photos and no
          event data. Point it at a folder on your machine and it reads the
          files straight off your disk &mdash; nothing is uploaded, even though
          this site is public.
        </p>
        <p className="app__empty-note">
          Folder loading arrives in the next milestone.
        </p>
      </main>
    </div>
  );
}
