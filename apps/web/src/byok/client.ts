import type {
  ProviderClient,
  ProviderRequest,
  ProviderResponse,
} from '../../../../packages/core/src/deployment';
import type { FreeTierConfig } from '../../../../packages/providers/src/free-tier';
import type {
  HttpFetch,
  HttpHeaders,
  HttpResponse,
  Sleep,
} from '../../../../packages/providers/src/http';
import { defaultHttpFetch, defaultSleep } from '../../../../packages/providers/src/http';
import { createGroqClient } from '../../../../packages/providers/src/groq';
import { createCerebrasClient } from '../../../../packages/providers/src/cerebras';
import { createGoogleClient } from '../../../../packages/providers/src/google';
import {
  assertVisitorSuppliedEndpoint,
  createVisitorEndpointClient,
} from '../../../../packages/providers/src/byok-direct';
import { isUnknownModelResponse } from '../../../../packages/providers/src/model-errors';
import type { RateLimitSignal } from '../../../../packages/providers/src/rate-limit';
import { byokModelOption, byokProvider, modelOptionNotice } from './catalogue';
import { redact } from './keys';
import type { QuotaSnapshot, WaitBudget } from './pacing';
import {
  NO_QUOTA_REPORTED,
  createWaitBudget,
  isWaitable,
  paceBeforeNextCallMs,
  readQuotaHeaders,
} from './pacing';

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
 *
 * ---------------------------------------------------------------------------
 * Story 4.8 reversed one of those two decisions, and only one.
 * ---------------------------------------------------------------------------
 *
 * **A rate limit is no longer a failure.** It was, above, and the reasoning
 * stands as far as it goes: a 429 absorbed into a Parse Failure publishes a
 * Match the visitor's quota never played. But a BYOK Match does not
 * *occasionally* meet a limit -- 60 calls worst case against 6-12K TPM meets one
 * **every time, by arithmetic** -- so "fail the Match" meant thirty successful
 * calls thrown away because the thirty-first arrived a second early.
 *
 * The 429 is now waited out and *the same call repeated*, and the boundary that
 * makes this legal rather than an INV-1 breach is exactly one line below:
 *
 *     if (seen.rateLimit === null) { config.onCall?.(); return response; }
 *
 * INV-1 forbids re-asking a model **after it has answered**, because that would
 * let a Match depend on how many attempts a Deployment needed. A 429 produced no
 * answer at all: waiting for the provider to accept the *first* call is not a
 * retry of a decision, it is the decision still being made. That `return` is
 * therefore the guard, and it is the primary mutation target of this story --
 * turn it into anything that loops after a success and a test must go red.
 *
 * Everything else follows from bounding it:
 *
 * - **Pacing.** Groq reports its remaining buckets on every response, so the
 *   next call can be held until the bucket refills rather than being refused.
 *   `pacing.ts` owns that arithmetic, and INV-3 stays intact because the delay
 *   is derived from a *quota* header and never from how long a model thought.
 * - **Two stop-immediately rules.** 401/403 never waits, and neither does a wait
 *   longer than `MAX_WAIT_MS` -- a daily cap resets hours away, and a wait that
 *   cannot succeed is worse than a failure.
 * - **A bound.** `WaitBudget` is shared across both fighters and abandons the
 *   Match once it is spent. Nothing partial is written, for the same structural
 *   reason as before: `runMatch` rejects and no log is ever built.
 */

