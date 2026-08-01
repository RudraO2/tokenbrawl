import type { AgentIdentity, CommandLog, DecisionEntry } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import {
  computeBehaviouralMetrics,
  isRateLimitedResponse,
  unreportedBehaviour,
} from './behavioural-metrics';

/**
 * Story 7-3, AC1 and AC3.
 *
 * The distinction this file exists to hold down is `null` versus `0`. Every
 * other number here is a floored integer division; that one is INV-5, and a
 * regression in it would render an unmetered Deployment as a frugal one.
 */

function bot(id: string): AgentIdentity {
  return { id, kind: 'bot' };
}

function deployment(id: string): AgentIdentity {
  return {
    id,
    kind: 'deployment',
    deployment: { provider: 'groq', endpoint: 'https://example.invalid/v1', model: id },
  };
}

function log(
  matchId: string,
  agents: readonly [AgentIdentity, AgentIdentity],
  decisions: readonly DecisionEntry[],
): CommandLog {
  return {
    schemaVersion: '1.0.0',
    matchId,
    environment: { id: 'mock', version: '1.0.0' },
    seed: 1,
    configHash: 'hash',
    agents,
    decisions,
    result: { outcome: 'p1', endTick: 10, endReason: 'ko', healthRemaining: [10, 0] },
    finalStateHash: 'final',
  };
}

/** A Deployment's Decision Point: everything the runner writes for one. */
function spend(
  tick: number,
  agentIndex: 0 | 1,
  fields: Partial<DecisionEntry> = {},
): DecisionEntry {
  return {
    tick,
    agentIndex,
    action: 'attack',
    tokensSpent: 100,
    reasoningTokens: 25,
    bankRemaining: 900,
    reflexMode: false,
    ...fields,
  };
}

/** A Baseline Bot's Decision Point: no banking fields at all. */
function botMove(tick: number, agentIndex: 0 | 1, fields: Partial<DecisionEntry> = {}): DecisionEntry {
  return { tick, agentIndex, action: 'advance', ...fields };
}

const GROQ_429 = JSON.stringify({
  error: { message: 'Rate limit reached for model', type: 'tokens', code: 'rate_limit_exceeded' },
});
const GOOGLE_429 = JSON.stringify({
  error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
});

function metricsFor(logs: readonly CommandLog[], agent: string) {
  const row = computeBehaviouralMetrics(logs).find((entry) => entry.agent === agent);
  if (row === undefined) {
    throw new Error(`no behaviour row for ${agent}`);
  }
  return row;
}

describe('tokens per Match (AC1)', () => {
  it('sums reported usage and divides by the Matches that reported it', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: 100 }),
        spend(1, 0, { tokensSpent: 140 }),
        botMove(0, 1),
      ]),
      log('m2', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: 60 })]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.matches).toBe(2);
    expect(row.decisions).toBe(3);
    expect(row.tokensSpent).toBe(300);
    expect(row.matchesReportingUsage).toBe(2);
    expect(row.tokensPerMatch).toBe(150);
  });

  it('floors rather than rounds, so a mean never reads higher than it is', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: 100 })]),
      log('m2', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: 101 })]),
      log('m3', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: 101 })]),
    ];

    // 302 / 3 is 100.66...; the published figure is the one that cannot overstate.
    expect(metricsFor(logs, 'd1').tokensPerMatch).toBe(100);
  });

  it('reports a Baseline Bot as not-reported rather than as zero tokens', () => {
    const logs = [log('m1', [deployment('d1'), bot('b1')], [spend(0, 0), botMove(0, 1)])];

    const row = metricsFor(logs, 'b1');
    expect(row.tokensSpent).toBeNull();
    expect(row.tokensPerMatch).toBeNull();
    expect(row.matchesReportingUsage).toBe(0);
  });

  it('treats a provider that reported no usage as not-reported, never as a free call', () => {
    // `tokensSpent: null` is the Metering Probe result "reported no usage".
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: null, reasoningTokens: null }),
      ]),
    ];

    expect(metricsFor(logs, 'd1').tokensPerMatch).toBeNull();
  });

  it('counts a reported zero as a report', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: 0, reasoningTokens: 0 })]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.tokensSpent).toBe(0);
    expect(row.tokensPerMatch).toBe(0);
  });
});

