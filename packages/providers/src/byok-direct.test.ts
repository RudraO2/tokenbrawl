import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProviderRequest } from '../../core/src/deployment';
import { assertVisitorSuppliedEndpoint, createVisitorEndpointClient } from './byok-direct';
import type { HttpFetch, HttpRequest, HttpResponse } from './http';
import { requestBody } from './http';

/**
 * Story 4.7, AC5 and AC6: the visitor-supplied endpoint.
 *
 * This is the file that consults no free-tier allowlist, so its guard rails are
 * the only ones it has and they are all tested here: https only, one resolved
 * origin, and nothing contacted that the visitor did not configure.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const RECORDED_200 = JSON.stringify({
  choices: [{ message: { content: 'ACTION: attack', reasoning: 'closing distance' } }],
  usage: {
    completion_tokens: 41,
    completion_tokens_details: { reasoning_tokens: 12 },
    prompt_tokens_details: { cached_tokens: 7 },
  },
});

const PROMPT_REQUEST: ProviderRequest = {
  system: 'you are a fighter',
  user: 'state: ...',
  maxTokens: undefined,
};

interface RecordedCall {
  readonly url: string;
  readonly request: HttpRequest;
}

function createTransport(
  status: number,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): { fetch: HttpFetch; calls(): readonly RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: HttpFetch = (url, request) => {
    calls.push({ url, request });
    const response: HttpResponse = {
      status,
      headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(body),
    };
    return Promise.resolve(response);
  };
  return { fetch, calls: () => calls };
}

describe('the guard rails on a visitor-supplied URL (AC6)', () => {
  it('refuses plaintext outright, because a key on http travels in clear', () => {
    expect(() => assertVisitorSuppliedEndpoint('http://openrouter.ai/api/v1')).toThrow(/not https/);
    // Not upgraded silently: the visitor is told, and no request is built.
    expect(() => assertVisitorSuppliedEndpoint('http://localhost:8080/v1')).toThrow(/Refused/);
  });

  it('refuses every other scheme too, not just http', () => {
    for (const url of ['ftp://x.example/v1', 'file:///etc/passwd', 'ws://x.example/v1']) {
      expect(() => assertVisitorSuppliedEndpoint(url)).toThrow(/not https/);
    }
  });

  it('refuses what is not a URL, and says what one looks like', () => {
    expect(() => assertVisitorSuppliedEndpoint('not a url')).toThrow(/is not a URL/);
    expect(() => assertVisitorSuppliedEndpoint('   ')).toThrow(/base URL/);
    expect(() => assertVisitorSuppliedEndpoint('openrouter.ai/api/v1')).toThrow(/is not a URL/);
  });

  it('resolves the exact origin the key will be sent to (AC6)', () => {
    expect(assertVisitorSuppliedEndpoint('https://openrouter.ai/api/v1').origin).toBe(
      'https://openrouter.ai',
    );
    // A port is part of an origin and must be shown as such: `x.example` and
    // `x.example:8443` are two different places to send a credential.
    expect(assertVisitorSuppliedEndpoint('https://gw.internal.example:8443/v1').origin).toBe(
      'https://gw.internal.example:8443',
    );
  });

  it('accepts a base URL or a full completions URL, and lands on the same place', () => {
    // A visitor copying from a provider's docs will have one or the other, and
    // guessing wrong should not cost them a failed Match to discover.
    const fromBase = assertVisitorSuppliedEndpoint('https://openrouter.ai/api/v1');
    const fromFull = assertVisitorSuppliedEndpoint('https://openrouter.ai/api/v1/chat/completions');
    const fromSlash = assertVisitorSuppliedEndpoint('https://openrouter.ai/api/v1/');
    expect(fromBase).toStrictEqual(fromFull);
    expect(fromSlash).toStrictEqual(fromFull);
    expect(fromFull.completions).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(fromFull.models).toBe('https://openrouter.ai/api/v1/models');
  });

  it('drops a query string, so a pasted ?key= never reaches a Command Log (INV-6)', () => {
    const resolved = assertVisitorSuppliedEndpoint('https://x.example/v1?key=SECRET#frag');
    expect(resolved.completions).toBe('https://x.example/v1/chat/completions');
    expect(resolved.completions).not.toContain('SECRET');
    expect(resolved.models).not.toContain('SECRET');
  });
});

describe('the client itself (AC5)', () => {
  it('sends to the configured origin and to no other', async () => {
    const transport = createTransport(200, RECORDED_200);
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-visitor',
      model: 'anthropic/claude-opus-4',
      fetch: transport.fetch,
    });

    await client.complete(PROMPT_REQUEST);

    expect(transport.calls()).toHaveLength(1);
    const call = transport.calls()[0];
    expect(call.url).toBe('https://gw.example/v1/chat/completions');
    expect(new URL(call.url).origin).toBe('https://gw.example');
    expect(call.request.headers.Authorization).toBe('Bearer sk-visitor');
  });

  it('records the model verbatim, however unusual (AC5, INV-6)', async () => {
    const transport = createTransport(200, RECORDED_200);
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'sk-visitor',
      model: 'Some/Weird_Model.v2',
      fetch: transport.fetch,
    });

    expect(client.model).toBe('Some/Weird_Model.v2');
    expect(client.endpoint).toBe('https://gw.example/v1/chat/completions');
    expect(client.provider).toBe('byok');

    await client.complete(PROMPT_REQUEST);
    const sent = JSON.parse(requestBody(transport.calls()[0].request)) as { model: string };
    expect(sent.model).toBe('Some/Weird_Model.v2');
  });

  it('speaks the same OpenAI wire format the tournament adapters do', async () => {
    const transport = createTransport(200, RECORDED_200);
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'k',
      model: 'm',
      fetch: transport.fetch,
    });

    const response = await client.complete(PROMPT_REQUEST);
    expect(response.text).toBe('ACTION: attack');
    expect(response.usage).toStrictEqual({
      tokensSpent: 41,
      reasoningTokens: 12,
      cachedTokens: 7,
    });
    expect(response.reasoning).toBe('closing distance');

    const sent = JSON.parse(requestBody(transport.calls()[0].request)) as Record<string, unknown>;
    // INV-4: no effort, thinking, budget or temperature key, and no max_tokens
    // outside Reflex Mode.
    expect(Object.keys(sent).sort()).toStrictEqual(['messages', 'model']);
  });

  it('sets max_tokens only when Reflex Mode asks for it (INV-4)', async () => {
    const transport = createTransport(200, RECORDED_200);
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'k',
      model: 'm',
      fetch: transport.fetch,
    });

    await client.complete({ ...PROMPT_REQUEST, maxTokens: 8 });
    const sent = JSON.parse(requestBody(transport.calls()[0].request)) as Record<string, unknown>;
    expect(sent.max_tokens).toBe(8);
    expect(sent).not.toHaveProperty('reasoning_effort');
    expect(sent).not.toHaveProperty('thinking');
  });

  it('refuses a blank key or model before any request exists', () => {
    const transport = createTransport(200, RECORDED_200);
    expect(() =>
      createVisitorEndpointClient({
        baseUrl: 'https://gw.example/v1',
        apiKey: '  ',
        model: 'm',
        fetch: transport.fetch,
      }),
    ).toThrow(/apiKey/);
    expect(() =>
      createVisitorEndpointClient({
        baseUrl: 'https://gw.example/v1',
        apiKey: 'k',
        model: '',
        fetch: transport.fetch,
      }),
    ).toThrow(/model/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('validates the URL at construction, not at the first call', () => {
    const transport = createTransport(200, RECORDED_200);
    expect(() =>
      createVisitorEndpointClient({
        baseUrl: 'http://gw.example/v1',
        apiKey: 'k',
        model: 'm',
        fetch: transport.fetch,
      }),
    ).toThrow(/not https/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('surfaces a rate limit as a signal and never retries', async () => {
    const transport = createTransport(429, '{"error":{"message":"slow down"}}', {
      'retry-after': '30',
    });
    const seen: string[] = [];
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'k',
      model: 'm',
      fetch: transport.fetch,
      sleep: () => Promise.resolve(),
      onRateLimit: (signal) => seen.push(signal.message),
    });

    const response = await client.complete(PROMPT_REQUEST);
    expect(seen).toHaveLength(1);
    expect(response.usage.tokensSpent).toBeNull();
    // Exactly one request, rate limit or not (INV-1).
    expect(transport.calls()).toHaveLength(1);
  });

  it('throws on any other non-2xx, naming the endpoint and the status', async () => {
    const transport = createTransport(404, '{"error":{"code":"model_not_found"}}');
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'k',
      model: 'nope',
      fetch: transport.fetch,
    });
    await expect(client.complete(PROMPT_REQUEST)).rejects.toThrow(
      /https:\/\/gw\.example\/v1\/chat\/completions failed with status 404/,
    );
  });

  it('is frozen and holds no cross-call state (AD-9)', () => {
    const transport = createTransport(200, RECORDED_200);
    const client = createVisitorEndpointClient({
      baseUrl: 'https://gw.example/v1',
      apiKey: 'k',
      model: 'm',
      fetch: transport.fetch,
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.keys(client).sort()).toStrictEqual([
      'complete',
      'endpoint',
      'model',
      'provider',
      'resolved',
    ]);
  });
});

describe('the containment that stands in for the allowlist check (INV-8)', () => {
  it('is not reachable through the package index', () => {
    // The in-file half of the audit script's narrowing. Exporting this factory
    // from `index.ts` would put an allowlist-free client one import away from
    // every tournament consumer of this package, which is the failure mode the
    // whole exemption is designed around.
    const index = readFileSync(join(HERE, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/from\s+'\.\/byok-direct'/);
    // And the omission is deliberate rather than forgotten, so it is written
    // down where the next person to add an export will read it.
    expect(index).toContain('byok-direct.ts');
  });

  it('never mentions the free-tier allowlist, which is the point of it', () => {
    const source = readFileSync(join(HERE, 'byok-direct.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    expect(code).not.toContain('assertFreeTierEndpoint');
    expect(code).not.toContain('loadFreeTierConfig');
  });
});

describe('exactly one request per call, whatever happened (INV-1)', () => {
  /**
   * A finding from this story's own mutation pass, and it was a finding about
   * the *tests* rather than the code.
   *
   * Adding a second `httpFetch` on the non-2xx branch -- the shape a
   * well-meaning "just retry once" edit takes -- passed the whole suite. The
   * code was right; nothing pinned it. INV-1 forbids a retry because it hands
   * extra compute to whichever Deployment is worst at following the format,
   * and that reasoning does not weaken because a human is watching this one.
   */
  it('issues no second request on any outcome a call can have', async () => {
    for (const status of [200, 400, 401, 403, 404, 429, 500, 503]) {
      const transport = createTransport(status, status === 200 ? RECORDED_200 : '{"error":{}}');
      const client = createVisitorEndpointClient({
        baseUrl: 'https://gw.example/v1',
        apiKey: 'k',
        model: 'm',
        fetch: transport.fetch,
        sleep: () => Promise.resolve(),
      });

      await client.complete(PROMPT_REQUEST).catch(() => undefined);
      expect(transport.calls(), `status ${String(status)} issued more than one request`).toHaveLength(1);
    }
  });
});
