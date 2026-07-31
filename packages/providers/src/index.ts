import type { Action } from '@tokenbrawl/contracts';

/**
 * Placeholder export for Story 1.1 (scaffold only). Real provider adapters
 * (Groq, Cerebras, Google AI Studio, OpenRouter, BYOK) and the Metering
 * Probe land in later stories.
 */
export const placeholder = true;

/** Proves the `@tokenbrawl/contracts` alias resolves here too. Type-only. */
export type PlaceholderAction = Action;

// ---------------------------------------------------------------------------
// Story 3.2: the Groq adapter, free-tier configuration, and rate-limit signals.
// ---------------------------------------------------------------------------

export {
  assertFreeTierEndpoint,
  freeTierLimitsFor,
  freeTierProvider,
  loadFreeTierConfig,
} from './free-tier';
export type { FreeTierConfig, FreeTierLimits, FreeTierProvider } from './free-tier';

export { defaultHttpFetch, defaultSleep } from './http';
export type { HttpFetch, HttpHeaders, HttpRequest, HttpResponse, Sleep } from './http';

export {
  RATE_LIMIT_STATUS,
  buildRateLimitSignal,
  parseDurationMs,
  quotaFrom,
  rateLimitMessage,
  retryAfterMsFrom,
} from './rate-limit';
export type {
  RateLimitQuota,
  RateLimitSignal,
  RateLimitSignalParams,
  RateLimitSink,
} from './rate-limit';

export { GROQ_PROVIDER_ID, createGroqClient, groqRequestBody, mapGroqResponse } from './groq';
export type { GroqClient, GroqClientConfig } from './groq';
