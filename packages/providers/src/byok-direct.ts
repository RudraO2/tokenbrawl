import type { ProviderClient, ProviderRequest, ProviderResponse } from '../../core/src/deployment';
import type { ParsedUrl } from './discovery';
import { parseUrl } from './discovery';
import type { HttpFetch, Sleep } from './http';
import { defaultHttpFetch, defaultSleep } from './http';
import { excerpt, mapOpenAiResponse, openAiRequestBody } from './openai-wire';
import type { RateLimitSink } from './rate-limit';
import { RATE_LIMIT_STATUS, buildRateLimitSignal } from './rate-limit';

/**
 * Story 4.7: a `ProviderClient` for an endpoint **this repo has never heard of**,
 * supplied by the visitor, reached with the visitor's own key.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE DOES NOT CALL `assertFreeTierEndpoint`, AND WHY THAT IS SAFE
 * ---------------------------------------------------------------------------
 *
 * Every other `create*Client` in this package validates its endpoint against
 * the free-tier allowlist, and `scripts/audit-invariants.sh` requires it of
 * each one. This file is the single, named exemption, and the reason is written
 * here and in the audit script rather than left to be inferred.
 *
 * INV-8 is *"zero recurring cost"* -- **this project's** cost. Tournament play
 * runs on this project's keys and is the only place a recurring cost could ever
 * appear, so the allowlist governs it absolutely and unchanged. A BYOK Match
 * runs on the visitor's own key and costs this project nothing, whatever
 * endpoint they choose. Refusing to let a visitor spend their own money buys
 * this project no protection from anything, and it is the reason OpenAI and
 * Anthropic -- which have no free tier at all and so can never be reached by
 * extending an allowlist -- are otherwise unreachable.
 *
 * The exemption is bounded by three things a grep can check, and the audit
 * script checks all three in place of the one it waives:
 *
 * 1. This file calls `assertVisitorSuppliedEndpoint`, which is https-only and
 *    resolves the exact origin the key will be sent to.
 * 2. `packages/providers/src/index.ts` does **not** re-export it. The package's
 *    public surface cannot reach this factory, so no tournament-path file can.
 * 3. Only `apps/web/src/byok/client.ts` imports it. Any other importer fails
 *    the audit.
 *
 * A boolean flag threaded through `createGroqClient` would have been the other
 * way to do this, and it is the wrong shape: it puts "skip the allowlist" one
 * edit away from tournament configuration. A separate file the package does not
 * export cannot be reached by accident.
 */

/** What a base URL resolves to. `origin` is what AC6 shows the visitor before the first request. */
export interface VisitorEndpoint {
  /** Scheme, host and port. The one origin this key is ever sent to. */
  readonly origin: string;
  readonly completions: string;
  /** The model list for the same origin, so discovery cannot drift to another host. */
  readonly models: string;
}

const COMPLETIONS_SUFFIX = '/chat/completions';
/** Not a free-tier quota: a visitor's endpoint publishes none this repo knows. A duration. */
const MS_PER_MINUTE = 60 * 1000;
const MODELS_SUFFIX = '/models';

/**
 * The security guard rail on the Advanced path, and the whole of it.
 *
 * `https://` only, because a plaintext URL puts the visitor's key on the wire
 * in clear -- that is an acceptance criterion, not a preference, and it is
 * refused outright rather than upgraded silently. The resolved origin comes back
 * so the panel can show it *before* the first request: "type a URL, we send your
 * key there" must never be a surprise.
 *
 * A base URL and a full completions URL are both accepted, because a visitor
 * copying from a provider's docs will have one or the other and guessing wrong
 * costs them a failed Match to find out.
 */
