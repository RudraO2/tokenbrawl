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
import { cerebrasRequestBody, createCerebrasClient, mapCerebrasResponse } from './cerebras';
import type { HttpFetch, HttpHeaders, HttpRequest, Sleep } from './http';
import type { RateLimitSignal } from './rate-limit';

/**
 * Story 3.3, Cerebras half of AC1/AC2/AC3/AC4/AC5. Same OpenAI-compatible
 * wire shape as `groq.test.ts` -- the coverage mirrors it deliberately, since
 * the discipline the story asks for (raw usage, no cross-call state, config-
 * driven quotas, a surfaced-not-thrown 429) does not vary by provider.
 */

const CEREBRAS_ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions';
const MODEL = 'llama3.1-8b';

const RECORDED_200 = JSON.stringify({
  id: 'chatcmpl-cerebras-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ACTION: attack' } }],
  usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
});

const RECORDED_429 = JSON.stringify({
  error: {
    message: 'Rate limit exceeded for requests per minute. Please try again in 2s.',
    type: 'requests',
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
  return createCerebrasClient({
    apiKey: 'test-key',
    model: MODEL,
    fetch: transport.fetch,
    sleep: transport.sleep,
    onRateLimit: transport.onRateLimit,
    ...overrides,
  });
}

describe('mapCerebrasResponse (AC4)', () => {
  it('maps a 200 to the completion text and the raw completion count', () => {
    expect(mapCerebrasResponse(RECORDED_200)).toStrictEqual({
      text: 'ACTION: attack',
      usage: { tokensSpent: 3, reasoningTokens: null },
      reasoning: null,
    });
  });

  it('never coerces an unreported count to zero (INV-5)', () => {
    const noUsage = JSON.stringify({ choices: [{ message: { content: 'attack' } }] });
    expect(mapCerebrasResponse(noUsage).usage).toStrictEqual({ tokensSpent: null, reasoningTokens: null });
  });

  it('throws on a body that is not a chat completion at all', () => {
    expect(() => mapCerebrasResponse('not json')).toThrow(/not JSON/);
    expect(() => mapCerebrasResponse(JSON.stringify({ choices: [] }))).toThrow(/no choices/);
  });
});

describe('cerebrasRequestBody (INV-4, INV-7)', () => {
  it('sends the assembled system/user pair verbatim and nothing else', () => {
    const body = JSON.parse(cerebrasRequestBody(MODEL, PROMPT_REQUEST)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toStrictEqual(['messages', 'model']);
    expect(body.messages).toStrictEqual([
      { role: 'system', content: 'SYSTEM SCAFFOLD' },
      { role: 'user', content: 'USER BLOCK' },
    ]);
  });

  it('sends max_tokens only in Reflex Mode', () => {
    expect(cerebrasRequestBody(MODEL, PROMPT_REQUEST)).not.toContain('max_tokens');
    const body = JSON.parse(
      cerebrasRequestBody(MODEL, { ...PROMPT_REQUEST, maxTokens: REFLEX_MAX_TOKENS }),
    ) as Record<string, unknown>;
    expect(body.max_tokens).toBe(8);
  });

  it('rejects a max_tokens that could never be a valid cap', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => cerebrasRequestBody(MODEL, { ...PROMPT_REQUEST, maxTokens: bad })).toThrow(
        /maxTokens must be a positive safe integer/,
      );
    }
  });

  it('carries no reasoning-effort parameter under any spelling (INV-4)', () => {
    const banned = [
      ['reason', 'ing_effort'].join(''),
      ['think', 'ingLevel'].join(''),
      'effort',
      'temperature',
    ];
    const serialised = cerebrasRequestBody(MODEL, { ...PROMPT_REQUEST, maxTokens: 8 });
    for (const key of banned) {
      expect(serialised).not.toContain(`"${key}"`);
    }
  });
});

