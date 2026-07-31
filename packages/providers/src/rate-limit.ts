import type { ProviderId } from '@tokenbrawl/contracts';
import type { HttpHeaders } from './http';

/**
 * Story 3.2: a rate limit as a typed signal rather than as an exception.
 *
 * The AC is four things at once -- surface it as a typed signal, back off, do
 * not fail the Match, do not retry the decision -- and only one shape satisfies
 * all four. A throw fails the Match (`runMatch` awaits `Promise.all` over every
 * pending Decision and has no catch, by design: Story 3.1 established that a
 * catch inside `decide()` would be either a timeout-driven default action or a
 * retry, and INV-1 forbids both). A retry re-asks the provider. So the adapter
 * emits this signal, sleeps once, and resolves.
 *
 * AD-9 draws the line for what the adapter may then do with it: nothing. The
 * signal goes to a sink the caller owns, and quota bookkeeping -- how many
 * requests are left this minute, which Deployment to pause, when to resume a
 * tournament -- lives in the runner, where state is allowed to live.
 */

export type RateLimitQuota = 'requests' | 'tokens' | 'unknown';

export interface RateLimitSignal {
  /** Discriminant, so a sink handling several signal types can switch on it. */
  readonly kind: 'rate-limit';
  readonly provider: ProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly status: number;
  /** Which quota tripped, as far as the provider said. */
  readonly quota: RateLimitQuota;
  /** Integer milliseconds to wait. Never negative, never fractional. */
  readonly retryAfterMs: number;
  /** The provider's own message, verbatim, for the runner's log. */
  readonly message: string;
}

/** Where a rate limit is surfaced. Synchronous: the adapter does not await the runner. */
export type RateLimitSink = (signal: RateLimitSignal) => void;

export const RATE_LIMIT_STATUS = 429;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: MS_PER_SECOND,
  m: MS_PER_MINUTE,
  h: MS_PER_HOUR,
};

/** `ms` before `m`, or `430ms` reads as 430 minutes followed by a stray `s`. */
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
const WHOLE_DURATION = /^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/;
const BARE_NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * Reads the duration forms these endpoints actually emit: `6s`, `430ms`,
 * `2m59.56s`, `1h2m3s`, and the bare number RFC 7231 defines for `Retry-After`
 * (seconds, which Groq sometimes sends fractionally as `7.66`).
 *
 * Rounds up. Waiting 10ms too long costs nothing; waiting 10ms too little
 * spends another request against an exhausted quota.
 *
 * Returns `null` for anything unreadable -- including an HTTP-date, which is
 * the one `Retry-After` form deliberately not supported: parsing it needs the
 * current time, and the caller has a configured fallback that needs no clock.
 */
export function parseDurationMs(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }

  const text = raw.trim().toLowerCase();
  if (text.length === 0) {
    return null;
  }

  if (BARE_NUMBER.test(text)) {
    return Math.ceil(Number(text) * MS_PER_SECOND);
  }

  if (!WHOLE_DURATION.test(text)) {
    return null;
  }

  let total = 0;
  // `matchAll` rather than a stateful `exec` loop: a module-level regex with
  // the `g` flag carries `lastIndex` between calls, which is precisely the
  // cross-call state AC3 forbids this package to hold.
  for (const match of text.matchAll(DURATION_PART)) {
    total += Number(match[1]) * UNIT_MS[match[2]];
  }
  return Math.ceil(total);
}

/**
 * `retry-after-ms` carries milliseconds, so its bare number must NOT go through
 * `parseDurationMs`, which reads a bare number as seconds per RFC 7231 -- that
 * is correct for `retry-after` and wrong by a factor of a thousand here. A
 * unit-suffixed value is still honoured, in case a provider sends one.
 */
function parseMillisecondsHeader(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const text = raw.trim();
  if (BARE_NUMBER.test(text)) {
    return Math.ceil(Number(text));
  }
  return parseDurationMs(text);
}

/**
 * How long to back off, from the headers the response actually carried.
 *
 * `retry-after-ms` first because it is the only unambiguous one; then
 * `retry-after`, which is what Groq documents for a 429; then the reset headers
 * that ride on every response, taking the *later* of the two, since a request
 * quota and a token quota can be exhausted at different times and clearing only
 * the nearer one puts the next call straight back into a 429.
 */
export function retryAfterMsFrom(headers: HttpHeaders, fallbackMs: number): number {
  const direct =
    parseMillisecondsHeader(headers.get('retry-after-ms')) ??
    parseDurationMs(headers.get('retry-after'));
  if (direct !== null) {
    return Math.max(0, direct);
  }

  const resets = [
    parseDurationMs(headers.get('x-ratelimit-reset-requests')),
    parseDurationMs(headers.get('x-ratelimit-reset-tokens')),
  ].filter((value): value is number => value !== null);

  if (resets.length > 0) {
    return Math.max(0, ...resets);
  }

  return Math.max(0, Number.isSafeInteger(fallbackMs) ? fallbackMs : 0);
}

function errorObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) {
      return null;
    }
    return error as Record<string, unknown>;
  } catch {
    // A 429 whose body is not JSON is still a 429. Classification degrades to
    // `unknown`; the backoff, which is what actually matters, comes from the
    // headers regardless.
    return null;
  }
}

/**
 * Which quota tripped. `error.type` is authoritative when present; otherwise
 * the message is scanned, because a provider that changes its `type` vocabulary
 * still spells out "tokens per minute" in prose.
 */
export function quotaFrom(bodyText: string): RateLimitQuota {
  const error = errorObject(bodyText);

  const type = error?.type;
  if (type === 'tokens' || type === 'requests') {
    return type;
  }

  const message = typeof error?.message === 'string' ? error.message : bodyText;
  const lowered = message.toLowerCase();
  if (lowered.includes('tokens per') || lowered.includes('tpm')) {
    return 'tokens';
  }
  if (lowered.includes('requests per') || lowered.includes('rpm') || lowered.includes('rpd')) {
    return 'requests';
  }
  return 'unknown';
}

/** The provider's own message where it gave one, and the raw body where it did not. */
export function rateLimitMessage(bodyText: string): string {
  const message = errorObject(bodyText)?.message;
  return typeof message === 'string' && message.trim().length > 0 ? message : bodyText.trim();
}

export interface RateLimitSignalParams {
  readonly provider: ProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly status: number;
  readonly headers: HttpHeaders;
  readonly bodyText: string;
  readonly fallbackBackoffMs: number;
}

export function buildRateLimitSignal(params: RateLimitSignalParams): RateLimitSignal {
  return Object.freeze({
    kind: 'rate-limit' as const,
    provider: params.provider,
    endpoint: params.endpoint,
    model: params.model,
    status: params.status,
    quota: quotaFrom(params.bodyText),
    retryAfterMs: retryAfterMsFrom(params.headers, params.fallbackBackoffMs),
    message: rateLimitMessage(params.bodyText),
  });
}
