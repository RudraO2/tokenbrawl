import type {
  ProviderClient,
  ProviderRequest,
  ProviderResponse,
} from '../../../../packages/core/src/deployment';
import type { FreeTierConfig } from '../../../../packages/providers/src/free-tier';
import type { HttpFetch, HttpResponse } from '../../../../packages/providers/src/http';
import { defaultHttpFetch } from '../../../../packages/providers/src/http';
import { createGroqClient } from '../../../../packages/providers/src/groq';
import { createCerebrasClient } from '../../../../packages/providers/src/cerebras';
import { createGoogleClient } from '../../../../packages/providers/src/google';
import {
  assertVisitorSuppliedEndpoint,
  createVisitorEndpointClient,
} from '../../../../packages/providers/src/byok-direct';
import { isUnknownModelResponse } from '../../../../packages/providers/src/model-errors';
import type { RateLimitSignal } from '../../../../packages/providers/src/rate-limit';
import { byokModelOption, byokProvider } from './catalogue';
import { redact } from './keys';

/**
 * Story 4.6: the visitor's key, held in one closure, and every way a call can
 * fail turned into a sentence naming *which* key failed (AC3).
 *
 * The client is a thin wrapper around the Story 3.2/3.3 adapter for the chosen
 * provider rather than a fourth implementation of the same HTTP call. That is
 * what makes AC1 true structurally: the adapter reads its endpoint from
 * `free-tier.config.json` and refuses anything not on the allowlist (INV-8), so
 * there is no URL in the BYOK path that the tournament path does not already
 * use, and no second place a key could be sent.
 *
 * Two things are deliberately different from the tournament path:
 *
 * 1. **`provider` reads `byok`** (AC4, AD-11), while `endpoint` and `model` stay
 *    the upstream ones. That is INV-6's provenance kept intact -- the log still
 *    records what actually served each call -- with the one extra fact that this
 *    Match was run on a key nobody else can verify.
 * 2. **A rate limit is a failure here, not a Parse Failure.** `createGroqClient`
 *    resolves on a 429 and lets `runMatch` record the Fallback Action, which is
 *    right for an unattended tournament: the Match continues and the Decision
 *    Point stays auditable. For a visitor it would be a Match their quota never
 *    actually played, published as if it had been. So the signal is caught and
 *    thrown, `runMatch` rejects, and no log is built at all (AC3's second half).
 *
 * ---------------------------------------------------------------------------
 * Story 4.7 added two things.
 * ---------------------------------------------------------------------------
 *
 * **A visitor-supplied endpoint.** When `baseUrl` is set the provider picker is
 * not consulted at all: the client comes from `byok-direct.ts`, which validates
 * the URL (https only, one resolved origin) and consults no free-tier
 * allowlist. That file's header carries the invariant reading in full, and
 * `scripts/audit-invariants.sh` names this file as one of exactly two allowed
 * to import it. The two paths meet again at the wrapper below, so attribution,
 * redaction and the rate-limit rule are identical whichever was taken.
 *
 * **An unknown model is its own failure (AC7).** It matters far more now that a
 * model name can be typed: "the provider returned an error" sends someone
 * looking at their key when the real problem is a missing `openai/` prefix.
 * `isUnknownModelResponse` reads the status and the provider's machine-readable
 * error code and never its prose -- the same discipline that already keeps a
 * 401 from being reclassified when an adapter reworded a sentence.
 */

/** Why one call failed, in terms the panel can turn into a sentence about a key. */
export type ByokFailure =
  | 'invalid-key'
  | 'rate-limited'
  | 'unreachable'
  | 'unknown-model'
  | 'provider-error';

/**
 * A failure attributed to one fighter's key.
 *
 * Carries the agent index because "which key failed" is the whole of AC3 and it
 * is not recoverable from an adapter's message -- both fighters may be on the
 * same provider, the same model, and the same endpoint.
 */
export class ByokKeyError extends Error {
  readonly agentIndex: 0 | 1;
  readonly provider: string;
  readonly model: string;
  readonly failure: ByokFailure;
  /** Provider text, redacted of the key before it ever becomes a string this app holds. */
  readonly detail: string;

  constructor(params: {
    readonly agentIndex: 0 | 1;
    readonly provider: string;
    readonly model: string;
    readonly failure: ByokFailure;
    readonly detail: string;
  }) {
    super(
      `Fighter ${String(params.agentIndex + 1)}'s ${params.provider} key: ${failureSentence(params.failure)} ${params.detail}`.trim(),
    );
    this.name = 'ByokKeyError';
    this.agentIndex = params.agentIndex;
    this.provider = params.provider;
    this.model = params.model;
    this.failure = params.failure;
    this.detail = params.detail;
  }
}

