import type { Observation, Prompt } from '@tokenbrawl/contracts';
import { ACTION_GRAMMAR } from './action-grammar';

/**
 * Story 3.1: the Scaffold and the only prompt assembler in the system (INV-7,
 * AD-7).
 *
 * INV-7 holds here structurally rather than by discipline. `assemblePrompt`
 * takes an Observation, a budget, and a flag -- there is no parameter through
 * which a provider, a model, an endpoint, or an Agent id could reach the
 * Scaffold, so a per-Deployment variation has nowhere to live even if someone
 * later wanted one. The two strings below are plain module constants with no
 * interpolation of anything Deployment-derived, and every Deployment's
 * `prompt.system` is one of exactly these two.
 *
 * Adding a provider therefore cannot require a change to this file: nothing in
 * it knows a provider exists.
 */

/**
 * The Scaffold. Byte-identical for every Deployment, forever.
 *
 * A Deployment that would perform better with different phrasing is a
 * published caveat, never a second string -- per-Deployment prompt tuning is
 * the confound this whole project exists to avoid measuring.
 */
export const SCAFFOLD = `You are one of two fighters in a 1v1 duel. Each Decision Point you are shown the current state of the fight and the Actions that are legal for you right now. Choose exactly one of them.

How the fight works:
- advance closes the distance to your opponent; retreat opens it. Neither commits you to anything.
- block reduces the damage you take, for this Decision Point only.
- attack and special commit you: for several Ticks afterwards you cannot move, cannot block, and are not asked to act again. A commitment that misses leaves you open, so an opponent who is mid-commitment is the safest thing to hit.
- special costs Super Meter and is offered to you only when you have enough to pay for it. It is spent whether or not it connects.
- You are told how much of the opponent's commitment remains. Nothing else about their intent is visible to you.

Your token budget is finite and shared across the entire fight. Reasoning costs tokens out of it. When it is empty you will still fight, but you will be asked for a single bare word and given room for nothing else.

${ACTION_GRAMMAR}`;

/**
 * The bare-Action variant, used once the Token Bank is empty (Reflex Mode,
 * Story 1.5). Also byte-identical across Deployments: Reflex Mode is a state
 * every Deployment can enter, not a per-Deployment setting.
 *
 * It invites nothing before the answer, because the caller pairs it with
 * `max_tokens=8` -- a request for justification that cannot fit in the reply
 * only manufactures Parse Failures.
 */
export const REFLEX_SCAFFOLD = `You are one of two fighters in a 1v1 duel. Your token budget is empty, so you are on reflex alone.

Reply with exactly one word: the Action you choose, taken from the legal Actions you are shown. No label, no punctuation, no explanation, nothing else.`;

/** Which of the two Scaffolds this Decision Point uses. Driven only by Reflex Mode -- never by who is answering. */
export function selectScaffold(reflexMode: boolean): string {
  return reflexMode ? REFLEX_SCAFFOLD : SCAFFOLD;
}

/**
 * Assembles the Prompt for one Decision Point (AC3: assembly happens in core).
 *
 * `observation.state` is embedded verbatim and last. Core never parses,
 * reformats, validates, or truncates it -- an Environment Adapter's serialised
 * state is opaque to the Harness by contract, and it is the adapter's *only*
 * contribution to what a model sees. Everything else in the user block is
 * core-owned and identical in shape for every Environment.
 *
 * Signature note: this is `Agent['observe']`, and Deployments use it directly
 * rather than wrapping it, so there is no per-Deployment seam between the
 * Scaffold and the wire.
 */
export function assemblePrompt(
  observation: Observation,
  budgetRemaining: number,
  reflexMode: boolean,
): Prompt {
  const user = [
    `TICK: ${observation.tick}`,
    `TOKEN BUDGET REMAINING: ${budgetRemaining}`,
    `LEGAL ACTIONS: ${observation.legalActions.join(', ')}`,
    'STATE:',
    observation.state,
  ].join('\n');

  return {
    system: selectScaffold(reflexMode),
    user,
    budgetRemaining,
    reflexMode,
  };
}
