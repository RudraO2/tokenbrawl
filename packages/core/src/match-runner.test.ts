import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Decision } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { runMatch } from './match-runner';
import { yieldMicrotasks } from './testing/async-delay';
import { createMockEnvironment } from './testing/mock-environment';
import { createScriptedAgent } from './testing/mock-agent';

const SEED = 42;

describe('runMatch: latency equivalence', () => {
  it('produces byte-identical decisions/result/hash regardless of one Agent taking many more microtask turns than the other', async () => {
    const makeEnv = () => createMockEnvironment({ maxTicks: 3, ticksPerDecision: 1 });

    const noDelayResult = await runMatch(
      makeEnv(),
      [
        createScriptedAgent({ id: 'p1', script: ['advance', 'attack', 'block'] }),
        createScriptedAgent({ id: 'p2', script: ['block', 'attack', 'advance'] }),
      ],
      SEED,
    );

    const asymmetricDelayResult = await runMatch(
      makeEnv(),
      [
        createScriptedAgent({ id: 'p1', script: ['advance', 'attack', 'block'], delay: () => yieldMicrotasks(0) }),
        createScriptedAgent({
          id: 'p2',
          script: ['block', 'attack', 'advance'],
          delay: () => yieldMicrotasks(100_000),
        }),
      ],
      SEED,
    );

    expect(asymmetricDelayResult).toStrictEqual(noDelayResult);
  });
});

describe('runMatch: never-returning Agent', () => {
  it('never resolves while an actionable Agent\'s decide() promise is stalled, and substitutes no default Action', async () => {
    let releaseHungAgent: ((decision: Decision) => void) | undefined;
    let observedBudgetRemaining: number | undefined;
    let observedReflexMode: boolean | undefined;
    const hungAgent: Agent = {
      id: 'hung',
      kind: 'bot',
      observe: (observation, budgetRemaining, reflexMode) => {
        observedBudgetRemaining = budgetRemaining;
        observedReflexMode = reflexMode;
        return {
          system: 'mock-scaffold',
          user: observation.state,
          budgetRemaining,
          reflexMode,
        };
      },
      decide: () =>
        new Promise<Decision>((resolve) => {
          releaseHungAgent = resolve;
        }),
    };

    const scriptedAgent = createScriptedAgent({ id: 'p1', script: ['advance'] });
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });

    let settled = false;
    const matchPromise = runMatch(env, [scriptedAgent, hungAgent], SEED);
    matchPromise.then(() => {
      settled = true;
    });

    // Pure microtask flushes -- no timer of any kind.
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }

    expect(settled).toBe(false);
    // Confirms runMatch actually threads its own budget/reflex values into
    // observe() rather than this test's mock coincidentally matching them.
    expect(observedBudgetRemaining).toBe(Number.MAX_SAFE_INTEGER);
    expect(observedReflexMode).toBe(false);

    // Clean teardown: release the stalled Agent so the suite can exit.
    expect(releaseHungAgent).toBeDefined();
    releaseHungAgent?.({
      action: 'block',
      tokensSpent: 0,
      reasoningTokens: 0,
      reasoning: null,
      rawResponse: 'block',
      provider: 'mock',
      endpoint: 'mock',
    });

    const result = await matchPromise;
    expect(result.result.endReason).toBe('timeout');
  });
});

