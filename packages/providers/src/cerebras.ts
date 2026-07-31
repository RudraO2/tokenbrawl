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
 * Story 3.3: the Cerebras adapter -- a second `ProviderClient` implementation
 * behind the same port Story 3.1 defined and Story 3.2's Groq adapter first
 * implemented.
 *
 * Cerebras's endpoint is OpenAI-compatible chat completions, so the wire
 * shape and every discipline this file must hold are the same as `groq.ts`:
 * no prompt assembly (INV-7, AD-7), raw usage passthrough with no arithmetic
 * (AD-6), no cross-call state (AD-9), and every quota read from
 * `free-tier.config.json` (AC5, INV-8). AD-1 forbids `packages/core` or any
 * Environment Adapter from changing to add a provider, and none did.
 */

export const CEREBRAS_PROVIDER_ID: ProviderId = 'cerebras';

/** Enough of a failing body to diagnose it, never enough to flood a log. */
const BODY_EXCERPT_LIMIT = 256;

export interface CerebrasClientConfig {
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

export interface CerebrasClient extends ProviderClient {
  /** Read-only quota facts for this Deployment, straight from the config file. Configuration, not state. */
  readonly limits: FreeTierLimits;
}

interface CerebrasUsage {
  readonly completion_tokens?: unknown;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown } | null;
}

interface CerebrasMessage {
  readonly content?: string | null;
  readonly reasoning?: string | null;
}

interface CerebrasBody {
  readonly choices?: readonly { readonly message?: CerebrasMessage | null }[];
  readonly usage?: CerebrasUsage | null;
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createCerebrasClient: ${field} must be a non-empty string.`);
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
 * The exact JSON sent on the wire. `max_tokens` appears only in Reflex Mode
 * (INV-4): no effort, thinking, budget or temperature key of any kind.
 */
export function cerebrasRequestBody(model: string, request: ProviderRequest): string {
  if (
    request.maxTokens !== undefined &&
    !(Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0)
  ) {
    throw new Error(
      `cerebrasRequestBody: maxTokens must be a positive safe integer when set, got ${String(request.maxTokens)}`,
    );
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
  };

  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }

  return JSON.stringify(body);
}

/**
 * Provider body text -> `ProviderResponse`. Pure, so every parsing case is
 * testable from a recorded fixture with no network.
 */
export function mapCerebrasResponse(bodyText: string): ProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Cerebras returned a body that is not JSON: ${excerpt(bodyText)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Cerebras returned a body that is not an object: ${excerpt(bodyText)}`);
  }

  const body = parsed as CerebrasBody;
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new Error(`Cerebras returned no choices: ${excerpt(bodyText)}`);
  }

  const message = choice.message ?? null;
  const content = message?.content;
  const details = body.usage?.completion_tokens_details ?? null;
  const separateReasoning = message?.reasoning;

  return {
    text: typeof content === 'string' ? content : '',
    usage: {
      tokensSpent: reportedCount(body.usage?.completion_tokens),
      reasoningTokens: reportedCount(details?.reasoning_tokens),
    },
    reasoning: typeof separateReasoning === 'string' ? separateReasoning : null,
  };
}

/**
 * Builds a Cerebras `ProviderClient`. Validation happens at construction, not
 * the first call, so a mistyped endpoint or missing key fails before a
 * tournament starts. The endpoint check is INV-8's.
 */
export function createCerebrasClient(config: CerebrasClientConfig): CerebrasClient {
  const { apiKey, model, onRateLimit } = config;

  assertNonBlank(apiKey, 'apiKey');
  assertNonBlank(model, 'model');

  const freeTier = loadFreeTierConfig(config.freeTier);
  const providerConfig = freeTierProvider(CEREBRAS_PROVIDER_ID, freeTier);
  const endpoint = config.endpoint ?? providerConfig.endpoints[0];
  assertFreeTierEndpoint(CEREBRAS_PROVIDER_ID, endpoint, freeTier);

  const limits = freeTierLimitsFor(CEREBRAS_PROVIDER_ID, model, freeTier);
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
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: cerebrasRequestBody(model, request),
    });

    const bodyText = await response.text();

    if (response.status === RATE_LIMIT_STATUS) {
      const signal = buildRateLimitSignal({
        provider: CEREBRAS_PROVIDER_ID,
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
        `Cerebras request to ${endpoint} failed with status ${response.status}: ${excerpt(bodyText)}`,
      );
    }

    return mapCerebrasResponse(bodyText);
  }

  return Object.freeze({
    provider: CEREBRAS_PROVIDER_ID,
    endpoint,
    model,
    limits,
    complete,
  });
}
