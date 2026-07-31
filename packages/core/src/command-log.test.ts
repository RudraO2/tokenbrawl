import type { CommandLog } from '@tokenbrawl/contracts';
import { SCHEMA_VERSION } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import commandLogSchema from '../../../docs/contracts/command-log.schema.json';
import { canonicalStringify, sha256Hex } from './canonical-hash';
import { buildCommandLog, computeConfigHash, computeMatchId, validateCommandLog } from './command-log';
import { createMockEnvironment } from './testing/mock-environment';
import { createScriptedAgent } from './testing/mock-agent';
import { runMatch } from './match-runner';
import type { MatchResult } from './match-runner';

const SEED = 42;

/** Any 64-char lowercase hex string satisfies both the `sha256` and `matchId` schema patterns. */
const FIXTURE_HASH = sha256Hex('fixture');
// Distinct per-field fixture hashes so a bug that swaps two of matchId/
// configHash/finalStateHash in buildCommandLog's candidate object would make
// a test fail instead of silently round-tripping under one shared value.
const FIXTURE_MATCH_ID = sha256Hex('fixture-match-id');
const FIXTURE_CONFIG_HASH = sha256Hex('fixture-config-hash');
const FIXTURE_STATE_HASH = sha256Hex('fixture-state-hash');

function baseCommandLog(overrides: Partial<CommandLog> = {}): CommandLog {
  return {
    schemaVersion: SCHEMA_VERSION,
    matchId: FIXTURE_MATCH_ID,
    environment: { id: 'mock-environment', version: '1.0.0' },
    seed: SEED,
    configHash: FIXTURE_CONFIG_HASH,
    agents: [
      { id: 'bot:p1', kind: 'bot' },
      { id: 'bot:p2', kind: 'bot' },
    ],
    decisions: [],
    result: { outcome: 'p1', endTick: 3, endReason: 'timeout', healthRemaining: [10, 5] },
    finalStateHash: FIXTURE_STATE_HASH,
    ...overrides,
  };
}

describe('types and schema agree', () => {
  it('SCHEMA_VERSION matches the schema JSON\'s pinned const', () => {
    expect(SCHEMA_VERSION).toBe(
      (commandLogSchema as { properties: { schemaVersion: { const: string } } }).properties.schemaVersion.const,
    );
  });

  it('a fully-populated CommandLog literal validates', () => {
    const log = baseCommandLog({
      tokenBankStart: 25000,
      decisions: [
        {
          tick: 0,
          agentIndex: 0,
          action: 'attack',
          tokensSpent: 12,
          reasoningTokens: 4,
          bankRemaining: 24988,
          reflexMode: false,
          parseFailure: false,
          reasoning: 'thinking',
          rawResponse: 'attack',
          provider: 'mock',
          endpoint: 'mock',
        },
      ],
      reasoningSidecar: null,
    });

    expect(validateCommandLog(log)).toStrictEqual(log);
  });
});

