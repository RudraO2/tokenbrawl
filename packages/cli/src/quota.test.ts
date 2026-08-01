import { describe, expect, it } from 'vitest';
import type { RateLimitSignal } from '../../providers/src/rate-limit';
import { createQuotaTracker } from './quota';

function signal(retryAfterMs: number): RateLimitSignal {
  return Object.freeze({
    kind: 'rate-limit' as const,
    provider: 'groq' as const,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    status: 429,
    quota: 'requests' as const,
    retryAfterMs,
    message: 'rate limited',
  });
}

const MAX_BACKOFF_MS = 120_000;

describe('createQuotaTracker', () => {
  it('starts with nothing parked', () => {
    const tracker = createQuotaTracker();
    expect(tracker.isParked('groq:llama-3.1-8b-instant')).toBe(false);
    expect(tracker.parked).toStrictEqual([]);
  });

  it('does not park a signal the adapter already fully waited out', () => {
    const tracker = createQuotaTracker();
    const parkedNow = tracker.recordRateLimit('groq:x', signal(MAX_BACKOFF_MS), MAX_BACKOFF_MS);
    expect(parkedNow).toBe(false);
    expect(tracker.isParked('groq:x')).toBe(false);
    expect(tracker.parked).toStrictEqual([]);
  });

  it('parks on a signal past what one call can wait out', () => {
    const tracker = createQuotaTracker();
    const parkedNow = tracker.recordRateLimit('groq:x', signal(MAX_BACKOFF_MS + 1), MAX_BACKOFF_MS);
    expect(parkedNow).toBe(true);
    expect(tracker.isParked('groq:x')).toBe(true);
    expect(tracker.parked).toStrictEqual(['groq:x']);
  });

  it('is a strict boundary: exactly maxBackoffMs does not park, one ms over does', () => {
    const under = createQuotaTracker();
    expect(under.recordRateLimit('a', signal(MAX_BACKOFF_MS), MAX_BACKOFF_MS)).toBe(false);

    const over = createQuotaTracker();
    expect(over.recordRateLimit('a', signal(MAX_BACKOFF_MS + 1), MAX_BACKOFF_MS)).toBe(true);
  });

  it('returns true exactly once for a Deployment parked twice', () => {
    const tracker = createQuotaTracker();
    expect(tracker.recordRateLimit('groq:x', signal(999_999), MAX_BACKOFF_MS)).toBe(true);
    expect(tracker.recordRateLimit('groq:x', signal(999_999), MAX_BACKOFF_MS)).toBe(false);
    expect(tracker.parked).toStrictEqual(['groq:x']);
  });

  it('tracks Deployments independently -- one parked, the other untouched', () => {
    const tracker = createQuotaTracker();
    tracker.recordRateLimit('groq:x', signal(999_999), MAX_BACKOFF_MS);
    expect(tracker.isParked('groq:x')).toBe(true);
    expect(tracker.isParked('groq:y')).toBe(false);
  });

  it('records parked ids in the order they were parked', () => {
    const tracker = createQuotaTracker();
    tracker.recordRateLimit('second', signal(999_999), MAX_BACKOFF_MS);
    tracker.recordRateLimit('first', signal(999_999), MAX_BACKOFF_MS);
    // Deliberately not alphabetical -- this pins insertion order, not a sort.
    expect(tracker.parked).toStrictEqual(['second', 'first']);
  });

  it('two trackers never share state', () => {
    const a = createQuotaTracker();
    const b = createQuotaTracker();
    a.recordRateLimit('groq:x', signal(999_999), MAX_BACKOFF_MS);
    expect(b.isParked('groq:x')).toBe(false);
    expect(b.parked).toStrictEqual([]);
  });
});
