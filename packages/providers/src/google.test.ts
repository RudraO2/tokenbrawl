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
import { createGoogleClient, googleRequestBody, mapGoogleResponse } from './google';
import type { HttpFetch, HttpHeaders, HttpRequest, Sleep } from './http';
import type { RateLimitSignal } from './rate-limit';

/**
 * Story 3.3, Google AI Studio half of AC1/AC2/AC3/AC4/AC5. Gemini's wire
 * shape differs from the OpenAI-compatible providers -- `contents`/
 * `systemInstruction`, `usageMetadata`, the key on a header -- but the
 * discipline under test is identical (raw usage, no cross-call state,
 * config-driven quotas, a surfaced-not-thrown 429).
 */

/*
 * Story 4.7 replaced the two Gemini 2.5 models this file was written against:
 * `gemini-2.5-flash` has a 20-request daily cap and can never finish a Match,
 * and `gemini-2.5-pro` has no free quota at all. Gemma 4 31B and the 3.1 Flash
 * Lite row stand in, and the path-addressed-model discipline under test is
 * unchanged -- which is the point of the substitution being this small.
 */
const GEMMA_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b:generateContent';
const FLASH_LITE_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent';
const MODEL = 'gemma-4-31b';

const RECORDED_200 = JSON.stringify({
  candidates: [
    {
      content: { role: 'model', parts: [{ text: 'ACTION: attack' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 38, candidatesTokenCount: 3, totalTokenCount: 41 },
});

const RECORDED_429 = JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
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
}

function makeHeaders(entries: Readonly<Record<string, string>>): HttpHeaders {
  const lowered = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

function repeat(count: number, response: ScriptedResponse): readonly ScriptedResponse[] {
  return Array.from({ length: count }, () => response);
}

function createTransport(script: readonly ScriptedResponse[]): Transport {
  const calls: { url: string; request: HttpRequest }[] = [];
  const sleeps: number[] = [];
  const signals: RateLimitSignal[] = [];

  return {
    calls: () => calls,
    sleeps: () => sleeps,
    signals: () => signals,

    fetch: (url: string, request: HttpRequest) => {
      if (calls.length >= script.length) {
        throw new Error(`Scripted transport exhausted after ${script.length} response(s).`);
      }
      const scripted = script[calls.length];
      calls.push({ url, request });
      return Promise.resolve({
        status: scripted.status ?? 200,
        headers: makeHeaders(scripted.headers ?? {}),
        text: () => Promise.resolve(scripted.body),
      });
    },

    sleep: (milliseconds: number) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },

    onRateLimit: (signal: RateLimitSignal) => {
      signals.push(signal);
    },
  };
}

function clientWith(transport: Transport, overrides: Record<string, unknown> = {}) {
  return createGoogleClient({
    apiKey: 'test-key',
    model: MODEL,
    fetch: transport.fetch,
    sleep: transport.sleep,
    onRateLimit: transport.onRateLimit,
    ...overrides,
  });
}

describe('mapGoogleResponse (AC4)', () => {
  it('maps a 200 to the completion text and the raw candidates token count', () => {
    expect(mapGoogleResponse(RECORDED_200)).toStrictEqual({
      text: 'ACTION: attack',
      usage: { tokensSpent: 3, reasoningTokens: null, cachedTokens: null },
      reasoning: null,
    });
  });

  it('reports thoughtsTokenCount as reasoningTokens when present', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'attack' }] } }],
      usageMetadata: { candidatesTokenCount: 50, thoughtsTokenCount: 120 },
    });
    expect(mapGoogleResponse(body).usage).toStrictEqual({
      tokensSpent: 50,
      reasoningTokens: 120,
      cachedTokens: null,
    });
  });

  it('never coerces an unreported count to zero (INV-5)', () => {
    const noUsage = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'attack' }] } }] });
    expect(mapGoogleResponse(noUsage).usage).toStrictEqual({
      tokensSpent: null,
      reasoningTokens: null,
      cachedTokens: null,
    });
  });

  it('reports cachedContentTokenCount as cachedTokens when present (Story 3.5)', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'attack' }] } }],
      usageMetadata: { candidatesTokenCount: 50, cachedContentTokenCount: 20 },
    });
    expect(mapGoogleResponse(body).usage.cachedTokens).toBe(20);
  });

  it('joins multiple parts and maps an empty/absent part list to an empty string', () => {
    const multi = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'AC' }, { text: 'TION: attack' }] } }],
    });
    expect(mapGoogleResponse(multi).text).toBe('ACTION: attack');

    const empty = JSON.stringify({ candidates: [{ content: { parts: [] } }] });
    expect(mapGoogleResponse(empty).text).toBe('');

    const noContent = JSON.stringify({ candidates: [{}] });
    expect(mapGoogleResponse(noContent).text).toBe('');
  });

  it('throws on a body that is not a well-formed response at all', () => {
    expect(() => mapGoogleResponse('not json')).toThrow(/not JSON/);
    expect(() => mapGoogleResponse(JSON.stringify({ candidates: [] }))).toThrow(/no candidates/);
  });
});

