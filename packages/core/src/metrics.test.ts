import { describe, expect, it } from 'vitest';
import { FALLBACK_ACTION, type CommandLog } from '@tokenbrawl/contracts';
import { computeParseFailureRates } from './metrics';

const baseLog = (decisions: CommandLog['decisions']): CommandLog => ({
  schemaVersion: '1.0.0',
  matchId: 'a'.repeat(24),
  environment: { id: 'fighter', version: '1.0.0' },
  seed: 1,
  configHash: 'b'.repeat(64),
  agents: [
    { id: 'agent-0', kind: 'bot' },
    { id: 'agent-1', kind: 'bot' },
  ],
  decisions,
  result: { outcome: 'draw', endTick: 0, endReason: 'timeout', healthRemaining: [0, 0] },
  finalStateHash: 'c'.repeat(64),
});

describe('computeParseFailureRates (Story 1.6, I/O matrix)', () => {
  it('mixed: returns parseFailureCount / decisionCount per Agent', () => {
    const log = baseLog([
      { tick: 0, agentIndex: 0, action: 'attack' },
      { tick: 1, agentIndex: 0, action: FALLBACK_ACTION, parseFailure: true, rawResponse: 'garbled' },
      { tick: 2, agentIndex: 0, action: 'block' },
      { tick: 0, agentIndex: 1, action: 'advance' },
      { tick: 1, agentIndex: 1, action: 'retreat' },
    ]);

    const [rate0, rate1] = computeParseFailureRates(log);

    expect(rate0).toMatchObject({
      agentIndex: 0,
      agentId: 'agent-0',
      decisionCount: 3,
      parseFailureCount: 1,
      parseFailureRate: 1 / 3,
    });
    expect(rate1).toMatchObject({
      agentIndex: 1,
      agentId: 'agent-1',
      decisionCount: 2,
      parseFailureCount: 0,
      parseFailureRate: 0,
    });
  });

  it('zero decisions: rate is 0, never NaN', () => {
    const log = baseLog([{ tick: 0, agentIndex: 1, action: 'advance' }]);

    const [rate0] = computeParseFailureRates(log);

    expect(rate0.decisionCount).toBe(0);
    expect(rate0.parseFailureCount).toBe(0);
    expect(rate0.parseFailureRate).toBe(0);
    expect(Number.isNaN(rate0.parseFailureRate)).toBe(false);
  });

  it('all failures: rate is 1', () => {
    const log = baseLog([
      { tick: 0, agentIndex: 0, action: FALLBACK_ACTION, parseFailure: true, rawResponse: 'x' },
      { tick: 1, agentIndex: 0, action: FALLBACK_ACTION, parseFailure: true, rawResponse: 'y' },
    ]);

    const [rate0] = computeParseFailureRates(log);

    expect(rate0.parseFailureRate).toBe(1);
  });

  it('bot-only Match with no parse failures: both rates are 0', () => {
    const log = baseLog([
      { tick: 0, agentIndex: 0, action: 'attack' },
      { tick: 0, agentIndex: 1, action: 'block' },
    ]);

    const [rate0, rate1] = computeParseFailureRates(log);

    expect(rate0.parseFailureRate).toBe(0);
    expect(rate1.parseFailureRate).toBe(0);
  });

  it('throws naming the value on a decision entry with an agentIndex outside 0|1 (defense-in-depth for disk-loaded logs bypassing schema validation)', () => {
    const log = baseLog([{ tick: 0, agentIndex: 2 as unknown as 0 | 1, action: 'attack' }]);

    expect(() => computeParseFailureRates(log)).toThrow(/invalid agentIndex 2/);
  });
});
