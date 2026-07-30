// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CourseRef } from '../src/core/schema.ts';
import { CourseFallback } from '../src/viewer/components/CourseFallback.tsx';

/**
 * The panel shown when the course is a Strava URL rather than a track.
 *
 * **Why a test asserts things about prose.** The privacy sentence in this
 * component has been wrong three times running, each time in a different
 * direction, and nothing was holding it: `grep -rn 'CourseFallback' tests/`
 * was empty until this file.
 *
 * 1. It claimed "the map tiles on this page load from other servers
 *    automatically" — but this panel only renders when there is NO track, and
 *    every map in the app needs one, so no tile is fetched here at all.
 * 2. The correction over-swung to "nothing on this page reaches another
 *    server except the Strava iframe", which is false on the deployed build.
 * 3. The next pass appended the analytics tag to a sentence that still opened
 *    with the absolute, so the copy contradicted itself inside one paragraph.
 *
 * So the assertions below are about SUBSTANCE, not phrasing: that the copy
 * accounts for the analytics tag the deployed build really does load
 * (`googleAnalytics()` in vite.config.ts, `apply: 'build'`), and that it does
 * not assert an unqualified "nothing else reaches another server". Ordinary
 * rewording passes; reintroducing the false claim does not.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const EMBED: CourseRef = {
  kind: 'strava-embed',
  url: 'https://www.strava.com/activities/123/embed/abc',
};
const LINK: CourseRef = { kind: 'strava-link', url: 'https://www.strava.com/activities/123' };
const GPX: CourseRef = { kind: 'gpx', src: 'course.gpx' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(course: CourseRef) {
  act(() => {
    root.render(
      <StrictMode>
        <CourseFallback course={course} />
      </StrictMode>,
    );
  });
}

/** The hint paragraph, which is where every one of the three flips happened. */
function hint(): string {
  const el = container.querySelector('.app__hint');
  if (!el) throw new Error('hint paragraph not found');
  return el.textContent ?? '';
}

describe('CourseFallback', () => {
  it('renders nothing at all for a real track', () => {
    // A GPX has a map, a profile and a position at every instant. This panel
    // exists only to explain their absence, so drawing it beside them would
    // contradict the page it sits on.
    mount(GPX);
    expect(container.innerHTML).toBe('');
  });

  it('renders for both Strava kinds, and links out in each', () => {
    for (const course of [EMBED, LINK]) {
      mount(course);
      const link = container.querySelector('.fallback__link');
      expect(link?.getAttribute('href')).toBe(course.url);
      // An external tab must not be handed a live `window.opener`.
      expect(link?.getAttribute('rel')).toContain('noopener');
    }
  });

  it('loads no iframe until the click, then loads exactly the pasted URL', () => {
    mount(EMBED);
    // The whole privacy claim rests on this: whoever is sent the manifest did
    // not consent to Strava seeing their IP, so nothing may be fetched from
    // strava.com before they ask for it.
    expect(container.querySelector('iframe')).toBeNull();

    const button = container.querySelector('button.button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('load button not found');
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(EMBED.url);
    // One control per action: the button is gone once it has done its job.
    expect(container.querySelector('button.button')).toBeNull();
  });

  it('offers no embed for a plain activity URL, and says why', () => {
    mount(LINK);
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('button.button')).toBeNull();
    expect(hint()).toMatch(/cannot be embedded/i);
  });

  it('does not claim the page reaches nobody, and names the analytics tag', () => {
    mount(EMBED);
    const text = hint();

    // (1) The tiles half is the part that is TRUE, and the reason this panel
    //     may say anything reassuring at all: no track here means no map.
    expect(text).toMatch(/tiles?/i);

    // (2) The deployed build injects a googletagmanager.com script, so any
    //     account of what this page fetches has to include it. Naming it is
    //     the substance; how it is worded is not.
    expect(text).toMatch(/analytics/i);

    // (3) And the false absolute must not come back in any of its shapes.
    //     Deliberately loose: it matches the CLASS of claim — "nothing /
    //     no other … reaches / contacts / touches … server" — rather than one
    //     sentence, because all three previous versions were worded
    //     differently and all three were the same mistake.
    expect(text).not.toMatch(
      /\b(nothing|no other|nothing else)\b[^.;]{0,60}\b(reach|reaches|contact|contacts|touch|touches)\b/i,
    );
  });
});
