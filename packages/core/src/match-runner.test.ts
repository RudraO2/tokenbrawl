import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, Decision } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { buildCommandLog, computeConfigHash } from './command-log';
import { runMatch } from './match-runner';
import { REFLEX_MAX_TOKENS, maxTokensFor } from './token-bank';
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
    // `hungAgent` is kind: 'bot' -- a Baseline Bot never touches a Token
    // Bank at all (Story 1.5), so it is always observed with the unmetered
    // sentinel (Number.MAX_SAFE_INTEGER, reflexMode false), exactly as
    // before Story 1.5 existed.
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

describe('runMatch: Token Bank (Story 1.5, I/O matrix)', () => {
  it('debits a Deployment bank by tokensSpent and writes tokensSpent/reasoningTokens/bankRemaining/reflexMode only for Deployment entries', async () => {
    const env = createMockEnvironment({ maxTicks: 3, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack', 'attack'],
      usage: [{ tokensSpent: 120, reasoningTokens: 40 }, { tokensSpent: 80 }, { tokensSpent: 0 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    expect(result.tokenBankStart).toBe(25_000);

    const p1Entries = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entries.map((entry) => entry.bankRemaining)).toStrictEqual([24_880, 24_800, 24_800]);
    expect(p1Entries.every((entry) => entry.reflexMode === false)).toBe(true);
    expect(p1Entries[0]?.tokensSpent).toBe(120);
    expect(p1Entries[0]?.reasoningTokens).toBe(40);
    // Usage row 2 supplied no reasoningTokens -- must come back null, never 0.
    expect(p1Entries[1]?.reasoningTokens).toBeNull();

    const p2Entries = result.decisions.filter((entry) => entry.agentIndex === 1);
    for (const entry of p2Entries) {
      expect(entry).not.toHaveProperty('tokensSpent');
      expect(entry).not.toHaveProperty('reasoningTokens');
      expect(entry).not.toHaveProperty('bankRemaining');
      expect(entry).not.toHaveProperty('reflexMode');
    }
  });

  it('exhaustion boundary: the emptying call logs reflexMode false, and only the next call is polled with reflexMode true / maxTokensFor 8', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [{ tokensSpent: 100 }, { tokensSpent: 0 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 100 });

    const p1Entries = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entries[0]).toMatchObject({ reflexMode: false, bankRemaining: 0 });
    expect(p1Entries[1]).toMatchObject({ reflexMode: true, bankRemaining: 0 });

    const prompts = agent0.capturedPrompts();
    expect(prompts[0]?.budgetRemaining).toBe(100);
    expect(prompts[0]?.reflexMode).toBe(false);
    expect(prompts[1]?.budgetRemaining).toBe(0);
    expect(prompts[1]?.reflexMode).toBe(true);
    expect(prompts[1] && maxTokensFor(prompts[1])).toBe(REFLEX_MAX_TOKENS);
  });

  it('overdraft: bankRemaining clamps at 0 rather than going negative, and all later calls are in Reflex Mode', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [{ tokensSpent: 500 }, { tokensSpent: 0 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 30 });

    const p1Entries = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entries[0]?.bankRemaining).toBe(0);
    // The I/O matrix's second clause: every later call stays Reflex Mode too,
    // not just the one that overdrew.
    expect(p1Entries[1]).toMatchObject({ reflexMode: true, bankRemaining: 0 });
  });

  it('both Deployments exhausted: the Match still reaches a normal TerminalResult with both in Reflex Mode, no error thrown', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [{ tokensSpent: 50 }, { tokensSpent: 0 }],
    });
    const agent1 = createScriptedAgent({
      id: 'dep:p2',
      kind: 'deployment',
      script: ['block', 'block'],
      usage: [{ tokensSpent: 50 }, { tokensSpent: 0 }],
    });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 50 });

    const finalTickEntries = result.decisions.filter((entry) => entry.tick === 1);
    expect(finalTickEntries).toHaveLength(2);
    expect(finalTickEntries.every((entry) => entry.reflexMode === true)).toBe(true);
    expect(result.result.endReason).toBe('timeout');
  });

  it('zero-size bank: every call from tick 0 is reflexMode true', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack'],
      usage: [{ tokensSpent: 0 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 0 });

    expect(result.decisions.find((entry) => entry.agentIndex === 0)?.reflexMode).toBe(true);
    expect(agent0.capturedPrompts()[0]?.reflexMode).toBe(true);
  });

  it('a null tokensSpent report leaves the bank untouched and is preserved as null, never coerced to 0', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [{ tokensSpent: null }, { tokensSpent: 100 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const p1Entries = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entries[0]?.tokensSpent).toBeNull();
    expect(p1Entries[0]?.bankRemaining).toBe(25_000);
    expect(p1Entries[1]?.bankRemaining).toBe(24_900);
  });

  it('a null tokensSpent report after Reflex Mode has already engaged leaves it engaged, with bankRemaining still 0', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [{ tokensSpent: 100 }, { tokensSpent: null }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 100 });

    const p1Entries = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entries[1]).toMatchObject({ tokensSpent: null, bankRemaining: 0, reflexMode: true });
  });

  it('bad usage report throws naming the Agent and the rejected value', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:bad-actor',
      kind: 'deployment',
      script: ['attack'],
      usage: [{ tokensSpent: -5 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    await expect(runMatch(env, [agent0, agent1], SEED)).rejects.toThrow(/dep:bad-actor/);
  });

  it('a Baseline Bot reporting the same garbage tokensSpent never throws -- it consumes nothing, so it is never validated', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({ id: 'bot:p1', kind: 'bot', script: ['attack'], usage: [{ tokensSpent: -5 }] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 100 });

    expect(result.decisions.find((entry) => entry.agentIndex === 0)).not.toHaveProperty('tokensSpent');
  });

  it('bad config throws from runMatch before any Agent is polled or observed', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({ id: 'dep:p1', kind: 'deployment', script: ['attack'] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    await expect(runMatch(env, [agent0, agent1], SEED, { tokenBankStart: -1 })).rejects.toThrow();
    expect(agent0.observeCallCount()).toBe(0);
    expect(agent0.decideCallCount()).toBe(0);
    expect(agent1.observeCallCount()).toBe(0);
    expect(agent1.decideCallCount()).toBe(0);
  });

  it('AC1 end-to-end: two Deployment Agents at tokenBankStart 25000, run through buildCommandLog, produce a log carrying tokenBankStart 25000 and per-decision bankRemaining tracking each Agent\'s running total', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [{ tokensSpent: 100 }, { tokensSpent: 50 }],
    });
    const agent1 = createScriptedAgent({
      id: 'dep:p2',
      kind: 'deployment',
      script: ['block', 'block'],
      usage: [{ tokensSpent: 30 }, { tokensSpent: 20 }],
    });

    const matchResult = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });
    const log = buildCommandLog(matchResult, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: computeConfigHash({ tokenBankStart: 25_000 }),
      agents: [
        { id: agent0.id, kind: 'deployment', deployment: { provider: 'groq', endpoint: 'https://api.groq.com', model: 'm' } },
        { id: agent1.id, kind: 'deployment', deployment: { provider: 'groq', endpoint: 'https://api.groq.com', model: 'm' } },
      ],
    });

    expect(log.tokenBankStart).toBe(25_000);
    const p1LogEntries = log.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1LogEntries.map((entry) => entry.bankRemaining)).toStrictEqual([24_900, 24_850]);
    const p2LogEntries = log.decisions.filter((entry) => entry.agentIndex === 1);
    expect(p2LogEntries.map((entry) => entry.bankRemaining)).toStrictEqual([24_970, 24_950]);
  });

  it('demonstrates the Reflex-Mode scaffold switch via a scripted test double (story AC: "the next call uses max_tokens=8 and a bare-Action scaffold") -- not a real Deployment Scaffold, which is Story 3.1\'s scope', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const observedSystems: string[] = [];
    // A test double, not the shared createScriptedAgent: it varies its
    // Prompt's `system` scaffold text based on the reflexMode runMatch hands
    // it, proving the switch the story's AC names is actually wired through
    // -- without this story building the real Deployment Scaffold (Story
    // 3.1's job) or a provider adapter (E3's job).
    const switchingAgent: Agent = {
      id: 'dep:switcher',
      kind: 'deployment',
      observe: (observation, budgetRemaining, reflexMode) => {
        const system = reflexMode ? 'bare-action-scaffold' : 'full-scaffold';
        observedSystems.push(system);
        return { system, user: observation.state, budgetRemaining, reflexMode };
      },
      decide: async () => ({
        action: 'attack',
        tokensSpent: 100,
        reasoningTokens: null,
        reasoning: null,
        rawResponse: 'attack',
        provider: 'mock',
        endpoint: 'mock',
      }),
    };
    const bot = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    await runMatch(env, [switchingAgent, bot], SEED, { tokenBankStart: 100 });

    // First call: bank not yet empty, full scaffold. Second call: the first
    // call's 100 tokensSpent emptied the bank, so this call is polled with
    // reflexMode true and gets the bare-Action scaffold.
    expect(observedSystems).toStrictEqual(['full-scaffold', 'bare-action-scaffold']);
  });
});

