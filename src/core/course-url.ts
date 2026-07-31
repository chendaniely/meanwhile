/**
 * Whether a course URL may be turned into a link, and whether it may be
 * loaded into an iframe. One module, imported by both the validator
 * (`schema.ts`) and the render site (`CourseFallback.tsx`), because two
 * copies of a security check drift and the weaker copy is the one that
 * decides.
 *
 * **Why this exists.** `course.url` arrives from a `manifest.json` somebody
 * emailed over — that is the collaboration model, and it is the whole threat
 * model too (see CLAUDE.md, "A file from someone else is the threat model").
 * It was validated as "a non-empty string" and nothing else, then handed
 * straight to `<a href>` and `<iframe src>`.
 *
 * **What was actually reachable, stated accurately.** An earlier version of
 * this comment said `javascript:` executed here and that React does not stop
 * it. **That is false, and it was corrected on 2026-07-30 after being checked
 * by execution.** React 19.2.8 — the version this project ships — runs
 * `sanitizeURL` over both `href` and `iframe src` in the development AND
 * production bundles, rewriting anything matching `isJavaScriptProtocol` to a
 * throwing stub. Mixed case, an embedded TAB and a leading space are all
 * covered by its regex. So `javascript:` was NOT reachable, and this was
 * never same-origin script execution.
 *
 * What WAS reachable, measured the same way — every one of these passed
 * through React untouched:
 *
 * - **`data:text/html,…` in the `<iframe src>`.** It renders, in an opaque
 *   origin: UI spoofing and phishing inside meanwhile's own page, not theft
 *   of the File System Access handles.
 * - **Any `https://` host in the iframe**, framing an arbitrary site.
 * - **`http://`**, and `vbscript:` (dead in modern browsers, but not stopped
 *   here).
 *
 * **The guard stays anyway, and that is not stubbornness.** React's sanitiser
 * covers exactly one scheme and does nothing about the two real problems
 * above. Sanitising a URL is not React's job and it does not claim it as an
 * API. And a security property that rests on a framework's implementation
 * detail is one dependency bump away from vanishing silently, with no test
 * anywhere that would notice.
 *
 * **Why it is hand-rolled rather than `new URL(...)`.** `URL` is in
 * `BANNED_GLOBALS` in `tests/core-purity.test.ts`, and CLAUDE.md forbids
 * weakening that test. Same answer as XML in `course.ts` and CSV in
 * `csv.ts`: write the small strict scanner. It is a security check, so it is
 * deliberately far stricter than the WHATWG parser rather than an attempt to
 * reimplement it — anything it cannot read with certainty is refused.
 *
 * **What it refuses, and why each refusal is load-bearing:**
 *
 * - **Any scheme but `https:`.** `data:text/html` in a frame renders attacker
 *   markup inside this page; `http:` sends someone's reading of a private
 *   timeline over the wire in clear. `javascript:` is refused here too — React
 *   happens to catch that one today, and this does not depend on it. There is
 *   no legitimate course URL that is not `https:`.
 * - **Any whitespace, C0 control, DEL, or backslash, ANYWHERE in the
 *   string.** This is the rule that makes the rest of the parse trustworthy.
 *   Browsers delete TAB, CR and LF from a URL *before* resolving it, so a
 *   TAB inside `https:`, or inside `strava.com`, is one thing to a regex and
 *   another thing to the browser; and browsers treat `\` as `/` inside a
 *   special scheme. Refusing these characters outright removes the whole
 *   class rather than modelling it. It also disposes of a leading TAB or
 *   space in front of `javascript:`, which the anchor alone would not.
 * - **Userinfo.** `https://www.strava.com@evil.com/` has a host of
 *   `evil.com`; the part that reads like Strava is a username. The authority
 *   charset below has no `@` in it, so such a URL matches nothing at all.
 * - **A non-ASCII host.** IDNA maps some non-ASCII characters onto ASCII
 *   ones during resolution, so a host this file reads is not necessarily the
 *   host the browser dials. Refusing them keeps `hostOf` a statement about
 *   what will actually be contacted. The cost is an internationalised domain
 *   name being refused; no Strava URL is one.
 *
 * **Reversing any of this** means accepting that a `manifest.json` — a file
 * whose entire purpose is to be passed between people — can render attacker
 * markup, or an arbitrary site, inside the page that holds directory handles
 * to the recipient's photo library.
 */

/**
 * Hosts whose pages this app will load INSIDE itself.
 *
 * A link merely offers to leave; an iframe fetches on the reader's behalf
 * and puts someone else's document in this page. So the link check is
 * "is it https", and the frame check is "is it https AND is it Strava" —
 * the only site there is any reason to embed, because the only embed this
 * app knows about is `/activities/{ID}/embed/{CODE}`.
 *
 * Exact host matches, never a suffix test: `endsWith('strava.com')` also
 * accepts `notstrava.com` and `strava.com.evil.test`.
 */
const EMBEDDABLE_HOSTS: readonly string[] = ['strava.com', 'www.strava.com'];

