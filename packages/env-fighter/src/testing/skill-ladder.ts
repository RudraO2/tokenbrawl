/**
 * The Baseline Bot ladder the skill-separation gate is computed from
 * (Story 2.4, FR-3).
 *
 * Lives under `src/testing/` rather than beside the bots for one reason: it
 * imports `packages/core`, and every *shipped* file in this package is held to
 * an import allowlist of `@tokenbrawl/contracts` alone (AD-4 -- core's Ajv and
 * `node:crypto` graph would break the web app's bundle). `source-discipline`
 * separately asserts no shipped file imports out of this directory, which is
 * what keeps that exemption honest.
 *
 * Deep relative specifiers into core are this repo's established test-side
 * convention (`harness-integration.test.ts`, `mirrored-seed.test.ts`): no
 * package declares `main`/`exports` yet, so the bare `@tokenbrawl/core`
 * specifier does not resolve at runtime. Already in the deferred-work ledger.
 */

import type { Agent } from '@tokenbrawl/contracts';
import { computeConfigHash, computeMatchId } from '../../../core/src/command-log';
import { runMatch } from '../../../core/src/match-runner';
import type { PairingSample } from '../../../core/src/skill-gate';
import { DRAW_BASIS_POINTS, LOSS_BASIS_POINTS, WIN_BASIS_POINTS } from '../../../core/src/statistics';
import { createAggressiveBot, createRandomBot, createSpacingBot } from '../bots';
import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from '../config';
import { createFighterEnvironment } from '../environment';

/**
 * 100 seeds, each played from both sides (AD-12), is 200 Matches per pairing
 * -- the floor the story's first acceptance criterion sets.
 */
export const LADDER_SEED_BASE = 20260731;
export const LADDER_SEED_COUNT = 100;

/** Resampling is itself seeded, or the gate result does not reproduce (AD-5). */
export const LADDER_BOOTSTRAP_SEED = 987654321;
export const LADDER_BOOTSTRAP_RESAMPLES = 2000;

/**
 * The three thresholds, in basis points, exactly as
 * `docs/stories/2.4-skill-separation-gate.md` committed them before any Match
 * was played: >= 0.65, >= 0.55, >= 0.50.
 *
 * They are written here as integers because a floating-point literal is banned
 * repo-wide in simulation code (INV-2), and they are `as const` because the
 * one thing this story must never do is move them to fit a result. If the
 * ladder cannot clear them, the game is wrong, not the numbers --
 * `scripts/audit-invariants.sh` pins these three values for exactly that
 * reason.
 */
export const SPACING_OVER_RANDOM_THRESHOLD_BASIS_POINTS = 6500;
export const SPACING_OVER_AGGRESSIVE_THRESHOLD_BASIS_POINTS = 5500;
export const AGGRESSIVE_OVER_RANDOM_THRESHOLD_BASIS_POINTS = 5000;

export const SPACING_BOT_ID = 'spacing-aware';
export const AGGRESSIVE_BOT_ID = 'aggressive';
export const RANDOM_BOT_ID = 'random';

type BotId = typeof SPACING_BOT_ID | typeof AGGRESSIVE_BOT_ID | typeof RANDOM_BOT_ID;

interface PairingDefinition {
  readonly stronger: BotId;
  readonly weaker: BotId;
  readonly thresholdBasisPoints: number;
}

/** Every unordered pair of the three bots, each with its committed threshold. */
export const LADDER_PAIRINGS: readonly PairingDefinition[] = [
  {
    stronger: SPACING_BOT_ID,
    weaker: RANDOM_BOT_ID,
    thresholdBasisPoints: SPACING_OVER_RANDOM_THRESHOLD_BASIS_POINTS,
  },
  {
    stronger: SPACING_BOT_ID,
    weaker: AGGRESSIVE_BOT_ID,
    thresholdBasisPoints: SPACING_OVER_AGGRESSIVE_THRESHOLD_BASIS_POINTS,
  },
  {
    stronger: AGGRESSIVE_BOT_ID,
    weaker: RANDOM_BOT_ID,
    thresholdBasisPoints: AGGRESSIVE_OVER_RANDOM_THRESHOLD_BASIS_POINTS,
  },
];

