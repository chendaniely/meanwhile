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
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
