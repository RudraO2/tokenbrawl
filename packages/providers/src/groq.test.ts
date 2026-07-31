import { FALLBACK_ACTION } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildCommandLog,
  computeConfigHash,
  validateCommandLog,
} from '../../core/src/command-log';
import { createDeployment } from '../../core/src/deployment';
import type { ProviderRequest } from '../../core/src/deployment';
import { runMatch } from '../../core/src/match-runner';
import { REFLEX_MAX_TOKENS } from '../../core/src/token-bank';
import { createScriptedAgent } from '../../core/src/testing/mock-agent';
import { createMockEnvironment } from '../../core/src/testing/mock-environment';
import { createGroqClient, groqRequestBody, mapGroqResponse } from './groq';
import type { HttpFetch, HttpHeaders, HttpRequest, Sleep } from './http';
import type { RateLimitSignal } from './rate-limit';

/**
 * Story 3.2, all five ACs. Every case here runs against an injected transport,
 * so the suite needs no network and no key. The live smoke test lives in
 * `groq-live.test.ts` and is opt-in.
 *
 * The 200 body below is the one the live endpoint actually returned on
 * 2026-08-01, trimmed of its cookie and request-id noise. Recording it rather
 * than inventing it is what makes the mapping assertions worth anything.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

const RECORDED_200 = JSON.stringify({
  id: 'chatcmpl-47aaed53-e318-4c85-88be-1de1812ed18d',
  object: 'chat.completion',
  created: 1_785_523_995,
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'ACTION: attack' },
      logprobs: null,
      finish_reason: 'stop',
    },
  ],
  usage: {
    queue_time: 0.051_231_198,
    prompt_tokens: 42,
    prompt_time: 0.002_830_621,
    completion_tokens: 3,
    completion_time: 0.007_305_625,
    total_tokens: 45,
    total_time: 0.010_136_246,
  },
  usage_breakdown: null,
  system_fingerprint: 'fp_4387d3edbb',
  service_tier: 'on_demand',
});

const RECORDED_429 = JSON.stringify({
  error: {
    message:
      'Rate limit reached for model `llama-3.1-8b-instant` in organization `org_x` on tokens per minute (TPM): Limit 6000, Used 6000, Requested 51. Please try again in 7.66s.',
    type: 'tokens',
    code: 'rate_limit_exceeded',
  },
});

const PROMPT_REQUEST: ProviderRequest = {
  system: 'SYSTEM SCAFFOLD',
  user: 'USER BLOCK',
  maxTokens: undefined,
};

interface ScriptedResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

interface Transport {
  readonly fetch: HttpFetch;
  readonly sleep: Sleep;
  readonly onRateLimit: (signal: RateLimitSignal) => void;
  readonly calls: () => readonly { readonly url: string; readonly request: HttpRequest }[];
  readonly sleeps: () => readonly number[];
  readonly signals: () => readonly RateLimitSignal[];
  /** Call order across all three channels, so backoff *ordering* is assertable. */
  readonly events: () => readonly string[];
}

function makeHeaders(entries: Readonly<Record<string, string>>): HttpHeaders {
  const lowered = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

function repeat(count: number, response: ScriptedResponse): readonly ScriptedResponse[] {
  return Array.from({ length: count }, () => response);
}

/**
 * Responses in call order, and the script is *exhaustible*: a request past the
 * end throws by name, the same way `createMockProviderClient` does in core.
 *
 * That is deliberate and was earned. An earlier version repeated the last entry
 * forever, and the mutation that makes `complete()` retry a 429 then recursed
 * until the Vitest worker died of a stack overflow -- detected, but as a crash
 * rather than as the one-request-per-call assertion that is actually the point.
 * An exhaustible script turns the same mutation into a named failure.
 */
function createTransport(script: readonly ScriptedResponse[]): Transport {
  const calls: { url: string; request: HttpRequest }[] = [];
  const sleeps: number[] = [];
  const signals: RateLimitSignal[] = [];
  const events: string[] = [];

  return {
    calls: () => calls,
    sleeps: () => sleeps,
    signals: () => signals,
    events: () => events,

    fetch: (url: string, request: HttpRequest) => {
      if (calls.length >= script.length) {
        throw new Error(
          `Scripted transport exhausted after ${script.length} response(s) -- something asked for more requests than the test scripted.`,
        );
      }
      const scripted = script[calls.length];
      calls.push({ url, request });
      events.push('fetch');
      return Promise.resolve({
        status: scripted.status ?? 200,
        headers: makeHeaders(scripted.headers ?? {}),
        text: () => Promise.resolve(scripted.body),
      });
    },

    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      events.push('sleep');
      return Promise.resolve();
    },

    onRateLimit: (signal: RateLimitSignal) => {
      signals.push(signal);
      events.push('signal');
    },
  };
}