describe('Round-trip (I/O matrix)', () => {
  it('a MatchResult from runMatch, built into a CommandLog, survives JSON round-trip validation', async () => {
    const env = createMockEnvironment({
      maxTicks: 3,
      ticksPerDecision: 1,
      commitmentTicksAfterSpecial: 2,
      initialHealth: 1000,
    });

    const agent0 = createScriptedAgent({ id: 'bot:p1', script: ['special'] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', script: ['attack', 'attack', 'attack'] });

    const matchResult = await runMatch(env, [agent0, agent1], SEED);

    const log = buildCommandLog(matchResult, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: FIXTURE_HASH,
      agents: [
        { id: agent0.id, kind: 'bot' },
        { id: agent1.id, kind: 'bot' },
      ],
    });

    const roundTripped = validateCommandLog(JSON.parse(JSON.stringify(log)));
    expect(roundTripped).toStrictEqual(log);
  });
});

describe('Commitment-Window tick (I/O matrix)', () => {
  it('omits the tick/agentIndex pair for a MatchDecisionEntry whose action is null', async () => {
    const env = createMockEnvironment({
      maxTicks: 3,
      ticksPerDecision: 1,
      commitmentTicksAfterSpecial: 2,
      initialHealth: 1000,
    });

    const agent0 = createScriptedAgent({ id: 'bot:p1', script: ['special'] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', script: ['attack', 'attack', 'attack'] });

    const matchResult = await runMatch(env, [agent0, agent1], SEED);

    // The raw MatchResult does contain null-action entries for agent0's
    // Commitment Window ticks -- proving the omission is buildCommandLog's
    // doing, not an artefact of the match never producing them.
    expect(matchResult.decisions.some((d) => d.action === null)).toBe(true);

    const log = buildCommandLog(matchResult, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: FIXTURE_HASH,
      agents: [
        { id: agent0.id, kind: 'bot' },
        { id: agent1.id, kind: 'bot' },
      ],
    });

    const agent0Entries = log.decisions.filter((d) => d.agentIndex === 0);
    expect(agent0Entries).toHaveLength(1);
    expect(agent0Entries[0]?.tick).toBe(0);
    expect(log.decisions.every((d) => (d.action as string | null) !== null)).toBe(true);
  });
});

describe('Unknown schemaVersion (I/O matrix)', () => {
  it('throws before Ajv ever runs when schemaVersion is an unrecognised value, naming the rejected version', () => {
    const candidate: unknown = { ...baseCommandLog(), schemaVersion: '2.0.0' };

    expect(() => validateCommandLog(candidate)).toThrow(/2\.0\.0/);
  });

  it('throws when schemaVersion is missing entirely', () => {
    const { schemaVersion: _schemaVersion, ...rest } = baseCommandLog();
    const candidate: unknown = rest;

    expect(() => validateCommandLog(candidate)).toThrow();
  });
});

describe('Config change (I/O matrix)', () => {
  it('computeConfigHash returns different hex strings for configs differing in one field', () => {
    const hashA = computeConfigHash({ tickRate: 60, tokenBankStart: 25000 });
    const hashB = computeConfigHash({ tickRate: 60, tokenBankStart: 30000 });

    expect(hashA).not.toBe(hashB);
  });
});

describe('Key-order stability (I/O matrix)', () => {
  it('computeConfigHash returns the identical hex string for the same config in two different key orders', () => {
    const hashA = computeConfigHash({ a: 1, b: 2, c: 3 });
    const hashB = computeConfigHash({ c: 3, a: 1, b: 2 });

    expect(hashA).toBe(hashB);
  });
});

describe('matchId determinism (I/O matrix)', () => {
  it('computeMatchId returns the identical id for the same (environmentId, seed, configHash, agentIds) twice', () => {
    const params = {
      environmentId: 'mock-environment',
      seed: SEED,
      configHash: FIXTURE_HASH,
      agentIds: ['bot:p1', 'bot:p2'] as [string, string],
    };

    expect(computeMatchId(params)).toBe(computeMatchId({ ...params }));
  });

  it('matches the schema\'s matchId pattern', () => {
    const matchId = computeMatchId({
      environmentId: 'mock-environment',
      seed: SEED,
      configHash: FIXTURE_HASH,
      agentIds: ['bot:p1', 'bot:p2'],
    });

    expect(matchId).toMatch(/^[a-z0-9-]{8,64}$/);
  });
});

describe('Parse Failure entry (I/O matrix)', () => {
  it('validates when parseFailure is true, rawResponse is present, and action is stand', () => {
    const log = baseCommandLog({
      decisions: [
        { tick: 0, agentIndex: 0, action: 'stand', parseFailure: true, rawResponse: 'garbled output' },
      ],
    });

    expect(validateCommandLog(log)).toStrictEqual(log);
  });

  it('throws with Ajv error text when parseFailure is true but rawResponse is omitted', () => {
    const log = baseCommandLog({
      decisions: [{ tick: 0, agentIndex: 0, action: 'stand', parseFailure: true }],
    });

    expect(() => validateCommandLog(log)).toThrow(/rawResponse/);
  });

  it('Story 1.6: a real runMatch Parse Failure survives buildCommandLog and validates end-to-end', async () => {
    const env = createMockEnvironment({ maxTicks: 1, ticksPerDecision: 1 });
    const agent0 = createScriptedAgent({
      id: 'dep:p1',
      kind: 'deployment',
      script: [null],
      usage: [{ tokensSpent: 15 }],
    });
    const agent1 = createScriptedAgent({ id: 'bot:p2', kind: 'bot', script: ['block'] });

    const matchResult = await runMatch(env, [agent0, agent1], SEED, { tokenBankStart: 25_000 });
    const log = buildCommandLog(matchResult, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash: FIXTURE_CONFIG_HASH,
      agents: [
        { id: agent0.id, kind: 'deployment', deployment: { provider: 'groq', endpoint: 'https://api.groq.com', model: 'm' } },
        { id: agent1.id, kind: 'bot' },
      ],
    });

    const entry = log.decisions.find((d) => d.agentIndex === 0);
    expect(entry).toMatchObject({ action: 'stand', parseFailure: true, tokensSpent: 15 });
    expect(entry?.rawResponse).toBeTruthy();
    expect(validateCommandLog(log)).toStrictEqual(log);
  });
});

describe('additionalProperties: false', () => {
  it('rejects a stray top-level property no consumer declared', () => {
    const log = { ...baseCommandLog(), extraField: 'not in the schema' };

    expect(() => validateCommandLog(log)).toThrow();
  });

  it('rejects a stray property on a decision entry', () => {
    const log = baseCommandLog({
      decisions: [{ tick: 0, agentIndex: 0, action: 'attack', notASchemaField: true } as never],
    });

    expect(() => validateCommandLog(log)).toThrow();
  });
});

describe('Non-integer in hashed input (I/O matrix)', () => {
  it('canonicalStringify throws before hashing when the input contains a non-integer number', () => {
    expect(() => canonicalStringify({ tickRate: 1.5 })).toThrow();
  });

  it('computeConfigHash throws for the same reason, never silently truncating', () => {
    expect(() => computeConfigHash({ tickRate: 1.5 })).toThrow();
  });
});

describe('Deployment agent identity (format: "uri")', () => {
  it('validates a deployment agent whose endpoint is a well-formed URI', () => {
    const log = baseCommandLog({
      agents: [
        {
          id: 'groq:llama',
          kind: 'deployment',
          deployment: { provider: 'groq', endpoint: 'https://api.groq.com/openai/v1', model: 'llama-3.1-70b' },
        },
        { id: 'bot:p2', kind: 'bot' },
      ],
    });

    expect(validateCommandLog(log)).toStrictEqual(log);
  });

  it('rejects a deployment agent whose endpoint is not a well-formed URI', () => {
    const log = baseCommandLog({
      agents: [
        {
          id: 'groq:llama',
          kind: 'deployment',
          deployment: { provider: 'groq', endpoint: 'not-a-uri', model: 'llama-3.1-70b' },
        },
        { id: 'bot:p2', kind: 'bot' },
      ],
    });

    expect(() => validateCommandLog(log)).toThrow();
  });

  it('rejects a deployment-kind agent with no deployment object', () => {
    const log = baseCommandLog({
      agents: [{ id: 'groq:llama', kind: 'deployment' } as never, { id: 'bot:p2', kind: 'bot' }],
    });

    expect(() => validateCommandLog(log)).toThrow();
  });
});

describe('canonicalStringify edge cases', () => {
  it('throws on a self-referential object rather than crashing with an uncaught RangeError', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    expect(() => canonicalStringify(circular)).toThrow(/circular/i);
  });

  it('throws on a non-plain object (e.g. a Date) instead of silently serialising it as "{}"', () => {
    expect(() => canonicalStringify({ when: new Date() })).toThrow(/non-plain object/);
  });

  it('throws on a sparse array hole instead of silently dropping it', () => {
    const sparse = [1, , 3];

    expect(() => canonicalStringify(sparse)).toThrow();
  });

  it('produces different output for a nested object vs. a flat one with the same leaf values', () => {
    const nested = canonicalStringify({ a: { b: 1 } });
    const flat = canonicalStringify({ a: 1, b: 1 });

    expect(nested).not.toBe(flat);
  });
});

