import type { CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog, computeConfigHash } from '../../../../packages/core/src/command-log';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { createAggressiveBot, createSpacingBot } from '../../../../packages/env-fighter/src/bots';

/**
 * Builds a real fighter Command Log by playing a real Match.
 *
 * Not a committed JSON fixture. A fixture recorded once drifts the moment the
 * frame data moves -- and Story 2.4's skill-separation gate exists precisely to
 * keep moving it -- at which point the player's tests would be asserting
 * against a Match the current engine can no longer produce. Playing two
 * Baseline Bots costs milliseconds and can never drift, because it re-derives
 * from the same engine the player re-simulates through.
 *
 * Test-only. Nothing shipped imports this: `source-discipline.test.ts` asserts
 * no file outside `src/testing/` reaches into it.
 */
export async function buildFixtureLog(seed = 4_101): Promise<CommandLog> {
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
