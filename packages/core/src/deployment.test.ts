import { FALLBACK_ACTION, type Observation } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { buildCommandLog, computeConfigHash, computeMatchId, validateCommandLog } from './command-log';
import { createDeployment } from './deployment';
import { runMatch } from './match-runner';
import { REFLEX_MAX_TOKENS } from './token-bank';
import { createMockProviderClient } from './testing/mock-provider';
import { createScriptedAgent } from './testing/mock-agent';
import { createMockEnvironment } from './testing/mock-environment';

const OBSERVATION: Observation = {
  state: '{"separation":5}',
  legalActions: ['advance', 'retreat', 'attack', 'block', 'special'],
  tick: 12,
};

describe('createDeployment identity', () => {
  it('defaults the Agent id to provider:model', () => {
    const agent = createDeployment({
      client: createMockProviderClient({ provider: 'groq', model: 'llama-3-1-8b-instant', script: [] }),
    });

    expect(agent.id).toBe('groq:llama-3-1-8b-instant');
    expect(agent.kind).toBe('deployment');
  });

  it('honours an explicit id override', () => {
    const agent = createDeployment({
      client: createMockProviderClient({ script: [] }),
      id: 'groq:pinned-name',
    });

    expect(agent.id).toBe('groq:pinned-name');
  });

  it('rejects a blank model, endpoint, or id at construction', () => {
    expect(() =>
      createDeployment({ client: createMockProviderClient({ model: '', script: [] }) }),
    ).toThrow(/client\.model/);

    expect(() =>
      createDeployment({ client: createMockProviderClient({ endpoint: '   ', script: [] }) }),
    ).toThrow(/client\.endpoint/);

    expect(() =>
      createDeployment({ client: createMockProviderClient({ script: [] }), id: '  ' }),
    ).toThrow(/id/);
  });
});

describe('the request a Deployment sends (INV-4, AC4)', () => {
  it('sends the assembled system and user blocks unchanged', async () => {
    const client = createMockProviderClient({ script: ['attack'] });
    const agent = createDeployment({ client });
    const prompt = agent.observe(OBSERVATION, 5_000, false);

    await agent.decide(prompt);

    const [request] = client.capturedRequests();
    expect(request.system).toBe(prompt.system);
    expect(request.user).toBe(prompt.user);
  });

  it('requests max_tokens=8 in Reflex Mode', async () => {
    const client = createMockProviderClient({ script: ['attack'] });
    const agent = createDeployment({ client });

    await agent.decide(agent.observe(OBSERVATION, 0, true));

    expect(client.capturedRequests()[0].maxTokens).toBe(8);
    expect(client.capturedRequests()[0].maxTokens).toBe(REFLEX_MAX_TOKENS);
  });

  it('sends no cap at all outside Reflex Mode', async () => {
    const client = createMockProviderClient({ script: ['attack'] });
    const agent = createDeployment({ client });

    await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(client.capturedRequests()[0].maxTokens).toBeUndefined();
  });

  it('carries no effort, thinking, or budget parameter in the request body', async () => {
    const client = createMockProviderClient({ script: ['attack'] });
    const agent = createDeployment({ client });

    await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    const serialised = JSON.stringify(client.capturedRequests()[0]);
    for (const banned of ['reasoning_effort', 'thinkingLevel', 'thinking_budget', 'reasoning', 'thinking']) {
      expect(serialised).not.toContain(banned);
    }
    expect(Object.keys(client.capturedRequests()[0]).sort()).toStrictEqual([
      'maxTokens',
      'system',
      'user',
    ]);
  });

  it('calls the provider exactly once per decide(), parse failure or not', async () => {
    const client = createMockProviderClient({ script: ['attack', 'gibberish'] });
    const agent = createDeployment({ client });

    await agent.decide(agent.observe(OBSERVATION, 5_000, false));
    expect(client.callCount()).toBe(1);

    await agent.decide(agent.observe(OBSERVATION, 5_000, false));
    expect(client.callCount()).toBe(2);
  });
});

