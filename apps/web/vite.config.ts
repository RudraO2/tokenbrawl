import { defineConfig } from 'vite';

// Only workspace using Vite (AD/story scope: apps/web is the replay player,
// leaderboard, and BYOK panel — everything else is a plain TS package).
export default defineConfig({
  build: {
    outDir: 'dist',
  },
});