export function assertVisitorSuppliedEndpoint(baseUrl: string): VisitorEndpoint {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error('Enter the base URL of an OpenAI-compatible endpoint, for example https://openrouter.ai/api/v1');
  }

  let parsed: ParsedUrl;
  try {
    parsed = parseUrl(trimmed);
  } catch {
    throw new Error(`"${excerpt(trimmed)}" is not a URL. It should look like https://openrouter.ai/api/v1`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refused: "${excerpt(trimmed)}" is not https. Your key would travel in clear text, so a plaintext endpoint is never contacted.`,
    );
  }

  // Query strings and fragments are dropped rather than carried: neither
  // belongs on a completions URL, and a `?key=` a visitor pasted from a docs
  // page would otherwise end up written into every Command Log entry (INV-6).
  const path = parsed.pathname.replace(/\/+$/, '');
  const completions = path.endsWith(COMPLETIONS_SUFFIX)
    ? `${parsed.origin}${path}`
    : `${parsed.origin}${path}${COMPLETIONS_SUFFIX}`;
  const base = completions.slice(0, -COMPLETIONS_SUFFIX.length);

  return Object.freeze({
    origin: parsed.origin,
    completions,
    models: `${base}${MODELS_SUFFIX}`,
  });
}

export interface VisitorEndpointClientConfig {
  /** Whatever the visitor typed. Validated here, never trusted. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Sent in the request body verbatim. No list is consulted; that is the point. */
  readonly model: string;
  readonly fetch?: HttpFetch;
  readonly sleep?: Sleep;
  readonly onRateLimit?: RateLimitSink;
}

export interface VisitorEndpointClient extends ProviderClient {
  /** The resolved endpoint, so a caller can display the origin without re-parsing. */
  readonly resolved: VisitorEndpoint;
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`createVisitorEndpointClient: ${field} must be a non-empty string.`);
  }
}

/**
 * Builds the client. `provider` reads `byok` because that is what the frozen
 * schema calls a Match run on a key nobody else can verify, and `endpoint` and
 * `model` are the visitor's own, verbatim -- INV-6's provenance does not weaken
 * because the visitor supplied the values.
 *
 * A rate limit resolves here exactly as it does in the tournament adapters, and
 * is turned into a failure one layer up in `apps/web/src/byok/client.ts`. The
 * split is deliberate: this file is a transport, and whether a 429 should end a
 * Match or become an auditable Parse Failure is a decision that depends on
 * whether anybody is watching.
 */
export function createVisitorEndpointClient(
  config: VisitorEndpointClientConfig,
): VisitorEndpointClient {
  assertNonBlank(config.apiKey, 'apiKey');
  assertNonBlank(config.model, 'model');

  const resolved = assertVisitorSuppliedEndpoint(config.baseUrl);
  const endpoint = resolved.completions;
  const model = config.model;
  const apiKey = config.apiKey;
  const httpFetch = config.fetch ?? defaultHttpFetch();
  const sleep = config.sleep ?? defaultSleep();
  const onRateLimit = config.onRateLimit;

  async function complete(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await httpFetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: openAiRequestBody(model, request, 'visitorEndpointRequestBody'),
    });

    const bodyText = await response.text();

    if (response.status === RATE_LIMIT_STATUS) {
      const signal = buildRateLimitSignal({
        provider: 'byok',
        endpoint,
        model,
        status: response.status,
        headers: response.headers,
        bodyText,
        // A visitor's own endpoint publishes no quota this repo knows, so the
        // fallback is the same one minute every adapter uses when a 429 carries
        // no timing header. It is only ever reached when the response says
        // nothing about when to come back.
        fallbackBackoffMs: MS_PER_MINUTE,
      });

      onRateLimit?.(signal);
      // Not awaited for its full interval: the BYOK wrapper turns a rate limit
      // into a thrown failure anyway, so a real sleep here would freeze the tab
      // for a minute before saying so.
      await sleep(0);

      return {
        text: bodyText,
        usage: { tokensSpent: null, reasoningTokens: null },
        reasoning: null,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Request to ${endpoint} failed with status ${String(response.status)}: ${excerpt(bodyText)}`,
      );
    }

    return mapOpenAiResponse(bodyText, 'The endpoint');
  }

  return Object.freeze({
    provider: 'byok' as const,
    endpoint,
    model,
    resolved,
    complete,
  });
}
