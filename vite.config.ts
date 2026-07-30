import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The site deploys to https://chendaniely.github.io/meanwhile/, so assets must
// resolve under /meanwhile/. Local dev serves from / and needs no base.
const base = process.env.MEANWHILE_BASE ?? (process.env.NODE_ENV === 'production' ? '/meanwhile/' : '/');

export default defineConfig({
  base,
  plugins: [react()],
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
