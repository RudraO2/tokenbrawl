import { describe, expect, it } from 'vitest';
import type { AgentIdentity } from '@tokenbrawl/contracts';
import { computeConfigHash, computeMatchId, validateCommandLog } from '../../../../packages/core/src/command-log';
import type { MatchResult } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { buildByokCommandLog, byokConfigHash, byokMatchId } from './log';

/**
 * Story 4.6 AC4's first half: "it is a valid Command Log".
 *
 * Validated here rather than in the browser module because Ajv is one of the
 * two things that cannot be bundled for a browser (the other is `node:crypto`,
 * which is why this log is built by hand at all). The validator runs in CI,
 * over a log the shipped builder produced, which is the only place that
 * assertion can be made with the real frozen schema.
 *
 * The hash agreement cases matter more than they look. A BYOK log and a CI log
 * of the same configuration must carry the same `configHash` and, for the same
 * agents and seed, the same `matchId` -- otherwise the two datasets cannot be
 * joined and nobody finds out until somebody tries.
 */

const AGENTS: readonly [AgentIdentity, AgentIdentity] = [
  {
    id: 'p1:byok:llama-3.1-8b-instant',
    kind: 'deployment',
    deployment: {
      provider: 'byok',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
    },
  },
  {
    id: 'p2:byok:llama3.1-8b',
    kind: 'deployment',
    deployment: {
      provider: 'byok',
      endpoint: 'https://api.cerebras.ai/v1/chat/completions',
      model: 'llama3.1-8b',
    },
  },
];

/** A two-Decision-Point Match with one of every entry shape the builder must handle. */
function matchResult(): MatchResult {
  return {
    decisions: [
      {
        tick: 0,
        agentIndex: 0,
        action: 'attack',
        tokensSpent: 12,
        reasoningTokens: null,
        bankRemaining: 24_988,
        reflexMode: false,
        reasoning: 'Closing the distance.',
        rawResponse: 'ACTION: attack',
        provider: 'byok',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        cachedTokens: null,
      },
      {
        tick: 0,
        agentIndex: 1,
        action: 'stand',
        tokensSpent: null,
        reasoningTokens: null,
        bankRemaining: 25_000,
        reflexMode: false,
        parseFailure: true,
        reasoning: null,
        rawResponse: 'I would rather not say.',
        provider: 'byok',
        endpoint: 'https://api.cerebras.ai/v1/chat/completions',
        cachedTokens: null,
      },
      // Not polled: inside a Commitment Window. Never reaches the log.
      { tick: 30, agentIndex: 0, action: null },
      {
        tick: 30,
        agentIndex: 1,
        action: 'block',
        tokensSpent: 8,
        reasoningTokens: 4,
        bankRemaining: 24_992,
        reflexMode: true,
        reasoning: null,
        rawResponse: 'ACTION: block',
        provider: 'byok',
        endpoint: 'https://api.cerebras.ai/v1/chat/completions',
        cachedTokens: 100,
      },
    ],
    result: { outcome: 'p1', endTick: 60, endReason: 'ko', healthRemaining: [40, 0] },
    finalStateHash: 'a'.repeat(64),
    tokenBankStart: 25_000,
    cacheStats: [
      { agentId: 'p1:byok:llama-3.1-8b-instant', calls: 2, cacheReportingCalls: 0, cachedTokens: 0, conservativeDebits: 0 },
      { agentId: 'p2:byok:llama3.1-8b', calls: 2, cacheReportingCalls: 1, cachedTokens: 100, conservativeDebits: 0 },
    ],
  } as unknown as MatchResult;
}

const PARAMS = {
  environment: { id: 'fighter', version: '1.0.0' },
  seed: 4_601,
  configHash: byokConfigHash(DEFAULT_FIGHTER_CONFIG),
  agents: AGENTS,
  tokenBankStart: 25_000,
};