describe('googleRequestBody (INV-4, INV-7)', () => {
  it('sends the assembled system/user pair verbatim and nothing else', () => {
    const body = JSON.parse(googleRequestBody(PROMPT_REQUEST)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toStrictEqual(['contents', 'systemInstruction']);
    expect(body.systemInstruction).toStrictEqual({ parts: [{ text: 'SYSTEM SCAFFOLD' }] });
    expect(body.contents).toStrictEqual([{ role: 'user', parts: [{ text: 'USER BLOCK' }] }]);
  });

  it('sends generationConfig.maxOutputTokens only in Reflex Mode', () => {
    expect(googleRequestBody(PROMPT_REQUEST)).not.toContain('generationConfig');
    const body = JSON.parse(
      googleRequestBody({ ...PROMPT_REQUEST, maxTokens: REFLEX_MAX_TOKENS }),
    ) as Record<string, unknown>;
    expect(body.generationConfig).toStrictEqual({ maxOutputTokens: 8 });
  });

  it('rejects a max_tokens that could never be a valid cap', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => googleRequestBody({ ...PROMPT_REQUEST, maxTokens: bad })).toThrow(
        /maxTokens must be a positive safe integer/,
      );
    }
  });

  it('carries no thinking-budget parameter under any spelling (INV-4)', () => {
    const banned = [['think', 'ingConfig'].join(''), ['think', 'ingBudget'].join(''), 'temperature'];
    const serialised = googleRequestBody({ ...PROMPT_REQUEST, maxTokens: 8 });
    for (const key of banned) {
      expect(serialised).not.toContain(`"${key}"`);
    }
  });
});

describe('createGoogleClient configuration (AC5, INV-8)', () => {
  it('defaults to the allowlisted per-model endpoint', () => {
    expect(clientWith(createTransport([{ body: RECORDED_200 }])).endpoint).toBe(GEMMA_ENDPOINT);
  });

  it('carries the free-tier limits for its model, read from the config file', () => {
    const client = clientWith(createTransport([{ body: RECORDED_200 }]));
    expect(client.limits).toStrictEqual({
      requestsPerMinute: 30,
      requestsPerDay: 14_400,
      tokensPerMinute: 16_000,
    });
  });

  it('picks each model its own endpoint, carrying its own quota', () => {
    const client = clientWith(createTransport([{ body: RECORDED_200 }]), {
      model: 'gemini-3.1-flash-lite',
    });
    expect(client.endpoint).toBe(FLASH_LITE_ENDPOINT);
    expect(client.limits.requestsPerDay).toBe(500);
  });

  it('refuses an endpoint that names a different model than configured', () => {
    expect(() =>
      clientWith(createTransport([{ body: RECORDED_200 }]), {
        model: 'gemma-4-31b',
        endpoint: FLASH_LITE_ENDPOINT,
      }),
    ).toThrow(/does not name model/);
  });

  it('refuses an endpoint that is not on the free-tier allowlist (INV-8)', () => {
    expect(() =>
      clientWith(createTransport([{ body: RECORDED_200 }]), {
        model: 'gemma-4-31b',
        endpoint:
          'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b:streamGenerateContent',
      }),
    ).toThrow(/does not name model|not on the free-tier allowlist/);
  });

  it('throws naming the model when no free-tier endpoint exists for it', () => {
    expect(() =>
      clientWith(createTransport([{ body: RECORDED_200 }]), { model: 'gemini-nano-nobody-configured' }),
    ).toThrow(/no free-tier endpoint for model/);
  });

  it('refuses a blank key or model before any request is made', () => {
    const transport = createTransport([{ body: RECORDED_200 }]);
    expect(() => clientWith(transport, { apiKey: '   ' })).toThrow(/apiKey/);
    expect(() => clientWith(transport, { model: '' })).toThrow(/model/);
    expect(transport.calls()).toHaveLength(0);
  });
});

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
});