function clientWith(transport: Transport, overrides: Record<string, unknown> = {}) {
  return createGroqClient({
    apiKey: 'test-key',
    model: MODEL,
    fetch: transport.fetch,
    sleep: transport.sleep,
    onRateLimit: transport.onRateLimit,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// AC4: raw usage counts, no bank arithmetic.
// ---------------------------------------------------------------------------

describe('mapGroqResponse (AC4)', () => {
  it('maps a recorded live 200 to the completion text and the raw completion count', () => {
    expect(mapGroqResponse(RECORDED_200)).toStrictEqual({
      text: 'ACTION: attack',
      usage: { tokensSpent: 3, reasoningTokens: null, cachedTokens: null },
      reasoning: null,
    });
  });

  it('reports a separately-reported reasoning count verbatim', () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'attack', reasoning: 'they are committed' } }],
      usage: { completion_tokens: 137, completion_tokens_details: { reasoning_tokens: 90 } },
    });

    expect(mapGroqResponse(body)).toStrictEqual({
      text: 'attack',
      usage: { tokensSpent: 137, reasoningTokens: 90, cachedTokens: null },
      reasoning: 'they are committed',
    });
  });

  it('never coerces an unreported count to zero (INV-5)', () => {
    const noUsage = JSON.stringify({ choices: [{ message: { content: 'attack' } }] });
    expect(mapGroqResponse(noUsage).usage).toStrictEqual({
      tokensSpent: null,
      reasoningTokens: null,
      cachedTokens: null,
    });

    // A reasoning count of a genuine 0 is not the same fact and is kept.
    const zeroReasoning = JSON.stringify({
      choices: [{ message: { content: 'attack' } }],
      usage: { completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 } },
    });
    expect(mapGroqResponse(zeroReasoning).usage).toStrictEqual({
      tokensSpent: 4,
      reasoningTokens: 0,
      cachedTokens: null,
    });
  });

  it('reports cachedTokens verbatim when the provider carries prompt_tokens_details (Story 3.5)', () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'attack' } }],
      usage: { completion_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } },
    });

    expect(mapGroqResponse(body).usage).toStrictEqual({
      tokensSpent: 100,
      reasoningTokens: null,
      cachedTokens: 40,
    });
  });

  it('treats a genuine cached_tokens of 0 as an honest report, not as unreported', () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'attack' } }],
      usage: { completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } },
    });

    expect(mapGroqResponse(body).usage.cachedTokens).toBe(0);
  });

  it('treats a malformed count as unreported rather than passing it to the bank', () => {
    // `debitTokenBank` throws on a non-integer or negative, which would take the
    // Match with it. `null` is the honest record, and the Metering Probe is what
    // classifies a Deployment that reports nothing usable.
    for (const bad of [-1, 1.5, '3', null, Number.NaN]) {
      const body = JSON.stringify({
        choices: [{ message: { content: 'attack' } }],
        usage: { completion_tokens: bad },
      });
      expect(mapGroqResponse(body).usage.tokensSpent).toBeNull();
    }
  });

  it('maps an empty or absent completion to an empty string, not a throw', () => {
    for (const content of ['', null, undefined]) {
      const body = JSON.stringify({ choices: [{ message: { content } }] });
      expect(mapGroqResponse(body).text).toBe('');
    }
    expect(mapGroqResponse(JSON.stringify({ choices: [{}] })).text).toBe('');
    expect(mapGroqResponse(JSON.stringify({ choices: [{ message: null }] })).text).toBe('');
  });

  it('throws on a body that is not a chat completion at all', () => {
    expect(() => mapGroqResponse('<html>502</html>')).toThrow(/not JSON/);
    expect(() => mapGroqResponse('null')).toThrow(/not an object/);
    expect(() => mapGroqResponse('"a bare string"')).toThrow(/not an object/);
    expect(() => mapGroqResponse(JSON.stringify({ choices: [] }))).toThrow(/no choices/);
    expect(() => mapGroqResponse(JSON.stringify({ object: 'error' }))).toThrow(/no choices/);
  });

  it('truncates a huge body in the failure message rather than flooding a log', () => {
    const huge = 'x'.repeat(5000);
    expect(() => mapGroqResponse(huge)).toThrow(/\.\.\.$/);
    try {
      mapGroqResponse(huge);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(400);
    }
  });
});

