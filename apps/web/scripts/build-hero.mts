import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBackdropLayout } from '../src/render/backdrop';
import { stageForSeed, stageLayoutUrlFor } from '../src/render/stages';
import { renderHeroGif } from '../src/hero/hero';
import { buildHeroLog } from '../src/testing/hero-match';

/**
 * Regenerates the two committed hero artefacts (Story 7.4).
 *
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs apps/web/scripts/build-hero.mts
 *
 * Both outputs are drift-gated by `apps/web/src/hero/hero-artefact.test.ts`, so
 * a frame-data change that moves the fight fails the suite until this is run
 * again. That is the point: a promotional image that quietly stops matching the
 * engine is the exact failure this story exists to avoid.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', '..', 'docs', 'hero');

const log = await buildHeroLog();

// Story 12.10. The hero draws the stage its own seed picks -- the same
// deterministic default the page and a direct replay link use -- read from the
// shipped layout and validated exactly as the browser validates it. `raster.ts`
// cannot decode the scene PNGs, so only the stage's dim is drawn; the point is
// that the hero builds and draws its stage through the shipped path, not that
// the raster gains a PNG decoder (see `HeroScene.backdrop`).
const PUBLIC = join(HERE, '..', 'public');
const stageId = stageForSeed(log.seed);
const stageLayout = validateBackdropLayout(
  JSON.parse(readFileSync(join(PUBLIC, stageLayoutUrlFor(stageId)), 'utf8')),
);
const gif = renderHeroGif(log, stageLayout);

mkdirSync(OUT, { recursive: true });
// Two-space JSON with a trailing newline, the same shape every other committed
// artefact in this repo has, so a diff of one is readable.
writeFileSync(join(OUT, 'hero.command-log.json'), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
writeFileSync(join(OUT, 'hero.gif'), gif);

process.stdout.write(
  `hero: ${String(log.decisions.length)} decision entries, ${String(gif.length)} bytes of GIF\n`,
);