describe('createCerebrasClient configuration (AC5, INV-8)', () => {
  it('defaults to the allowlisted free-tier endpoint', () => {
    expect(clientWith(createTransport([{ body: RECORDED_200 }])).endpoint).toBe(CEREBRAS_ENDPOINT);
  });

  it('carries the free-tier limits for its model, read from the config file', () => {
    const client = clientWith(createTransport([{ body: RECORDED_200 }]));
    expect(client.limits).toStrictEqual({
      requestsPerMinute: 30,
      requestsPerDay: 1000,
      tokensPerMinute: 60_000,
    });
  });

  it('refuses an endpoint that is not on the free-tier allowlist (INV-8)', () => {
    expect(() =>
      clientWith(createTransport([{ body: RECORDED_200 }]), {
        endpoint: 'https://api.cerebras.ai/v1/dedicated/chat/completions',
      }),
    ).toThrow(/not on the free-tier allowlist/);
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

  it('is unchanged by the calls it serves, rate limits included', async () => {
    const transport = createTransport([
      { body: RECORDED_200 },
      { status: 429, headers: { 'retry-after': '2' }, body: RECORDED_429 },
    ]);
    const client = clientWith(transport);
    const before = { ...client };
    await client.complete(PROMPT_REQUEST);
    await client.complete(PROMPT_REQUEST);
    expect({ ...client }).toStrictEqual(before);
  });
});

describe('complete() over the transport', () => {
  it('issues exactly one POST to the configured endpoint, authenticated', async () => {
    const transport = createTransport([{ body: RECORDED_200 }]);
    const response = await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.calls()).toHaveLength(1);
    const [call] = transport.calls();
    expect(call.url).toBe(CEREBRAS_ENDPOINT);
    expect(call.request.headers.Authorization).toBe('Bearer test-key');
    expect(response.text).toBe('ACTION: attack');
  });

  it('throws on any non-2xx that is not a rate limit', async () => {
    const transport = createTransport([{ status: 401, body: '{"error":{"message":"bad key"}}' }]);
    await expect(clientWith(transport).complete(PROMPT_REQUEST)).rejects.toThrow(/failed with status 401/);
  });
});

describe('a rate-limit response (AC2)', () => {
  it('surfaces a typed signal, backs off once, resolves without failing or retrying', async () => {
    const transport = createTransport([{ status: 429, headers: { 'retry-after': '2' }, body: RECORDED_429 }]);
    const response = await clientWith(transport).complete(PROMPT_REQUEST);

    expect(transport.signals()).toHaveLength(1);
    expect(transport.signals()[0]).toMatchObject({
      kind: 'rate-limit',
      provider: 'cerebras',
      endpoint: CEREBRAS_ENDPOINT,
      quota: 'requests',
      retryAfterMs: 2000,
    });
    expect(transport.sleeps()).toStrictEqual([2000]);
    expect(transport.calls()).toHaveLength(1);
    expect(response.usage).toStrictEqual({ tokensSpent: null, reasoningTokens: null });
    expect(response.text).toBe(RECORDED_429);
  });

  it('bounds the backoff at the config maxBackoffMs', async () => {
    const transport = createTransport([
      { status: 429, headers: { 'retry-after': '86400' }, body: RECORDED_429 },
    ]);
    await clientWith(transport).complete(PROMPT_REQUEST);
    expect(transport.sleeps()).toStrictEqual([120_000]);
  });
});

describe('a Cerebras Deployment inside a real Match (AC1)', () => {
  async function playMatch(script: readonly ScriptedResponse[]) {
    const env = createMockEnvironment();
    const transport = createTransport(script);
    const client = clientWith(transport);
    const deployment = createDeployment({ client });
    const bot = createScriptedAgent({
      id: 'bot:blocker',
      script: Array.from({ length: 64 }, () => 'block' as const),
    });
    const match = await runMatch(env, [deployment, bot], 11, { tokenBankStart: 1_000 });
    return { env, transport, deployment, match };
  }

  it('produces a schema-valid Command Log with provider and endpoint on every entry', async () => {
    const { env, deployment, match } = await playMatch(repeat(64, { body: RECORDED_200 }));

    const entries = match.decisions.filter(
      (entry) => entry.agentIndex === 0 && entry.action !== null,
    );
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry.provider).toBe('cerebras');
      expect(entry.endpoint).toBe(CEREBRAS_ENDPOINT);
    }

    const log = buildCommandLog(match, {
      environment: { id: env.id, version: env.version },
      seed: 11,
      configHash: computeConfigHash({}),
      agents: [
        {
          id: deployment.id,
          kind: 'deployment',
          deployment: { provider: 'cerebras', endpoint: CEREBRAS_ENDPOINT, model: MODEL },
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
