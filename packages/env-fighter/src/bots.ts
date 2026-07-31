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
import { COMMITTED_ATTACK, PHASE_IDLE, rangeForCode } from './frames';
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
 * Closes to `attackRange`, then plays off the opponent's Commitment Window:
 * guards while the opponent is free to act, and attacks the moment the
 * opponent has committed to one.
 *
 * This is the only one of the three bots that reads `opponentPhase` and acts
 * on it, and Story 2.4's gate is what turned that from a decoration into an
 * edge. Two facts about the environment make the rule the right one:
 *
 *   - A hit lands on anyone inside the range band who did not submit `block`,
 *     whatever phase they are in. So "punishing recovery" buys nothing on its
 *     own -- an opponent's recovery is not what makes it hittable, being in
 *     range is. What recovery *does* guarantee is that no hit is coming back
 *     this Decision Point, which is what makes attacking into it free.
 *   - Attacking opens a Commitment Window longer than the Decision Point
 *     cadence, so a fighter that attacks is unactionable when the opponent
 *     next chooses. Trading blows is therefore always even, and the only way
 *     to come out ahead is to spend the Decision Points where a hit *is*
 *     coming on a guard that absorbs it (`blockDamageReduction`).
 *
 * Story 2.3's version retreated whenever it was inside `attackRange` and
 * attacked only at the exact boundary, which left it unable to punish
 * anything: against the aggressive bot it mirrored move for move into a
 * double KO, and it lost to the random bot outright. See the Story 2.4 spec
 * for the measurements.
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

      if (state.separation > attackRange) {
        // Out of range: nothing can be landed or received, so close.
        action = 'advance';
      } else if (state.opponentPhase === PHASE_IDLE) {
        // The opponent is free to act, so a hit may be coming this Decision
        // Point. A guard costs this bot its own attack and denies the
        // opponent's -- an even trade in tempo, and a winning one in damage.
        action = 'block';
      } else {
        // The opponent is inside a Commitment Window: it cannot guard, and
        // (in recovery) it cannot answer either. A free hit.
        action = 'attack';
      }

      return decisionFor(action, `spacing:${action}`);
    },
  };
}
