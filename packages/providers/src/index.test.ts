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

describe('the Story 3.3 barrel', () => {
  it('exposes the Cerebras and Google AI Studio adapters plus tournament-config validation', () => {
    for (const name of [
      'createCerebrasClient',
      'cerebrasRequestBody',
      'mapCerebrasResponse',
      'CEREBRAS_PROVIDER_ID',
      'createGoogleClient',
      'googleRequestBody',
      'mapGoogleResponse',
      'GOOGLE_PROVIDER_ID',
      'validateTournamentConfig',
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });

  it('names the two new providers as the contracts already allow', () => {
    expect(barrel.CEREBRAS_PROVIDER_ID).toBe('cerebras');
    expect(barrel.GOOGLE_PROVIDER_ID).toBe('google-ai-studio');
  });
});

describe('the Story 3.4 barrel', () => {
  it('exposes the Metering Probe and the track it forces', () => {
    for (const name of [
      'runMeteringProbe',
      'probeDeployments',
      'probeRequestBody',
      'probeWireFamilyFor',
      'mapProbeUsage',
      'classifyProbeUsage',
      'PROBE_SYSTEM_PROMPT',
      'PROBE_USER_PROMPT',
      'trackFor',
      'withMeteringProbe',
      'deploymentIdentityFrom',
      'applyMeteringProbe',
      'partitionByTrack',
      'formatMeteringExclusions',
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });

  it('reaches the leaderboard decision through the barrel, which is where a consumer will call it', () => {
    // Story 7.2 publishes ratings and 4.x renders them; both reach this
    // package through the barrel, and a module in `src/` that is never
    // exported is invisible to every one of them.
    expect(barrel.trackFor('reports-reasoning')).toBe('main');
    expect(barrel.trackFor(undefined)).toBe('reflex');
  });
});
