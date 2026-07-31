// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddableSrc, hostOf, safeHref } from '../src/core/course-url.ts';
import { validateManifest } from '../src/core/schema.ts';
import type { CourseRef } from '../src/core/schema.ts';
import { CourseFallback } from '../src/viewer/components/CourseFallback.tsx';

/**
 * `course.url` was an unvalidated URL sink.
 *
 * `validateManifest` checked it was a non-empty string and nothing more, and
 * `CourseFallback` put it straight into `<a href>` and, for an embed, an
 * `<iframe src>` with no host allowlist. So a `manifest.json` — the file this
 * project's whole collaboration model consists of emailing to people —
 * carrying `{"course":{"kind":"strava-link","url":"javascript:…"}}` loaded
 * cleanly and executed same-origin script on click. React does not block a
 * `javascript:` href; it logs a development warning and renders it anyway.
 *
 * Same page, same consequence as the Leaflet tooltip XSS
 * (`map-tooltip-xss.test.ts`): File System Access handles to the owner's
 * entire photo folder, on an origin shared with everything else they publish
 * to GitHub Pages.
 *
 * Three layers are pinned below, and none of them substitutes for another:
 *
 *   1. the rule itself, in `core/course-url.ts`;
 *   2. the DOM the component really renders — a test of the helper alone
 *      would pass while `CourseFallback` regressed;
 *   3. the SOURCE of the component, because a guard that lives in a
 *      surrounding `if` can be moved, inverted or dropped without either of
 *      the first two noticing which value ends up in the attribute. This is
 *      the same reasoning, and the same technique, as
 *      `map-tooltip-xss.test.ts`'s "pins the CALL SITE" case.
 */