describe('runMatch: cache accounting and conservative debit (Story 3.5, I/O matrix)', () => {
  it('excludes cachedTokens from the debit and records them on the entry when the provider reports cache signal', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack'],
      usage: [{ tokensSpent: 120, cachedTokens: 40 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const [p1Entry] = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entry?.cachedTokens).toBe(40);
    // 120 spent, 40 cached -- only 80 debited.
    expect(p1Entry?.bankRemaining).toBe(24_920);
  });

  it('charges tokensSpent in full -- conservative -- when the provider reports no cache signal', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack'],
      usage: [{ tokensSpent: 120 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const [p1Entry] = result.decisions.filter((entry) => entry.agentIndex === 0);
    expect(p1Entry?.cachedTokens).toBeNull();
    expect(p1Entry?.bankRemaining).toBe(24_880);
  });

  it('surfaces per-Agent cache stats on the MatchResult, with the conservative call counted', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: ['attack', 'attack'],
      usage: [
        { tokensSpent: 100, cachedTokens: 25 },
        { tokensSpent: 100 },
      ],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const [p1Stats, p2Stats] = result.cacheStats;
    expect(p1Stats).toStrictEqual({
      agentIndex: 0,
      agentId: 'dep:p1',
      billableCalls: 2,
      totalTokens: 200,
      cachedTokens: 25,
      cacheHitRate: 0.125,
      conservativeDebitCalls: 1,
    });
    // A Baseline Bot bills nothing.
    expect(p2Stats.billableCalls).toBe(0);
  });
});

