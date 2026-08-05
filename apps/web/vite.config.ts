import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { localSpritesPlugin } from './src/dev/local-sprites.ts';

// Only workspace using Vite (AD/story scope: apps/web is the replay player,
// leaderboard, and BYOK panel — everything else is a plain TS package).
//
// The alias mirrors `@tokenbrawl/contracts` from tsconfig.base.json, exactly as
// packages/core and packages/providers do in their vitest configs. Story 4.1 is
// where this app first needs it: the player imports `packages/core/src/replay`,
// which imports `assertSchemaVersion` as a *value* rather than a type, so the
// specifier has to resolve for the browser bundle and for Vitest alike. Vitest
// reads this file, so one alias serves both.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Story 9.1 / AD-16: dev-only, fails soft, structurally absent from
  // `vite build` (`apply: 'serve'`) -- see apps/web/src/dev/local-sprites.ts.
  plugins: [localSpritesPlugin()],
  resolve: {
    alias: {
      '@tokenbrawl/contracts': path.resolve(here, '../../docs/contracts/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