describe('runMatch: simultaneity', () => {
  it('applies both Actions for one Decision Point in a single env.step call', async () => {
    const baseEnv = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const stepCalls: Array<readonly [unknown, unknown]> = [];
    const spiedEnv: typeof baseEnv = {
      ...baseEnv,
      step: (state, actions) => {
        stepCalls.push(actions);
        return baseEnv.step(state, actions);
      },
    };

    const agent0 = createScriptedAgent({ id: 'p1', script: ['attack'] });
    const agent1 = createScriptedAgent({ id: 'p2', script: ['attack'] });

    await runMatch(spiedEnv, [agent0, agent1], SEED);

    expect(stepCalls).toHaveLength(1);
    expect(stepCalls[0]).toStrictEqual(['attack', 'attack']);
  });

  it("builds both Agents' Prompts before either Agent's Decision exists for that tick", async () => {
    // Proves the structural claim, not a string-content proxy for it: both
    // observe() calls (which build the Prompt from pre-step state) must
    // complete before either decide() resolves. p1 is slow (many microtask
    // yields); if p2's observe() were ever deferred until after p1's
    // decide() resolved, 'observe:p2' would appear after 'decide-end:p1' in
    // the call log below.
    const callLog: string[] = [];
    const capturingAgent = (id: string, action: 'attack' | 'special', delayCycles: number): Agent => ({
      id,
      kind: 'bot',
      observe: (observation) => {
        callLog.push(`observe:${id}`);
        return {
          system: 'mock-scaffold',
          user: observation.state,
          budgetRemaining: Number.MAX_SAFE_INTEGER,
          reflexMode: false,
        };
      },
      decide: async () => {
        await yieldMicrotasks(delayCycles);
        callLog.push(`decide-end:${id}`);
        return {
          action,
          tokensSpent: 0,
          reasoningTokens: 0,
          reasoning: null,
          rawResponse: action,
          provider: 'mock',
          endpoint: 'mock',
        };
      },
    });

    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    await runMatch(env, [capturingAgent('p1', 'attack', 5000), capturingAgent('p2', 'special', 0)], SEED);

    expect(callLog).toStrictEqual(['observe:p1', 'observe:p2', 'decide-end:p2', 'decide-end:p1']);
  });
});

describe('runMatch: Commitment Window', () => {
  it('never polls an Agent for a Decision Point where isActionable is false, and logs a null action for it', async () => {
    const env = createMockEnvironment({
      maxTicks: 3,
      ticksPerDecision: 1,
      commitmentTicksAfterSpecial: 2,
      // Pinned well above anything 3 ticks of attackDamage could deplete, so
      // this test's pass/fail is coupled only to Commitment Window polling
      // behavior -- never to an incidental early KO from unrelated changes
      // to DEFAULT_MOCK_ENVIRONMENT_CONFIG's health/damage tuning.
      initialHealth: 1000,
    });

    const agent0 = createScriptedAgent({ id: 'p1', script: ['special'] });
    const agent1 = createScriptedAgent({ id: 'p2', script: ['attack', 'attack', 'attack'] });

    const result = await runMatch(env, [agent0, agent1], SEED);

    // agent0 is actionable only at tick 0 (plays 'special', which locks it
    // out for the next commitmentTicksAfterSpecial Decision Points).
    expect(agent0.decideCallCount()).toBe(1);
    expect(agent0.observeCallCount()).toBe(1);
    expect(agent1.decideCallCount()).toBe(3);

    const agent0Entries = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(agent0Entries).toStrictEqual([
      expect.objectContaining({ tick: 0, action: 'special' }),
      expect.objectContaining({ tick: 1, action: null }),
      expect.objectContaining({ tick: 2, action: null }),
    ]);

    const agent1Entries = result.decisions.filter((entry) => entry.agentIndex === 1);
    expect(agent1Entries.every((entry) => entry.action === 'attack')).toBe(true);
  });
});

describe('match-runner.ts source text', () => {
  it('contains no wall-clock or timer identifier (INV-1 machine check)', () => {
    const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'match-runner.ts');
    const source = readFileSync(filePath, 'utf-8');

    // Built via concatenation so this scanner's own source text never
    // contains the literal banned substrings -- scripts/audit-invariants.sh
    // greps every *.ts under packages/core, including .test.ts files, for
    // exactly these tokens, with no test-file exclusion for INV-1. Writing
    // them contiguously here would make this very test trip that gate.
    const bannedIdentifiers = [
      ['Date', '.', 'now'].join(''),
      ['performance', '.', 'now'].join(''),
      ['new', ' ', 'Date', '('].join(''),
      ['set', 'Timeout'].join(''),
      ['set', 'Interval'].join(''),
    ];

    for (const identifier of bannedIdentifiers) {
      expect(source.includes(identifier)).toBe(false);
    }
  });
});
