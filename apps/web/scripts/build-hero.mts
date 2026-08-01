import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const gif = renderHeroGif(log);

mkdirSync(OUT, { recursive: true });
// Two-space JSON with a trailing newline, the same shape every other committed
// artefact in this repo has, so a diff of one is readable.
writeFileSync(join(OUT, 'hero.command-log.json'), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
writeFileSync(join(OUT, 'hero.gif'), gif);

process.stdout.write(
  `hero: ${String(log.decisions.length)} decision entries, ${String(gif.length)} bytes of GIF\n`,
);
