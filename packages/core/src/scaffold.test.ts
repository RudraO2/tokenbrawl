import { ACTIONS, type Agent, type Observation, type ProviderId } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { createDeployment } from './deployment';
import { ACTION_GRAMMAR } from './action-grammar';
import { REFLEX_SCAFFOLD, SCAFFOLD, assemblePrompt, selectScaffold } from './scaffold';
import { createMockProviderClient } from './testing/mock-provider';

const OBSERVATION: Observation = {
  state: '{"opponentHealth":90,"selfHealth":100,"separation":7}',
  legalActions: ['advance', 'retreat', 'attack', 'block'],
  tick: 24,
};

/**
 * Five Deployments differing in every axis a Deployment has: provider,
 * endpoint, model, and Agent id. If any of those could reach the Scaffold,
 * this set is where it would show.
 */
const CONFIGURED: readonly { provider: ProviderId; endpoint: string; model: string }[] = [
  { provider: 'groq', endpoint: 'https://api.groq.invalid/openai/v1', model: 'llama-3-8b' },
  { provider: 'cerebras', endpoint: 'https://api.cerebras.invalid/v1', model: 'qwen-3-32b' },
  { provider: 'google-ai-studio', endpoint: 'https://generativelanguage.invalid/v1beta', model: 'gemini-flash' },
  { provider: 'openrouter', endpoint: 'https://openrouter.invalid/api/v1', model: 'some-free-model' },
  { provider: 'xai', endpoint: 'https://api.x.invalid/v1', model: 'grok-mini' },
];

function deploymentsUnderTest(): readonly Agent[] {
  return CONFIGURED.map((identity) =>
    createDeployment({ client: createMockProviderClient({ ...identity, script: [] }) }),
  );
}

describe('the Scaffold is identical across Deployments (AC1, INV-7)', () => {
  it('every configured Deployment produces the byte-identical system prompt', () => {
    const systems = deploymentsUnderTest().map(
      (agent) => agent.observe(OBSERVATION, 5_000, false).system,
    );

    expect(systems).toHaveLength(CONFIGURED.length);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toBe(SCAFFOLD);
  });

  it('holds in Reflex Mode too', () => {
    const systems = deploymentsUnderTest().map(
      (agent) => agent.observe(OBSERVATION, 0, true).system,
    );

    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).toBe(REFLEX_SCAFFOLD);
  });

  it('produces the byte-identical user block too -- same Observation, same state serialisation', () => {
    const users = deploymentsUnderTest().map(
      (agent) => agent.observe(OBSERVATION, 5_000, false).user,
    );

    expect(new Set(users).size).toBe(1);
  });

  it('adding a provider requires no Scaffold change', () => {
    const newcomer = createDeployment({
      client: createMockProviderClient({
        provider: 'byok',
        endpoint: 'https://a-provider-that-did-not-exist.invalid/v1',
        model: 'brand-new-model',
        script: [],
      }),
    });

    expect(newcomer.observe(OBSERVATION, 5_000, false).system).toBe(SCAFFOLD);
    expect(newcomer.observe(OBSERVATION, 0, true).system).toBe(REFLEX_SCAFFOLD);
  });

  it('every Deployment shares one `observe` implementation, so there is no per-Deployment seam', () => {
    const observers = new Set(deploymentsUnderTest().map((agent) => agent.observe));
    expect(observers.size).toBe(1);
    expect([...observers][0]).toBe(assemblePrompt);
  });
});

describe('assemblePrompt (AC3: assembly is core-owned)', () => {
  it('takes exactly three parameters, none of which can identify a Deployment', () => {
    expect(assemblePrompt.length).toBe(3);
  });

  it('embeds the adapter state verbatim and opaquely', () => {
    const opaque = '<<<not JSON, not parsed, not ours>>>';
    const prompt = assemblePrompt({ ...OBSERVATION, state: opaque }, 5_000, false);

    expect(prompt.user).toContain(opaque);
  });

  it('carries the legal Actions, the Tick, and the remaining budget', () => {
    const prompt = assemblePrompt(OBSERVATION, 4_321, false);

    expect(prompt.user).toContain('LEGAL ACTIONS: advance, retreat, attack, block');
    expect(prompt.user).toContain('TICK: 24');
    expect(prompt.user).toContain('4321');
  });

  it('reports the legal Actions it was given, not the full Action set', () => {
    const prompt = assemblePrompt(OBSERVATION, 10, false);

    expect(prompt.user).not.toContain('special');
    expect(assemblePrompt({ ...OBSERVATION, legalActions: ACTIONS }, 10, false).user).toContain(
      'special',
    );
  });

  it('mirrors budgetRemaining and reflexMode onto the Prompt unchanged', () => {
    const main = assemblePrompt(OBSERVATION, 7, false);
    expect(main.budgetRemaining).toBe(7);
    expect(main.reflexMode).toBe(false);

    const reflex = assemblePrompt(OBSERVATION, 0, true);
    expect(reflex.budgetRemaining).toBe(0);
    expect(reflex.reflexMode).toBe(true);
  });

  it('is pure: the same inputs give a byte-identical Prompt every time', () => {
    const first = assemblePrompt(OBSERVATION, 5_000, false);
    const second = assemblePrompt(OBSERVATION, 5_000, false);

    expect(second).toStrictEqual(first);
  });
});

describe('the two Scaffold variants (AC4)', () => {
  it('selectScaffold is driven only by Reflex Mode', () => {
    expect(selectScaffold(false)).toBe(SCAFFOLD);
    expect(selectScaffold(true)).toBe(REFLEX_SCAFFOLD);
  });

  it('the main Scaffold carries the full Action grammar', () => {
    expect(SCAFFOLD).toContain(ACTION_GRAMMAR);
  });

  it('the Reflex variant is the bare-Action form: one word, no label, no reasoning invited', () => {
    expect(REFLEX_SCAFFOLD).not.toContain(ACTION_GRAMMAR);
    expect(REFLEX_SCAFFOLD).not.toContain('ACTION: <action>');
    expect(REFLEX_SCAFFOLD).toContain('exactly one word');
    expect(REFLEX_SCAFFOLD.length).toBeLessThan(SCAFFOLD.length);
  });

  it('neither variant interpolates anything: both are plain constants', () => {
    expect(SCAFFOLD).not.toContain('undefined');
    expect(REFLEX_SCAFFOLD).not.toContain('undefined');
  });
});
