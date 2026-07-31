import type { Action, AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
// Deep relative imports into packages/core, not `@tokenbrawl/core`: none of
// these packages declares `main`/`exports`, so the bare specifier does not
// resolve at runtime (already logged in the deferred-work ledger). The
// direction is the allowed one -- AD-1 forbids core depending on an adapter,
// not the reverse -- and ESLint's `no-restricted-imports` block is scoped to
// `packages/core/**`, so nothing here is being worked around.
//
// Importing `./command-log` pulls in Ajv and, through `canonical-hash`,
// `node:crypto`. That is fine *here* and nowhere else in this package: a test
// file is never bundled into the web app, which is why AD-4's audit check and
// `source-discipline.test.ts` both exempt `*.test.ts`.
import {
  buildCommandLog,
  computeConfigHash,
  validateCommandLog,
} from '../../core/src/command-log';
import { runMatch } from '../../core/src/match-runner';
import { replayCommandLog } from '../../core/src/replay';
import { createScriptedAgent } from '../../core/src/testing/mock-agent';
import { DEFAULT_FIGHTER_CONFIG } from './config';
import { createFighterEnvironment } from './environment';

/**
 * The fighter driven by the real Harness, end to end.
 *
 * Until this file, every guarantee in this package was asserted by calling
 * `step()`/`hash()` directly, and every `runMatch`/`replayCommandLog` test in
 * `packages/core` ran against `mock-environment.ts`. The two halves had never
 * met: an adapter that satisfies `EnvironmentAdapter` in isolation can still
 * be undriveable by the Harness (an `isActionable` that never clears, a
 * `terminal()` the loop cannot reach, a state the Command Log cannot carry),
 * and nothing would have caught it before Epic 4 tried to render a replay.
 */

const SEED = 4242;

/** Long enough for the tick cap: 1200 / 30 = 40 Decision Points, and an Agent is polled at most once each. */
function repeatPattern(pattern: readonly Action[], length: number): readonly Action[] {
  return Array.from({ length }, (_unused, index) => pattern[index % pattern.length]);
}

const AGGRESSIVE = repeatPattern(['advance', 'advance', 'attack', 'attack', 'block'], 60);
const TURTLE = repeatPattern(['block'], 60);

const AGENT_IDS: readonly [AgentIdentity, AgentIdentity] = [
  { id: 'bot-aggressive', kind: 'bot' },
  { id: 'bot-turtle', kind: 'bot' },
];

function fighterAgents(first: readonly Action[], second: readonly Action[]) {
  return [
    createScriptedAgent({ id: 'bot-aggressive', kind: 'bot', script: first }),
    createScriptedAgent({ id: 'bot-turtle', kind: 'bot', script: second }),
  ] as const;
}

describe('env-fighter driven by the real Harness', () => {
  it('runs a Match to a terminal result through runMatch', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);

    expect(result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(['ko', 'timeout']).toContain(result.result.endReason);
    expect(result.result.endTick).toBeLessThanOrEqual(DEFAULT_FIGHTER_CONFIG.maxTicks);
    expect(result.decisions.length).toBeGreaterThan(0);
  });

  it('reaches the tick cap and reports a timeout when neither side can score', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(TURTLE, TURTLE), SEED);

    expect(result.result.endReason).toBe('timeout');
    expect(result.result.endTick).toBe(DEFAULT_FIGHTER_CONFIG.maxTicks);
    expect(result.result.outcome).toBe('draw');
  });

  it('scores a KO when a fighter starts in range and the defender does not block', async () => {
    // Started in range deliberately rather than tuning an Action pattern to
    // close the gap in time: from the default 320-unit separation only one
    // side advances, `advanceCap` halves each step, and the aggressor lands
    // ~90 damage into a 100 health pool -- a timeout that turns on the exact
    // frame data Story 2.4 is going to change. This asserts the KO path is
    // reachable through the Harness, not what the numbers happen to be.
    // The defender advances rather than standing: `stand` is the Fallback
    // Action, and the frozen contract types `script` as `(Action | null)[]`
    // precisely so an Agent can never *choose* it. Advancing keeps the
    // defender in range without blocking, which is what this case needs.
    const env = createFighterEnvironment({ startPosition: [440, 520] });
    const brawler = repeatPattern(['attack'], 60);
    const closer = repeatPattern(['advance'], 60);
    const result = await runMatch(env, fighterAgents(brawler, closer), SEED);

    expect(result.result.endReason).toBe('ko');
    expect(result.result.outcome).toBe('p1');
    expect(result.result.healthRemaining[1]).toBe(0);
    // AC6's early exit: a KO ends the Match before the cap, so the Harness
    // stops issuing Decision Points rather than running out the clock.
    expect(result.result.endTick).toBeLessThan(DEFAULT_FIGHTER_CONFIG.maxTicks);
  });

  it('issues a Decision Point exactly every 30 Ticks, for actionable Agents only (AC6)', async () => {
    // The cadence claim from the Timing model table, read off the log the
    // Harness actually produced rather than from the adapter's own constants:
    // every tick present is a multiple of `ticksPerDecision`, they ascend with
    // no gaps, and each Decision Point carries one entry per Agent -- `null`
    // for a committed one, a real Action for an actionable one.
    const env = createFighterEnvironment();
    const brawler = repeatPattern(['attack'], 60);
    const result = await runMatch(env, fighterAgents(brawler, TURTLE), SEED);

    const ticks = [...new Set(result.decisions.map((entry) => entry.tick))];
    expect(ticks).toStrictEqual(
      ticks.map((_unused, index) => index * DEFAULT_FIGHTER_CONFIG.ticksPerDecision),
    );
    expect(result.decisions).toHaveLength(ticks.length * 2);
    expect(result.result.endTick).toBe(ticks.length * DEFAULT_FIGHTER_CONFIG.ticksPerDecision);
    expect(result.result.endTick).toBeLessThanOrEqual(DEFAULT_FIGHTER_CONFIG.maxTicks);
  });

  it('punishes a whiffed attack through the Harness, on the Agent that never got polled (AC2)', async () => {
    // The story's central mechanic, end to end. p1 attacks from out of range
    // while p2 closes; p1's 40-Tick window outlives the Decision Point, so at
    // the next boundary the Harness does not poll it -- and an Agent that is
    // not polled cannot block, which is exactly what the punish exploits.
    //
    // Method: the whiffer's punished Decision Points are the ones logged as
    // `action: null` for index 0, and the damage it took is read from the
    // terminal result. Comparing against the same Match where the opponent
    // spends those Decision Points blocking instead of attacking isolates the
    // punish from everything else the two scripts do.
    const env = createFighterEnvironment({ startPosition: [420, 540] });
    const whiffer = repeatPattern(['attack'], 60);
    const punisher = repeatPattern(['advance', 'attack'], 60);

    const punished = await runMatch(env, fighterAgents(whiffer, punisher), SEED);
    const unpunished = await runMatch(
      createFighterEnvironment({ startPosition: [420, 540] }),
      fighterAgents(whiffer, repeatPattern(['advance', 'block'], 60)),
      SEED,
    );

    const notPolled = punished.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action === null,
    );
    expect(notPolled.length).toBeGreaterThan(0);
    expect(punished.result.healthRemaining[0]).toBeLessThan(
      unpunished.result.healthRemaining[0],
    );
  });

  it('is polled once per actionable Agent per Decision Point, and never while committed (AC1)', async () => {
    // The load-bearing claim in docs/ARCHITECTURE.md: not polling an Agent
    // mid-Commitment-Window is what keeps call volume inside free-tier
    // quotas. It only holds if the Harness actually honours *this* adapter's
    // isActionable, which nothing had checked.
    //
    // Story 2.1's `attack` resolved within a single Decision Point and opened
    // no commitment at all, so this case had to prove the claim through
    // `special` at `specialMeterCost: 0` -- the only Story 2.1 Action with any
    // lockout. Story 2.2 gives `attack` itself a 40-Tick Commitment Window
    // (4 startup / 4 active / 32 recovery) that outlives the 30-Tick Decision
    // Point cadence, so the same claim is now provable directly through
    // `attack`, with no config override standing in for it.
    const env = createFighterEnvironment();
    const brawler = repeatPattern(['attack'], 60);
    const [aggressor, defender] = fighterAgents(brawler, TURTLE);
    const result = await runMatch(env, [aggressor, defender], SEED);

    const notPolled = result.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action === null,
    );
    expect(notPolled.length).toBeGreaterThan(0);

    const polled = result.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    expect(aggressor.decideCallCount()).toBe(polled.length);
    expect(defender.decideCallCount()).toBeGreaterThan(aggressor.decideCallCount());
  });

  it('leaves an Agent that only ever picks an unaffordable special fully inert (AC3)', async () => {
    // Deferred-work ledger item, now resolved: Story 2.2 has landed, and
    // `special` below its meter cost is no longer a silent no-op -- it is
    // rejected as illegal. `observe().legalActions` withholds it, and a
    // submission of it anyway resolves as the Fallback Action (`stand`),
    // exactly as a Parse Failure would. Because `stand` opens no commitment,
    // this Agent is still polled at *every* Decision Point (never committed),
    // still lands nothing, and the Match still times out at full health --
    // the same externally observable ending as 2.1, now reached through
    // illegal-Action rejection rather than a quiet no-op.
    const env = createFighterEnvironment();
    // Meter starts at 0 and never accrues (neither side ever lands a hit
    // against `block`/rejected-`special`), so `special` is illegal at every
    // Decision Point this Match reaches -- not just the first.
    expect(env.observe(env.reset(SEED), 0).legalActions).not.toContain('special');

    const special = repeatPattern(['special'], 60);
    const [stubborn, turtle] = fighterAgents(special, TURTLE);
    const result = await runMatch(env, [stubborn, turtle], SEED);

    const stubbornDecisions = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(stubbornDecisions.filter((entry) => entry.action === null)).toStrictEqual([]);
    // Every one of those polls really happened: an Agent that is never
    // committed is polled at every Decision Point, not merely logged as if it
    // were.
    expect(stubborn.decideCallCount()).toBe(stubbornDecisions.length);
    expect(result.result.endReason).toBe('timeout');
    expect(result.result.healthRemaining).toStrictEqual([
      DEFAULT_FIGHTER_CONFIG.initialHealth,
      DEFAULT_FIGHTER_CONFIG.initialHealth,
    ]);
  });

  it('produces a schema-valid Command Log', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);

    const log = buildCommandLog(result, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: AGENT_IDS,
    });

    expect(() => validateCommandLog(log)).not.toThrow();
    expect(log.environment).toStrictEqual({ id: 'fighter-1v1', version: '1.0.0' });
    expect(log.finalStateHash).toBe(result.finalStateHash);
    // Non-actionable ticks are filtered out of the log, so every entry that
    // survives carries a real Action.
    expect(log.decisions.every((entry) => entry.action !== null)).toBe(true);
  });

  it('replays that Command Log to a bit-identical Final-State Hash (INV-2)', async () => {
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);
    const log = buildCommandLog(result, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: AGENT_IDS,
    });

    const replayed = replayCommandLog(log, createFighterEnvironment());

    expect(replayed.matchesRecordedHash).toBe(true);
    expect(replayed.finalStateHash).toBe(result.finalStateHash);
    expect(replayed.result).toStrictEqual(result.result);
  });

  it('detects a tampered log rather than replaying it happily', async () => {
    // Confirms the case above is a real check and not an identity.
    const env = createFighterEnvironment();
    const result = await runMatch(env, fighterAgents(AGGRESSIVE, TURTLE), SEED);
    const log = buildCommandLog(result, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agents: AGENT_IDS,
    });

    const tampered = { ...log, seed: SEED + 1 };
    expect(replayCommandLog(tampered, createFighterEnvironment()).matchesRecordedHash).toBe(false);
  });

  it('produces identical Command Logs from identical seeds', async () => {
    const first = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED,
    );
    const second = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED,
    );

    expect(second.finalStateHash).toBe(first.finalStateHash);
    expect(second.decisions).toStrictEqual(first.decisions);
  });

  it('produces different Final-State Hashes from different seeds', async () => {
    const first = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED,
    );
    const other = await runMatch(
      createFighterEnvironment(),
      fighterAgents(AGGRESSIVE, TURTLE),
      SEED + 1,
    );

    expect(other.finalStateHash).not.toBe(first.finalStateHash);
  });
});
