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
 * request meanwhile makes: once a TRACK is in the folder, map tiles fetch on
 * their own — OpenTopoMap, Esri and OSM, plus Thunderforest only when a build
 * key is configured (`basemaps()` filters it out otherwise; see
 * src/viewer/map/basemaps.ts) — and on Feed and Swimlanes too, because the
 * course rail mounts a second CourseMap there. At most two of those hosts are
 * fetched at a time, the chosen basemap plus the optional Esri hillshade, and
 * CourseMap's layer effect removes the previous layers when either changes.
 *
 * NONE OF THAT REACHES THIS PANEL, which is why the text below must not claim
 * it does. App.tsx renders this only when there is no course to draw
 * (`view.view === 'course' && !stage.course`), and both CourseMap mount sites
 * require `stage.course` — so a Strava link draws no map anywhere and fetches
 * no tile at all, leaving this iframe as the page's only external request
 * besides the deployed build's analytics tag.
 *
 * What click-to-load buys is the same either way: whoever pastes the URL
 * consents to that click; whoever they later send the manifest to did not,
 * and loading it on their behalf would hand their IP address to Strava before
 * they had decided to look. One click is a small price for that staying true.
 *
 * THE ANALYTICS TAG IS NOT AN ASIDE, and the copy below must never say
 * "nothing else on this page reaches another server". That sentence has now
 * been wrong three times running: it is false on the DEPLOYED build, which is
 * the only place a manifest someone sent you is ever read, because
 * `googleAnalytics()` in vite.config.ts is `apply: 'build'` and injects a
 * googletagmanager.com script into dist/index.html. `make dev` injects none.
 * `tests/course-fallback.test.tsx` holds the substance of that so the fourth
 * flip cannot happen quietly.
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
          ? 'Strava’s widget is a sealed box — it cannot follow the cursor here, and it is the one thing on this page that waits for your click. With no track there is no map, so no tiles load at all; the published site’s analytics tag is the only other request this page makes on its own, and running it locally with make dev makes none.'
          : 'A plain activity URL cannot be embedded: the embed needs a code that only Strava’s share dialog produces.'}{' '}
        To light up the course view, ask the athlete for <strong>Export TCX</strong>
        {' '}(heart rate and cadence) or <strong>Export GPX</strong>, and drop the file
        in with the photos.
      </p>
    </section>
  );
}
