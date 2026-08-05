import { describe, expect, it } from 'vitest';
import type { Action, Observation } from '@tokenbrawl/contracts';
import { createHumanAgent } from './agent';

/**
 * Story 9.2: the boundary where a raw key becomes an `Action`, or is dropped.
 *
 * These tests are the machine form of the I/O matrix in the spec's
 * intent-contract: a legal mapped input resolves `decide()` with the right
 * `Action`; an unmapped key, or a mapped key not currently legal, never
 * resolves it and never crashes.
 */

const OBSERVATION = (legalActions: readonly Action[]): Observation => ({
  state: '{}',
  legalActions,
  tick: 0,
});

const KEYMAP: Record<string, Action> = {
  ArrowRight: 'advance',
  ArrowLeft: 'retreat',
  z: 'attack',
  x: 'block',
  c: 'special',
};

const mapInput = (raw: string): Action | null => KEYMAP[raw] ?? null;

describe('a legal mapped input resolves decide() (I/O matrix row 1)', () => {
  it('resolves with the mapped Action', async () => {
    const { agent, feedInput } = createHumanAgent('p1:human', mapInput);
    agent.observe(OBSERVATION(['advance', 'attack', 'block']), Number.MAX_SAFE_INTEGER, false);

    const pending = agent.decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false });
    feedInput('z');

    const decision = await pending;
    expect(decision.action).toBe('attack');
    expect(decision.tokensSpent).toBe(0);
    expect(decision.reasoning).toBeNull();
  });
});

describe('an unmapped key, or a mapped-but-illegal one, is dropped (I/O matrix row 2)', () => {
  it('never resolves decide() for a key with no mapping', async () => {
    const { agent, feedInput } = createHumanAgent('p1:human', mapInput);
    agent.observe(OBSERVATION(['advance', 'attack', 'block']), Number.MAX_SAFE_INTEGER, false);

    let resolved = false;
    void agent
      .decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false })
      .then(() => {
        resolved = true;
      });

    feedInput('Escape');
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('never resolves decide() for a mapped key that is not currently legal', async () => {
    const { agent, feedInput } = createHumanAgent('p1:human', mapInput);
    // 'attack' is mapped, but not legal at this Decision Point.
    agent.observe(OBSERVATION(['advance', 'block']), Number.MAX_SAFE_INTEGER, false);

    let resolved = false;
    void agent
      .decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false })
      .then(() => {
        resolved = true;
      });

    feedInput('z');
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('never throws for input fed before any observe() has run', () => {
    const { feedInput } = createHumanAgent('p1:human', mapInput);
    expect(() => feedInput('z')).not.toThrow();
  });

  it('drops input fed after decide() has already resolved once', async () => {
    const { agent, feedInput } = createHumanAgent('p1:human', mapInput);
    agent.observe(OBSERVATION(['advance', 'attack']), Number.MAX_SAFE_INTEGER, false);
    const first = agent.decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false });
    feedInput('z');
    const decision = await first;
    expect(decision.action).toBe('attack');

    // A second feed with no new observe()/decide() in between must be inert:
    // there is no pending promise to resolve.
    expect(() => feedInput('ArrowRight')).not.toThrow();
  });
});

describe('decide() called again before the previous call resolves (P4)', () => {
  it('throws a clear contract-violation error rather than orphaning the first promise', () => {
    const { agent } = createHumanAgent('p1:human', mapInput);
    agent.observe(OBSERVATION(['advance', 'attack']), Number.MAX_SAFE_INTEGER, false);

    void agent.decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false });

    expect(() =>
      agent.decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false }),
    ).toThrow(/decide\(\) was called again before its previous call resolved/);
  });
});

describe('a throwing mapInput is treated as no mapping (P5)', () => {
  it('drops the input silently instead of letting the exception escape feedInput', async () => {
    const throwingMapInput = (): Action | null => {
      throw new Error('boom');
    };
    const { agent, feedInput } = createHumanAgent('p1:human', throwingMapInput);
    agent.observe(OBSERVATION(['advance', 'attack']), Number.MAX_SAFE_INTEGER, false);

    let resolved = false;
    void agent
      .decide({ system: 'human', user: '{}', budgetRemaining: 0, reflexMode: false })
      .then(() => {
        resolved = true;
      });

    expect(() => feedInput('z')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
  });
});

describe('the Agent port shape (AD-14)', () => {
  it('is unmetered at the Agent-port level (kind: "bot")', () => {
    const { agent } = createHumanAgent('p1:human', mapInput);
    expect(agent.kind).toBe('bot');
    expect(agent.id).toBe('p1:human');
  });
});
