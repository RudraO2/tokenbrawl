/**
 * Story 3.2: the two I/O primitives a provider adapter needs, as injectable
 * ports.
 *
 * `packages/providers` is the one package allowed to do I/O, but an adapter
 * that reaches for the global `fetch` directly cannot be tested without a
 * network, and every assertion this story makes -- what was sent, what happened
 * on a 429, how long the backoff was -- is an assertion about the transport.
 * So the transport is a parameter.
 *
 * The two interfaces are deliberately the narrowest shape that the real
 * `fetch`/`Response` pair already satisfies structurally. That is not just
 * minimalism: `tsconfig.base.json` sets `lib: ["ES2022"]` with no DOM lib, so
 * naming `Response` or `RequestInit` here would bind this package to whichever
 * ambient declaration happens to be installed.
 */

export interface HttpHeaders {
  /** Case-insensitive, per the header spec. Returns `null` when absent. */
  get(name: string): string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: HttpHeaders;
  text(): Promise<string>;
}

export interface HttpPostRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Story 4.7: model discovery is a `GET .../models`, which is the only reason
 * this union exists.
 *
 * A discriminated union rather than `body?: string` on one shape, because
 * `fetch` *throws* on a GET that carries a body -- "Request with GET/HEAD
 * method cannot have body". Making that a type error is strictly better than
 * making it a runtime one, and it costs callers nothing: every existing adapter
 * already writes `method: 'POST'` as a literal, so each narrows itself.
 */
export interface HttpGetRequest {
  readonly method: 'GET';
  readonly headers: Readonly<Record<string, string>>;
}

export type HttpRequest = HttpPostRequest | HttpGetRequest;

export type HttpFetch = (url: string, request: HttpRequest) => Promise<HttpResponse>;

/**
 * The body a POST carried, or `''` for a GET.
 *
 * For the callers -- almost all of them tests -- that hold an `HttpRequest` they
 * know is a POST and want its body. Narrowing at each of those sites would be
 * four lines of ceremony asserting something the surrounding code already knows.
 */
export function requestBody(request: HttpRequest): string {
  return request.method === 'POST' ? request.body : '';
}

/** Milliseconds, integer. The adapter's only use of wall-clock, and it cannot affect a Match's outcome (INV-1). */
export type Sleep = (milliseconds: number) => Promise<void>;

/**
 * The real transport. Resolved through `globalThis` rather than referenced as
 * a bare identifier so this module compiles under a `lib` with no DOM, and so
 * a runtime without `fetch` fails with a sentence instead of a ReferenceError.
 */
export function defaultHttpFetch(): HttpFetch {
  const candidate = (globalThis as unknown as { fetch?: unknown }).fetch;
  if (typeof candidate !== 'function') {
    throw new Error(
      'No global fetch is available. Pass an HttpFetch explicitly, or run on Node 18 or newer.',
    );
  }
  return candidate as HttpFetch;
}

/**
 * The real backoff. A non-positive or non-finite delay resolves immediately
 * rather than being handed to the timer, so a malformed `retry-after` can never
 * hang a tournament on a negative or NaN interval.
 */
export function defaultSleep(): Sleep {
  return (milliseconds: number): Promise<void> => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, milliseconds);
    });
  };
}