/**
 * A fresh Agent per Match, never a shared one.
 *
 * The random bot carries a generator in its closure, so reusing an instance
 * across Matches would make Match `n` depend on Match `n-1` and the ladder
 * would stop being a function of its seeds. Its seed is derived from the Match
 * seed and its side, so the two sides of one seed are genuinely different
 * streams rather than the same one replayed.
 */
function createBot(id: BotId, matchSeed: number, agentIndex: 0 | 1, config: FighterConfig): Agent {
  if (id === RANDOM_BOT_ID) {
    return createRandomBot(id, Math.imul(matchSeed, 31) + agentIndex);
  }
  if (id === AGGRESSIVE_BOT_ID) {
    return createAggressiveBot(id, config);
  }
  return createSpacingBot(id, config);
}

export interface LadderMatch {
  readonly matchId: string;
  readonly seed: number;
  /** Which side the *stronger*-listed bot played. AD-12: both, per seed. */
  readonly strongerAgentIndex: 0 | 1;
  readonly scoreBasisPoints: number;
  readonly endReason: 'ko' | 'timeout';
}

export interface LadderPairingResult extends PairingSample {
  readonly matches: readonly LadderMatch[];
}

export interface LadderRun {
  readonly configHash: string;
  readonly environment: { readonly id: string; readonly version: string };
  readonly seedBase: number;
  readonly seedCount: number;
  readonly pairings: readonly LadderPairingResult[];
}

/**
 * Play the whole ladder: every pairing, every seed, both sides.
 *
 * Pure with respect to its inputs -- same config, same seeds, same result --
 * because every Agent is rebuilt per Match and the environment carries its own
 * PRNG in state. That is what makes the committed report a fact that can be
 * re-derived rather than a number somebody once observed.
 */
export async function runSkillLadder(
  overrides: Partial<FighterConfig> = {},
): Promise<LadderRun> {
  const config: FighterConfig = { ...DEFAULT_FIGHTER_CONFIG, ...overrides };
  const configHash = computeConfigHash(config);
  const probe = createFighterEnvironment(overrides);
  const environment = { id: probe.id, version: probe.version };

  const pairings: LadderPairingResult[] = [];

  for (const pairing of LADDER_PAIRINGS) {
    const matches: LadderMatch[] = [];

    for (let offset = 0; offset < LADDER_SEED_COUNT; offset += 1) {
      const seed = LADDER_SEED_BASE + offset;

      // Both side swaps of one seed, as separate Matches with distinct
      // `matchId`s (AD-12) -- a pairing measured from one side only would
      // report any side advantage in the engine as skill.
      for (const strongerAgentIndex of [0, 1] as const) {
        const weakerAgentIndex = strongerAgentIndex === 0 ? 1 : 0;
        const agents: [Agent, Agent] = [
          createBot(RANDOM_BOT_ID, seed, 0, config),
          createBot(RANDOM_BOT_ID, seed, 1, config),
        ];
        agents[strongerAgentIndex] = createBot(pairing.stronger, seed, strongerAgentIndex, config);
        agents[weakerAgentIndex] = createBot(pairing.weaker, seed, weakerAgentIndex, config);

        const result = await runMatch(createFighterEnvironment(overrides), agents, seed);

        const strongerWon =
          (result.result.outcome === 'p1' && strongerAgentIndex === 0) ||
          (result.result.outcome === 'p2' && strongerAgentIndex === 1);
        const scoreBasisPoints =
          result.result.outcome === 'draw'
            ? DRAW_BASIS_POINTS
            : strongerWon
              ? WIN_BASIS_POINTS
              : LOSS_BASIS_POINTS;

        matches.push({
          matchId: computeMatchId({
            environmentId: environment.id,
            seed,
            configHash,
            agentIds: [agents[0].id, agents[1].id],
          }),
          seed,
          strongerAgentIndex,
          scoreBasisPoints,
          endReason: result.result.endReason,
        });
      }
    }

    pairings.push({
      stronger: pairing.stronger,
      weaker: pairing.weaker,
      thresholdBasisPoints: pairing.thresholdBasisPoints,
      scoresBasisPoints: matches.map((match) => match.scoreBasisPoints),
      matches,
    });
  }

  return {
    configHash,
    environment,
    seedBase: LADDER_SEED_BASE,
    seedCount: LADDER_SEED_COUNT,
    pairings,
  };
}