/** Plain language for each failure. The visitor is not reading a status code. */
export function failureSentence(failure: ByokFailure): string {
  switch (failure) {
    case 'invalid-key':
      return 'the provider rejected it. Check the key was pasted whole and is enabled for this model.';
    case 'rate-limited':
      return 'the provider says this key is out of quota for now. Nothing was recorded.';
    case 'unreachable':
      return 'the request never reached the provider. Check the connection, or an extension blocking the request.';
    case 'unknown-model':
      return 'the provider does not serve that model. Check the exact id — some providers prefix it, as in openai/gpt-oss-120b — or fetch the list your key can use.';
    case 'provider-error':
      return 'the provider returned an error.';
  }
}

const UNAUTHORISED = 401;
const FORBIDDEN = 403;
const RATE_LIMITED = 429;

export interface ByokClientConfig {
  readonly agentIndex: 0 | 1;
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  /**
   * Advanced: an OpenAI-compatible base URL the visitor supplied.
   *
   * When set and non-blank, `provider` is not consulted at all -- no picker
   * entry, no free-tier allowlist, no catalogue lookup. See `byok-direct.ts`
   * for why that is permitted and how it is contained.
   */
  readonly baseUrl?: string;
  /** Injectable so every failure branch is testable without a network. */
  readonly fetch?: HttpFetch;
  readonly freeTier?: FreeTierConfig;
  /** Called once per completed provider call, so the panel can show progress with no timing in it (INV-3). */
  readonly onCall?: () => void;
}

/**
 * Builds the upstream adapter for a provider the picker allows.
 *
 * `sleep` is an immediate resolve on purpose. Every adapter backs off once
 * before returning a rate-limited response; here the rate limit aborts the
 * Match, so the wait would buy nothing and would freeze the tab for a minute
 * before saying so.
 */
function createUpstream(
  providerId: string,
  config: ByokClientConfig,
  httpFetch: HttpFetch,
  onRateLimit: (signal: RateLimitSignal) => void,
): ProviderClient {
  // Advanced first, and it short-circuits: a base URL means the provider
  // dropdown is irrelevant, not merely overridden. Reading it in this order is
  // what keeps "the key goes to the origin the visitor configured" true even if
  // the picker were left on something else.
  const baseUrl = config.baseUrl?.trim() ?? '';
  if (baseUrl.length > 0) {
    return createVisitorEndpointClient({
      baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      fetch: httpFetch,
      sleep: (): Promise<void> => Promise.resolve(),
      onRateLimit,
    });
  }

  const shared = {
    apiKey: config.apiKey,
    model: config.model,
    fetch: httpFetch,
    sleep: (): Promise<void> => Promise.resolve(),
    onRateLimit,
    freeTier: config.freeTier,
  };

  if (providerId === 'groq') {
    return createGroqClient(shared);
  }
  if (providerId === 'cerebras') {
    return createCerebrasClient(shared);
  }
  if (providerId === 'google-ai-studio') {
    return createGoogleClient(shared);
  }
  // Unreachable through `byokProvider`, which throws first. Kept because a
  // fourth catalogue entry with no branch here would otherwise fall through to
  // whichever adapter happened to be last.
  throw new Error(`No browser adapter for provider "${providerId}".`);
}

/**
 * Classifies whatever went wrong into one of four things a visitor can act on.
 *
 * The status is read from the *response the wrapper saw*, not parsed back out
 * of the adapter's message: a message is prose that a later story may
 * legitimately reword, and a regex over it would then silently reclassify every
 * bad key as a generic provider error.
 */
function classify(status: number, networkFailed: boolean, bodyText: string): ByokFailure {
  if (networkFailed) {
    return 'unreachable';
  }
  // A key problem and a quota problem are checked before the model, because
  // both have unambiguous statuses of their own and neither overlaps a 404.
  if (status === UNAUTHORISED || status === FORBIDDEN) {
    return 'invalid-key';
  }
  if (status === RATE_LIMITED) {
    return 'rate-limited';
  }
  if (isUnknownModelResponse(status, bodyText)) {
    return 'unknown-model';
  }
  return 'provider-error';
}

/**
 * A `ProviderClient` that reports `byok` and refuses to let a Match limp on
 * after a key problem.
 *
 * The key appears in exactly two places: the closure of the adapter this
 * function builds, and the `Authorization`/`x-goog-api-key` header that adapter
 * writes. It is never returned, never stored on the client object, and never
 * reaches `packages/core` -- core is handed this port and nothing else (AC2).
 */