/**
 * Characters a browser strips or rewrites before resolving a URL, plus the
 * ASCII space. See the module comment: while any of these are present, no
 * conclusion drawn from the raw string holds.
 *
 * `\u0000-\u0020` covers every C0 control and the space; `\u007f` is DEL.
 * No `g` flag, deliberately — a global regex carries `lastIndex` between
 * calls and `.test` would then alternate true and false on the same input.
 */
const REWRITABLE = /[\u0000-\u0020\u007f\\]/;

/**
 * `https://` then an authority, terminated by end-of-string, `/`, `?` or `#`.
 *
 * The authority charset excludes `@` (userinfo), `[` and `]` (IPv6 literals,
 * which have no legitimate use here) and everything non-ASCII. Anchored, with
 * no allowance for leading whitespace — `REWRITABLE` has already refused
 * anything that could have hidden in front of the scheme. Case-insensitive
 * because a scheme is.
 *
 * No `g` flag, for the same reason as `REWRITABLE`.
 */
const HTTPS_AUTHORITY = /^https:\/\/([a-zA-Z0-9._-]+(?::\d{1,5})?)(?:[/?#]|$)/i;

/**
 * The lower-cased host of an `https:` URL this app is willing to contact, or
 * null if the string is not one.
 *
 * Null is not "malformed" — it is "this build will not act on it", which is a
 * deliberately broader category. A caller that gets a host may use the URL; a
 * caller that gets null must say so rather than render it.
 */
export function hostOf(raw: string): string | null {
  if (REWRITABLE.test(raw)) return null;
  const match = HTTPS_AUTHORITY.exec(raw);
  if (!match) return null;
  const authority = match[1] as string;
  return authority.replace(/:\d{1,5}$/, '').toLowerCase();
}

/**
 * The URL if it may be given to an `<a href>`, otherwise null.
 *
 * Returning the value rather than a boolean is on purpose: it makes the call
 * site `href={href}` instead of `href={course.url}`, so the guard travels
 * with the value through any later refactor. A surrounding `if` does not —
 * it can be moved, inverted, or lost, and `tests/course-url-guard.test.tsx`
 * reads the source for exactly that shape.
 */
export function safeHref(raw: string): string | null {
  return hostOf(raw) === null ? null : raw;
}

/**
 * The URL if it may be given to an `<iframe src>`, otherwise null.
 *
 * Stricter than `safeHref` by a host allowlist — see `EMBEDDABLE_HOSTS`.
 */
export function embeddableSrc(raw: string): string | null {
  const host = hostOf(raw);
  return host !== null && EMBEDDABLE_HOSTS.includes(host) ? raw : null;
}

/** The allowlist, for a message that has to name what is permitted. */
export function embeddableHosts(): readonly string[] {
  return EMBEDDABLE_HOSTS;
}

/**
 * What someone typed, turned into something this build will act on where that
 * is unambiguous.
 *
 * **Why this exists.** The ordinary way to fill the event-settings box is to
 * copy the address bar and drop the scheme: `strava.com/activities/123`, or
 * `www.strava.com/...`. Every one of those is refused by `hostOf`, and before
 * this the refusal reached `manifest.json` and then the reader, for a paste
 * that was never ambiguous about what it meant.
 *
 * The rule is deliberately narrow and self-checking: prefix `https://` ONLY
 * when doing so turns something `hostOf` refuses into something it accepts.
 * There is no second notion of a URL here — the same one function decides
 * both times.
 *
 * **A scheme that is present is never rewritten.** `http://evil.test` stays
 * `http://evil.test` and is refused at render, because silently upgrading it
 * would change where a person said to go. Prefixing that one produces
 * `https://http://evil.test`, which `hostOf` refuses (`http` is not followed
 * by `/`, `?`, `#` or end-of-string), so the guard below returns the original
 * without needing a special case for it.
 *
 * Leading slashes are dropped first so a protocol-relative `//strava.com/x`
 * normalises rather than becoming `https:////strava.com/x`.
 */
export function normalizeCourseUrl(raw: string): string {
  const trimmed = raw.trim();
  // The `hostOf(trimmed) !== null` half is PROVABLY REDUNDANT today, and is
  // kept deliberately. Removing it changes nothing — measured across 504
  // inputs, zero differences — because prefixing an address that already
  // works yields `https://https://…`, whose authority `https` is followed by
  // `:` and then `/` rather than a port, so `hostOf` refuses it and the
  // fallback below returns `trimmed` anyway. It stays because it states the
  // invariant ("something already valid is never rewritten") instead of
  // leaving it as an emergent property of the authority regex, which is
  // exactly the kind of thing a later tightening of that regex would break
  // silently. A mutation test will report this line as an equivalent mutant;
  // that is expected, not a missing test.
  if (trimmed === '' || hostOf(trimmed) !== null) return trimmed;
  const prefixed = `https://${trimmed.replace(/^\/+/, '')}`;
  return hostOf(prefixed) !== null ? prefixed : trimmed;
}
