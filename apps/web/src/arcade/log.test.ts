import { describe, expect, it } from 'vitest';
import type { AgentIdentityV2 } from '@tokenbrawl/contracts';
import { validateCommandLogV2 } from '../../../../packages/core/src/command-log-v2';
import { computeConfigHash, computeMatchId } from '../../../../packages/core/src/command-log';
import type { MatchResult } from '../../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { arcadeConfigHash, arcadeMatchId, buildArcadeCommandLog } from './log';

/**
 * Story 9.2's log builder, checked the same way `byok/log.test.ts` checks
 * its v1 counterpart: the real v2 validator over a log this module produced,
 * and the browser hashes checked to agree with what `packages/core` computes.
 */

const AGENTS: readonly [AgentIdentityV2, AgentIdentityV2] = [
  { id: 'p1:human', kind: 'human' },
  { id: 'p2:bot:random', kind: 'bot' },
];

function matchResult(): MatchResult {
  return {
    decisions: [
      {
        tick: 0,
        agentIndex: 0,
        action: 'attack',
        reasoning: null,
        rawResponse: 'human:attack',
        provider: 'human',
        endpoint: 'human',
      },
      {
        tick: 0,
        agentIndex: 1,
        action: 'block',
        reasoning: null,
        rawResponse: 'random:block',
        provider: 'bot',
        endpoint: 'bot',
      },
      // Not polled: inside a Commitment Window. Never reaches the log.
      { tick: 30, agentIndex: 1, action: null },
      {
        tick: 30,
        agentIndex: 0,
        action: 'advance',
        reasoning: null,
        rawResponse: 'human:advance',
        provider: 'human',
        endpoint: 'human',
      },
    ],
    result: { outcome: 'p1', endTick: 60, endReason: 'ko', healthRemaining: [40, 0] },
    finalStateHash: 'b'.repeat(64),
    tokenBankStart: 25_000,
    cacheStats: [
      { agentId: 'p1:human', calls: 2, cacheReportingCalls: 0, cachedTokens: 0, conservativeDebits: 0 },
      { agentId: 'p2:bot:random', calls: 2, cacheReportingCalls: 0, cachedTokens: 0, conservativeDebits: 0 },
    ],
  } as unknown as MatchResult;
}

const PARAMS = {
  environment: { id: 'fighter', version: '1.0.0' },
  seed: 4_601,
  configHash: arcadeConfigHash(DEFAULT_FIGHTER_CONFIG),
  agents: AGENTS,
};

describe('the arcade log passes the real v2 validator', () => {
  it('validates against command-log.v2.schema.json', () => {
    expect(() => validateCommandLogV2(buildArcadeCommandLog(matchResult(), PARAMS))).not.toThrow();
  });

  it('carries schemaVersion 2.0.0', () => {
    expect(buildArcadeCommandLog(matchResult(), PARAMS).schemaVersion).toBe('2.0.0');
  });

  it('marks the human side kind: "human"', () => {
    const log = buildArcadeCommandLog(matchResult(), PARAMS);
    expect(log.agents[0].kind).toBe('human');
    expect(log.agents[1].kind).toBe('bot');
  });

  it('writes zero token fields on any decision, human side or bot side', () => {
    const log = buildArcadeCommandLog(matchResult(), PARAMS);
    for (const entry of log.decisions) {
      expect(entry.tokensSpent).toBeUndefined();
      expect(entry.reasoningTokens).toBeUndefined();
      expect(entry.bankRemaining).toBeUndefined();
      expect(entry.reflexMode).toBeUndefined();
    }
  });

  it('carries no tokenBankStart at all, since neither Agent is a Deployment', () => {
    expect(buildArcadeCommandLog(matchResult(), PARAMS).tokenBankStart).toBeUndefined();
  });

  it('drops the Decision Points at which an Agent was not polled', () => {
    const log = buildArcadeCommandLog(matchResult(), PARAMS);
    expect(log.decisions).toHaveLength(3);
    expect(log.decisions.every((entry) => entry.action !== null)).toBe(true);
  });

  it('would still carry a tokenBankStart if one side were a Deployment', () => {
    const deploymentAgents: readonly [AgentIdentityV2, AgentIdentityV2] = [
      { id: 'p1:human', kind: 'human' },
      {
        id: 'p2:byok:model',
        kind: 'deployment',
        deployment: { provider: 'byok', endpoint: 'https://example.test', model: 'model' },
      },
    ];
    const log = buildArcadeCommandLog(matchResult(), {
      ...PARAMS,
      agents: deploymentAgents,
      tokenBankStart: 25_000,
    });
    expect(log.tokenBankStart).toBe(25_000);
  });
});

describe('an out-of-range agentIndex is rejected rather than silently propagated (P6)', () => {
  it('throws a clear error instead of an unhelpful TypeError', () => {
    const base = matchResult();
    const malformed: MatchResult = {
      ...base,
      decisions: [{ ...base.decisions[0], agentIndex: 2 }, ...base.decisions.slice(1)] as unknown as MatchResult['decisions'],
    };

    expect(() => buildArcadeCommandLog(malformed, PARAMS)).toThrow(/agentIndex 2 is out of range/);
  });
});

describe('the browser hashes agree with what core computes', () => {
  it('produces the same configHash as computeConfigHash', () => {
    expect(arcadeConfigHash(DEFAULT_FIGHTER_CONFIG)).toBe(computeConfigHash(DEFAULT_FIGHTER_CONFIG));
  });

  it('produces the same matchId as computeMatchId', () => {
    const params = {
      environmentId: 'fighter',
      seed: 4_601,
      configHash: arcadeConfigHash(DEFAULT_FIGHTER_CONFIG),
      agentIds: [AGENTS[0].id, AGENTS[1].id] as readonly [string, string],
    };
    expect(arcadeMatchId(params)).toBe(computeMatchId(params));
  });

  it('produces an id the schema pattern accepts', () => {
    expect(buildArcadeCommandLog(matchResult(), PARAMS).matchId).toMatch(/^[a-z0-9-]{8,64}$/);
  });
});