describe('complete() over the transport', () => {
  it('issues exactly one POST, key on the header rather than the URL', async () => {
    const transport = createTransport([{ body: RECORDED_200 }]);
    const response = await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.calls()).toHaveLength(1);
    const [call] = transport.calls();
    expect(call.url).toBe(GEMMA_ENDPOINT);
    expect(call.url).not.toContain('key=');
    expect(call.request.headers['x-goog-api-key']).toBe('test-key');
    expect(response.text).toBe('ACTION: attack');
  });

  it('throws on any non-2xx that is not a rate limit', async () => {
    const transport = createTransport([{ status: 400, body: '{"error":{"message":"bad request"}}' }]);
    await expect(clientWith(transport).complete(PROMPT_REQUEST)).rejects.toThrow(/failed with status 400/);
  });
});

describe('a rate-limit response (AC2)', () => {
  it('surfaces a typed signal, backs off once, resolves without failing or retrying', async () => {
    const transport = createTransport([{ status: 429, headers: { 'retry-after': '5' }, body: RECORDED_429 }]);
    const response = await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.signals()).toHaveLength(1);
    expect(transport.signals()[0]).toMatchObject({
      kind: 'rate-limit',
      provider: 'google-ai-studio',
      endpoint: GEMMA_ENDPOINT,
      retryAfterMs: 5000,
    });
    expect(transport.sleeps()).toStrictEqual([5000]);
    expect(transport.calls()).toHaveLength(1);
    expect(response.usage).toStrictEqual({ tokensSpent: null, reasoningTokens: null });
    expect(response.text).toBe(RECORDED_429);
  });

  it('falls back to the configured backoff when no timing header is present', async () => {
    const transport = createTransport([{ status: 429, body: RECORDED_429 }]);
    await clientWith(transport).complete(PROMPT_REQUEST);
    expect(transport.sleeps()).toStrictEqual([60_000]);
  });
});

describe('a Google AI Studio Deployment inside a real Match (AC1)', () => {
  async function playMatch(script: readonly ScriptedResponse[]) {
    const env = createMockEnvironment();
    const transport = createTransport(script);
    const client = clientWith(transport);
    const deployment = createDeployment({ client });
    const bot = createScriptedAgent({
      id: 'bot:blocker',
      script: Array.from({ length: 64 }, () => 'block' as const),
    });
    const match = await runMatch(env, [deployment, bot], 13, { tokenBankStart: 1_000 });
    return { env, transport, deployment, match };
  }

  it('produces a schema-valid Command Log with provider and endpoint on every entry', async () => {
    const { env, deployment, match } = await playMatch(repeat(64, { body: RECORDED_200 }));

    const entries = match.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry.provider).toBe('google-ai-studio');
      expect(entry.endpoint).toBe(GEMMA_ENDPOINT);
    }

    const log = buildCommandLog(match, {
      environment: { id: env.id, version: env.version },
      seed: 13,
      configHash: computeConfigHash({}),
      agents: [
        {
          id: deployment.id,
          kind: 'deployment',
          deployment: { provider: 'google-ai-studio', endpoint: GEMMA_ENDPOINT, model: MODEL },
        },
        { id: 'bot:blocker', kind: 'bot' },
      ],
    });

    expect(() => validateCommandLog(log)).not.toThrow();
  });

  it('survives a rate limit mid-Match without failing it or retrying (AC2)', async () => {
    const { match } = await playMatch([
      { body: RECORDED_200 },
      { status: 429, headers: { 'retry-after': '2' }, body: RECORDED_429 },
      ...repeat(62, { body: RECORDED_200 }),
    ]);

    const entries = match.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    const failures = entries.filter((entry) => entry.parseFailure === true);

    expect(match.result).toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures[0].action).toBe(FALLBACK_ACTION);
    expect(failures[0].rawResponse).toBe(RECORDED_429);
  });
});
