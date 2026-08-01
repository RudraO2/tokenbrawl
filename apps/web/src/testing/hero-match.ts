import type { CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog, computeConfigHash } from '../../../../packages/core/src/command-log';
import { createDeployment } from '../../../../packages/core/src/deployment';
import type { ProviderClient, ProviderRequest, ProviderResponse } from '../../../../packages/core/src/deployment';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { REFLEX_MAX_TOKENS } from '../../../../packages/core/src/token-bank';
import { createSpacingBot } from '../../../../packages/env-fighter/src/bots';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';

/**
 * Story 7.4: the Match the README hero is made of.
 *
 * **Node-only, and under `src/testing/` for that reason** -- `buildCommandLog`
 * imports `canonical-hash.ts`, which imports `node:crypto`, and a shipped file
 * here may not (see `demo-log.ts`, which learned this the hard way).
 *
 * ## What is real and what is scripted
 *
 * No provider credential exists in this repository, and this story does not
 * pretend one does. So one side is a **scripted stand-in**: a `ProviderClient`
 * that answers from a fixed table instead of from a network.
 *
 * Real: the environment, the frame data, `runMatch`'s polling loop and its
 * simultaneity, the Token Bank debits, Reflex Mode engaging the moment the bank
 * empties, the `max_tokens=8` cap that follows, the Command Log, its schema
 * validation, and the replay hash. Scripted: the text a model would have
 * written.
 *
 * Three things stop that from being a misleading picture, which matters in a
 * story called *honest claims*:
 *
 *   1. The Agent id is `byok:scripted-stand-in` and the provider is `byok` --
 *      the one enum value in the frozen schema that does not name a first-party
 *      provider. AD-11 already bars a BYOK Match from every rating, so this log
 *      cannot reach a leaderboard even by accident.
 *   2. The caption panel on the GIF says so on every frame.
 *   3. The README says so directly under the image, and
 *      `docs-discipline.test.ts` fails if that sentence is deleted.
 *
 * The log is committed at `docs/hero/hero.command-log.json` rather than in
 * `apps/web/public/replays`, so it stays out of the leaderboard corpus by
 * construction rather than by relying on the exclusion to catch it.
 *
 * Regenerate both artefacts with:
 *   node --experimental-strip-types --import ./packages/cli/bin/register.mjs apps/web/scripts/build-hero.mts
 */

export const HERO_SEED = 7_404;

/**
 * Small on purpose. The default is 25,000, which no 40-Decision-Point Match
 * comes close to spending -- and a hero whose Token Bank never empties would
 * show none of the mechanic the benchmark is built around. At 4,000 against
 * ~420 tokens a call the bank runs out around the tenth Decision Point, leaving
 * the back half of the fight in Reflex Mode with the meter inverted.
 */
export const HERO_TOKEN_BANK_START = 4_000;

export const HERO_AGENT_ID = 'byok:scripted-stand-in';
export const HERO_ENDPOINT = 'https://scripted-stand-in.invalid/v1/chat/completions';
export const HERO_MODEL = 'scripted-stand-in';
export const HERO_OPPONENT_ID = 'bot:spacing';

interface ScriptedTurn {
  readonly action: string;
  readonly reasoning: string;
  readonly tokensSpent: number;
  readonly reasoningTokens: number;
}

/**
 * The stand-in's turns, cycled.
 *
 * Written to read like a fighter thinking about frame data, because that is
 * what the hero is advertising: the reasoning panel is the one thing a
 * screenshot cannot show and the whole reason the animation exists.
 */
