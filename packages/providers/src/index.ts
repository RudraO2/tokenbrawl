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

// ---------------------------------------------------------------------------
// Story 3.3: Cerebras and Google AI Studio adapters, plus tournament-config
// validation (one ranked Deployment per provider, no OpenRouter in a
// tournament).
// ---------------------------------------------------------------------------

export {
  CEREBRAS_PROVIDER_ID,
  cerebrasRequestBody,
  createCerebrasClient,
  mapCerebrasResponse,
} from './cerebras';
export type { CerebrasClient, CerebrasClientConfig } from './cerebras';

export { GOOGLE_PROVIDER_ID, createGoogleClient, googleRequestBody, mapGoogleResponse } from './google';
export type { GoogleClient, GoogleClientConfig } from './google';

export { validateTournamentConfig } from './tournament-config';
export type { TournamentConfigValidation, TournamentDeploymentConfig } from './tournament-config';

// ---------------------------------------------------------------------------
// Story 3.4: the Metering Probe (INV-5) and the Reflex-Track consequences of
// its classification.
// ---------------------------------------------------------------------------

export {
  PROBE_SYSTEM_PROMPT,
  PROBE_USER_PROMPT,
  classifyProbeUsage,
  mapProbeUsage,
  probeDeployments,
  probeRequestBody,
  probeWireFamilyFor,
  runMeteringProbe,
} from './metering-probe';
export type {
  MeteringProbeOutcome,
  MeteringProbeTarget,
  ProbeWireFamily,
} from './metering-probe';

export {
  applyMeteringProbe,
  deploymentIdentityFrom,
  formatMeteringExclusions,
  partitionByTrack,
  trackFor,
  withMeteringProbe,
} from './track';
export type { LeaderboardTrack, MeteringExclusion, TrackPartition } from './track';