describe('the browser builds a log the frozen schema accepts (AC4)', () => {
  it('passes the real validator', () => {
    expect(() => validateCommandLog(buildByokCommandLog(matchResult(), PARAMS))).not.toThrow();
  });

  it('records provider "byok" on both agents and on every decision', () => {
    const log = buildByokCommandLog(matchResult(), PARAMS);
    expect(log.agents.map((agent) => agent.deployment?.provider)).toStrictEqual(['byok', 'byok']);
    expect([...new Set(log.decisions.map((entry) => entry.provider))]).toStrictEqual(['byok']);
  });

  it('keeps the upstream endpoint verbatim, which is INV-6 provenance', () => {
    // `byok` says the Match is unratable. It must not also erase which endpoint
    // actually served each call -- two endpoints serving one model name are two
    // different things, and that is true whoever paid for the call.
    const log = buildByokCommandLog(matchResult(), PARAMS);
    expect(log.agents[0].deployment?.endpoint).toContain('api.groq.com');
    expect(log.agents[1].deployment?.endpoint).toContain('api.cerebras.ai');
    expect(log.decisions[0].endpoint).toContain('api.groq.com');
  });

  it('drops the Decision Points at which an Agent was not polled', () => {
    const log = buildByokCommandLog(matchResult(), PARAMS);
    expect(log.decisions).toHaveLength(3);
    expect(log.decisions.every((entry) => entry.action !== null)).toBe(true);
  });

  it('keeps a null tokensSpent as null rather than collapsing it to zero (INV-5)', () => {
    const log = buildByokCommandLog(matchResult(), PARAMS);
    const parseFailure = log.decisions.find((entry) => entry.parseFailure === true);
    expect(parseFailure?.tokensSpent).toBeNull();
  });

  it('never writes cachedTokens, which the frozen schema has no field for', () => {
    const log = buildByokCommandLog(matchResult(), PARAMS);
    expect(JSON.stringify(log)).not.toContain('cachedTokens');
  });

  it('carries the Token Bank start, because both Agents are Deployments', () => {
    expect(buildByokCommandLog(matchResult(), PARAMS).tokenBankStart).toBe(25_000);
  });
});

describe('the browser hashes agree with the ones core computes', () => {
  it('produces the same configHash as computeConfigHash', () => {
    // Two implementations exist only because `node:crypto` cannot be bundled.
    // If they ever disagree, a BYOK log and a CI log of the same configuration
    // stop being comparable, silently.
    expect(byokConfigHash(DEFAULT_FIGHTER_CONFIG)).toBe(computeConfigHash(DEFAULT_FIGHTER_CONFIG));
  });

  it('produces the same matchId as computeMatchId, for the values this path uses', () => {
    const params = {
      environmentId: 'fighter',
      seed: 4_601,
      configHash: byokConfigHash(DEFAULT_FIGHTER_CONFIG),
      agentIds: [AGENTS[0].id, AGENTS[1].id] as readonly [string, string],
    };
    expect(byokMatchId(params)).toBe(computeMatchId(params));
    expect(buildByokCommandLog(matchResult(), PARAMS).matchId).toBe(computeMatchId(params));
  });

  it('produces an id the schema pattern accepts', () => {
    expect(buildByokCommandLog(matchResult(), PARAMS).matchId).toMatch(/^[a-z0-9-]{8,64}$/);
  });

  it('changes the matchId when the seed changes, and not otherwise', () => {
    const first = buildByokCommandLog(matchResult(), PARAMS).matchId;
    const second = buildByokCommandLog(matchResult(), { ...PARAMS, seed: 4_602 }).matchId;
    expect(second).not.toBe(first);
    expect(buildByokCommandLog(matchResult(), PARAMS).matchId).toBe(first);
  });

  it('changes the matchId when the sides swap, because a side swap is a different Match', () => {
    const swapped = buildByokCommandLog(matchResult(), {
      ...PARAMS,
      agents: [AGENTS[1], AGENTS[0]] as readonly [AgentIdentity, AgentIdentity],
    }).matchId;
    expect(swapped).not.toBe(buildByokCommandLog(matchResult(), PARAMS).matchId);
  });
});
