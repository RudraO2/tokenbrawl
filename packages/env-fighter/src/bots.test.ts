import type { Action, AgentIdentity } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
// Deep relative import into packages/core, mirroring harness-integration.test.ts's
// justification: neither package declares `main`/`exports`, and a test file is
// exempt from AD-4's Node-built-in sweep (buildCommandLog pulls in Ajv and
// node:crypto through command-log.ts).
import { buildCommandLog, computeConfigHash, validateCommandLog } from '../../core/src/command-log';
import { runMatch } from '../../core/src/match-runner';
import { createAggressiveBot, createRandomBot, createSpacingBot } from './bots';
import { COMMITTED_ATTACK, PHASE_RECOVERY, rangeForCode } from './frames';
import { DEFAULT_FIGHTER_CONFIG } from './config';
import { createFighterEnvironment } from './environment';

const SEED = 777;

describe('Baseline Bots (Story 2.3)', () => {
  describe('random bot', () => {
    it('selects uniformly from legal Actions using the match PRNG (AC1)', async () => {
      const env = createFighterEnvironment();
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createRandomBot('bot:random', SEED);

      const seen = new Set<Action>();
      for (let i = 0; i < 200; i += 1) {
        const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
        expect(decision.action).not.toBeNull();
        expect(observation.legalActions).toContain(decision.action);
        seen.add(decision.action as Action);
      }
      // Over 200 draws from a 5-Action grammar, every legal Action must have
      // come up at least once -- a generator wired to a constant bit would
      // still pass a single-draw assertion.
      expect(seen.size).toBe(observation.legalActions.length);
    });

    it('produces an identical Action sequence for the same seed and opponent (AC5)', async () => {
      const env = createFighterEnvironment();
      const opponent = () => Array.from({ length: 40 }, () => 'block' as const);

      const first = await runMatch(
        env,
        [createRandomBot('bot:random', SEED), scriptedBlockAgent(opponent())],
        SEED,
      );
      const second = await runMatch(
        createFighterEnvironment(),
        [createRandomBot('bot:random', SEED), scriptedBlockAgent(opponent())],
        SEED,
      );

      expect(second.decisions).toStrictEqual(first.decisions);
      expect(second.finalStateHash).toBe(first.finalStateHash);
    });

    it('consumes zero tokens', async () => {
      const env = createFighterEnvironment();
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createRandomBot('bot:random', SEED);
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.tokensSpent).toBe(0);
    });
  });

  describe('aggressive bot', () => {
    it('closes distance when out of attackRange (AC-behavioural)', async () => {
      const env = createFighterEnvironment();
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createAggressiveBot('bot:aggressive');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      // Default startPosition separates the fighters by 320 units, well
      // outside attackRange (80): the bot must close rather than attack.
      expect(decision.action).toBe('advance');
    });

    it('attacks whenever in range, regardless of the opponent phase (no punish awareness)', async () => {
      const env = createFighterEnvironment({ startPosition: [440, 480] });
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createAggressiveBot('bot:aggressive');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.action).toBe('attack');
    });

    it('is deterministic for the same seed and opponent (AC5)', async () => {
      const opponent = () => Array.from({ length: 40 }, () => 'block' as const);
      const first = await runMatch(
        createFighterEnvironment(),
        [createAggressiveBot('bot:aggressive'), scriptedBlockAgent(opponent())],
        SEED,
      );
      const second = await runMatch(
        createFighterEnvironment(),
        [createAggressiveBot('bot:aggressive'), scriptedBlockAgent(opponent())],
        SEED,
      );
      expect(second.decisions).toStrictEqual(first.decisions);
    });
  });

  describe('spacing-aware bot', () => {
    it('does not attack out of range', async () => {
      const env = createFighterEnvironment();
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createSpacingBot('bot:spacing');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.action).not.toBe('attack');
    });

    it('attacks when the opponent is inside attackRange and not vulnerable', async () => {
      const config = DEFAULT_FIGHTER_CONFIG;
      const attackRange = rangeForCode(config, COMMITTED_ATTACK);
      const env = createFighterEnvironment({ startPosition: [500, 500 + attackRange] });
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createSpacingBot('bot:spacing');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.action).toBe('attack');
    });

    it('retreats to hold range rather than overextending well inside attackRange', async () => {
      const env = createFighterEnvironment({ startPosition: [460, 510] });
      const observation = env.observe(env.reset(SEED), 0);
      const bot = createSpacingBot('bot:spacing');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.action).toBe('retreat');
    });

    it('punishes an observed recovery even from well inside attackRange (AC2)', async () => {
      // Drive p2 into an attack's recovery phase, then hand a spacing bot a
      // hand-built Observation whose opponentPhase reports PHASE_RECOVERY at
      // close range -- the exact condition a normal hold would retreat from.
      const env = createFighterEnvironment({ startPosition: [460, 510] });
      let state = env.reset(SEED);
      // p2 commits to `attack`; p1 is not actionable yet at reset so it
      // submits nothing. One Decision Point later p2's 40-Tick window has
      // consumed its 4-Tick startup and 4-Tick active phase (this config's
      // `ticksPerDecision` is 30), landing it in recovery.
      state = env.step(state, [null, 'attack']);

      const observation = env.observe(state, 0);
      const parsed = JSON.parse(observation.state) as { opponentPhase: number };
      expect(parsed.opponentPhase).toBe(PHASE_RECOVERY);

      const bot = createSpacingBot('bot:spacing');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.action).toBe('attack');
    });

    it('closes rather than swings at a recovering opponent still out of attackRange', async () => {
      // Recovery alone is not enough to punish -- the recovering opponent
      // must also be inside attackRange, or `step()` would drop the attack
      // as a whiff. Same setup as the punish case above, but started far
      // enough apart that p2's recovery leaves it still out of range.
      const env = createFighterEnvironment({ startPosition: [200, 700] });
      let state = env.reset(SEED);
      state = env.step(state, [null, 'attack']);

      const observation = env.observe(state, 0);
      const parsed = JSON.parse(observation.state) as { opponentPhase: number; separation: number };
      expect(parsed.opponentPhase).toBe(PHASE_RECOVERY);
      expect(parsed.separation).toBeGreaterThan(rangeForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK));

      const bot = createSpacingBot('bot:spacing');
      const decision = await bot.decide(bot.observe(observation, Number.MAX_SAFE_INTEGER, false));
      expect(decision.action).toBe('advance');
    });

    it('is deterministic for the same seed and opponent (AC5)', async () => {
      const opponent = () => Array.from({ length: 40 }, () => 'block' as const);
      const first = await runMatch(
        createFighterEnvironment(),
        [createSpacingBot('bot:spacing'), scriptedBlockAgent(opponent())],
        SEED,
      );
      const second = await runMatch(
        createFighterEnvironment(),
        [createSpacingBot('bot:spacing'), scriptedBlockAgent(opponent())],
        SEED,
      );
      expect(second.decisions).toStrictEqual(first.decisions);
    });
  });

  describe('every Baseline Bot through the real Harness', () => {
    const AGENT_IDS: readonly [AgentIdentity, AgentIdentity] = [
      { id: 'bot:random', kind: 'bot' },
      { id: 'bot:aggressive', kind: 'bot' },
    ];

    it('consumes zero tokens and logs kind: "bot" with no deployment object (AC4)', async () => {
      const env = createFighterEnvironment();
      const result = await runMatch(
        env,
        [createRandomBot('bot:random', SEED), createAggressiveBot('bot:aggressive')],
        SEED,
      );

      expect(result.decisions.length).toBeGreaterThan(0);
      for (const entry of result.decisions) {
        expect('tokensSpent' in entry).toBe(false);
        expect('bankRemaining' in entry).toBe(false);
        expect('reflexMode' in entry).toBe(false);
      }

      const log = buildCommandLog(result, {
        environment: { id: env.id, version: env.version },
        seed: SEED,
        configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
        agents: AGENT_IDS,
      });

      expect(() => validateCommandLog(log)).not.toThrow();
      for (const agent of log.agents) {
        expect(agent.kind).toBe('bot');
        expect('deployment' in agent).toBe(false);
      }
    });
  });
});

/**
 * A trivial `block`-scripted opponent Agent, hand-rolled here rather than
 * pulled from `packages/core/src/testing/mock-agent.ts` so this file's only
 * cross-package test dependency is `command-log.ts`/`match-runner.ts`
 * themselves -- both already justified above.
 */
function scriptedBlockAgent(script: readonly Action[]) {
  let cursor = 0;
  return {
    id: 'bot:turtle',
    kind: 'bot' as const,
    observe(observation: { state: string }, budgetRemaining: number, reflexMode: boolean) {
      return { system: 'turtle', user: observation.state, budgetRemaining, reflexMode };
    },
    async decide() {
      const action = script[cursor];
      cursor += 1;
      return {
        action,
        tokensSpent: 0,
        reasoningTokens: null,
        reasoning: null,
        rawResponse: 'block',
        provider: 'bot',
        endpoint: 'bot',
      };
    },
  };
}
