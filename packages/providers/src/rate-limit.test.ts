import { describe, expect, it } from 'vitest';
import type { HttpHeaders } from './http';
import {
  RATE_LIMIT_STATUS,
  buildRateLimitSignal,
  parseDurationMs,
  quotaFrom,
  rateLimitMessage,
  retryAfterMsFrom,
} from './rate-limit';

/**
 * Story 3.2 AC2, the parsing half: what a rate-limit response is turned into
 * before the adapter backs off.
 *
 * The header shapes below are the ones the live endpoint actually returned on
 * 2026-08-01 (`x-ratelimit-reset-requests: 6s`,
 * `x-ratelimit-reset-tokens: 430ms`) plus the `retry-after` form Groq documents
 * for a 429.
 */

function headers(entries: Readonly<Record<string, string>>): HttpHeaders {
  const lowered = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

const FALLBACK_MS = 60_000;

describe('parseDurationMs', () => {
  it('reads the duration forms these endpoints emit', () => {
    expect(parseDurationMs('430ms')).toBe(430);
    expect(parseDurationMs('6s')).toBe(6000);
    expect(parseDurationMs('2m')).toBe(120_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('2m59.56s')).toBe(179_560);
    expect(parseDurationMs('1h2m3s')).toBe(3_723_000);
  });

  it('reads `ms` as milliseconds, never as minutes followed by a stray second', () => {
    // The alternation order in the unit pattern is load-bearing: `m|ms` would
    // read `430ms` as 430 minutes.
    expect(parseDurationMs('430ms')).toBeLessThan(parseDurationMs('1s') as number);
  });

  it('reads a bare number as seconds, per RFC 7231', () => {
    expect(parseDurationMs('2')).toBe(2000);
    expect(parseDurationMs('0')).toBe(0);
  });

  it('rounds a fractional value up, never down', () => {
    // Groq sends fractional seconds. Waiting 4ms too long costs nothing;
    // waiting 4ms too little spends another request against a dead quota.
    expect(parseDurationMs('7.66')).toBe(7660);
    expect(parseDurationMs('0.0001')).toBe(1);
    expect(parseDurationMs('0.0004s')).toBe(1);
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(parseDurationMs('  6S  ')).toBe(6000);
    expect(parseDurationMs('2M59.56S')).toBe(179_560);
  });

  it('returns null for anything it cannot read, including an HTTP-date', () => {
    for (const raw of [
      null,
      '',
      '   ',
      'soon',
      'Wed, 21 Oct 2026 07:28:00 GMT',
      '6 s',
      'x6s',
      '6sx',
      '6d',
      '-6s',
      'NaN',
      'Infinity',
    ]) {
      expect(parseDurationMs(raw)).toBeNull();
    }
  });

  it('holds no state between calls, so a repeated read gives the same answer', () => {
    // The unit pattern carries the `g` flag; an `exec` loop over it would carry
    // `lastIndex` across calls and silently halve the second answer.
    expect(parseDurationMs('2m59.56s')).toBe(parseDurationMs('2m59.56s'));
    expect(parseDurationMs('6s')).toBe(6000);
    expect(parseDurationMs('6s')).toBe(6000);
  });
});

describe('retryAfterMsFrom', () => {
  it('prefers retry-after-ms, the only unambiguous header', () => {
    expect(
      retryAfterMsFrom(headers({ 'retry-after-ms': '430', 'retry-after': '9' }), FALLBACK_MS),
    ).toBe(430);
  });

  it('reads retry-after-ms as milliseconds, not as seconds', () => {
    // The two headers spell the same number in different units. Routing
    // `retry-after-ms: 430` through the RFC 7231 bare-number rule would back
    // off for seven minutes instead of half a second.
    expect(retryAfterMsFrom(headers({ 'retry-after-ms': '430' }), FALLBACK_MS)).toBe(430);
    expect(retryAfterMsFrom(headers({ 'retry-after': '430' }), FALLBACK_MS)).toBe(430_000);
    // A unit-suffixed value is still honoured, in case a provider sends one.
    expect(retryAfterMsFrom(headers({ 'retry-after-ms': '430ms' }), FALLBACK_MS)).toBe(430);
  });

  it('falls back to retry-after, which is what a 429 documents', () => {
    expect(retryAfterMsFrom(headers({ 'retry-after': '2' }), FALLBACK_MS)).toBe(2000);
    expect(retryAfterMsFrom(headers({ 'retry-after': '7.66' }), FALLBACK_MS)).toBe(7660);
  });

  it('reads the header case-insensitively', () => {
    expect(retryAfterMsFrom(headers({ 'Retry-After': '2' }), FALLBACK_MS)).toBe(2000);
  });

  it('falls back to the reset headers, taking the later of the two', () => {
    // A request quota and a token quota expire at different moments; clearing
    // only the nearer one puts the next call straight back into a 429.
    expect(
      retryAfterMsFrom(
        headers({ 'x-ratelimit-reset-requests': '6s', 'x-ratelimit-reset-tokens': '430ms' }),
        FALLBACK_MS,
      ),
    ).toBe(6000);
    expect(
      retryAfterMsFrom(
        headers({ 'x-ratelimit-reset-requests': '430ms', 'x-ratelimit-reset-tokens': '2m59.56s' }),
        FALLBACK_MS,
      ),
    ).toBe(179_560);
  });

  it('uses one reset header when only one is readable', () => {
    expect(
      retryAfterMsFrom(
        headers({ 'x-ratelimit-reset-requests': 'soon', 'x-ratelimit-reset-tokens': '6s' }),
        FALLBACK_MS,
      ),
    ).toBe(6000);
  });

  it('falls back to the configured backoff when no header is readable', () => {
    expect(retryAfterMsFrom(headers({}), FALLBACK_MS)).toBe(FALLBACK_MS);
    expect(retryAfterMsFrom(headers({ 'retry-after': 'later' }), FALLBACK_MS)).toBe(FALLBACK_MS);
  });

  it('never returns a negative or non-integer delay', () => {
    expect(retryAfterMsFrom(headers({}), -1)).toBe(0);
    expect(retryAfterMsFrom(headers({}), Number.NaN)).toBe(0);
    expect(retryAfterMsFrom(headers({ 'retry-after': '0' }), FALLBACK_MS)).toBe(0);
    expect(Number.isSafeInteger(retryAfterMsFrom(headers({ 'retry-after': '7.66' }), 0))).toBe(true);
  });
});

describe('quotaFrom', () => {
  const body = (error: Record<string, unknown>): string => JSON.stringify({ error });

  it('trusts error.type when the provider gives one', () => {
    expect(quotaFrom(body({ type: 'tokens', message: 'anything' }))).toBe('tokens');
    expect(quotaFrom(body({ type: 'requests', message: 'anything' }))).toBe('requests');
  });

  it('falls back to the prose when the type is absent or unrecognised', () => {
    expect(
      quotaFrom(
        body({
          type: 'rate_limit_exceeded',
          message:
            'Rate limit reached for model `llama-3.1-8b-instant` on tokens per minute (TPM): Limit 6000, Used 6000.',
        }),
      ),
    ).toBe('tokens');
    expect(
      quotaFrom(body({ message: 'Rate limit reached: requests per day (RPD): Limit 14400.' })),
    ).toBe('requests');
  });

  it('degrades to unknown rather than guessing', () => {
    expect(quotaFrom(body({ message: 'Too many.' }))).toBe('unknown');
    expect(quotaFrom('not json at all')).toBe('unknown');
    expect(quotaFrom('')).toBe('unknown');
    expect(quotaFrom('null')).toBe('unknown');
    expect(quotaFrom('{"error":"a string, not an object"}')).toBe('unknown');
  });

  it('scans a non-JSON body for the same prose', () => {
    expect(quotaFrom('429 Too Many Requests: requests per minute exceeded')).toBe('requests');
  });
});

describe('rateLimitMessage', () => {
  it('reports the provider message where there is one', () => {
    expect(rateLimitMessage(JSON.stringify({ error: { message: 'Rate limit reached.' } }))).toBe(
      'Rate limit reached.',
    );
  });

  it('reports the raw body where there is not', () => {
    expect(rateLimitMessage('  upstream connect error  ')).toBe('upstream connect error');
    expect(rateLimitMessage(JSON.stringify({ error: { message: '   ' } }))).toBe(
      '{"error":{"message":"   "}}',
    );
  });
});

describe('buildRateLimitSignal', () => {
  const params = {
    provider: 'groq' as const,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    status: RATE_LIMIT_STATUS,
    headers: headers({ 'retry-after': '2' }),
    bodyText: JSON.stringify({
      error: { type: 'tokens', message: 'Rate limit reached.', code: 'rate_limit_exceeded' },
    }),
    fallbackBackoffMs: FALLBACK_MS,
  };

  it('carries everything a runner needs to do the bookkeeping it owns (AD-9)', () => {
    expect(buildRateLimitSignal(params)).toStrictEqual({
      kind: 'rate-limit',
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
      status: 429,
      quota: 'tokens',
      retryAfterMs: 2000,
      message: 'Rate limit reached.',
    });
  });

  it('is frozen, so a sink cannot edit the record another sink will see', () => {
    expect(Object.isFrozen(buildRateLimitSignal(params))).toBe(true);
  });

  it('pins the rate-limit status at 429', () => {
    expect(RATE_LIMIT_STATUS).toBe(429);
  });
});
