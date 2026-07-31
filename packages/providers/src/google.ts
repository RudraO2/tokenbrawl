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
import type { RateLimitSink } from './rate-limit';
import { RATE_LIMIT_STATUS, buildRateLimitSignal } from './rate-limit';

/**
 * Story 3.3: the Google AI Studio adapter -- a `ProviderClient` over the
 * Gemini `generateContent` endpoint.
 *
 * The wire shape differs from Groq/Cerebras's OpenAI-compatible chat
 * completions (`contents`/`systemInstruction` instead of `messages`,
 * `usageMetadata` instead of `usage`, the key on a header instead of in the
 * `Authorization` bearer scheme, the model baked into the endpoint path
 * rather than the request body) but every discipline is the same: no prompt
 * assembly (INV-7, AD-7), raw usage passthrough with no arithmetic (AD-6), no
 * cross-call state (AD-9), every quota from `free-tier.config.json` (AC5,
 * INV-8).
 *
 * The API key rides on the `x-goog-api-key` header rather than the URL's
 * `?key=` query parameter Google's own docs often show -- the query form
 * would put the key on `DeploymentIdentity.endpoint`, and that field is
 * written to every Command Log entry (INV-6). A header keeps the key out of
 * anything ever persisted to disk.
 */

export const GOOGLE_PROVIDER_ID: ProviderId = 'google-ai-studio';

/** Enough of a failing body to diagnose it, never enough to flood a log. */
const BODY_EXCERPT_LIMIT = 256;

export interface GoogleClientConfig {
  readonly apiKey: string;
  readonly model: string;
  /** Defaults to that model's allowlisted `generateContent` endpoint in `free-tier.config.json`. */
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

export interface GoogleClient extends ProviderClient {
  /** Read-only quota facts for this Deployment, straight from the config file. Configuration, not state. */
  readonly limits: FreeTierLimits;
}

interface GooglePart {
  readonly text?: unknown;
}

interface GoogleContent {
  readonly parts?: readonly GooglePart[] | null;
}

interface GoogleCandidate {
  readonly content?: GoogleContent | null;
}

interface GoogleUsageMetadata {
  readonly candidatesTokenCount?: unknown;
  readonly thoughtsTokenCount?: unknown;
}

interface GoogleBody {
  readonly candidates?: readonly GoogleCandidate[];
  readonly usageMetadata?: GoogleUsageMetadata | null;
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createGoogleClient: ${field} must be a non-empty string.`);
  }
}

function excerpt(bodyText: string): string {
  return bodyText.length > BODY_EXCERPT_LIMIT
    ? `${bodyText.slice(0, BODY_EXCERPT_LIMIT)}...`
    : bodyText;
}

/**
 * A reported count, or `null` when the provider did not report a usable one
 * (INV-5). A present-but-malformed value is treated the same way, rather than
 * passed on to `debitTokenBank`, which would throw and take the Match with it.
 */
function reportedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * The exact JSON sent on the wire. `generationConfig.maxOutputTokens`
 * appears only in Reflex Mode (INV-4): no thinking budget, effort or
 * temperature key of any kind -- `thinkingConfig` never appears here.
 */
export function googleRequestBody(request: ProviderRequest): string {
  if (
    request.maxTokens !== undefined &&
    !(Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0)
  ) {
    throw new Error(
      `googleRequestBody: maxTokens must be a positive safe integer when set, got ${String(request.maxTokens)}`,
    );
  }

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
  };

  if (request.maxTokens !== undefined) {
    body.generationConfig = { maxOutputTokens: request.maxTokens };
  }

  return JSON.stringify(body);
}

/**
 * Provider body text -> `ProviderResponse`. Pure, so every parsing case is
 * testable from a recorded fixture with no network.
 */
export function mapGoogleResponse(bodyText: string): ProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Google AI Studio returned a body that is not JSON: ${excerpt(bodyText)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Google AI Studio returned a body that is not an object: ${excerpt(bodyText)}`);
  }

  const body = parsed as GoogleBody;
  const candidate = body.candidates?.[0];
  if (candidate === undefined) {
    throw new Error(`Google AI Studio returned no candidates: ${excerpt(bodyText)}`);
  }

  const parts = candidate.content?.parts ?? [];
  const text = parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');

  return {
    text,
    usage: {
      tokensSpent: reportedCount(body.usageMetadata?.candidatesTokenCount),
      reasoningTokens: reportedCount(body.usageMetadata?.thoughtsTokenCount),
    },
    reasoning: null,
  };
}

/**
 * Builds a Google AI Studio `ProviderClient`. Validation happens at
 * construction, not the first call, so a mistyped endpoint or missing key
 * fails before a tournament starts. The endpoint check is INV-8's; because
 * the model is part of this provider's URL path, a Deployment's `model` and
 * its `endpoint` must name the same model or construction throws.
 */
export function createGoogleClient(config: GoogleClientConfig): GoogleClient {
  const { apiKey, model, onRateLimit } = config;

  assertNonBlank(apiKey, 'apiKey');
  assertNonBlank(model, 'model');

  const freeTier = loadFreeTierConfig(config.freeTier);
  const providerConfig = freeTierProvider(GOOGLE_PROVIDER_ID, freeTier);
  const discovered = providerConfig.endpoints.find((url) => url.includes(`/models/${model}:`));
  const requestedEndpoint = config.endpoint ?? discovered;
  if (requestedEndpoint === undefined) {
    throw new Error(
      `createGoogleClient: no free-tier endpoint for model "${model}". Add one to free-tier.config.json before configuring a Deployment against it (INV-8).`,
    );
  }
  const endpoint: string = requestedEndpoint;
  assertFreeTierEndpoint(GOOGLE_PROVIDER_ID, endpoint, freeTier);
  if (!endpoint.includes(`/models/${model}:`)) {
    throw new Error(
      `createGoogleClient: endpoint "${endpoint}" does not name model "${model}" -- Google AI Studio bakes the model into the URL path.`,
    );
  }

  const limits = freeTierLimitsFor(GOOGLE_PROVIDER_ID, model, freeTier);
  const fallbackBackoffMs = providerConfig.fallbackBackoffMs;
  const maxBackoffMs = providerConfig.maxBackoffMs;
  const httpFetch = config.fetch ?? defaultHttpFetch();
  const sleep = config.sleep ?? defaultSleep();

  /**
   * Exactly one HTTP request per call, rate limit or not -- see `groq.ts` for
   * the full reasoning; the shape here is identical because the constraint
   * (AC2: surface a typed signal, back off, never fail the Match, never
   * retry) is the same regardless of which free-tier provider issued it.
   */
  async function complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await httpFetch(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: googleRequestBody(request),
    });

    const bodyText = await response.text();

    if (response.status === RATE_LIMIT_STATUS) {
      const signal = buildRateLimitSignal({
        provider: GOOGLE_PROVIDER_ID,
        endpoint,
        model,
        status: response.status,
        headers: response.headers,
        bodyText,
        fallbackBackoffMs,
      });

      onRateLimit?.(signal);
      await sleep(Math.min(signal.retryAfterMs, maxBackoffMs));

      return {
        text: bodyText,
        usage: { tokensSpent: null, reasoningTokens: null },
        reasoning: null,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Google AI Studio request to ${endpoint} failed with status ${response.status}: ${excerpt(bodyText)}`,
      );
    }

    return mapGoogleResponse(bodyText);
  }

  return Object.freeze({
    provider: GOOGLE_PROVIDER_ID,
    endpoint,
    model,
    limits,
    complete,
  });
}