describe('runMatch: Parse Failure (Story 1.6, I/O matrix)', () => {
  it('Deployment Parse Failure: logs action stand, parseFailure true, verbatim rawResponse, and still debits the bank', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: [null],
      usage: [{ tokensSpent: 40 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const entry = result.decisions.find((d) => d.agentIndex === 0);
    const expectedRawResponse = `null:${agent0.capturedPrompts()[0]?.user}`;
    expect(entry).toMatchObject({
      action: 'stand',
      parseFailure: true,
      rawResponse: expectedRawResponse,
      tokensSpent: 40,
      bankRemaining: 24_960,
    });
    expect(agent0.decideCallCount()).toBe(1);

    // The sibling Agent's entry is untouched by the failing Agent's fallback.
    const sibling = result.decisions.find((d) => d.agentIndex === 1);
    expect(sibling).toMatchObject({ action: 'block' });
    expect(sibling).not.toHaveProperty('parseFailure');
  });

  it('Deployment Parse Failure with tokensSpent: null (Metering Probe result) leaves the bank untouched, never coerced to 0', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: [null],
      usage: [{ tokensSpent: null }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const entry = result.decisions.find((d) => d.agentIndex === 0);
    expect(entry).toMatchObject({
      action: 'stand',
      parseFailure: true,
      tokensSpent: null,
      bankRemaining: 25_000,
    });
  });

  it('Bot Parse Failure: logs action stand, parseFailure true, no banking fields', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({ id: 'bot:p1', kind: 'bot', script: [null] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED);

    const entry = result.decisions.find((d) => d.agentIndex === 0);
    expect(entry).toMatchObject({ action: 'stand', parseFailure: true });
    expect(entry).not.toHaveProperty('tokensSpent');
    expect(entry).not.toHaveProperty('bankRemaining');
    expect(agent0.decideCallCount()).toBe(1);

    const sibling = result.decisions.find((d) => d.agentIndex === 1);
    expect(sibling).toMatchObject({ action: 'block' });
    expect(sibling).not.toHaveProperty('parseFailure');
  });

  it('both Agents Parse-Fail at the same Decision Point independently', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: [null],
      usage: [{ tokensSpent: 10 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: [null] });

    const result = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });

    const entry0 = result.decisions.find((d) => d.agentIndex === 0);
    const entry1 = result.decisions.find((d) => d.agentIndex === 1);
    expect(entry0).toMatchObject({ action: 'stand', parseFailure: true, tokensSpent: 10, bankRemaining: 24_990 });
    expect(entry1).toMatchObject({ action: 'stand', parseFailure: true });
    expect(entry1).not.toHaveProperty('tokensSpent');
    expect(agent0.decideCallCount()).toBe(1);
    expect(agent1.decideCallCount()).toBe(1);
  });

  it('a successful Decision never carries a parseFailure key at all', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({ id: 'bot:p1', kind: 'bot', script: ['attack'] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const result = await runMatch(env, [agent0, agent1], SEED);

    for (const entry of result.decisions) {
      expect(entry).not.toHaveProperty('parseFailure');
    }
  });

  it('the Fallback Action is stand regardless of the Agent\'s previous logged Action, never a repeat', async () => {
    const env = createMockEnvironment({ maxTicks: 2, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({ id: 'bot:p1', kind: 'bot', script: ['attack', null] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block', 'block'] });

    const result = await runMatch(env, [agent0, agent1], SEED);

    const p1Entries = result.decisions.filter((d) => d.agentIndex === 0);
    expect(p1Entries[0]?.action).toBe('attack');
    expect(p1Entries[1]).toMatchObject({ action: 'stand', parseFailure: true });
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