describe('reasoning-token share (AC3)', () => {
  it('is the reported reasoning tokens over the tokens reported beside them', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: 100, reasoningTokens: 40 }),
        spend(1, 0, { tokensSpent: 100, reasoningTokens: 20 }),
      ]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.reasoningTokens).toBe(60);
    expect(row.reasoningShareBasisPoints).toBe(3000);
  });

  it('shows not-reported rather than zero when reasoning tokens were never reported', () => {
    // The criterion, verbatim: a Deployment whose reasoning tokens were never
    // reported shows as not-reported rather than as zero.
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: 500, reasoningTokens: null }),
        spend(1, 0, { tokensSpent: 500, reasoningTokens: undefined }),
      ]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.reasoningTokens).toBeNull();
    expect(row.reasoningShareBasisPoints).toBeNull();
    // And the tokens themselves are still reported: only the share is silent.
    expect(row.tokensPerMatch).toBe(1000);
  });

  it('distinguishes a reported zero share from a missing one', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: 500, reasoningTokens: 0 }),
      ]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.reasoningTokens).toBe(0);
    expect(row.reasoningShareBasisPoints).toBe(0);
  });

  it('is not-reported when reasoning tokens arrived with no completion count to share of', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: null, reasoningTokens: 30 }),
      ]),
    ];

    expect(metricsFor(logs, 'd1').reasoningShareBasisPoints).toBeNull();
  });

  it('refuses a log claiming more reasoning tokens than completion tokens', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { tokensSpent: 10, reasoningTokens: 11 }),
      ]),
    ];

    expect(() => computeBehaviouralMetrics(logs)).toThrow(/cannot be a share/);
  });
});

describe('parse-failure rate, split from rate limits (AC1)', () => {
  it('counts every Fallback Action against every Decision Point', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { action: 'stand', parseFailure: true, rawResponse: 'I think I will attack!' }),
        spend(1, 0),
        spend(2, 0),
        spend(3, 0),
      ]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.parseFailures).toBe(1);
    expect(row.parseFailureRateBasisPoints).toBe(2500);
  });

  it('separates a provider refusal from text the grammar could not read', () => {
    // The 3.2 ledger's finding: a raw rate of 3/4 that is really 1/4 grammar.
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { action: 'stand', parseFailure: true, rawResponse: GROQ_429 }),
        spend(1, 0, { action: 'stand', parseFailure: true, rawResponse: GOOGLE_429 }),
        spend(2, 0, { action: 'stand', parseFailure: true, rawResponse: 'let me think about it' }),
        spend(3, 0),
      ]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.parseFailures).toBe(3);
    expect(row.rateLimited).toBe(2);
    expect(row.grammarFailures).toBe(1);
    expect(row.parseFailureRateBasisPoints).toBe(7500);
    expect(row.rateLimitedRateBasisPoints).toBe(5000);
    expect(row.grammarFailureRateBasisPoints).toBe(2500);
  });

  it('is zero rather than not-reported when nothing failed', () => {
    // The one metric that is never null: a Decision Point either parsed or it
    // did not, with no provider cooperation required.
    const logs = [log('m1', [deployment('d1'), bot('b1')], [spend(0, 0)])];

    expect(metricsFor(logs, 'd1').parseFailureRateBasisPoints).toBe(0);
  });

  it('counts a Bot Parse Failure too', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        botMove(0, 1, { action: 'stand', parseFailure: true, rawResponse: 'nonsense' }),
        botMove(1, 1),
      ]),
    ];

    expect(metricsFor(logs, 'b1').parseFailureRateBasisPoints).toBe(5000);
  });
});

describe('isRateLimitedResponse', () => {
  it('recognises the OpenAI-shaped refusal Groq and Cerebras send', () => {
    expect(isRateLimitedResponse(GROQ_429)).toBe(true);
  });

  it('recognises the status-string refusal Google sends', () => {
    expect(isRateLimitedResponse(GOOGLE_429)).toBe(true);
  });

  it('recognises a numeric 429 echoed into the body', () => {
    expect(isRateLimitedResponse(JSON.stringify({ error: { code: 429 } }))).toBe(true);
  });

  it('does not classify model prose as a refusal, even when it says the words', () => {
    // The direction of error matters: a false positive here moves a real
    // grammar failure into somebody else's column, which flatters the model.
    expect(isRateLimitedResponse('I hit a rate_limit_exceeded once, so I will block.')).toBe(false);
  });

  it('does not classify a well-formed error that is not a rate limit', () => {
    expect(
      isRateLimitedResponse(JSON.stringify({ error: { code: 'invalid_api_key', message: 'no' } })),
    ).toBe(false);
  });

  it('treats absent, empty and non-JSON responses as not a refusal', () => {
    expect(isRateLimitedResponse(undefined)).toBe(false);
    expect(isRateLimitedResponse(null)).toBe(false);
    expect(isRateLimitedResponse('')).toBe(false);
    expect(isRateLimitedResponse('{not json')).toBe(false);
    expect(isRateLimitedResponse('"a string"')).toBe(false);
  });
});

