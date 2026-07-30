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
            `gtag('config', '${GA_MEASUREMENT_ID}');`,
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