/** Why one call failed, in terms the panel can turn into a sentence about a key. */
export type ByokFailure =
  | 'invalid-key'
  | 'rate-limited'
  | 'unreachable'
  | 'unknown-model'
  | 'provider-error'
  /** Story 4.8: a wait measured in hours, so waiting is not an option. */
  | 'daily-quota'
  /** Story 4.8: refused before the first call, not after the thirtieth. */
  | 'cannot-finish';

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
      // Story 4.8 reworded this. A rate limit is now waited out and the call
      // repeated, so reaching this sentence means the waiting itself ran out --
      // not that a limit was met, which happens in almost every Match.
      return 'the provider kept refusing it after every wait this Match allows. Nothing was recorded.';
    case 'daily-quota':
      return 'the provider will not serve this key again until its daily quota resets. Waiting that out is not something a browser tab can do, so nothing was recorded.';
    case 'cannot-finish':
      return 'its daily quota cannot cover one whole Match, so no call was made at all.';
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
  /**
   * Story 4.8: how the runner waits. Injectable so no test waits on a clock,
   * and so the whole pacing path is exercised in milliseconds.
   */
  readonly sleep?: Sleep;
  /**
   * The Match's allowance of reactive waits. Supplied by `run.ts` so both
   * fighters draw on one; a client built alone gets its own.
   */
  readonly budget?: WaitBudget;
  /** Called when a wait begins. Carries nothing: the panel may report a state, never a duration (INV-3). */
  readonly onWait?: () => void;
}

/** Headers before the first response, and after any wait: nothing reported. */
const NO_HEADERS: HttpHeaders = { get: (): string | null => null };

/**
 * What a visitor is told when their quota will not refill in time.
 *
 * No number in it, deliberately. This is a terminal message rather than a pause
 * report, but a page that says "six hours" once has established that the page
 * says how long things take, and the next story writes a countdown (INV-3).
 */
const DAILY_QUOTA_DETAIL =
  'The quota this key draws on refills on a daily cycle, not a per-minute one. Try again tomorrow, or pick a model with a larger daily allowance.';