// ---------------------------------------------------------------------------
// INV-4 and INV-7: what goes on the wire.
// ---------------------------------------------------------------------------

describe('groqRequestBody (INV-4, INV-7)', () => {
  it('sends the assembled system/user pair verbatim and nothing else', () => {
    const body = JSON.parse(groqRequestBody(MODEL, PROMPT_REQUEST)) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toStrictEqual(['messages', 'model']);
    expect(body.model).toBe(MODEL);
    expect(body.messages).toStrictEqual([
      { role: 'system', content: 'SYSTEM SCAFFOLD' },
      { role: 'user', content: 'USER BLOCK' },
    ]);
  });

  it('omits max_tokens outside Reflex Mode, rather than sending a large cap', () => {
    expect(groqRequestBody(MODEL, PROMPT_REQUEST)).not.toContain('max_tokens');
  });

  it('sends max_tokens only in Reflex Mode, at the value core supplies', () => {
    const body = JSON.parse(
      groqRequestBody(MODEL, { ...PROMPT_REQUEST, maxTokens: REFLEX_MAX_TOKENS }),
    ) as Record<string, unknown>;

    expect(body.max_tokens).toBe(REFLEX_MAX_TOKENS);
    expect(body.max_tokens).toBe(8);
  });

  it('rejects a max_tokens that could never be a valid cap', () => {
    // Only `maxTokensFor` should fill this in, and it yields 8 or nothing. A
    // degenerate value would otherwise reach the provider and come back as a
    // remote 400, one wasted request later.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => groqRequestBody(MODEL, { ...PROMPT_REQUEST, maxTokens: bad })).toThrow(
        /maxTokens must be a positive safe integer/,
      );
    }
    expect(() =>
      groqRequestBody(MODEL, { ...PROMPT_REQUEST, maxTokens: REFLEX_MAX_TOKENS }),
    ).not.toThrow();
  });

  it('carries no reasoning-effort parameter under any spelling (INV-4)', () => {
    // Assembled from fragments so this assertion does not itself trip the
    // repo-wide grep in scripts/audit-invariants.sh.
    const banned = [
      ['reason', 'ing'].join(''),
      ['reason', 'ing_effort'].join(''),
      ['reason', 'ingEffort'].join(''),
      ['think', 'ing'].join(''),
      ['think', 'ingLevel'].join(''),
      ['think', 'ing_budget'].join(''),
      'effort',
      'temperature',
      'top_p',
    ];

    for (const request of [PROMPT_REQUEST, { ...PROMPT_REQUEST, maxTokens: 8 }]) {
      const serialised = groqRequestBody(MODEL, request);
      for (const key of banned) {
        expect(serialised).not.toContain(`"${key}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 / INV-8: configuration.
// ---------------------------------------------------------------------------

describe('createGroqClient configuration (AC5, INV-8)', () => {
  it('defaults to the allowlisted free-tier endpoint', () => {
    expect(clientWith(createTransport([{ body: RECORDED_200 }])).endpoint).toBe(GROQ_ENDPOINT);
  });

  it('carries the free-tier limits for its model, read from the config file', () => {
    const client = clientWith(createTransport([{ body: RECORDED_200 }]));
    expect(client.limits).toStrictEqual({
      requestsPerMinute: 30,
      requestsPerDay: 14_400,
      tokensPerMinute: 6000,
    });
  });

  it('refuses an endpoint that is not on the free-tier allowlist (INV-8)', () => {
    expect(() =>
      clientWith(createTransport([{ body: RECORDED_200 }]), {
        endpoint: 'https://api.groq.com/openai/v1/dedicated/chat/completions',
      }),
    ).toThrow(/not on the free-tier allowlist/);
  });

  it('refuses a blank key or model before any request is made', () => {
    const transport = createTransport([{ body: RECORDED_200 }]);
    expect(() => clientWith(transport, { apiKey: '   ' })).toThrow(/apiKey/);
    expect(() => clientWith(transport, { model: '' })).toThrow(/model/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('validates an injected free-tier config exactly as it validates the committed one', () => {
    expect(() =>
      clientWith(createTransport([{ body: RECORDED_200 }]), {
        freeTier: { verifiedOn: '2026-08-01', providers: {} },
      }),
    ).toThrow(/providers must not be empty/);
  });
});

// ---------------------------------------------------------------------------
// AC3: no cross-call state.
// ---------------------------------------------------------------------------

describe('the adapter holds no cross-call state (AC3, AD-9)', () => {
  it('exposes only the port plus read-only limits, frozen', () => {
    const client = clientWith(createTransport([{ body: RECORDED_200 }]));

    expect(Object.getOwnPropertyNames(client).sort()).toStrictEqual([
      'complete',
      'endpoint',
      'limits',
      'model',
      'provider',
    ]);
    expect(Object.isFrozen(client)).toBe(true);
  });

  it('is unchanged by the calls it serves, rate limits included', async () => {
    const transport = createTransport([
      { body: RECORDED_200 },
      { status: 429, headers: { 'retry-after': '2' }, body: RECORDED_429 },
      { body: RECORDED_200 },
    ]);
    const client = clientWith(transport);
    const before = { ...client };

    await client.complete(PROMPT_REQUEST);
    await client.complete(PROMPT_REQUEST);
    await client.complete(PROMPT_REQUEST);

    expect({ ...client }).toStrictEqual(before);
  });

  it('sends a byte-identical body for a repeated identical request', async () => {
    const transport = createTransport(repeat(2, { body: RECORDED_200 }));
    const client = clientWith(transport);

    await client.complete(PROMPT_REQUEST);
    await client.complete(PROMPT_REQUEST);

    const [first, second] = transport.calls();
    expect(second.request.body).toBe(first.request.body);
    expect(second.request.headers).toStrictEqual(first.request.headers);
  });
});

// ---------------------------------------------------------------------------
// The happy path over the transport.
// ---------------------------------------------------------------------------

describe('complete() over the transport', () => {
  it('issues exactly one POST to the configured endpoint, authenticated', async () => {
    const transport = createTransport([{ body: RECORDED_200 }]);
    const response = await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.calls()).toHaveLength(1);
    const [call] = transport.calls();
    expect(call.url).toBe(GROQ_ENDPOINT);
    expect(call.request.method).toBe('POST');
    expect(call.request.headers.Authorization).toBe('Bearer test-key');
    expect(call.request.headers['Content-Type']).toBe('application/json');
    expect(call.request.body).toBe(groqRequestBody(MODEL, PROMPT_REQUEST));

    expect(response.text).toBe('ACTION: attack');
    expect(transport.sleeps()).toStrictEqual([]);
  });

  it('throws on any non-2xx that is not a rate limit', async () => {
    for (const status of [400, 401, 404, 500, 503]) {
      const transport = createTransport([{ status, body: '{"error":{"message":"nope"}}' }]);
      await expect(clientWith(transport).complete(PROMPT_REQUEST)).rejects.toThrow(
        new RegExp(`failed with status ${status}`),
      );
      // A failure is never silently backed off or absorbed into a Parse Failure.
      expect(transport.sleeps()).toStrictEqual([]);
      expect(transport.signals()).toStrictEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2: the rate-limit path.
// ---------------------------------------------------------------------------

describe('a rate-limit response (AC2)', () => {
  const rateLimited = (headers: Readonly<Record<string, string>> = { 'retry-after': '2' }) =>
    createTransport([{ status: 429, headers, body: RECORDED_429 }]);

  it('surfaces a typed signal carrying what the runner needs', async () => {
    const transport = rateLimited();
    await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.signals()).toHaveLength(1);
    expect(transport.signals()[0]).toStrictEqual({
      kind: 'rate-limit',
      provider: 'groq',
      endpoint: GROQ_ENDPOINT,
      model: MODEL,
      status: 429,
      quota: 'tokens',
      retryAfterMs: 2000,
      message: expect.stringContaining('Rate limit reached') as unknown as string,
    });
  });

  it('backs off for the signalled interval', async () => {
    const transport = rateLimited({ 'retry-after': '7.66' });
    await clientWith(transport).complete(PROMPT_REQUEST);
    expect(transport.sleeps()).toStrictEqual([7660]);
  });

  it('backs off by the configured fallback when the response carries no timing header', async () => {
    const transport = rateLimited({});
    await clientWith(transport).complete(PROMPT_REQUEST);
    // 60_000 is `fallbackBackoffMs` in free-tier.config.json, not a constant here.
    expect(transport.sleeps()).toStrictEqual([60_000]);
  });

  it('bounds the backoff, while still reporting the provider interval in full', async () => {
    // An exhausted daily quota legitimately resets hours away. Sleeping that
    // inside complete() would hang the Match with no diagnostic, so the wait is
    // capped at the config's `maxBackoffMs` while the signal stays truthful --
    // pausing a Deployment for the rest of the day is the runner's call (AD-9).
    const transport = rateLimited({ 'retry-after': '86400' });
    await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.signals()[0].retryAfterMs).toBe(86_400_000);
    expect(transport.sleeps()).toStrictEqual([120_000]);
  });

  it('sleeps the whole interval when it is under the cap', async () => {
    const transport = rateLimited({ 'retry-after': '30' });
    await clientWith(transport).complete(PROMPT_REQUEST);
    expect(transport.sleeps()).toStrictEqual([30_000]);
  });

  it('does not retry the decision: one call in, one request out', async () => {
    const transport = rateLimited();
    await clientWith(transport).complete(PROMPT_REQUEST);
    expect(transport.calls()).toHaveLength(1);
  });

  it('signals first, then backs off, then resolves', async () => {
    const transport = rateLimited();
    await clientWith(transport).complete(PROMPT_REQUEST);
    expect(transport.events()).toStrictEqual(['fetch', 'signal', 'sleep']);
  });

  it('resolves with the provider body and no usage, so the bank is untouched', async () => {
    const transport = rateLimited();
    const response = await clientWith(transport).complete(PROMPT_REQUEST);

    expect(response.text).toBe(RECORDED_429);
    expect(response.usage).toStrictEqual({ tokensSpent: null, reasoningTokens: null });
    expect(response.reasoning).toBeNull();
  });

  it('leaves the 429 body distinguishable from an empty completion in a log', () => {
    // `DecisionEntry` is frozen and has no rate-limit field, so `rawResponse` is
    // the only place the fact can survive to disk. It must not collide with a
    // model that genuinely replied with nothing.
    expect(RECORDED_429).not.toBe('');
    expect(RECORDED_429).toContain('rate_limit_exceeded');
  });

  it('still backs off and resolves when no sink is attached', async () => {
    const transport = rateLimited();
    const client = createGroqClient({
      apiKey: 'test-key',
      model: MODEL,
      fetch: transport.fetch,
      sleep: transport.sleep,
    });

    await expect(client.complete(PROMPT_REQUEST)).resolves.toBeDefined();
    expect(transport.sleeps()).toStrictEqual([2000]);
  });

  it('lets a throwing sink propagate rather than hiding a broken runner hook', async () => {
    const transport = rateLimited();
    const client = createGroqClient({
      apiKey: 'test-key',
      model: MODEL,
      fetch: transport.fetch,
      sleep: transport.sleep,
      onRateLimit: () => {
        throw new Error('runner bookkeeping is broken');
      },
    });

    await expect(client.complete(PROMPT_REQUEST)).rejects.toThrow('runner bookkeeping is broken');
  });
});

// ---------------------------------------------------------------------------
// AC1: a real Match and a valid Command Log.
// ---------------------------------------------------------------------------

describe('a Groq Deployment inside a real Match (AC1)', () => {
  async function playMatch(script: readonly ScriptedResponse[]) {
    const env = createMockEnvironment();
    const transport = createTransport(script);
    const client = clientWith(transport);
    const deployment = createDeployment({ client });
    const bot = createScriptedAgent({
      id: 'bot:blocker',
      script: Array.from({ length: 64 }, () => 'block' as const),
    });

    const match = await runMatch(env, [deployment, bot], 7, { tokenBankStart: 1_000 });
    return { env, transport, client, deployment, match };
  }

  it('produces a schema-valid Command Log with provider and endpoint on every entry', async () => {
    const { env, deployment, match } = await playMatch(repeat(64, { body: RECORDED_200 }));

    const entries = match.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry.provider).toBe('groq');
      expect(entry.endpoint).toBe(GROQ_ENDPOINT);
      expect(entry.parseFailure).toBeUndefined();
    }

    expect(deployment.id).toBe(`groq:${MODEL}`);

    const log = buildCommandLog(match, {
      environment: { id: env.id, version: env.version },
      seed: 7,
      configHash: computeConfigHash({}),
      agents: [
        {
          id: deployment.id,
          kind: 'deployment',
          deployment: { provider: 'groq', endpoint: GROQ_ENDPOINT, model: MODEL },
        },
        { id: 'bot:blocker', kind: 'bot' },
      ],
    });

    expect(() => validateCommandLog(log)).not.toThrow();
    for (const entry of log.decisions.filter((decision) => decision.agentIndex === 0)) {
      expect(entry.provider).toBe('groq');
      expect(entry.endpoint).toBe(GROQ_ENDPOINT);
    }
  });

  it('debits the bank by the reported count, with the arithmetic done by the Harness (AC4)', async () => {
    const { match } = await playMatch(repeat(64, { body: RECORDED_200 }));
    const banked = match.decisions
      .filter((entry) => entry.agentIndex === 0 && entry.action !== null)
      .map((entry) => entry.bankRemaining);

    // 3 completion tokens per call, straight from the recorded body.
    expect(banked[0]).toBe(997);
    expect(banked[1]).toBe(994);
  });

  it('survives a rate limit mid-Match without failing it or retrying (AC2)', async () => {
    const { transport, match } = await playMatch([
      { body: RECORDED_200 },
      { status: 429, headers: { 'retry-after': '2' }, body: RECORDED_429 },
      ...repeat(62, { body: RECORDED_200 }),
    ]);

    const entries = match.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    const failures = entries.filter((entry) => entry.parseFailure === true);

    // The Match ran to a terminal result rather than rejecting.
    expect(match.result).toBeDefined();
    expect(entries.length).toBeGreaterThan(2);

    // Exactly the rate-limited Decision Point produced no Action.
    expect(failures).toHaveLength(1);
    expect(failures[0].action).toBe(FALLBACK_ACTION);
    expect(failures[0].rawResponse).toBe(RECORDED_429);

    // Nothing was consumed, so the bank did not move across that Decision Point.
    expect(entries[0].bankRemaining).toBe(997);
    expect(entries[1].bankRemaining).toBe(997);
    expect(entries[2].bankRemaining).toBe(994);

    // One signal, one backoff, and one HTTP request for that Decision Point.
    expect(transport.signals()).toHaveLength(1);
    expect(transport.sleeps()).toStrictEqual([2000]);
    expect(transport.calls().length).toBe(entries.length);
  });
});
