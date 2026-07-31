import type { CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog, computeConfigHash } from '../../../../packages/core/src/command-log';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { createAggressiveBot, createSpacingBot } from '../../../../packages/env-fighter/src/bots';

/**
 * Builds a real Command Log by playing a real Match between two Baseline Bots.
 *
 * **Node-only, and it lives under `src/testing/` for that reason.** This was
 * briefly shipped and imported by the page, which broke the browser outright:
 * `buildCommandLog` imports `canonical-hash.ts`, which imports `node:crypto`,
 * and it also pulls in Ajv. Vite externalises `node:crypto` and the page died
 * on first load with "Module node:crypto has been externalized for browser
 * compatibility".
 *
 * That is the same constraint `packages/core/src/replay.ts` documents from the
 * other side -- it stays dependency-starved so a bare Node child can load it --
 * and it turns out to bind the browser just as hard. `source-discipline.test.ts`
 * now gates it: no shipped file under `apps/web/src` may import
 * `command-log` or `canonical-hash`.
 *
 * So the demo replay is **precomputed** into
 * `apps/web/public/replays/demo.command-log.json` and fetched by the page,
 * which is the architecture anyway (INV-8: precompute plus static) and is
 * exactly how a real tournament log will arrive. `demo-log.test.ts` replays
 * that committed file and rebuilds it here, failing if the two have drifted --
 * so the recorded fixture cannot go stale when the frame data moves.
 *
 * Regenerate with: `node --experimental-strip-types apps/web/scripts/build-demo-replay.mts`
 */
/** The seed the committed demo replay was built from. One place, so the script and the drift test cannot disagree. */
export const DEMO_SEED = 4_101;

export async function buildDemoLog(seed: number = DEMO_SEED): Promise<CommandLog> {
  const env = createFighterEnvironment();
  const p1 = createAggressiveBot('bot:aggressive');
  const p2 = createSpacingBot('bot:spacing');

  const match = await runMatch(env, [p1, p2], seed);

  return buildCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed,
    configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
    agents: [
      { id: p1.id, kind: 'bot' },
      { id: p2.id, kind: 'bot' },
    ],
  });
}
