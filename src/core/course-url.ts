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
 * straight to `<a href>` and `<iframe src>`. `javascript:alert(document.cookie)`
 * passed validation and executed on click, in a page holding File System
 * Access handles to the owner's entire photo folder. React does not stop
 * that: it prints a development warning and renders the attribute anyway.
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
 * - **Any scheme but `https:`.** `javascript:` and `data:` run as code;
 *   `http:` sends someone's reading of a private timeline over the wire in
 *   clear. There is no legitimate course URL that is not `https:`.
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
 * whose entire purpose is to be passed between people — can run script in a
 * page that holds directory handles to the recipient's photo library, or can
 * frame an arbitrary site inside it.
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
