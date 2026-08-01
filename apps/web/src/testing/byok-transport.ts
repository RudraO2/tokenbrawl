import type { HttpFetch, HttpRequest, HttpResponse } from '../../../../packages/providers/src/http';
import { requestBody } from '../../../../packages/providers/src/http';

/**
 * The transport fake every BYOK test runs against (Story 4.6).
 *
 * It satisfies the same `HttpFetch` interface the real `fetch` does,
 * structurally and by construction, so an assertion made here is an assertion
 * about the shape of the real request: the URL it went to, the headers it
 * carried, and the body on the wire. AC1 -- "the keys are transmitted only to
 * the model provider that visitor selected, and to no other origin" -- is a
 * claim about exactly those three things and is not otherwise observable
 * without a network.
 *
 * Lives under `src/testing/`, which `source-discipline.test.ts` exempts from
 * the shipped-file sweeps, for the same reason `demo-log.ts` does: it is
 * scaffolding, imported only by `*.test.ts`, and never reaches the bundle.
 */

const RATE_LIMITED = 429;

export interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeTransport {
  readonly fetch: HttpFetch;
  readonly calls: () => readonly RecordedCall[];
  /** Every distinct origin any request reached. AC1 is a statement about this set. */
  readonly origins: () => readonly string[];
}

/** An OpenAI-compatible completion, which is the shape Groq and Cerebras both return. */
export function chatCompletionBody(text: string, completionTokens = 12): string {
  return JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { completion_tokens: completionTokens },
  });
}

/** Google AI Studio's `generateContent` shape. */
export function generateContentBody(text: string, completionTokens = 12): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { candidatesTokenCount: completionTokens },
  });
}

/**
 * Scheme and authority, by pattern rather than by `URL`.
 *
 * `tsconfig.base.json` sets `lib: ["ES2022"]` with no DOM, so `URL` is not a
 * name this project may reference -- the same constraint that made `main.ts`
 * declare its own `CanvasSurface` instead of naming `HTMLCanvasElement`.
 */
function originOf(url: string): string {
  return /^[a-z]+:\/\/[^/]+/i.exec(url)?.[0] ?? url;
}

function headersOf(entries: Readonly<Record<string, string>>): HttpResponse['headers'] {
  return {
    get: (name: string): string | null => entries[name.toLowerCase()] ?? null,
  };
}

/** A 429 body in the shape `quotaFrom`/`rateLimitMessage` read (Story 3.2). */
export function rateLimitBody(message = 'Rate limit reached for tokens per minute (TPM).'): string {
  return JSON.stringify({ error: { type: 'tokens', message } });
}

export interface FakeTransportConfig {
  /** Status per call, in order. The last value repeats once the list is exhausted. */
  readonly statuses?: readonly number[];
  /**
   * The answer, from the index of this *served* call and from the request that
   * asked for it.
   *
   * `call` counts answers, not requests: a 429 produced none, so a repeated call
   * gets the index it would have had if the refusal had never happened. Without
   * that, injecting a 429 shifts every later reply and a "byte-identical log"
   * comparison would be measuring the fake rather than the runner.
   *
   * The second argument is what a test needs when *order* must not matter
   * either. Both fighters call concurrently at one Decision Point, so a reply
   * keyed on the call index changes when a wait makes them interleave the other
   * way -- again an artefact of the fake, since a real provider answers the
   * prompt it was given whenever it arrives. Keying on the request body models
   * that honestly.
   */
  readonly body?: (call: number, requestBody: string) => string;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  /**
   * Story 4.8. Call indices (0-based) that answer 429 whatever `statuses` says.
   *
   * A separate knob rather than a longer `statuses` array because the whole
   * point of a repeated call is that it *shifts every later index*: writing
   * "the fifth call is refused" as position 4 of a status list stops being true
   * the moment position 4 is retried. This is indexed the same way, but it is
   * the only thing the test has to keep straight, and `rateLimitAt` reads as the
   * script it is.
   */
  readonly rateLimitAt?: readonly number[];
  /** Headers per call index. Takes precedence over `responseHeaders` when given. */
  readonly headersFor?: (call: number) => Readonly<Record<string, string>>;
  /** When set, `fetch` rejects the way a cross-origin refusal or an offline tab does. */
  readonly rejectWith?: Error;
}

/**
 * Records every request and answers with whatever the configuration says.
 *
 * Answers with a *valid* Action by default. A test about where a key was sent
 * should not also be a test about Parse Failure handling, and a Match whose
 * every reply was unparseable would make the origin assertion weaker rather
 * than stronger -- fewer Decision Points, fewer requests to check.
 */
export function createFakeTransport(config: FakeTransportConfig = {}): FakeTransport {
  const calls: RecordedCall[] = [];
  const statuses = config.statuses ?? [200];
  // How many requests were refused rather than answered, so `body` can be given
  // the index of the *answer* it is producing. An object rather than a mutable
  // binding, which is the same discipline the shipped files here keep.
  const refusals = { count: 0 };

  const fetch: HttpFetch = (url: string, request: HttpRequest): Promise<HttpResponse> => {
    const sent = requestBody(request);
    calls.push({ url, headers: request.headers, body: sent });
    if (config.rejectWith !== undefined) {
      return Promise.reject(config.rejectWith);
    }
    const index = calls.length - 1;
    const refused = config.rateLimitAt?.includes(index) === true;
    if (refused) {
      refusals.count += 1;
    }
    const status = refused ? RATE_LIMITED : statuses[Math.min(index, statuses.length - 1)];
    const bodyText = refused
      ? rateLimitBody()
      : (config.body?.(index - refusals.count, sent) ?? chatCompletionBody('ACTION: attack'));
    return Promise.resolve({
      status,
      headers: headersOf(config.headersFor?.(index) ?? config.responseHeaders ?? {}),
      text: (): Promise<string> => Promise.resolve(bodyText),
    });
  };

  return {
    fetch,
    calls: () => calls,
    origins: () => [...new Set(calls.map((call) => originOf(call.url)))],
  };
}
