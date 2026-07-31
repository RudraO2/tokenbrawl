import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { placeholder } from './index';

describe('@tokenbrawl/providers placeholder', () => {
  it('exports a truthy placeholder', () => {
    expect(placeholder).toBe(true);
  });
});

describe('the Story 3.2 barrel', () => {
  it('exposes the adapter, the config queries, and the rate-limit signal', () => {
    // A consumer (the CLI in 5.1, the tournament runner in 5.2) reaches this
    // package through the barrel. A module added to `src/` but never exported
    // is invisible to every one of them.
    for (const name of [
      'createGroqClient',
      'groqRequestBody',
      'mapGroqResponse',
      'GROQ_PROVIDER_ID',
      'loadFreeTierConfig',
      'freeTierLimitsFor',
      'freeTierProvider',
      'assertFreeTierEndpoint',
      'buildRateLimitSignal',
      'parseDurationMs',
      'quotaFrom',
      'rateLimitMessage',
      'retryAfterMsFrom',
      'RATE_LIMIT_STATUS',
      'defaultHttpFetch',
      'defaultSleep',
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });

  it('names Groq as the provider id the contracts already allow', () => {
    expect(barrel.GROQ_PROVIDER_ID).toBe('groq');
  });
});