describe('the Decision a Deployment reports (AD-6, INV-5, INV-6)', () => {
  it('reports the parsed Action and the verbatim response', async () => {
    const client = createMockProviderClient({ script: ['ACTION: block'] });
    const agent = createDeployment({ client });

    const decision = await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(decision.action).toBe('block');
    expect(decision.rawResponse).toBe('ACTION: block');
  });

  it('reports an unparseable response as a Parse Failure with the raw text intact', async () => {
    const client = createMockProviderClient({ script: ['I think I will maybe attack or block'] });
    const agent = createDeployment({ client });

    const decision = await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(decision.action).toBeNull();
    expect(decision.rawResponse).toBe('I think I will maybe attack or block');
  });

  it('passes raw usage through and performs no arithmetic on it', async () => {
    const client = createMockProviderClient({
      script: [
        {
          text: 'attack',
          usage: { tokensSpent: 137, reasoningTokens: 90 },
          reasoning: 'they are open',
        },
      ],
    });
    const agent = createDeployment({ client });

    const decision = await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(decision.tokensSpent).toBe(137);
    expect(decision.reasoningTokens).toBe(90);
    expect(decision.reasoning).toBe('they are open');
  });

  it('preserves a null usage report rather than collapsing it to zero', async () => {
    const client = createMockProviderClient({
      script: [{ text: 'attack', usage: { tokensSpent: null, reasoningTokens: null } }],
    });
    const agent = createDeployment({ client });

    const decision = await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(decision.tokensSpent).toBeNull();
    expect(decision.reasoningTokens).toBeNull();
    expect(decision.reasoning).toBeNull();
  });

  it('records the client identity per call by default', async () => {
    const client = createMockProviderClient({
      provider: 'cerebras',
      endpoint: 'https://api.cerebras.invalid/v1/chat/completions',
      script: ['attack'],
    });
    const agent = createDeployment({ client });

    const decision = await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(decision.provider).toBe('cerebras');
    expect(decision.endpoint).toBe('https://api.cerebras.invalid/v1/chat/completions');
  });

  it('records a per-call override when the call was rerouted', async () => {
    const client = createMockProviderClient({
      provider: 'cerebras',
      endpoint: 'https://api.cerebras.invalid/v1/chat/completions',
      script: [
        {
          text: 'attack',
          usage: { tokensSpent: 5, reasoningTokens: null },
          provider: 'openrouter',
          endpoint: 'https://openrouter.invalid/api/v1/chat/completions',
        },
      ],
    });
    const agent = createDeployment({ client });

    const decision = await agent.decide(agent.observe(OBSERVATION, 5_000, false));

    expect(decision.provider).toBe('openrouter');
    expect(decision.endpoint).toBe('https://openrouter.invalid/api/v1/chat/completions');
  });
});

describe('a Deployment inside a real Match', () => {
  it('produces a schema-valid Command Log with per-entry provider and endpoint', async () => {
    const env = createMockEnvironment();
    const client = createMockProviderClient({
      provider: 'groq',
      endpoint: 'https://api.groq.invalid/openai/v1/chat/completions',
      model: 'llama-3-8b',
      script: Array.from({ length: 64 }, (_unused, index) => ({
        text: index === 1 ? 'hmm, not sure' : 'ACTION: attack',
        usage: { tokensSpent: 10, reasoningTokens: null },
      })),
    });
    const deployment = createDeployment({ client });
    const bot = createScriptedAgent({ id: 'bot:blocker', script: Array.from({ length: 64 }, () => 'block' as const) });

    const match = await runMatch(env, [deployment, bot], 7, { tokenBankStart: 1_000 });

    const deploymentEntries = match.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    expect(deploymentEntries.length).toBeGreaterThan(1);
    for (const entry of deploymentEntries) {
      expect(entry.provider).toBe('groq');
      expect(entry.endpoint).toBe('https://api.groq.invalid/openai/v1/chat/completions');
    }

    // The Harness owns the debit (AD-6): the Deployment did no bank arithmetic,
    // yet the bank still fell by the reported 10 per call.
    const banked = deploymentEntries.map((entry) => entry.bankRemaining);
    expect(banked[0]).toBe(990);
    expect(banked[1]).toBe(980);

    // The scripted unparseable second response became the Fallback Action.
    const failures = deploymentEntries.filter((entry) => entry.parseFailure === true);
    expect(failures).toHaveLength(1);
    expect(failures[0].action).toBe(FALLBACK_ACTION);
    expect(failures[0].rawResponse).toBe('hmm, not sure');

    const log = buildCommandLog(match, {
      environment: { id: env.id, version: env.version },
      seed: 7,
      configHash: computeConfigHash({}),
      agents: [
        {
          id: deployment.id,
          kind: 'deployment',
          deployment: {
            provider: 'groq',
            endpoint: 'https://api.groq.invalid/openai/v1/chat/completions',
            model: 'llama-3-8b',
          },
        },
        { id: 'bot:blocker', kind: 'bot' },
      ],
    });

    expect(deployment.id).toBe('groq:llama-3-8b');
    expect(() => validateCommandLog(log)).not.toThrow();
    expect(log.matchId).toBe(
      computeMatchId({
        environmentId: env.id,
        seed: 7,
        configHash: computeConfigHash({}),
        agentIds: [deployment.id, 'bot:blocker'],
      }),
    );
  });

  it('enters Reflex Mode once the bank empties, and the request is capped from then on', async () => {
    const env = createMockEnvironment();
    const client = createMockProviderClient({
      script: Array.from({ length: 64 }, () => ({
        text: 'ACTION: advance',
        usage: { tokensSpent: 30, reasoningTokens: null },
      })),
    });
    const deployment = createDeployment({ client });
    const bot = createScriptedAgent({ id: 'bot:blocker', script: Array.from({ length: 64 }, () => 'block' as const) });

    await runMatch(env, [deployment, bot], 7, { tokenBankStart: 60 });

    const caps = client.capturedRequests().map((request) => request.maxTokens);
    expect(caps.slice(0, 2)).toStrictEqual([undefined, undefined]);
    expect(caps.slice(2).every((cap) => cap === REFLEX_MAX_TOKENS)).toBe(true);
    expect(caps.length).toBeGreaterThan(2);
  });
});
