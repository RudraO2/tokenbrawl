import type { CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog, computeConfigHash } from '../../../../packages/core/src/command-log';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { createAggressiveBot, createSpacingBot } from '../../../../packages/env-fighter/src/bots';

/**
 * Builds a real Command Log by playing a real Match between two Baseline Bots.
 *
 * Shipped rather than test-only, and used by both the page and the tests. Two
 * reasons, which turn out to be one reason:
 *
 * - The page needs something to replay before a tournament has ever run, and a
 *   Match between two bots is honest about what it is. A hand-written demo log
 *   would be a fake, and one whose hash did not verify would make the player's
 *   own AC5 chip lie on first load.
 * - The tests need a fixture that cannot drift. A recorded JSON file goes stale
 *   the moment the frame data moves -- and Story 2.4's skill-separation gate
 *   exists precisely to keep moving it -- at which point the player's tests
 *   would assert against a Match the current engine can no longer produce.
 *   Playing the bots re-derives from the same engine the player re-simulates
 *   through, so it is drift-proof by construction.
 *
 * It is also the strongest available demonstration of AD-4: `runMatch`, the
 * environment and both Baseline Bots run unmodified in a browser, with no Node
 * built-in anywhere in the graph.
 */
export async function buildDemoLog(seed = 4_101): Promise<CommandLog> {
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
