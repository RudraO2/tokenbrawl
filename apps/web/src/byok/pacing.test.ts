import { describe, expect, it } from 'vitest';
import type { HttpHeaders } from '../../../../packages/providers/src/http';
import { MATCH_TOKENS_PER_CALL } from '../../../../packages/providers/src/match-feasibility';
import {
  MAX_RATE_LIMIT_WAITS,
  MAX_WAIT_MS,
  createWaitBudget,
  isWaitable,
  paceBeforeNextCallMs,
  readQuotaHeaders,
} from './pacing';

/**
 * Story 4.8, the arithmetic half. Everything here is a pure function over the
 * headers a provider actually sends, so every case is a table row rather than a
 * Match.
 */

function headersOf(entries: Readonly<Record<string, string>>): HttpHeaders {
  return { get: (name: string): string | null => entries[name.toLowerCase()] ?? null };
}

const EMPTY = readQuotaHeaders(headersOf({}));

describe('reading the quota headers a provider rides on every response', () => {
  it('reads all four of Groq’s, in the forms it sends them', () => {
    const snapshot = readQuotaHeaders(
      headersOf({
        'x-ratelimit-remaining-requests': '14382',
        'x-ratelimit-remaining-tokens': '4211',
        'x-ratelimit-reset-requests': '2m59.56s',
        'x-ratelimit-reset-tokens': '7.66s',
      }),
    );
    expect(snapshot).toStrictEqual({
      remainingRequests: 14_382,
      remainingTokens: 4211,
      resetRequestsMs: 179_560,
      resetTokensMs: 7660,
    });
  });

  it('reports absent as null, never as zero', () => {
    // The distinction is the whole file: "no headroom left" and "the provider
    // said nothing" are opposite instructions, and a provider that reports
    // nothing must not be paced as though it were exhausted.
    expect(EMPTY).toStrictEqual({
      remainingRequests: null,
      remainingTokens: null,
      resetRequestsMs: null,
      resetTokensMs: null,
    });
    expect(paceBeforeNextCallMs(EMPTY)).toBe(0);
  });

  it('refuses a count that is not a whole number', () => {
    const snapshot = readQuotaHeaders(
      headersOf({
        'x-ratelimit-remaining-requests': 'unlimited',
        'x-ratelimit-remaining-tokens': '-4',
      }),
    );
    expect(snapshot.remainingRequests).toBeNull();
    expect(snapshot.remainingTokens).toBeNull();
  });

  it('reads a zero bucket as zero, which is the one value that matters most', () => {
    const snapshot = readQuotaHeaders(headersOf({ 'x-ratelimit-remaining-tokens': '0' }));
    expect(snapshot.remainingTokens).toBe(0);
  });
});

describe('pacing before a limit rather than after one (AC1)', () => {
  it('waits for the token bucket when it cannot cover one more call', () => {
    const snapshot = readQuotaHeaders(
      headersOf({
        'x-ratelimit-remaining-tokens': String(MATCH_TOKENS_PER_CALL - 1),
        'x-ratelimit-reset-tokens': '7.66s',
      }),
    );
    expect(paceBeforeNextCallMs(snapshot)).toBe(7660);
  });

  it('does not wait while a whole call still fits', () => {
    const snapshot = readQuotaHeaders(
      headersOf({
        'x-ratelimit-remaining-tokens': String(MATCH_TOKENS_PER_CALL),
        'x-ratelimit-reset-tokens': '7.66s',
      }),
    );
    expect(paceBeforeNextCallMs(snapshot)).toBe(0);
  });

  it('waits when the request bucket is empty', () => {
    const snapshot = readQuotaHeaders(
      headersOf({
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '12s',
      }),
    );
    expect(paceBeforeNextCallMs(snapshot)).toBe(12_000);
  });

  it('does not wait on the last remaining request, which will still be served', () => {
    const snapshot = readQuotaHeaders(
      headersOf({ 'x-ratelimit-remaining-requests': '1', 'x-ratelimit-reset-requests': '12s' }),
    );
    expect(paceBeforeNextCallMs(snapshot)).toBe(0);
  });

  it('takes the later of two exhausted buckets', () => {
    // Clearing only the nearer one puts the next call straight back into a
    // refusal, which is the same reason `retryAfterMsFrom` takes the later.
    const snapshot = readQuotaHeaders(
      headersOf({
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '30s',
        'x-ratelimit-remaining-tokens': '10',
        'x-ratelimit-reset-tokens': '4s',
      }),
    );
    expect(paceBeforeNextCallMs(snapshot)).toBe(30_000);
  });

  it('yields zero when a bucket is exhausted but no reset was given', () => {
    // Not a guess. The call goes out, is refused, and the 429's own
    // `retry-after` decides the wait -- information rather than invention.
    const snapshot = readQuotaHeaders(headersOf({ 'x-ratelimit-remaining-tokens': '0' }));
    expect(paceBeforeNextCallMs(snapshot)).toBe(0);
  });
});

describe('separating a wait that will clear from a daily cap (AC6)', () => {
  it('accepts every per-minute reset these providers actually emit', () => {
    for (const waitMs of [0, 7660, 60_000, MAX_WAIT_MS]) {
      expect(isWaitable(waitMs)).toBe(true);
    }
  });

  it('refuses a reset measured in hours', () => {
    expect(isWaitable(MAX_WAIT_MS + 1)).toBe(false);
    // A Google daily cap resets at midnight Pacific; six hours is a mild case.
    expect(isWaitable(6 * 60 * 60 * 1000)).toBe(false);
  });

  it('refuses a non-finite wait rather than sleeping forever', () => {
    expect(isWaitable(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isWaitable(Number.NaN)).toBe(false);
  });
});

describe('the wait budget is a property of the Match (AC7)', () => {
  it('allows exactly the bound and then refuses', () => {
    const budget = createWaitBudget(3);
    expect([budget.spend(), budget.spend(), budget.spend()]).toStrictEqual([true, true, true]);
    expect(budget.spend()).toBe(false);
    expect(budget.taken()).toBe(3);
  });

  it('does not keep counting once it has refused', () => {
    const budget = createWaitBudget(1);
    budget.spend();
    budget.spend();
    budget.spend();
    expect(budget.taken()).toBe(1);
  });

  it('defaults to the committed bound', () => {
    const budget = createWaitBudget();
    for (let index = 0; index < MAX_RATE_LIMIT_WAITS; index += 1) {
      expect(budget.spend()).toBe(true);
    }
    expect(budget.spend()).toBe(false);
  });

  it('is shared, so two fighters draw on one allowance', () => {
    // The bound is a statement about the Match. Two keys each stalling four
    // times is the same amount of nothing happening as one stalling eight.
    const budget = createWaitBudget(4);
    expect([budget.spend(), budget.spend()]).toStrictEqual([true, true]);
    expect([budget.spend(), budget.spend()]).toStrictEqual([true, true]);
    expect(budget.spend()).toBe(false);
  });
});
