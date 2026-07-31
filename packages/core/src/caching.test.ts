import { describe, expect, it } from 'vitest';
import { computeCacheStats, formatCacheDeviations } from './caching';
import type { MatchDecisionEntry } from './match-runner';

const AGENT_IDS: readonly [string, string] = ['dep:p1', 'dep:p2'];

function entry(overrides: Partial<MatchDecisionEntry>): MatchDecisionEntry {
  return {
    tick: 0,
    agentIndex: 0,
    action: 'attack',
    ...overrides,
  };
}

describe('computeCacheStats (I/O matrix: aggregation)', () => {
  it('sums tokens and cached tokens per Agent, and computes the hit rate', () => {
    const decisions: MatchDecisionEntry[] = [
      entry({ agentIndex: 0, tokensSpent: 100, cachedTokens: 40 }),
      entry({ agentIndex: 0, tokensSpent: 100, cachedTokens: 60 }),
      entry({ agentIndex: 1, tokensSpent: 50, cachedTokens: 0 }),
    ];

    const [p1, p2] = computeCacheStats(decisions, AGENT_IDS);

    expect(p1).toStrictEqual({
      agentIndex: 0,
      agentId: 'dep:p1',
      billableCalls: 2,
      totalTokens: 200,
      cachedTokens: 100,
      cacheHitRate: 0.5,
      conservativeDebitCalls: 0,
    });
    expect(p2).toStrictEqual({
      agentIndex: 1,
      agentId: 'dep:p2',
      billableCalls: 1,
      totalTokens: 50,
      cachedTokens: 0,
      cacheHitRate: 0,
      conservativeDebitCalls: 0,
    });
  });

  it('counts a call with no cache signal as conservative, and excludes it from cachedTokens', () => {
    const decisions: MatchDecisionEntry[] = [
      entry({ agentIndex: 0, tokensSpent: 100, cachedTokens: null }),
      entry({ agentIndex: 0, tokensSpent: 100 }), // cachedTokens omitted entirely
    ];

    const [p1] = computeCacheStats(decisions, AGENT_IDS);

    expect(p1.billableCalls).toBe(2);
    expect(p1.totalTokens).toBe(200);
    expect(p1.cachedTokens).toBe(0);
    expect(p1.conservativeDebitCalls).toBe(2);
  });

  it('does not divide by zero when nothing was billed -- cacheHitRate is 0, never NaN', () => {
    const [p1, p2] = computeCacheStats([], AGENT_IDS);

    expect(p1.cacheHitRate).toBe(0);
    expect(p2.cacheHitRate).toBe(0);
    expect(p1.billableCalls).toBe(0);
  });

  it('ignores a decision with tokensSpent null or absent -- a Baseline Bot, or an unmetered probe result', () => {
    const decisions: MatchDecisionEntry[] = [
      entry({ agentIndex: 0, tokensSpent: null, cachedTokens: null }),
      entry({ agentIndex: 1, action: 'block' }), // Baseline Bot entry: no tokensSpent field at all
    ];

    const [p1, p2] = computeCacheStats(decisions, AGENT_IDS);

    expect(p1.billableCalls).toBe(0);
    expect(p1.conservativeDebitCalls).toBe(0);
    expect(p2.billableCalls).toBe(0);
  });

  it('treats a reported zero cachedTokens as an honest report, not as unreported', () => {
    const decisions: MatchDecisionEntry[] = [entry({ agentIndex: 0, tokensSpent: 100, cachedTokens: 0 })];

    const [p1] = computeCacheStats(decisions, AGENT_IDS);

    expect(p1.conservativeDebitCalls).toBe(0);
    expect(p1.cachedTokens).toBe(0);
  });
});

describe('formatCacheDeviations (AC5: published per Deployment)', () => {
  it('reports only Agents with at least one conservatively-billed call', () => {
    const decisions: MatchDecisionEntry[] = [
      entry({ agentIndex: 0, tokensSpent: 100, cachedTokens: null }),
      entry({ agentIndex: 1, tokensSpent: 50, cachedTokens: 10 }),
    ];
    const [p1, p2] = computeCacheStats(decisions, AGENT_IDS);

    const notes = formatCacheDeviations([p1, p2]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('dep:p1');
    expect(notes[0]).toContain('1 of 1');
  });

  it('is empty when every billed call carried cache signal', () => {
    const decisions: MatchDecisionEntry[] = [entry({ agentIndex: 0, tokensSpent: 100, cachedTokens: 10 })];
    const [p1, p2] = computeCacheStats(decisions, AGENT_IDS);

    expect(formatCacheDeviations([p1, p2])).toStrictEqual([]);
  });

  it('is empty when nothing was billed at all', () => {
    const [p1, p2] = computeCacheStats([], AGENT_IDS);

    expect(formatCacheDeviations([p1, p2])).toStrictEqual([]);
  });
});
