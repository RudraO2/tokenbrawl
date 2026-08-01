import type { ProviderId } from '@tokenbrawl/contracts';
import type { ProviderClient, ProviderRequest, ProviderResponse } from '../../core/src/deployment';
import type { FreeTierConfig, FreeTierLimits } from './free-tier';
import {
  assertFreeTierEndpoint,
  freeTierLimitsFor,
  freeTierProvider,
  loadFreeTierConfig,
} from './free-tier';
import type { HttpFetch, Sleep } from './http';
import { defaultHttpFetch, defaultSleep } from './http';
import { excerpt, mapOpenAiResponse, openAiRequestBody } from './openai-wire';
import type { RateLimitSink } from './rate-limit';
import { RATE_LIMIT_STATUS, buildRateLimitSignal } from './rate-limit';

/**
 * Story 3.2: the Groq adapter -- the first real implementation of the
 * `ProviderClient` port Story 3.1 defined in `packages/core`.
 *
 * The port lives in core and this package implements it, not the other way
 * round: `eslint.config.js` machine-enforces AD-1, so core may not import an
 * adapter. Everything below is therefore a *mapping* -- an already-assembled
 * `system`/`user` pair onto Groq's OpenAI-compatible wire format, and its
 * response back onto raw usage counts. No prompt is built here and none can be
 * (INV-7, AD-7): `ProviderRequest` carries no material an adapter could rebuild
 * one from.
 *
 * AD-6 is the other half of the division: this file reports what the provider
 * reported and does no arithmetic on it. `runMatch` and `debitTokenBank` own
 * the Token Bank, and neither identifier appears in this package.
 *
 * AD-9: no cross-call state. The returned client is frozen and holds only
 * configuration -- the key, the model, the endpoint, the injected transport,
 * and the read-only quota facts. Rate-limit bookkeeping is surfaced to the
 * runner and kept there.
 */

export const GROQ_PROVIDER_ID: ProviderId = 'groq';

export interface GroqClientConfig {
  readonly apiKey: string;
  readonly model: string;
  /** Defaults to the single allowlisted free-tier endpoint in `free-tier.config.json`. */
  readonly endpoint?: string;
  readonly fetch?: HttpFetch;
  readonly sleep?: Sleep;
  /**
   * Where a rate limit is surfaced. Optional because a Match must still run
   * without a runner attached; quota state belongs to whoever supplies this.
   */
  readonly onRateLimit?: RateLimitSink;
  /** Overridable for tests. Production reads the committed config file. */
  readonly freeTier?: FreeTierConfig;
}

export interface GroqClient extends ProviderClient {
  /** Read-only quota facts for this Deployment, straight from the config file. Configuration, not state. */
  readonly limits: FreeTierLimits;
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createGroqClient: ${field} must be a non-empty string.`);
  }
}

/**
 * The exact JSON sent on the wire.
 *
 * Story 4.7 moved the body itself to `openai-wire.ts`: Groq, Cerebras and the
 * visitor-supplied endpoint all speak the same OpenAI chat-completions format,
 * and three copies of the INV-4 `max_tokens` guard is two places for it to be
 * relaxed by accident. The wrapper stays so the thrown sentence still names
 * this builder, which is what the tests read.
 */
export function groqRequestBody(model: string, request: ProviderRequest): string {
  return openAiRequestBody(model, request, 'groqRequestBody');
}

/**
 * Provider body text -> `ProviderResponse`. Pure, so every parsing case is
 * testable from a recorded fixture with no network. See `openai-wire.ts` for
 * why a 200 with no choice throws rather than becoming an empty completion.
 */
export function mapGroqResponse(bodyText: string): ProviderResponse {
  return mapOpenAiResponse(bodyText, 'Groq');
}

/**
 * Builds a Groq `ProviderClient`.
 *
 * Validation happens here rather than at the first call, so a mistyped endpoint
 * or a missing key fails before a tournament starts instead of an hour into
 * one. The endpoint check is INV-8's: an endpoint absent from the free-tier
 * allowlist is refused outright, and there is no parameter to wave it through.
 */
export function createGroqClient(config: GroqClientConfig): GroqClient {
  const { apiKey, model, onRateLimit } = config;

  assertNonBlank(apiKey, 'apiKey');
  assertNonBlank(model, 'model');

  // Routed through the loader even when supplied, so an injected config is
  // validated exactly as the committed one is (INV-8).
  const freeTier = loadFreeTierConfig(config.freeTier);
  const providerConfig = freeTierProvider(GROQ_PROVIDER_ID, freeTier);
  const endpoint = config.endpoint ?? providerConfig.endpoints[0];
  assertFreeTierEndpoint(GROQ_PROVIDER_ID, endpoint, freeTier);

  const limits = freeTierLimitsFor(GROQ_PROVIDER_ID, model, freeTier);
  const fallbackBackoffMs = providerConfig.fallbackBackoffMs;
  const maxBackoffMs = providerConfig.maxBackoffMs;
  const httpFetch = config.fetch ?? defaultHttpFetch();
  const sleep = config.sleep ?? defaultSleep();

  /**
   * Exactly one HTTP request per call, rate limit or not.
   *
   * On a 429 this resolves rather than rejecting. That is the only shape in
   * which the AC holds in full: a rejection propagates through `runMatch`'s
   * `Promise.all` and fails the Match, and a second request would be the retry
   * the AC forbids. So the limit is surfaced as a typed signal, backed off
   * once, and reported as a Decision Point at which the Deployment produced no
   * Action -- which `runMatch` already records as the Fallback Action `stand`
   * with `parseFailure: true`.
   *
   * The 429 body is passed through as the response text on purpose. It is
   * honestly what the endpoint returned, and it is the only way a rate-limited
   * Decision Point stays distinguishable once the Match is on disk: the frozen
   * `DecisionEntry` has no field for one, and an empty string would be
   * indistinguishable from a model that replied with nothing.
   */
  async function complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await httpFetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: groqRequestBody(model, request),
    });

    const bodyText = await response.text();

    if (response.status === RATE_LIMIT_STATUS) {
      const signal = buildRateLimitSignal({
        provider: GROQ_PROVIDER_ID,
        endpoint,
        model,
        status: response.status,
        headers: response.headers,
        bodyText,
        fallbackBackoffMs,
      });

      onRateLimit?.(signal);
      // Bounded. The signal keeps the provider's true interval -- a daily quota
      // resets hours away -- but sleeping that here would hang the Match with
      // no diagnostic. Pausing a Deployment for the rest of the day is the
      // runner's decision to make from the signal it was just handed (AD-9).
      await sleep(Math.min(signal.retryAfterMs, maxBackoffMs));

      return {
        text: bodyText,
        usage: { tokensSpent: null, reasoningTokens: null },
        reasoning: null,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      // Everything that is not a rate limit fails loudly. A bad key, a retired
      // model or a gateway error absorbed into a Parse Failure would produce a
      // full tournament of plausible-looking logs recording a model that was
      // never asked anything.
      throw new Error(
        `Groq request to ${endpoint} failed with status ${response.status}: ${excerpt(bodyText)}`,
      );
    }

    return mapGroqResponse(bodyText);
  }

  return Object.freeze({
    provider: GROQ_PROVIDER_ID,
    endpoint,
    model,
    limits,
    complete,
  });
}
