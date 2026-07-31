/**
 * Three graded Baseline Bots implementing the frozen `Agent` port.
 *
 * Permanent fixtures (FR-23): every published results table carries them as
 * the skill floor the leaderboard is read against, not scaffolding to be torn
 * out once Deployments exist.
 *
 * `Prompt` is the only channel from `observe()` to `decide()` (docs/contracts
 * is frozen and neither type carries a bot-specific extension), so every bot
 * here serialises the state it needs into `Prompt.user` and reads it back --
 * `decide()` never reaches for anything outside its own `prompt` argument.
 */

import type { Action, Agent, Decision, Observation, Prompt } from '@tokenbrawl/contracts';
import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import { COMMITTED_ATTACK, PHASE_RECOVERY, rangeForCode } from './frames';
import { mixSeed, nextRngState } from './prng';

/** The subset of `environment.ts`'s `observe().state` JSON a bot reads. */
interface BotState {
  readonly opponentPhase: number;
  readonly separation: number;
}

interface BotPrompt {
  readonly state: BotState;
  readonly legalActions: readonly Action[];
}

function buildPrompt(observation: Observation): Prompt {
  const state = JSON.parse(observation.state) as BotState;
  const payload: BotPrompt = { state, legalActions: observation.legalActions };
  return {
    system: 'baseline-bot',
    user: JSON.stringify(payload),
    // A Baseline Bot never consumes a Token Bank (Story 1.5); these two
    // values are what `match-runner.ts` already passes for `kind: 'bot'`,
    // repeated here only so `Prompt` is self-describing to the bot itself.
    budgetRemaining: Number.MAX_SAFE_INTEGER,
    reflexMode: false,
  };
}

function readPrompt(prompt: Prompt): BotPrompt {
  return JSON.parse(prompt.user) as BotPrompt;
}

function decisionFor(action: Action, rawResponse: string): Decision {
  return {
    action,
    tokensSpent: 0,
    reasoningTokens: null,
    reasoning: null,
    rawResponse,
    provider: 'bot',
    endpoint: 'bot',
  };
}

/**
 * Selects uniformly among legal Actions using a match-local xorshift32
 * stream seeded at construction -- never the unseeded global generator
 * (AC1, INV-2). The stream lives in a per-Agent closure, not module scope, so
 * two instances with different seeds never interfere and the same seed
 * reproduces the same Action sequence against the same opponent (AC5).
 */
export function createRandomBot(id: string, seed: number): Agent {
  let rngState = mixSeed(seed);

  return {
    id,
    kind: 'bot',

    observe: buildPrompt,

    async decide(prompt: Prompt): Promise<Decision> {
      const { legalActions } = readPrompt(prompt);
      rngState = nextRngState(rngState);
      const index = Math.abs(rngState) % legalActions.length;
      const action = legalActions[index];
      return decisionFor(action, `random:${action}`);
    },
  };
}

/**
 * Closes distance and attacks whenever off cooldown (i.e. whenever polled --
 * a bot mid-Commitment-Window is never polled at all). No punish awareness:
 * the opponent's phase never enters the decision.
 */
export function createAggressiveBot(
  id: string,
  config: FighterConfig = DEFAULT_FIGHTER_CONFIG,
): Agent {
  const attackRange = rangeForCode(config, COMMITTED_ATTACK);

  return {
    id,
    kind: 'bot',

    observe: buildPrompt,

    async decide(prompt: Prompt): Promise<Decision> {
      const { state } = readPrompt(prompt);
      const action: Action = state.separation <= attackRange ? 'attack' : 'advance';
      return decisionFor(action, `aggressive:${action}`);
    },
  };
}

/**
 * Holds `attackRange`: advances when the opponent is out of it, retreats
 * when well inside it, and attacks only when the opponent is inside it.
 * Overrides the hold to close and attack whenever the opponent's
 * Commitment Window is observed in recovery, punishing the whiff rather
 * than continuing to kite.
 */
export function createSpacingBot(
  id: string,
  config: FighterConfig = DEFAULT_FIGHTER_CONFIG,
): Agent {
  const attackRange = rangeForCode(config, COMMITTED_ATTACK);

  return {
    id,
    kind: 'bot',

    observe: buildPrompt,

    async decide(prompt: Prompt): Promise<Decision> {
      const { state } = readPrompt(prompt);
      let action: Action;

      if (state.opponentPhase === PHASE_RECOVERY) {
        action = state.separation <= attackRange ? 'attack' : 'advance';
      } else if (state.separation > attackRange) {
        action = 'advance';
      } else if (state.separation < attackRange) {
        action = 'retreat';
      } else {
        action = 'attack';
      }

      return decisionFor(action, `spacing:${action}`);
    },
  };
}