export function createByokClient(config: ByokClientConfig): ProviderClient {
  const endpoint = byokFighterEndpoint(config, config.freeTier);
  // The name a failure sentence uses. For Advanced that is the origin the
  // visitor typed, because "OpenRouter" is a guess and the origin is a fact.
  const label = byokFighterLabel(config, config.freeTier);

  if (config.apiKey.trim().length === 0) {
    throw new ByokKeyError({
      agentIndex: config.agentIndex,
      provider: label,
      model: config.model,
      failure: 'invalid-key',
      detail: 'No key was supplied.',
    });
  }

  const baseFetch = config.fetch ?? defaultHttpFetch();
  // Per-call observation of the transport, so classification reads a status
  // rather than a sentence. Function-scoped and reset at the top of every call:
  // a client is reused across a whole Match and stale state here would
  // misattribute the second failure to the first one's cause.
  const seen: {
    status: number;
    networkFailed: boolean;
    bodyText: string;
    rateLimit: RateLimitSignal | null;
  } = {
    status: 0,
    networkFailed: false,
    bodyText: '',
    rateLimit: null,
  };

  // Reset through a function rather than three assignments inside `complete`.
  // Assigning `seen.rateLimit = null` in the same flow narrows it to `null` for
  // the rest of that flow, and TypeScript does not widen it back when the sink
  // writes it from another function -- the rate-limit branch below would then
  // be typed `never` and would not compile against `.message`.
  const forgetLastCall = (): void => {
    seen.status = 0;
    seen.networkFailed = false;
    seen.bodyText = '';
    seen.rateLimit = null;
  };

  const instrumentedFetch: HttpFetch = async (url, request): Promise<HttpResponse> => {
    try {
      const response = await baseFetch(url, request);
      seen.status = response.status;

      // The body is read here and handed on as a resolved string, because a
      // body can only be read once and the adapter downstream needs it too.
      // Classification needs it for AC7: an unknown model is signalled by the
      // provider's machine-readable error code, which lives in the body.
      const bodyText = await response.text();
      seen.bodyText = bodyText;
      return Object.freeze({
        status: response.status,
        headers: response.headers,
        text: (): Promise<string> => Promise.resolve(bodyText),
      });
    } catch (error) {
      // A cross-origin refusal, an offline tab and a blocked request are all
      // this: `fetch` rejects with a TypeError carrying no status at all.
      seen.networkFailed = true;
      throw error;
    }
  };

  const upstream = createUpstream(config.provider, config, instrumentedFetch, (signal) => {
    seen.rateLimit = signal;
  });

  const fail = (failure: ByokFailure, detail: string): ByokKeyError =>
    new ByokKeyError({
      agentIndex: config.agentIndex,
      provider: label,
      model: config.model,
      failure,
      // The key last, and always: a provider that quotes the offending
      // credential back in its error body is not hypothetical, and this string
      // is about to be put on the page.
      detail: redact(detail, [config.apiKey]),
    });

  async function complete(request: ProviderRequest): Promise<ProviderResponse> {
    forgetLastCall();

    const response = await upstream.complete(request).catch((error: unknown) => {
      throw fail(
        classify(seen.status, seen.networkFailed, seen.bodyText),
        error instanceof Error ? error.message : String(error),
      );
    });

    // Reached only when the adapter *resolved* a rate limit, which is the
    // tournament behaviour (Story 3.2): the Match continues and the Decision
    // Point becomes a Parse Failure. Here that would publish a Match the
    // visitor's quota never played, so it is turned back into a failure.
    if (seen.rateLimit !== null) {
      throw fail('rate-limited', seen.rateLimit.message);
    }

    config.onCall?.();
    return response;
  }

  return Object.freeze({
    // AC4. The upstream endpoint and model are kept verbatim beside it, so the
    // log still says exactly what served the call (INV-6).
    provider: 'byok' as const,
    endpoint,
    model: config.model,
    complete,
  });
}

/**
 * The one URL this fighter's key may ever be sent to.
 *
 * Exported and shared with `run.ts` on purpose. Story 4.6 had the endpoint
 * resolved in two places -- once for the client and once for the Command Log's
 * `deployment.endpoint` -- and a Match whose log named a URL other than the one
 * actually called would be an INV-6 provenance failure that no test in either
 * file would notice, because each would agree with itself.
 */
export function byokFighterEndpoint(
  fighter: { readonly provider: string; readonly model: string; readonly baseUrl?: string },
  config?: FreeTierConfig,
): string {
  const baseUrl = fighter.baseUrl?.trim() ?? '';
  if (baseUrl.length > 0) {
    return assertVisitorSuppliedEndpoint(baseUrl).completions;
  }
  return byokModelOption(fighter.provider, fighter.model, config).endpoint;
}

/** What a failure sentence calls this fighter's provider. An origin for Advanced, a label otherwise. */
export function byokFighterLabel(
  fighter: { readonly provider: string; readonly baseUrl?: string },
  config?: FreeTierConfig,
): string {
  const baseUrl = fighter.baseUrl?.trim() ?? '';
  if (baseUrl.length > 0) {
    return assertVisitorSuppliedEndpoint(baseUrl).origin;
  }
  return byokProvider(fighter.provider, config).label;
}