describe('bank-exhaustion rate (AC1)', () => {
  it('counts Matches in which the bank reached zero, not Decision Points', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { bankRemaining: 0, reflexMode: false }),
        spend(1, 0, { bankRemaining: 0, reflexMode: true }),
      ]),
      log('m2', [deployment('d1'), bot('b1')], [spend(0, 0, { bankRemaining: 500 })]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.matchesReportingBank).toBe(2);
    expect(row.bankExhaustedMatches).toBe(1);
    expect(row.bankExhaustionRateBasisPoints).toBe(5000);
  });

  it('catches a Match that emptied its bank on the last Decision Point', () => {
    // `reflexMode` is the state at poll time, so a Match that exhausted its
    // bank on its final call never sees a `reflexMode: true` entry.
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [
        spend(0, 0, { bankRemaining: 40, reflexMode: false }),
        spend(1, 0, { bankRemaining: 0, reflexMode: false }),
      ]),
    ];

    expect(metricsFor(logs, 'd1').bankExhaustionRateBasisPoints).toBe(10000);
  });

  it('shows not-reported for an Agent whose Decisions carry no bank state', () => {
    const logs = [log('m1', [deployment('d1'), bot('b1')], [spend(0, 0), botMove(0, 1)])];

    const row = metricsFor(logs, 'b1');
    expect(row.matchesReportingBank).toBe(0);
    expect(row.bankExhaustionRateBasisPoints).toBeNull();
  });
});

describe('the corpus as a whole', () => {
  it('returns one row per Agent, sorted by id', () => {
    const logs = [
      log('m1', [deployment('zeta'), bot('alpha')], [spend(0, 0), botMove(0, 1)]),
      log('m2', [bot('alpha'), deployment('mid')], [botMove(0, 0), spend(0, 1)]),
    ];

    expect(computeBehaviouralMetrics(logs).map((row) => row.agent)).toStrictEqual([
      'alpha',
      'mid',
      'zeta',
    ]);
  });

  it('is empty for an empty corpus rather than throwing', () => {
    expect(computeBehaviouralMetrics([])).toStrictEqual([]);
  });

  it('refuses one id appearing as both a Deployment and a Bot (INV-6)', () => {
    const logs = [
      log('m1', [deployment('x'), bot('b1')], [spend(0, 0)]),
      log('m2', [bot('x'), bot('b1')], [botMove(0, 0)]),
    ];

    expect(() => computeBehaviouralMetrics(logs)).toThrow(/One id is one entrant/);
  });

  it('refuses a Match that pairs an Agent with itself', () => {
    const logs = [log('m1', [deployment('d1'), deployment('d1')], [spend(0, 0)])];

    expect(() => computeBehaviouralMetrics(logs)).toThrow(/with itself/);
  });

  it('refuses a negative or fractional token count', () => {
    expect(() =>
      computeBehaviouralMetrics([
        log('m1', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: -5 })]),
      ]),
    ).toThrow(/not a non-negative integer/);
  });

  it('accumulates one Agent across every Match it played, on either side', () => {
    const logs = [
      log('m1', [deployment('d1'), bot('b1')], [spend(0, 0, { tokensSpent: 10, reasoningTokens: 2 })]),
      log('m2', [bot('b1'), deployment('d1')], [spend(0, 1, { tokensSpent: 30, reasoningTokens: 6 })]),
    ];

    const row = metricsFor(logs, 'd1');
    expect(row.matches).toBe(2);
    expect(row.tokensSpent).toBe(40);
    expect(row.tokensPerMatch).toBe(20);
  });
});

describe('unreportedBehaviour', () => {
  it('is every quantity not-reported and every count zero', () => {
    const row = unreportedBehaviour('bot:spacing', 'bot');

    expect(row.tokensPerMatch).toBeNull();
    expect(row.reasoningShareBasisPoints).toBeNull();
    expect(row.bankExhaustionRateBasisPoints).toBeNull();
    // Including the parse-failure rate: no Decision Point was observed, so
    // there is nothing to have a rate of. A zero here would read as "this
    // entrant never fumbled", which nothing measured.
    expect(row.parseFailureRateBasisPoints).toBeNull();
    expect(row.matches).toBe(0);
    expect(row.parseFailures).toBe(0);
  });
});
