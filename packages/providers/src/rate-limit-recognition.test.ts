import { describe, expect, it } from 'vitest';
import { isRateLimitedResponse } from '../../core/src/behavioural-metrics';
import { quotaFrom } from './rate-limit';

/**
 * Story 7-3, the seam between the two packages that know what a 429 looks like.
 *
 * A rate-limited Decision Point and a grammar Parse Failure are recorded
 * identically in a Command Log -- `DecisionEntry` is frozen and carries no
 * discriminator -- so `packages/core`'s `isRateLimitedResponse` reads the
 * refusal back out of `rawResponse`, which Story 3.2 kept verbatim for exactly
 * this purpose. On the one live run the raw parse-failure rate was 20/40 while
 * the real grammar rate was 1/21, so the split is not a nicety.
 *
 * AD-1 forbids core importing this package, so the recogniser cannot share code
 * with `rate-limit.ts` and instead knows a small list of provider error codes.
 * That list can go stale silently -- a provider changes its vocabulary, every
 * refusal starts counting as the model's fault, and the published rate flatters
 * nobody in particular but is wrong. This file is the check: the bodies each
 * adapter has actually recorded, run through core's recogniser, here where the
 * dependency is allowed to point.
 *
 * A new adapter adds its recorded body to `RECORDED_REFUSALS` below.
 */

const GROQ_429 = JSON.stringify({
  error: {
    message:
      'Rate limit reached for model `llama-3.1-8b-instant` in organization `org_x` on tokens per minute (TPM): Limit 6000, Used 6000, Requested 51. Please try again in 7.66s.',
    type: 'tokens',
    code: 'rate_limit_exceeded',
  },
});

const CEREBRAS_429 = JSON.stringify({
  error: {
    message: 'Rate limit exceeded for requests per minute. Please try again in 2s.',
    type: 'requests',
    code: 'rate_limit_exceeded',
  },
});

const GOOGLE_429 = JSON.stringify({
  error: {
    code: 429,
    message: 'Quota exceeded for quota metric "Generate requests" and limit "per minute".',
    status: 'RESOURCE_EXHAUSTED',
  },
});

const RECORDED_REFUSALS: readonly (readonly [string, string])[] = [
  ['groq', GROQ_429],
  ['cerebras', CEREBRAS_429],
  ['google-ai-studio', GOOGLE_429],
];

describe("core's recogniser knows every refusal this repo has recorded", () => {
  for (const [provider, body] of RECORDED_REFUSALS) {
    it(`recognises the ${provider} 429 body`, () => {
      expect(isRateLimitedResponse(body)).toBe(true);
    });
  }

  it('recognises every body this package classifies a quota for', () => {
    // `quotaFrom` is the adapter-side reader of the same bodies, answering a
    // different question -- *which* quota tripped. Where it is confident, core
    // must at least agree the body is a refusal at all; the reverse does not
    // hold, and deliberately so. Google's message names neither "requests per"
    // nor "tokens per", so `quotaFrom` returns `unknown` for it while its
    // `RESOURCE_EXHAUSTED` status is unambiguous to the recogniser -- the
    // backoff comes from the headers regardless, which is the reasoning
    // `quotaFrom` already carries.
    for (const [, body] of RECORDED_REFUSALS) {
      if (quotaFrom(body) !== 'unknown') {
        expect(isRateLimitedResponse(body)).toBe(true);
      }
    }
    expect(quotaFrom(GOOGLE_429)).toBe('unknown');
    expect(isRateLimitedResponse(GOOGLE_429)).toBe(true);
  });

  it('does not recognise an ordinary completion as a refusal', () => {
    const completion = JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: 'ACTION: attack' } }],
      usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
    });
    expect(isRateLimitedResponse(completion)).toBe(false);
    // Nor the bare model text a Parse Failure actually leaves behind.
    expect(isRateLimitedResponse('I will attack now.')).toBe(false);
  });

  it('does not recognise a failure that is not a quota, so a bad key stays a bad key', () => {
    const badKey = JSON.stringify({
      error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' },
    });
    expect(isRateLimitedResponse(badKey)).toBe(false);
  });
});
