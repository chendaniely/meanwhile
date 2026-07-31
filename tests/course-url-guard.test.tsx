// @vitest-environment jsdom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddableSrc, hostOf, normalizeCourseUrl, safeHref } from '../src/core/course-url.ts';
import { validateManifest } from '../src/core/schema.ts';
import type { CourseRef } from '../src/core/schema.ts';
import { CourseFallback } from '../src/viewer/components/CourseFallback.tsx';

/**
 * `course.url` was an unvalidated URL sink.
 *
 * `validateManifest` checked it was a non-empty string and nothing more, and
 * `CourseFallback` put it straight into `<a href>` and, for an embed, an
 * `<iframe src>` with no host allowlist.
 *
 * **Stated accurately, because the first version of this comment was not.**
 * It claimed `javascript:` executed here and that React does not stop it.
 * React 19.2.8 — this project's version — sanitises `javascript:` in both
 * `href` and `iframe src`, in the development and production bundles, and
 * `describes what React really does` below proves it by execution rather than
 * by reading the changelog. What passed through untouched, and what this
 * guard is actually for, is `data:text/html` in the frame (an opaque origin:
 * UI spoofing inside meanwhile's own page), an arbitrary https host in the
 * frame, and `http:` anywhere.
 *
 * The guard still refuses `javascript:` and is still tested for it: React's
 * sanitiser covers one scheme, sanitising URLs is not React's job, and a
 * security property resting on a framework's implementation detail is one
 * dependency bump from vanishing with nothing here to notice.
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

/** The hint paragraph, where the refusal reasons used to bleed into each other. */
function hintText(): string {
  return container.querySelector('.app__hint')?.textContent ?? '';
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

  it('WARNS about a javascript: course URL and still loads the manifest', () => {
    const r = validateManifest(withCourse({ kind: 'strava-link', url: 'javascript:alert(1)' }));
    // Loading is the assertion that matters. Refusing here for one commit
    // took `event.range`, `markers[]` and every `timeSource: 'manual'`
    // placement with it — see 'the data a refusal would have destroyed'.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join(' ')).toMatch(/course\.url/);
    expect(r.warnings.join(' ')).toMatch(/https/);
    // And it is kept verbatim, not scrubbed: refusing to act on a value is
    // not permission to delete it.
    expect(r.manifest.course).toEqual({ kind: 'strava-link', url: 'javascript:alert(1)' });
  });

  it('WARNS about an embed pointed at a host that is not Strava, naming both', () => {
    const r = validateManifest(
      withCourse({ kind: 'strava-embed', url: 'https://evil.test/activities/1/embed/x' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join(' ')).toMatch(/evil\.test/);
    expect(r.warnings.join(' ')).toMatch(/strava\.com/);
  });

  it('never refuses a manifest over a course URL, whatever it says', () => {
    for (const [, url] of REFUSED) {
      if (url === '') continue;
      for (const kind of ['strava-link', 'strava-embed'] as const) {
        expect(validateManifest(withCourse({ kind, url })).ok, `${kind} ${url}`).toBe(true);
      }
    }
  });

  it('keeps the data a refusal would have destroyed', () => {
    // The regression this warning-not-error decision exists to prevent, made
    // concrete. CLAUDE.md's "The manifest is the contract" names exactly
    // these as NOT regenerable from the photographs; `ingestFolder` leaves
    // `imported` null on a refusal, and on 'replace' nothing stands in.
    const r = validateManifest({
      schema: 1,
      event: {
        title: 'CM100',
        timezone: 'America/Denver',
        range: { from: '2026-07-25T10:00:00Z', to: '2026-07-27T00:00:00Z' },
      },
      people: [{ id: 'p', name: 'Priya' }],
      markers: [{ label: 'Cottonwood', at: '2026-07-26T03:00:00Z' }],
      items: [
        {
          id: 'a.jpg', person: 'p', type: 'photo', src: 'a.jpg',
          at: '2026-07-25T15:45:00Z', timeSource: 'manual',
        },
      ],
      // The ordinary paste: the address bar with the scheme dropped.
      course: { kind: 'strava-link', url: 'strava.com/activities/123' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.event.range).toEqual({
      from: '2026-07-25T10:00:00Z', to: '2026-07-27T00:00:00Z',
    });
    expect(r.manifest.markers).toHaveLength(1);
    expect(r.manifest.items[0]?.timeSource).toBe('manual');
    expect(r.manifest.event.timezone).toBe('America/Denver');
  });

  it('still loads an http:// course URL, which was legal before this guard', () => {
    // Backward compatibility, stated as a test: a manifest that opened before
    // the guard landed must still open after it.
    const r = validateManifest(
      withCourse({ kind: 'strava-link', url: 'http://www.strava.com/activities/1' }),
    );
    expect(r.ok).toBe(true);
  });

  it('accepts a non-Strava https LINK with no warning about it at all', () => {
    const r = validateManifest(
      withCourse({ kind: 'strava-link', url: 'https://connect.garmin.com/activity/1' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Permitted by design — meanwhile does not claim to know which sites are
    // safe to visit. The link's own TEXT names the host; see the render tests.
    expect(r.warnings.join(' ')).not.toMatch(/connect\.garmin\.com/);
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

  it('names the ACTUAL host in the link text, never a hardcoded "Strava"', () => {
    // The phishing shape: an emailed manifest whose link reads "Open the
    // activity on Strava" and goes to evil.test, with target="_blank" so the
    // address bar never changes to give it away.
    mount({ kind: 'strava-link', url: 'https://evil.test/login' });
    const link = container.querySelector('.fallback__link');
    expect(link?.getAttribute('href')).toBe('https://evil.test/login');
    expect(link?.textContent).toContain('evil.test');
    expect(link?.textContent).not.toMatch(/strava/i);
    // And the callout above it must not assert Strava either.
    expect(container.querySelector('.callout')?.textContent).not.toMatch(/strava/i);
  });

  it('names the host for a legitimate Strava link too, rather than a label', () => {
    mount({ kind: 'strava-link', url: GOOD_LINK });
    expect(container.querySelector('.fallback__link')?.textContent).toContain('www.strava.com');
  });

  it('gives each refusal ONLY its own reason', () => {
    // An embed refused for its HOST used to also print "a plain activity URL
    // cannot be embedded: the embed needs a code that only Strava's share
    // dialog produces" — false, since this URL carries /embed/ and was
    // refused for where it points. The page contradicted itself.
    mount({ kind: 'strava-embed', url: 'https://evil.test/activities/1/embed/x' });
    expect(container.querySelector('.fallback__refused')?.textContent).toMatch(/evil\.test/);
    expect(hintText()).not.toMatch(/share dialog/i);
    expect(hintText()).not.toMatch(/cannot be embedded/i);

    // The plain-link case keeps the explanation that IS true of it.
    mount({ kind: 'strava-link', url: GOOD_LINK });
    expect(hintText()).toMatch(/cannot be embedded/i);

    // And a URL refused for its SCHEME borrows neither reason.
    mount({ kind: 'strava-embed', url: 'data:text/html,<b>x' });
    expect(hintText()).not.toMatch(/cannot be embedded/i);
    expect(hintText()).not.toMatch(/share dialog/i);
  });

  it('points at the repair the reader can actually reach', () => {
    // The likeliest way to get here is typing into the event-settings box,
    // not hand-editing JSON, so "correct course.url and open the folder
    // again" sent people to the wrong place.
    mount({ kind: 'strava-link', url: 'data:text/html,<b>x' });
    expect(container.querySelector('.fallback__refused')?.textContent).toMatch(
      /event settings/i,
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

describe('what React really does with these URLs', () => {
  /*
   * Pinned because a claim about it was committed, was wrong, and was
   * repeated in four files. Two things this holds:
   *
   *   1. React DOES sanitise `javascript:` — so no future comment may say it
   *      does not, and the guard must not be justified by that claim.
   *   2. React does NOT sanitise anything else — so no future session may
   *      delete the guard on the grounds that React has it covered.
   *
   * If React ever changes either way, this fails and says which.
   */
  const blocked = (v: string | null) => (v ?? '').startsWith('javascript:throw');

  function renderRaw(url: string): { href: string | null; src: string | null } {
    act(() => {
      root.render(
        <>
          <a href={url}>x</a>
          <iframe src={url} title="t" />
        </>,
      );
    });
    return {
      href: container.querySelector('a')?.getAttribute('href') ?? null,
      src: container.querySelector('iframe')?.getAttribute('src') ?? null,
    };
  }

  it.each([
    'javascript:globalThis.__PWNED=1',
    'JaVaScRiPt:globalThis.__PWNED=1',
    'java\tscript:globalThis.__PWNED=1',
    ' javascript:globalThis.__PWNED=1',
  ])('sanitises %s in BOTH href and iframe src', (url) => {
    const { href, src } = renderRaw(url);
    expect(blocked(href), 'href').toBe(true);
    expect(blocked(src), 'iframe src').toBe(true);
  });

  it.each([
    ['data:text/html,<b>x</b>', 'renders attacker markup in the frame'],
    ['vbscript:msgbox(1)', 'a scheme React knows nothing about'],
    ['//evil.test/x', 'protocol-relative, inherits the page scheme'],
    ['https://evil.test/login', 'an arbitrary site framed inside this page'],
    ['http://evil.test/x', 'cleartext'],
  ])('does NOT sanitise %s — %s', (url) => {
    const { href, src } = renderRaw(url);
    expect(blocked(href)).toBe(false);
    expect(blocked(src)).toBe(false);
    expect(href).toBe(url);
    expect(src).toBe(url);
    // Which is precisely why the guard cannot be retired: the FRAME is the
    // sink React leaves wide open, and `embeddableSrc` closes every one of
    // these. (`https://evil.test/login` is deliberately still LINKABLE —
    // meanwhile does not police which sites you may visit — and is handled
    // instead by naming the host in the link's own text.)
    expect(embeddableSrc(url)).toBeNull();
  });
});

describe('course-url: normalizeCourseUrl', () => {
  it('prefixes https:// for the ordinary scheme-less paste', () => {
    // The input that made a bad manifest in the first place.
    expect(normalizeCourseUrl('strava.com/activities/123')).toBe(
      'https://strava.com/activities/123',
    );
    expect(normalizeCourseUrl('  www.strava.com/activities/1  ')).toBe(
      'https://www.strava.com/activities/1',
    );
    expect(normalizeCourseUrl('//www.strava.com/activities/1')).toBe(
      'https://www.strava.com/activities/1',
    );
  });

  it('leaves an address that already works exactly alone', () => {
    expect(normalizeCourseUrl(GOOD_EMBED)).toBe(GOOD_EMBED);
    expect(normalizeCourseUrl('')).toBe('');
    expect(normalizeCourseUrl('   ')).toBe('');
  });

  it('never invents a scheme over one that is already there', () => {
    // Upgrading http:// to https:// would silently change where the author
    // said to go. It stays as typed and is refused at render instead.
    for (const url of ['http://evil.test/x', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(normalizeCourseUrl(url), url).toBe(url);
      expect(safeHref(normalizeCourseUrl(url)), url).toBeNull();
    }
  });

  it('leaves a word alone rather than promoting it to a live link', () => {
    // `none`, `n/a`, `TBD` and `-` are real things people leave in an
    // optional field. Prefixing them produced `https://none`, which `hostOf`
    // accepts, so the page rendered an anchor reading "Open the activity on
    // none". A dot is what separates a shortened address from a word.
    for (const word of ['none', 'n/a', 'TBD', '-', 'unknown', '/activities/123']) {
      expect(normalizeCourseUrl(word), word).toBe(word);
    }
  });

  it('only ever produces something the one guard accepts, or the input back', () => {
    for (const raw of [
      'strava.com/x', 'evil.test/x', 'not a url at all', 'https://ok.test/x',
      'javascript:1', '///x', '@evil.test',
    ]) {
      const out = normalizeCourseUrl(raw);
      expect(out === raw.trim() || safeHref(out) !== null, raw).toBe(true);
    }
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

  it('never hardcodes the destination in the link text', () => {
    // `href` may point at any https host, so the visible text has to be
    // derived from the URL rather than asserting a site.
    expect(src).toContain('Open the activity on {host}');
    expect(src).not.toMatch(/Open the activity on Strava/);
  });

  it('keeps the rule in core, so the two layers cannot drift', () => {
    // One copy, imported by both. A second copy is how the weaker of two
    // checks ends up being the one that decides.
    expect(src).toContain("from '../../core/course-url.ts'");
    expect(readFileSync('src/core/schema.ts', 'utf8')).toContain("from './course-url.ts'");
  });
});