(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

/** Real Strava URLs, which must keep working. */
const GOOD_LINK = 'https://www.strava.com/activities/123';
const GOOD_EMBED = 'https://www.strava.com/activities/123/embed/abc';

/** Everything that must not reach an attribute, and why each one is here. */
const REFUSED: Array<[label: string, url: string]> = [
  ['javascript:', 'javascript:globalThis.__PWNED=true'],
  // A scheme is case-insensitive to a browser and so must be to the check.
  ['JaVaScRiPt: mixed case', 'JaVaScRiPt:globalThis.__PWNED=true'],
  // Browsers strip TAB/CR/LF from a URL before resolving it, so a regex
  // reading the raw string sees a scheme the browser never will.
  ['javascript: split by a TAB', 'java\tscript:globalThis.__PWNED=true'],
  ['a leading space', ' javascript:globalThis.__PWNED=true'],
  ['a leading newline', '\njavascript:globalThis.__PWNED=true'],
  ['data:', 'data:text/html,<script>globalThis.__PWNED=true</script>'],
  ['vbscript:', 'vbscript:msgbox(1)'],
  // Not an injection, but a private timeline read over the wire in clear.
  ['http:', 'http://www.strava.com/activities/123'],
  // A protocol-relative URL inherits whatever scheme the page has; on a
  // file:// or http:// origin that is not https.
  ['protocol-relative', '//www.strava.com/activities/123'],
  ['a bare host', 'www.strava.com/activities/123'],
  ['empty', ''],
];

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

/** Every URL-bearing attribute anywhere in the rendered tree. */
function renderedUrls(): string[] {
  const out: string[] = [];
  for (const el of container.querySelectorAll('a, iframe, link, script, img, form')) {
    for (const attr of ['href', 'src', 'action']) {
      const value = el.getAttribute(attr);
      if (value !== null) out.push(value);
    }
  }
  return out;
}

describe('course-url: the rule', () => {
  it('reads the host of a real https URL, port and case folded away', () => {
    expect(hostOf(GOOD_LINK)).toBe('www.strava.com');
    expect(hostOf('HTTPS://WWW.Strava.COM/activities/1')).toBe('www.strava.com');
    expect(hostOf('https://strava.com:443/activities/1')).toBe('strava.com');
    // Terminated by ?, # or end-of-string as well as by /.
    expect(hostOf('https://strava.com')).toBe('strava.com');
    expect(hostOf('https://strava.com?a=1')).toBe('strava.com');
    expect(hostOf('https://strava.com#x')).toBe('strava.com');
  });

  it.each(REFUSED)('refuses %s', (_label, url) => {
    expect(hostOf(url)).toBeNull();
    expect(safeHref(url)).toBeNull();
    expect(embeddableSrc(url)).toBeNull();
  });

  it('reads userinfo as what it is, and refuses it', () => {
    // `https://www.strava.com@evil.test/` has a HOST of evil.test — the part
    // that reads like Strava is a username. Refused outright rather than
    // parsed, because a check that gets this wrong is worse than none.
    for (const url of [
      'https://www.strava.com@evil.test/activities/1',
      'https://strava.com:x@evil.test/',
      'https://user@www.strava.com/activities/1',
    ]) {
      expect(hostOf(url), url).toBeNull();
    }
  });

  it('refuses a control character ANYWHERE, not only in the host', () => {
    // Defence in depth, and worth being honest about which: the authority
    // charset already refuses a TAB inside the host, so this rule earns its
    // place on the rest of the string. Browsers delete TAB, CR and LF from a
    // URL before resolving it, so while any are present the string this file
    // reads is not the string the browser will dial — and a check whose
    // input is not what gets used is not a check. Refused rather than
    // stripped: stripping would mean deciding what the author meant.
    for (const url of [
      'https://www.strava.com/activities/1\t',
      'https://www.strava.com/activities/\r\n1',
      'https://www.strava.com/activities/1 2',
      'https://www.strava.com/activities\\1',
    ]) {
      expect(hostOf(url), JSON.stringify(url)).toBeNull();
    }
  });

  it('does not mistake a lookalike host for strava.com', () => {
    for (const url of [
      'https://notstrava.com/activities/1',
      'https://strava.com.evil.test/activities/1',
      'https://evil.test/https://www.strava.com/activities/1',
      'https://evil.test/#https://www.strava.com',
    ]) {
      // Linkable — it is a plain https address, and meanwhile does not
      // pretend to know which sites are trustworthy to visit.
      expect(safeHref(url), url).toBe(url);
      // But never framed.
      expect(embeddableSrc(url), url).toBeNull();
    }
  });

  it('embeds strava.com and www.strava.com, and nothing else', () => {
    expect(embeddableSrc(GOOD_EMBED)).toBe(GOOD_EMBED);
    expect(embeddableSrc('https://strava.com/activities/1/embed/x')).toBe(
      'https://strava.com/activities/1/embed/x',
    );
  });

  it('answers the same on a second call, so no regex carries lastIndex', () => {
    // A `/g` regex reused with `.test` alternates true and false on one
    // input. Neither regex in course-url.ts has the flag; this fails if one
    // ever gains it.
    for (let i = 0; i < 3; i++) {
      expect(hostOf(GOOD_EMBED)).toBe('www.strava.com');
      expect(hostOf('javascript:1')).toBeNull();
    }
  });
});

describe('course-url: validateManifest', () => {
  const withCourse = (course: unknown) => ({
    schema: 1,
    event: { title: 'race' },
    people: [{ id: 'p', name: 'P' }],
    items: [],
    course,
  });

  it('refuses a javascript: course URL, naming the field', () => {
    const r = validateManifest(withCourse({ kind: 'strava-link', url: 'javascript:alert(1)' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/course\.url/);
    expect(r.errors.join(' ')).toMatch(/https/);
  });

  it('refuses an embed pointed at a host that is not Strava', () => {
    const r = validateManifest(
      withCourse({ kind: 'strava-embed', url: 'https://evil.test/activities/1/embed/x' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/evil\.test/);
    expect(r.errors.join(' ')).toMatch(/strava\.com/);
  });

  it('accepts a non-Strava https LINK, which is a link and not a frame', () => {
    const r = validateManifest(
      withCourse({ kind: 'strava-link', url: 'https://connect.garmin.com/activity/1' }),
    );
    expect(r.ok).toBe(true);
  });

  it('still accepts the real thing', () => {
    expect(validateManifest(withCourse({ kind: 'strava-link', url: GOOD_LINK })).ok).toBe(true);
    expect(validateManifest(withCourse({ kind: 'strava-embed', url: GOOD_EMBED })).ok).toBe(true);
  });
});

describe('course-url: what CourseFallback actually renders', () => {
  it.each(REFUSED.filter(([, url]) => url !== ''))(
    'puts %s in no href and no src',
    (_label, url) => {
      for (const kind of ['strava-link', 'strava-embed'] as const) {
        mount({ kind, url });
        // The assertion that matters: nothing anywhere in the tree carries
        // it. Checking `.fallback__link` alone would miss it moving.
        expect(renderedUrls()).toEqual([]);
        expect(container.querySelector('.fallback__link')).toBeNull();
        expect(container.querySelector('iframe')).toBeNull();
        // A missing control has to say it is missing. Silence reads as a bug
        // in meanwhile rather than a refusal of somebody's file.
        expect(container.querySelector('.fallback__refused')?.textContent ?? '').toMatch(
          /not shown|not loaded/i,
        );
      }
    },
  );

  it('refuses to FRAME a non-Strava https URL while still linking to it', () => {
    const url = 'https://evil.test/activities/1/embed/x';
    mount({ kind: 'strava-embed', url });

    // The link is fine — it is https, and clicking it leaves this page.
    expect(container.querySelector('.fallback__link')?.getAttribute('href')).toBe(url);
    // The frame is not: an embed loads INTO the page holding the folder
    // handles. There must be no iframe and no way to ask for one.
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('button.button')).toBeNull();
    expect(container.querySelector('.fallback__refused')?.textContent ?? '').toMatch(
      /strava\.com/i,
    );
  });

  it('still renders a legitimate Strava link and embed', () => {
    mount({ kind: 'strava-link', url: GOOD_LINK });
    expect(container.querySelector('.fallback__link')?.getAttribute('href')).toBe(GOOD_LINK);
    expect(container.querySelector('.fallback__refused')).toBeNull();

    mount({ kind: 'strava-embed', url: GOOD_EMBED });
    expect(container.querySelector('.fallback__link')?.getAttribute('href')).toBe(GOOD_EMBED);
    expect(container.querySelector('.fallback__refused')).toBeNull();

    const button = container.querySelector('button.button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('load button not found');
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(GOOD_EMBED);
  });
});

describe('course-url: the call site, read from source', () => {
  // The DOM tests above would all still pass if the component computed the
  // guard and then rendered `course.url` anyway in some branch they do not
  // reach. These read the file. Relative to the repo root, which is vitest's
  // cwd — `import.meta.url` is not a file: URL under jsdom.
  const src = readFileSync('src/viewer/components/CourseFallback.tsx', 'utf8');

  it('never hands course.url straight to an attribute', () => {
    expect(src).not.toMatch(/(?:href|src)=\{\s*course\.url\s*\}/);
  });

  it('hands each attribute the value the guard returned', () => {
    expect(src).toContain('href={href}');
    expect(src).toContain('src={embedSrc}');
    expect(src).toContain('safeHref(course.url)');
    expect(src).toContain('embeddableSrc(course.url)');
  });

  it('keeps the rule in core, so the two layers cannot drift', () => {
    // One copy, imported by both. A second copy is how the weaker of two
    // checks ends up being the one that decides.
    expect(src).toContain("from '../../core/course-url.ts'");
    expect(readFileSync('src/core/schema.ts', 'utf8')).toContain("from './course-url.ts'");
  });
});
