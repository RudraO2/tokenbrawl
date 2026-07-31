import type { Action, AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
// Deep relative imports into packages/core for the same reason
// `harness-integration.test.ts` uses them: no package declares `main`/`exports`
// yet, so the bare `@tokenbrawl/core` specifier does not resolve at runtime
// (already logged in the deferred-work ledger). AD-1 forbids core depending on
// an adapter, not the reverse, and ESLint's `no-restricted-imports` block is
// scoped to `packages/core/**`.
import { runMatch } from '../../core/src/match-runner';
import { createScriptedAgent } from '../../core/src/testing/mock-agent';
import { DEFAULT_FIGHTER_CONFIG } from './config';
import { createFighterEnvironment } from './environment';

/**
 * Side-swap symmetry: the story's Test plan item, "a mirrored-seed test
 * asserting no side advantage beyond what is intended".
 *
 * Story 2.2 made resolution tick-sensitive, and a tick loop is exactly where a
 * side advantage hides: an ordering bug in movement, in hit resolution, or in
 * the closing-room split shows up as p1 winning a fight p2 would have lost from
 * the identical position. Nothing here would be caught by same-side determinism
 * testing, which happily reproduces a biased engine bit for bit.
 *
 * Two intended asymmetries are configured away rather than asserted around:
 *
 *   - `damageJitter: 0`. The two sides deliberately draw jitter from disjoint
 *     bits of one PRNG word (Story 2.1) so that an RNG-threading bug affecting
 *     one side is observable. That is a real per-side difference, and leaving it
 *     on would mask the property this file exists to check.
 *   - A symmetric `startPosition`. The default start is already symmetric about
 *     the arena centre, but stating it here keeps the case honest if Story 2.4
 *     recalibrates the arena.
 *
 * Epic 7 Story 7.1 builds mirrored seeds and side swaps on top of this; a
 * violation caught here is a violation of that whole comparison.
 */

const SEED = 8675309;

const ARENA_CENTRE = (DEFAULT_FIGHTER_CONFIG.arenaMin + DEFAULT_FIGHTER_CONFIG.arenaMax) >> 1;
const HALF_GAP = 160;
const MIRRORED_START: readonly [number, number] = [ARENA_CENTRE - HALF_GAP, ARENA_CENTRE + HALF_GAP];

function mirroredEnvironment() {
  return createFighterEnvironment({
    startPosition: [MIRRORED_START[0], MIRRORED_START[1]],
    damageJitter: 0,
  });
}

const IDENTITIES: readonly [AgentIdentity, AgentIdentity] = [
  { id: 'bot-first', kind: 'bot' },
  { id: 'bot-second', kind: 'bot' },
];

function repeatPattern(pattern: readonly Action[], length: number): readonly Action[] {
  return Array.from({ length }, (_unused, index) => pattern[index % pattern.length]);
}

/** Two deliberately different styles: a rushdown pattern and a spacing one. */
const RUSHDOWN = repeatPattern(['advance', 'attack', 'attack', 'advance', 'block'], 60);
const SPACER = repeatPattern(['advance', 'block', 'attack', 'retreat', 'block'], 60);

function agentsFor(first: readonly Action[], second: readonly Action[]) {
  return [
    createScriptedAgent({ id: IDENTITIES[0].id, kind: 'bot', script: first }),
    createScriptedAgent({ id: IDENTITIES[1].id, kind: 'bot', script: second }),
  ] as const;
}

/** Actions in order for one Agent index, with the not-polled entries dropped. */
function actionsOf(
  decisions: readonly { readonly agentIndex: 0 | 1; readonly action: unknown }[],
  agentIndex: 0 | 1,
): readonly unknown[] {
  return decisions
    .filter((entry) => entry.agentIndex === agentIndex && entry.action !== null)
    .map((entry) => entry.action);
}

const MIRRORED_OUTCOME = { p1: 'p2', p2: 'p1', draw: 'draw' } as const;

describe('mirrored sides (no side advantage -- INV-2, Story 7.1 depends on this)', () => {
  it('produces the mirror-image result when the two scripts swap sides', async () => {
    const forwards = await runMatch(mirroredEnvironment(), agentsFor(RUSHDOWN, SPACER), SEED);
    const swapped = await runMatch(mirroredEnvironment(), agentsFor(SPACER, RUSHDOWN), SEED);

    expect(swapped.result.outcome).toBe(MIRRORED_OUTCOME[forwards.result.outcome]);
    expect(swapped.result.endReason).toBe(forwards.result.endReason);
    expect(swapped.result.endTick).toBe(forwards.result.endTick);
    expect(swapped.result.healthRemaining).toStrictEqual([
      forwards.result.healthRemaining[1],
      forwards.result.healthRemaining[0],
    ]);
  });

  it('polls each style the same number of times whichever side it plays', async () => {
    // Commitment Windows drive polling, so an asymmetry in how windows are
    // counted would show up here as one side getting more Decision Points --
    // which in a tournament is one side getting more tokens to think with.
    const forwards = await runMatch(mirroredEnvironment(), agentsFor(RUSHDOWN, SPACER), SEED);
    const swapped = await runMatch(mirroredEnvironment(), agentsFor(SPACER, RUSHDOWN), SEED);

    expect(actionsOf(swapped.decisions, 1)).toStrictEqual(actionsOf(forwards.decisions, 0));
    expect(actionsOf(swapped.decisions, 0)).toStrictEqual(actionsOf(forwards.decisions, 1));
  });

  it('is not vacuous: an asymmetric pairing does not mirror', async () => {
    // Without this, the cases above would pass just as happily against an
    // engine that ignored its Actions entirely and always reported a draw.
    const forwards = await runMatch(mirroredEnvironment(), agentsFor(RUSHDOWN, SPACER), SEED);
    const lopsided = await runMatch(mirroredEnvironment(), agentsFor(RUSHDOWN, RUSHDOWN), SEED);

    expect(lopsided.result.healthRemaining).not.toStrictEqual([
      forwards.result.healthRemaining[1],
      forwards.result.healthRemaining[0],
    ]);
  });

  it('keeps a symmetric pairing an exact draw at symmetric positions', async () => {
    // The strongest form of the property: identical styles from mirrored
    // positions can only diverge if the engine itself favours a side.
    const symmetric = await runMatch(mirroredEnvironment(), agentsFor(RUSHDOWN, RUSHDOWN), SEED);

    expect(symmetric.result.healthRemaining[0]).toBe(symmetric.result.healthRemaining[1]);
    expect(symmetric.result.outcome).toBe('draw');
  });
});