describe('computeConfigHash wired through buildCommandLog end-to-end', () => {
  it('buildCommandLog and computeMatchId both accept a real computeConfigHash output and validate', async () => {
    const env = createMockEnvironment({
      maxTicks: 1,
      ticksPerDecision: 1,
      commitmentTicksAfterSpecial: 2,
      initialHealth: 1000,
    });

    const agent0 = createScriptedAgent({ id: 'bot:p1', script: ['attack'] });
    const agent1 = createScriptedAgent({ id: 'bot:p2', script: ['attack'] });

    const matchResult = await runMatch(env, [agent0, agent1], SEED);
    const configHash = computeConfigHash({ tickRate: 60, tokenBankStart: 25000 });

    const log = buildCommandLog(matchResult, {
      environment: { id: env.id, version: env.version },
      seed: SEED,
      configHash,
      agents: [
        { id: agent0.id, kind: 'bot' },
        { id: agent1.id, kind: 'bot' },
      ],
    });

    expect(log.configHash).toBe(configHash);
    expect(log.matchId).toBe(
      computeMatchId({
        environmentId: env.id,
        seed: SEED,
        configHash,
        agentIds: [agent0.id, agent1.id],
      }),
    );
    expect(validateCommandLog(JSON.parse(JSON.stringify(log)))).toStrictEqual(log);
  });
});