const SCRIPT: readonly ScriptedTurn[] = Object.freeze([
  {
    action: 'advance',
    reasoning:
      'Opening at max range with a full bank. Walking in costs nothing and forces the spacing bot to commit first.',
    tokensSpent: 412,
    reasoningTokens: 260,
  },
  {
    action: 'advance',
    reasoning:
      'Still outside attack range. Another step closes the gap without opening a Commitment Window I would have to sit through.',
    tokensSpent: 396,
    reasoningTokens: 244,
  },
  {
    action: 'attack',
    reasoning:
      'In range now. Attack is 4 startup, 4 active, 32 recovery - if this whiffs I am helpless for a whole Decision Point, so it is worth it only here.',
    tokensSpent: 468,
    reasoningTokens: 302,
  },
  {
    action: 'block',
    reasoning:
      'Recovered into their range. Block cuts the damage rather than trading, and it costs no meter.',
    tokensSpent: 401,
    reasoningTokens: 251,
  },
  {
    action: 'retreat',
    reasoning:
      'They are winding up. Stepping back out of the range band beats guessing at the timing of the active frames.',
    tokensSpent: 424,
    reasoningTokens: 268,
  },
  {
    action: 'attack',
    reasoning:
      'Punish window. They are in recovery and cannot move, act or block until it expires.',
    tokensSpent: 447,
    reasoningTokens: 285,
  },
  {
    action: 'advance',
    reasoning:
      'Bank is getting thin. Closing distance now while I can still afford to think about the read.',
    tokensSpent: 433,
    reasoningTokens: 271,
  },
  {
    action: 'special',
    reasoning:
      'Meter is full and they are cornered. Special is 60 ticks of commitment, which is only survivable when they have nowhere to walk to.',
    tokensSpent: 489,
    reasoningTokens: 318,
  },
]);

/**
 * What the stand-in answers once its Token Bank is empty.
 *
 * `runMatch` sets `maxTokens` to `REFLEX_MAX_TOKENS` for exactly this state, so
 * the stand-in answers the way a capped model does: no deliberation, the
 * cheapest legal thing, eight tokens. That is the mechanic the hero exists to
 * show, and faking it in the renderer instead of letting the harness produce it
 * would be the lie this story is about not telling.
 */
const REFLEX_TURN: ScriptedTurn = Object.freeze({
  action: 'attack',
  reasoning:
    'Reflex Mode: bank empty, call capped at 8 tokens. No frames read, no spacing check - just swing.',
  tokensSpent: REFLEX_MAX_TOKENS,
  reasoningTokens: 0,
});

/**
 * A `ProviderClient` that answers from `SCRIPT`, or from `REFLEX_TURN` once the
 * harness caps it.
 *
 * It reads only `request.maxTokens`, never the prompt: an Agent that parsed the
 * Observation back out of its own Scaffold would be a second, undeclared bot,
 * and the point of the stand-in is that it is transparently scripted.
 */
export function createStandInClient(): ProviderClient {
  const calls = { count: 0 };

  return {
    provider: 'byok',
    endpoint: HERO_ENDPOINT,
    model: HERO_MODEL,

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const reflex = request.maxTokens === REFLEX_MAX_TOKENS;
      const turn = reflex ? REFLEX_TURN : SCRIPT[calls.count % SCRIPT.length];
      calls.count += 1;

      return {
        text: `${turn.reasoning}\nACTION: ${turn.action}`,
        reasoning: turn.reasoning,
        usage: { tokensSpent: turn.tokensSpent, reasoningTokens: turn.reasoningTokens },
      };
    },
  };
}

/** Plays the hero Match and returns its validated Command Log. */
export async function buildHeroLog(seed: number = HERO_SEED): Promise<CommandLog> {
  const env = createFighterEnvironment();
  const standIn = createDeployment({ client: createStandInClient(), id: HERO_AGENT_ID });
  const opponent = createSpacingBot(HERO_OPPONENT_ID);

  const match = await runMatch(env, [standIn, opponent], seed, {
    tokenBankStart: HERO_TOKEN_BANK_START,
  });

  return buildCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed,
    configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
    agents: [
      {
        id: HERO_AGENT_ID,
        kind: 'deployment',
        deployment: { provider: 'byok', endpoint: HERO_ENDPOINT, model: HERO_MODEL },
      },
      { id: HERO_OPPONENT_ID, kind: 'bot' },
    ],
    tokenBankStart: HERO_TOKEN_BANK_START,
  });
}
