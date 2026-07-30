import { useState } from 'react';
import type { CourseRef } from '../../core/schema.ts';

/**
 * What a Strava reference can show when there is no GPX.
 *
 * The design's `course` union has three rungs, and only the top one is a
 * spine:
 *
 * - `gpx` — a real track. Position-at-time, elevation, the map, everything.
 * - `strava-embed` — Strava's own widget. A sealed iframe: it cannot follow
 *   our cursor, and it yields no position at any time.
 * - `strava-link` — a hyperlink and nothing else.
 *
 * This renders the bottom two, and **says plainly what is missing**, because
 * the failure otherwise looks like a bug in this app rather than a limit of
 * what a URL can carry. An activity URL is not embeddable on its own: the
 * embed needs a `{CODE}` that only Strava's share dialog produces, and it
 * cannot be derived.
 *
 * THE IFRAME IS CLICK-TO-LOAD. That does NOT make it the only external
 * request meanwhile makes — the course view's map tiles (OpenTopoMap, Esri,
 * OSM, and optionally Thunderforest; see src/viewer/map/basemaps.ts) fetch
 * from four external hosts unconditionally, on every render. What click-to-
 * load buys is narrower: this iframe is the only one of those requests that
 * waits for a person to ask for it. Whoever pastes the URL consents to that
 * click; whoever they later send the manifest to did not, and loading it on
 * their behalf would hand their IP address to Strava before they had decided
 * to look. One click is a small price for that staying true.
 */

interface Props {
  course: CourseRef;
}

export function CourseFallback({ course }: Props) {
  const [loadEmbed, setLoadEmbed] = useState(false);
  if (!course || course.kind === 'gpx') return null;

  return (
    <section className="fallback" aria-label="Course">
      <p className="callout">
        This is a <strong>Strava link</strong>, not a track. It cannot say where
        the runner was at 2am, so there is no map, no elevation profile, and no
        heart rate or cadence &mdash; those need the file itself. (Camera clock
        differences are corrected by hand, in <code>people.csv</code>, whether
        or not there&rsquo;s a track.)
      </p>

      <p>
        <a className="fallback__link" href={course.url} target="_blank" rel="noreferrer noopener">
          Open the activity on Strava
        </a>
      </p>

      {course.kind === 'strava-embed' &&
        (loadEmbed ? (
          <iframe
            className="fallback__embed"
            src={course.url}
            title="Strava activity"
            loading="lazy"
            frameBorder="0"
            scrolling="no"
          />
        ) : (
          <button type="button" className="button" onClick={() => setLoadEmbed(true)}>
            Load Strava&rsquo;s embedded map
          </button>
        ))}

      <p className="app__hint">
        {course.kind === 'strava-embed'
          ? 'Strava’s widget is a sealed box — it cannot follow the cursor here. The map tiles on this page load from other servers automatically; this is the only thing that waits for you to click first.'
          : 'A plain activity URL cannot be embedded: the embed needs a code that only Strava’s share dialog produces.'}{' '}
        To light up the course view, ask the athlete for <strong>Export TCX</strong>
        {' '}(heart rate and cadence) or <strong>Export GPX</strong>, and drop the file
        in with the photos.
      </p>
    </section>
  );
}
