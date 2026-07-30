import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** The owner's Google Analytics property for the published site. */
const GA_MEASUREMENT_ID = 'G-45CW80QRH9';

/**
 * Google Analytics, on the DEPLOYED SITE ONLY.
 *
 * `apply: 'build'` is the whole point, and it is a privacy decision rather
 * than a performance one. meanwhile's local mode reads a folder of somebody's
 * private photographs straight off their disk, and the promise made
 * throughout the README is that nothing leaves the machine. Loading a Google
 * tag during local authoring would quietly break that promise for the one
 * person most entitled to it — so `make dev` gets no analytics at all, and
 * only the public Pages build is measured.
 *
 * What this DOES cost, stated plainly because the docs used to claim
 * otherwise: the published page now contacts googletagmanager.com on load and
 * Google sees each visitor's IP. That is a change in kind for a site whose
 * fonts are self-hosted specifically to avoid third-party requests, so the
 * "zero external requests" claims elsewhere were corrected in the same commit
 * rather than left to rot.
 *
 * THE FRAGMENT MUST NEVER REACH GOOGLE. `src/core/state.ts#toHash` puts a
 * photo-derived timestamp (`t=`) and the ids of whichever people are shown or
 * hidden (`who=`) straight in the URL, because that is what makes any moment
 * a link you can text someone. GA4's default `page_location` is
 * `location.href`, fragment included, and `useAppState` calls
 * `history.replaceState` on every cursor change — continuously, while
 * scrubbing — so the naive `gtag('config', ID)` this used to be would ship
 * both of those to Google on a schedule closer to "constantly" than "once".
 *
 * `send_page_view: false` stops the page view GA4's `config` command would
 * otherwise send automatically, and the `page_view` sent explicitly below
 * uses `location.origin + location.pathname` — which cannot contain a
 * fragment, by construction, regardless of what gtag's own default
 * fragment-handling turns out to be.
 *
 * THIS DOES NOT CLOSE THE WHOLE GAP. GA4's "enhanced measurement" is a
 * property-level feature, not a `gtag()` parameter, and its
 * "page changes based on browser history events" listener fires its own
 * automatic `page_view` on every `pushState`/`replaceState`/`hashchange` —
 * with `page_location` read fresh from `location.href` at the moment it
 * fires, independent of `send_page_view` and independent of the
 * `page_location` passed to `config` here. Verified against Google's own
 * docs and independent write-ups (no live GA4 property was probed): disabling
 * that listener is a toggle in the GA4 console — Admin → Data Streams → this
 * stream → Enhanced measurement (gear icon) → "Page changes based on browser
 * history events" — off. That is the owner's action, not a `vite.config.ts`
 * change; see CLAUDE.md's "Verified external constraints" table.
 */
function googleAnalytics(): Plugin {
  return {
    name: 'meanwhile-google-analytics',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}` },
          injectTo: 'head',
        },
        {
          tag: 'script',
          children:
            'window.dataLayer = window.dataLayer || [];\n' +
            'function gtag(){dataLayer.push(arguments);}\n' +
            "gtag('js', new Date());\n" +
            `gtag('config', '${GA_MEASUREMENT_ID}', { send_page_view: false, page_location: location.origin + location.pathname });\n` +
            "gtag('event', 'page_view', { page_location: location.origin + location.pathname });",
          injectTo: 'head',
        },
      ];
    },
  };
}

// The site deploys to https://chendaniely.github.io/meanwhile/, so assets must
// resolve under /meanwhile/. Local dev serves from / and needs no base.
const base = process.env.MEANWHILE_BASE ?? (process.env.NODE_ENV === 'production' ? '/meanwhile/' : '/');

export default defineConfig({
  base,
  plugins: [react(), googleAnalytics()],
  build: {
    outDir: 'dist',
    // Nothing under src/ imports a race photo or video — media always
    // resolves at runtime from a URL or a locally granted folder — so this
    // setting has no effect on media either way; that part was never true
    // at the moment of this setting, only true generally. What it actually
    // changes: `leaflet/dist/leaflet.css` references several small PNGs
    // (marker-icon.png, layers.png, ...), all under Vite's default 4KB
    // inline threshold. Without this, Vite base64-inlines them into the
    // CSS (verified: three `data:image/png;base64` URIs appear). With it,
    // they're emitted as separate files in dist/assets/ instead — simpler
    // to inspect and cache independently of the CSS.
    assetsInlineLimit: 0,
  },
  test: {
    // Node by default — the kernel needs no DOM, and keeping it that way is
    // the point. Files that genuinely exercise React opt in with a
    // `// @vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