describe('buildCommandLog optional-field omission', () => {
  it('omits keys whose source value is undefined and keeps a null reasoning/rawResponse value', () => {
    const matchResult: MatchResult = {
      decisions: [
        {
          tick: 0,
          agentIndex: 0,
          action: 'stand',
          parseFailure: true,
          bankRemaining: 100,
          reflexMode: true,
          reasoning: null,
          rawResponse: 'garbled',
          // tokensSpent, reasoningTokens, provider, endpoint deliberately
          // left undefined -- must be omitted, not written as `undefined`.
        },
      ],
      result: { outcome: 'p1', endTick: 1, endReason: 'timeout', healthRemaining: [10, 5] },
      finalStateHash: FIXTURE_STATE_HASH,
      tokenBankStart: 25_000,
      cacheStats: [
        { agentIndex: 0, agentId: 'bot:p1', billableCalls: 0, totalTokens: 0, cachedTokens: 0, cacheHitRate: 0, conservativeDebitCalls: 0 },
        { agentIndex: 1, agentId: 'bot:p2', billableCalls: 0, totalTokens: 0, cachedTokens: 0, cacheHitRate: 0, conservativeDebitCalls: 0 },
      ],
    };

    const log = buildCommandLog(matchResult, {
      environment: { id: 'mock-environment', version: '1.0.0' },
      seed: SEED,
      configHash: FIXTURE_CONFIG_HASH,
      agents: [
        { id: 'bot:p1', kind: 'bot' },
        { id: 'bot:p2', kind: 'bot' },
      ],
    });

    const entry = log.decisions[0];
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('tokensSpent');
    expect(entry).not.toHaveProperty('reasoningTokens');
    expect(entry).not.toHaveProperty('provider');
    expect(entry).not.toHaveProperty('endpoint');
    expect(entry?.parseFailure).toBe(true);
    expect(entry?.bankRemaining).toBe(100);
    expect(entry?.reflexMode).toBe(true);
    expect(entry?.reasoning).toBeNull();
    expect(entry?.rawResponse).toBe('garbled');
    // Both agents are bots -- absent regardless of what MatchResult carried.
    expect(log).not.toHaveProperty('tokenBankStart');
  });
});

describe('buildCommandLog tokenBankStart reconciliation (Story 1.5, I/O matrix)', () => {
  function matchResultWith(tokenBankStart: number): MatchResult {
    return {
      decisions: [],
      result: { outcome: 'p1', endTick: 1, endReason: 'timeout', healthRemaining: [10, 5] },
      finalStateHash: FIXTURE_STATE_HASH,
      tokenBankStart,
      cacheStats: [
        { agentIndex: 0, agentId: 'bot:p1', billableCalls: 0, totalTokens: 0, cachedTokens: 0, cacheHitRate: 0, conservativeDebitCalls: 0 },
        { agentIndex: 1, agentId: 'bot:p2', billableCalls: 0, totalTokens: 0, cachedTokens: 0, cacheHitRate: 0, conservativeDebitCalls: 0 },
      ],
    };
  }

  it('includes tokenBankStart from MatchResult when any Agent is a Deployment', () => {
    const log = buildCommandLog(matchResultWith(25_000), {
      environment: { id: 'mock-environment', version: '1.0.0' },
      seed: SEED,
      configHash: FIXTURE_CONFIG_HASH,
      agents: [
        { id: 'groq:llama', kind: 'deployment', deployment: { provider: 'groq', endpoint: 'https://api.groq.com', model: 'llama' } },
        { id: 'bot:p2', kind: 'bot' },
      ],
    });

    expect(log.tokenBankStart).toBe(25_000);
  });

  it('omits tokenBankStart when every Agent is a Baseline Bot, even though MatchResult carried one', () => {
    const log = buildCommandLog(matchResultWith(25_000), {
      environment: { id: 'mock-environment', version: '1.0.0' },
      seed: SEED,
      configHash: FIXTURE_CONFIG_HASH,
      agents: [
        { id: 'bot:p1', kind: 'bot' },
        { id: 'bot:p2', kind: 'bot' },
      ],
    });

    expect(log).not.toHaveProperty('tokenBankStart');
  });

  it('accepts params.tokenBankStart agreeing with matchResult.tokenBankStart', () => {
    const log = buildCommandLog(matchResultWith(25_000), {
      environment: { id: 'mock-environment', version: '1.0.0' },
      seed: SEED,
      configHash: FIXTURE_CONFIG_HASH,
      tokenBankStart: 25_000,
      agents: [
        { id: 'groq:llama', kind: 'deployment', deployment: { provider: 'groq', endpoint: 'https://api.groq.com', model: 'llama' } },
        { id: 'bot:p2', kind: 'bot' },
      ],
    });

    expect(log.tokenBankStart).toBe(25_000);
  });

  it('throws when params.tokenBankStart disagrees with matchResult.tokenBankStart -- two consumers must never derive different values for one Match', () => {
    expect(() =>
      buildCommandLog(matchResultWith(25_000), {
        environment: { id: 'mock-environment', version: '1.0.0' },
        seed: SEED,
        configHash: FIXTURE_CONFIG_HASH,
        tokenBankStart: 30_000,
        agents: [
          { id: 'groq:llama', kind: 'deployment', deployment: { provider: 'groq', endpoint: 'https://api.groq.com', model: 'llama' } },
          { id: 'bot:p2', kind: 'bot' },
        ],
      }),
    ).toThrow(/25000|30000/);
  });
});
