/**
 * Google Analytics, told exactly one thing: which of the three views is open.
 *
 * The owner drew the line explicitly:
 *
 * > "i don't think i need view-usage. maybe the only tab info that is useful
 * > is which view are people looking at, but i don't need to track
 * > time/people information at all."
 *
 * So this module has exactly one job, and the shape of it is the contract:
 * a three-value enum in, nothing else out. `AppState` also carries `cursor`
 * (a timestamp taken from somebody's photograph) and `visible` (which
 * people's lanes are shown), both mirrored into the URL fragment — see
 * `core/state.ts#toHash`. Neither may ever reach this module, let alone
 * Google, which is why `trackView` takes a bare `ViewName` and not the
 * `AppState` it is read from.
 *
 * `window.gtag` only exists on the published build — `vite.config.ts`'s
 * `googleAnalytics()` plugin injects the snippet that defines it, and only
 * `apply: 'build'`, never for `make dev`. So "gtag is undefined" is not an
 * error case to guard against defensively; it is the entire local-dev
 * experience, every time, and the no-op path below is the normal one for
 * anyone running this project from source.
 */

import type { ViewName } from '../core/state.ts';

type Gtag = (...args: unknown[]) => void;

function gtagOrNull(): Gtag | null {
  const fn = (window as unknown as { gtag?: unknown }).gtag;
  return typeof fn === 'function' ? (fn as Gtag) : null;
}

/**
 * Report that `view` is now the one being looked at.
 *
 * The payload is `{ view }` and nothing else — no cursor, no crop, no
 * person, no URL. `view_change` is a made-up event name (not one of GA4's
 * reserved automatically-collected events), so it never collides with
 * anything GA4 sends on its own.
 */
export function trackView(view: ViewName): void {
  const gtag = gtagOrNull();
  if (!gtag) return;
  gtag('event', 'view_change', { view });
}
