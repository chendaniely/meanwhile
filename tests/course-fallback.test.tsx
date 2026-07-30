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
    expect(unqualifiedDenials(text)).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // The guard above, aimed at its own weak spot.
  //
  // The first version of (3) was a regex needing one of three NOUNS
  // (nothing / no other / nothing else) near one of three VERBS (reach /
  // contact / touch). Aiming at six words is aiming at a wording, and the
  // 2026-07-30 gate walked straight past it with a differently-worded
  // falsehood — "no analytics or anything else is ever sent anywhere from
  // this page" — which passed all five tests in this file.
  //
  // `unqualifiedDenials` aims at the substance instead, and the cases below
  // are the proof it does: each falsehood must be caught, and the copy the
  // component actually ships must not be.
  // -----------------------------------------------------------------------
  describe('the denial guard itself', () => {
    it('catches every shape of the false claim, including ones no regex was written for', () => {
      for (const falsehood of [
        // The exact substitution that defeated the previous guard.
        'Strava’s widget is a sealed box. With no track there is no map, so no tiles load at all, and no analytics or anything else is ever sent anywhere from this page.',
        // Pass 3's version, which the previous guard did catch.
        'With no track there is no map, so no tiles load; nothing else on this page reaches another server except the Strava iframe.',
        // Pass 1's direction, inverted into an absolute.
        'No tiles here. This page never contacts any server unless you click.',
        // A verb the old list did not have, and no "nothing" at all.
        'No tiles are fetched, and no data leaves your machine from this page.',
        // The claim made about the reader rather than the page.
        'You are not tracked here, and nobody is told you opened this.',
      ]) {
        expect(unqualifiedDenials(falsehood), falsehood).not.toEqual([]);
      }
    });

    it('lets the shipped copy through, and ordinary rewordings of it', () => {
      mount(EMBED);
      for (const honest of [
        hint(),
        // Reworded, same substance.
        'There is no track, so no map tiles are fetched here at all. The published site’s analytics tag is the only request this page makes by itself; make dev adds none.',
        // A total, but scoped to tiles inside the same clause.
        'Nothing is fetched from any map or tile server while there is no track.',
        'No map tile is loaded from anywhere on this page.',
        // Scoped to the local build, in the clause that makes the denial.
        'Locally, make dev loads no analytics at all.',
      ]) {
        expect(unqualifiedDenials(honest), honest).toEqual([]);
      }
    });
  });
});

/**
 * Clauses that DENY this page contacts anything, without saying what the
 * denial is limited to.
 *
 * The property being guarded, stated once: **the copy must not deny that the
 * published page contacts anything, because it contacts googletagmanager.**
 * What separates the true sentences from the false ones is not which verb
 * they use — it is SCOPE. Every true negative here names its subject ("no
 * *tiles*", "run it *locally* with *make dev*"); every false one has been an
 * unscoped claim about the page as a whole.
 *
 * So: split into clauses, find the ones that negate outbound contact, and
 * keep any that does not name one of the two things this panel may honestly
 * say nothing is fetched for. A rewording that keeps the scope keeps
 * passing; a rewording that drops it fails whatever words it uses.
 *
 * **`and` splits a clause**, which is the one rule a writer has to know: the
 * scope must sit in the same clause as the denial it limits. "no tiles load
 * and nothing else is ever sent anywhere" reads as scoped and is not — the
 * second half is a fresh claim about the whole page, and that is precisely
 * the move each of the three wrong versions made. Write "nothing is fetched
 * from any tile server" instead, and it passes.
 */
function unqualifiedDenials(text: string): string[] {
  // Outbound contact, by any name anyone has reached for. Substrings, so
  // "reaches"/"contacted"/"requests"/"loading" come along for free.
  // `tracked`/`tracking` and not a bare `track`: this panel's whole subject
  // is a GPX *track*, so the bare word is the commonest honest noun on the
  // page and matching it flags "there is no track" as a privacy claim.
  const CONTACT =
    /\b(reach|contact|touch|talk|sent|send|fetch|request|load|transmit|upload|phone|call|tracked|tracking|leave|leaves|told|tell)/i;
  // A denial. `no`/`not`/`never`/`none`/`nothing`/`nobody`/`cannot`, plus the
  // "n't" contractions and the totalising "anything/anywhere" that only ever
  // appears here under a negation.
  const DENIAL = /\b(no|not|never|none|nothing|nobody|n['’]t|cannot|without|anywhere|anything)\b/i;
  // The two scopes this panel may honestly deny anything for: map tiles
  // (there is no track, so no map, so no tile) and the local dev build
  // (which really does inject no analytics).
  const SCOPED = /\b(tile|tiles|basemap|map|local|locally|localhost|dev)\b/i;

  return text
    .split(/[.;:]|\s—\s|\band\b|,\s*/i)
    .map((clause) => clause.trim())
    .filter(
      (clause) => clause !== '' && DENIAL.test(clause) && CONTACT.test(clause) && !SCOPED.test(clause),
    );
}
