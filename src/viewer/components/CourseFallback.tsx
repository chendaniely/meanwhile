import { useState } from 'react';
import { embeddableHosts, embeddableSrc, hostOf, safeHref } from '../../core/course-url.ts';
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
 *
 * THE URL IS CHECKED HERE, AND THIS IS WHERE THE REFUSAL LIVES.
 * `validateManifest` only WARNS about a bad `course.url` — it must, or a
 * scheme-less paste in `manifest.json` would refuse the whole file and take
 * the crop, the markers and every hand-placed photograph with it. So this
 * component is not a second opinion, it is the one that declines to render.
 * `updateCourse` in App.tsx also builds a `CourseRef` straight from the
 * event-settings box, which never goes near the validator at all.
 *
 * `safeHref`, `embeddableSrc` and `hostOf` (`core/course-url.ts`) are the
 * single copy of the rule; the VALUES they return are what the attributes
 * get, so the guard cannot be refactored away from the attribute the way a
 * surrounding `if` can. `tests/course-url-guard.test.tsx` pins the behaviour
 * and that shape.
 *
 * **On React and `javascript:` — do not re-add the claim that was here.** An
 * earlier version of this comment said React renders a `javascript:` href
 * anyway. It does not: React 19.2.8 runs `sanitizeURL` over `href` and
 * `iframe src` in both bundles, verified by execution on 2026-07-30. What it
 * does NOT stop, and what this guard is actually for, is `data:text/html` in
 * the frame, an arbitrary https host in the frame, and `http:` anywhere.
 */

interface Props {
  course: CourseRef;
}

export function CourseFallback({ course }: Props) {
  const [loadEmbed, setLoadEmbed] = useState(false);
  if (!course || course.kind === 'gpx') return null;

  // Null means "this build will not act on it". All three are computed from
  // the one rule in core/course-url.ts, and the first two are the VALUE the
  // attribute gets — see the note at the top of this file.
  const href = safeHref(course.url);
  const embedSrc = course.kind === 'strava-embed' ? embeddableSrc(course.url) : null;
  /*
   * The host, shown in the link's own text.
   *
   * `safeHref` permits ANY https host on purpose — meanwhile does not claim to
   * know which sites are safe to visit, and a Garmin or COROS activity is a
   * reasonable thing to link to. But the text used to read "Open the activity
   * on Strava" whatever the URL was, so an emailed manifest could render a
   * link labelled Strava pointing at `https://evil.test/login` — with
   * `target="_blank"`, so the address bar never changed to give it away. The
   * visible text must name the destination the guard actually permitted, not
   * the one the field is usually used for.
   */
  const host = hostOf(course.url);

  return (
    <section className="fallback" aria-label="Course">
      <p className="callout">
        This is a <strong>course link</strong>, not a track. It cannot say where
        the runner was at 2am, so there is no map, no elevation profile, and no
        heart rate or cadence &mdash; those need the file itself. (Camera clock
        differences are corrected by hand, in <code>people.csv</code>, whether
        or not there&rsquo;s a track.)
      </p>

      {href !== null ? (
        <p>
          <a className="fallback__link" href={href} target="_blank" rel="noreferrer noopener">
            Open the activity on {host}
          </a>
        </p>
      ) : (
        <p className="fallback__refused">
          <strong>This course link was not shown.</strong> It is not a plain{' '}
          <code>https://</code> address, and meanwhile only makes a link out of
          one &mdash; a manifest is a file people send each other, and a{' '}
          <code>data:</code> or <code>http:</code> address in it is not
          something to hand a reader unasked. The address is kept exactly as
          written. Correct it in the event settings above, or in{' '}
          <code>course.url</code> if you are editing <code>manifest.json</code>{' '}
          by hand.
        </p>
      )}

      {course.kind === 'strava-embed' && href !== null && embedSrc === null && (
        <p className="fallback__refused">
          <strong>The embedded map was not loaded.</strong> An embed is put
          inside this page rather than opened in a tab, so only{' '}
          {embeddableHosts().join(' and ')} are framed there, and this one is on{' '}
          {host}. The link above still works.
        </p>
      )}

      {embedSrc !== null &&
        (loadEmbed ? (
          <iframe
            className="fallback__embed"
            src={embedSrc}
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
        {/*
          * Each refusal explains ITSELF, and nothing else.
          *
          * This ternary keyed off `embedSrc` for one commit, which meant an
          * embed refused for its HOST also printed "a plain activity URL
          * cannot be embedded: the embed needs a code that only Strava's
          * share dialog produces" — false, since that URL carries `/embed/`
          * and was refused for where it points. The page contradicted itself
          * in two adjacent paragraphs. A refusal already has its own
          * `.fallback__refused` sentence above, so the third branch adds
          * nothing rather than borrowing somebody else's reason.
          */}
        {embedSrc !== null
          ? 'Strava’s widget is a sealed box — it cannot follow the cursor here, and it is the one thing on this page that waits for your click. With no track there is no map, so no tiles load at all; the published site’s analytics tag is the only other request this page makes on its own, and running it locally with make dev makes none.'
          : href !== null && course.kind === 'strava-link'
            ? 'A plain activity URL cannot be embedded: the embed needs a code that only Strava’s share dialog produces.'
            : ''}{' '}
        To light up the course view, ask the athlete for <strong>Export TCX</strong>
        {' '}(heart rate and cadence) or <strong>Export GPX</strong>, and drop the file
        in with the photos.
      </p>
    </section>
  );
}