/**
 * Builds the upstream adapter for a provider the picker allows.
 *
 * `sleep` is an immediate resolve on purpose, and Story 4.8 did not change it.
 * Every adapter backs off once before returning a rate-limited response, and
 * that backoff is now redundant rather than merely unhelpful: the wrapper below
 * owns the waiting, reads the same `retry-after` the adapter did, and repeats
 * the call afterwards. Letting the adapter sleep as well would double every
 * wait. The adapters themselves are untouched by this story (`git diff --
 * packages` is empty); this is the seam that made that possible.
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

  // Story 4.8, AC8: told before the first call, not after the thirtieth.
  //
  // `byokCatalogue` already filters an unrunnable model out of the picker, so
  // this only ever fires for a *typed* or *discovered* model that inherits a
  // provider default too small to cover a Match -- which is precisely the case
  // 4.7 opened up and could not close from the picker alone. It costs one
  // catalogue lookup and no request, and `run.ts` builds both clients before
  // calling either, so the refusal lands before a single call exists.
  //
  // Skipped on the Advanced path: a visitor's own endpoint publishes no quota
  // this build knows, and inventing one to refuse them by would be worse than
  // letting the Match tell them.
  if ((config.baseUrl?.trim() ?? '').length === 0) {
    const option = byokModelOption(config.provider, config.model, config.freeTier);
    if (!option.feasibility.runnable) {
      throw new ByokKeyError({
        agentIndex: config.agentIndex,
        provider: label,
        model: config.model,
        failure: 'cannot-finish',
        detail: modelOptionNotice(option),
      });
    }
  }

  const baseFetch = config.fetch ?? defaultHttpFetch();
  const sleep = config.sleep ?? defaultSleep();
  const budget = config.budget ?? createWaitBudget();
  // What the last response said about this key's remaining buckets. Per client,
  // because a quota belongs to a key and the two fighters hold different ones;
  // it survives across calls, which is exactly what `seen` below must not do.
  const quota: { snapshot: QuotaSnapshot } = { snapshot: NO_QUOTA_REPORTED };
  // Per-call observation of the transport, so classification reads a status
  // rather than a sentence. Function-scoped and reset at the top of every call:
  // a client is reused across a whole Match and stale state here would
  // misattribute the second failure to the first one's cause.
  const seen: {
    status: number;
    networkFailed: boolean;
    bodyText: string;
    rateLimit: RateLimitSignal | null;
    // Story 4.8. The quota headers ride on *every* response, which is the whole
    // reason pacing is possible without touching an adapter: this wrapper is
    // already between the transport and the adapter and can simply keep them.
    headers: HttpHeaders;
  } = {
    status: 0,
    networkFailed: false,
    bodyText: '',
    rateLimit: null,
    headers: NO_HEADERS,
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
    seen.headers = NO_HEADERS;
  };

  const instrumentedFetch: HttpFetch = async (url, request): Promise<HttpResponse> => {
    try {
      const response = await baseFetch(url, request);
      seen.status = response.status;
      seen.headers = response.headers;

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

  /**
   * Waits, then forgets what caused the wait.
   *
   * The forgetting is not tidiness, and the case that needs it is the *reactive*
   * one specifically. A 429 almost always carries `x-ratelimit-remaining-tokens:
   * 0` alongside its `retry-after`, and both are recorded before the branch
   * below decides what to do. Wait out the `retry-after`, come back round the
   * loop still holding that reading, and the runner paces a *second* time for
   * the bucket the first wait already refilled -- two waits for one refusal.
   *
   * On the proactive path it is belt and braces: the snapshot is overwritten by
   * the next response either way. That asymmetry is why a mutation probe of this
   * line survived every test until one was written for the 429 path -- see the
   * spec's Review Triage Log.
   */
  const waitAndForget = async (waitMs: number): Promise<void> => {
    config.onWait?.();
    await sleep(waitMs);
    quota.snapshot = NO_QUOTA_REPORTED;
  };

  /**
   * One Decision Point's call, waited out however many times it takes.
   *
   * The loop has exactly two exits that matter and they are the two halves of
   * INV-1's boundary:
   *
   *   `return response`  a call that produced an answer. It leaves here and is
   *                      never issued again -- this is the guard the story asks
   *                      to be pinned, and `client.test.ts` mutates it.
   *   `throw fail(...)`  nothing was answered and nothing will be. No log is
   *                      built, because `runMatch` rejects and `run.ts` never
   *                      reaches `buildByokCommandLog`.
   *
   * Everything between them is a call that produced *no answer*, which is the
   * decision still being made rather than a decision being re-asked.
   */
  async function complete(request: ProviderRequest): Promise<ProviderResponse> {
    for (;;) {
      // Proactive (AC1): stay inside the limit rather than waiting to be
      // refused. Zero whenever the provider reported nothing, which is why
      // reactive waiting below stays the floor rather than a fallback.
      const pacedMs = paceBeforeNextCallMs(quota.snapshot);
      if (pacedMs > 0) {
        if (!isWaitable(pacedMs)) {
          // The bucket that ran out refills hours from now: a daily cap, read
          // off the headers before spending a request to be told so.
          throw fail('daily-quota', DAILY_QUOTA_DETAIL);
        }
        await waitAndForget(pacedMs);
      }

      forgetLastCall();

      const response = await upstream.complete(request).catch((error: unknown) => {
        // 401, 403, a retired model, a gateway error, an offline tab. None of
        // these clears by waiting, and `classify` never returns a waitable
        // failure from this branch -- the adapters resolve a 429 rather than
        // throwing one.
        throw fail(
          classify(seen.status, seen.networkFailed, seen.bodyText),
          error instanceof Error ? error.message : String(error),
        );
      });

      quota.snapshot = readQuotaHeaders(seen.headers);

      if (seen.rateLimit === null) {
        config.onCall?.();
        return response;
      }

      // Reached only when the adapter *resolved* a rate limit, which is the
      // tournament behaviour (Story 3.2): there the Decision Point becomes a
      // Parse Failure and the Match continues. Here the call is repeated
      // instead, so the Decision Point is decided by the model rather than by
      // the Fallback Action -- and `response` is dropped on the floor, which is
      // what keeps a 429 body out of the Command Log.
      const waitMs = seen.rateLimit.retryAfterMs;
      if (!isWaitable(waitMs)) {
        throw fail('daily-quota', seen.rateLimit.message);
      }
      if (!budget.spend()) {
        throw fail('rate-limited', seen.rateLimit.message);
      }
      await waitAndForget(waitMs);
    }
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
