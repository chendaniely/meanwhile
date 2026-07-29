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
    // Media is never bundled. Only the app itself.
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
