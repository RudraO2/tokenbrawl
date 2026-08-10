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
  test: {
    /**
     * 30s rather than Vitest's 5s default, for this workspace only.
     *
     * Story 12.1 recorded the problem and commit 76e953f took the first bite:
     * a handful of cases here walk an entire replay film, drawing every frame
     * through the real renderer against a recording surface, and they finish in
     * under two seconds alone. Under the parallel load of 52 files and 1166
     * tests they do not -- `hero.test.ts`'s drift gate measured 5.9s and 6.3s,
     * and Story 12.3's new camera cases pushed four more over the line
     * (`hero-artefact`'s GIF rebuild, two in `cinematic-neutrality`, one in
     * `juice-neutrality`), with *which* four varying run to run.
     *
     * 76e953f raised one case rather than the project, and said why: a blanket
     * timeout hides a genuine hang. That was right at one case and stops being
     * right at five, because the set is unstable -- every remaining film-walking
     * case is one new test file away from joining it, and a suite that is green
     * most of the time teaches the next session to shrug at a red one. Epic 12
     * runs a story per chat with no orchestrator re-running the verify block, so
     * a red suite is the only thing between a wrong claim and a commit.
     *
     * What is given up is precision, not detection: a hung test still fails, 25
     * seconds later. "Five seconds" was never a hang detector for a case whose
     * honest cost is two.
     */
    testTimeout: 30_000,
  },
});
