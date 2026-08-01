import { describe, expect, it } from 'vitest';
import type { FreeTierConfig } from '../../../../packages/providers/src/free-tier';
import { loadFreeTierConfig } from '../../../../packages/providers/src/free-tier';
import { createFakeTransport, chatCompletionBody } from '../testing/byok-transport';
import { byokEndpoint } from './catalogue';
import { ByokKeyError, createByokClient, failureSentence } from './client';
import { createWaitBudget } from './pacing';

/**
 * Story 4.6 AC1 and AC3, at the one boundary where a key becomes a request.
 *
 * Everything here is asserted against the transport rather than against a
 * message: the URL the request went to, the header the key rode on, and the
 * status that came back. A test that read the adapter's prose would pass on a
 * client that sent the key to the wrong host with the right wording.
 */

const KEY = 'gsk_test_key_do_not_use_1234';
const GROQ_ORIGIN = 'https://api.groq.com';

function groqClient(overrides: Partial<Parameters<typeof createByokClient>[0]> = {}) {
  const transport = createFakeTransport();
  // Story 4.8: every wait this file provokes is recorded as a number instead of
  // being served by a timer. That makes the whole pacing path run in zero time
  // *and* makes "it did not wait" an assertion rather than an absence -- which
  // is exactly what the 401 and daily-quota cases need to prove.
  const waits: number[] = [];
  const client = createByokClient({
    agentIndex: 0,
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    apiKey: KEY,
    fetch: transport.fetch,
    sleep: (milliseconds: number): Promise<void> => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { client, transport, waits };
}

const REQUEST = { system: 'system', user: 'user', maxTokens: undefined };

describe('a key goes to one origin and no other (AC1)', () => {
  it('sends the request to the endpoint the selection resolves to', async () => {
    const { client, transport } = groqClient();
    await client.complete(REQUEST);
    expect(transport.calls()).toHaveLength(1);
    expect(transport.calls()[0].url).toBe(byokEndpoint('groq', 'llama-3.1-8b-instant'));
    expect(transport.origins()).toStrictEqual([GROQ_ORIGIN]);
  });

  it('puts the key on the provider\'s own auth header and nowhere else', async () => {
    const { client, transport } = groqClient();
    await client.complete(REQUEST);
    const call = transport.calls()[0];
    expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
    // Not in the body, not in the URL. Both are places a key ends up when a
    // request is assembled by hand instead of by the adapter.
    expect(call.body).not.toContain(KEY);
    expect(call.url).not.toContain(KEY);
  });

  it('reaches exactly one origin across many calls', async () => {
    const { client, transport } = groqClient();
    for (let call = 0; call < 5; call += 1) {
      await client.complete(REQUEST);
    }
    expect(transport.calls()).toHaveLength(5);
    expect(transport.origins()).toStrictEqual([GROQ_ORIGIN]);
  });

  it('sends a Google selection to Google, on Google\'s own key header', async () => {
    const transport = createFakeTransport({
      body: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ACTION: block' }] } }] }),
    });
    const client = createByokClient({
      agentIndex: 1,
      provider: 'google-ai-studio',
      model: 'gemma-4-31b',
      apiKey: KEY,
      fetch: transport.fetch,
    });
    await client.complete(REQUEST);
    expect(transport.origins()).toStrictEqual(['https://generativelanguage.googleapis.com']);
    expect(transport.calls()[0].headers['x-goog-api-key']).toBe(KEY);
    expect(transport.calls()[0].headers.Authorization).toBeUndefined();
  });
});

describe('the client reports byok while keeping provenance (AC4, INV-6)', () => {
  it('reports provider byok with the upstream endpoint and model', () => {
    const { client } = groqClient();
    expect(client.provider).toBe('byok');
    expect(client.endpoint).toBe(byokEndpoint('groq', 'llama-3.1-8b-instant'));
    expect(client.model).toBe('llama-3.1-8b-instant');
  });

  it('holds no key on the object it hands out', () => {
    // The client is passed to `createDeployment`, which is `packages/core`.
    // Anything readable off it is readable by core (AC2).
    const { client } = groqClient();
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(Object.values(client).some((value) => value === KEY)).toBe(false);
  });
});

describe('every failure names a key and a reason (AC3)', () => {
  it('calls a 401 an invalid key, and says which fighter', async () => {
    const transport = createFakeTransport({ statuses: [401], body: () => 'Invalid API Key' });
    const client = createByokClient({
      agentIndex: 1,
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      apiKey: KEY,
      fetch: transport.fetch,
    });
    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).failure).toBe('invalid-key');
    expect((error as ByokKeyError).agentIndex).toBe(1);
    expect((error as ByokKeyError).message).toContain('Fighter 2');
    expect((error as ByokKeyError).message).toContain('Groq');
  });

  it('calls a 403 an invalid key too', async () => {
    const transport = createFakeTransport({ statuses: [403], body: () => 'Forbidden' });
    const { client } = groqClient({ fetch: transport.fetch });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ failure: 'invalid-key' });
  });

  it('never lets a 429 become a Parse Failure, whichever way it ends', async () => {
    // The tournament adapter *resolves* a 429 so an unattended Match can carry
    // on with the Fallback Action. That has never been right here -- it would
    // publish a Match the visitor's quota never played. Story 4.8 changed what
    // happens *instead* (wait and repeat rather than fail outright); it did not
    // change this, and this is the half that matters for the Command Log.
    const transport = createFakeTransport({
      statuses: [429],
      body: () => 'Rate limit reached for model llama-3.1-8b-instant',
      responseHeaders: { 'retry-after': '60' },
    });
    const { client } = groqClient({ fetch: transport.fetch });
    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).failure).toBe('rate-limited');
    expect((error as ByokKeyError).detail).toContain('Rate limit reached');
  });

  it('calls a rejected fetch unreachable, which is what a CORS refusal looks like', async () => {
    // A cross-origin refusal reaches JavaScript as a TypeError with no status
    // at all -- indistinguishable from an offline tab, and nothing like a 4xx.
    const transport = createFakeTransport({ rejectWith: new TypeError('Failed to fetch') });
    const { client } = groqClient({ fetch: transport.fetch });
    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect((error as ByokKeyError).failure).toBe('unreachable');
    expect((error as ByokKeyError).message).toContain('never reached the provider');
  });

  it('calls anything else a provider error rather than guessing', async () => {
    const transport = createFakeTransport({ statuses: [500], body: () => 'upstream exploded' });
    const { client } = groqClient({ fetch: transport.fetch });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ failure: 'provider-error' });
  });

  it('classifies each call on its own, never on the previous call\'s status', async () => {
    // The client is reused for the whole Match. Stale transport state here
    // would report the second failure with the first one's cause.
    const transport = createFakeTransport({
      statuses: [200, 401],
      body: (call) => (call === 0 ? chatCompletionBody('ACTION: attack') : 'Invalid API Key'),
    });
    const { client } = groqClient({ fetch: transport.fetch });
    await client.complete(REQUEST);
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ failure: 'invalid-key' });
  });

  it('recovers its classification after a failure, rather than latching', async () => {
    const transport = createFakeTransport({
      statuses: [401, 200],
      body: (call) => (call === 0 ? 'Invalid API Key' : chatCompletionBody('ACTION: block')),
    });
    const { client } = groqClient({ fetch: transport.fetch });
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(ByokKeyError);
    await expect(client.complete(REQUEST)).resolves.toMatchObject({ text: 'ACTION: block' });
  });

  it('redacts a key the provider quoted back before it becomes a displayable message', async () => {
    const transport = createFakeTransport({
      statuses: [401],
      body: () => `Incorrect API key provided: ${KEY}`,
    });
    const { client } = groqClient({ fetch: transport.fetch });
    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect((error as ByokKeyError).detail).not.toContain(KEY);
    expect((error as ByokKeyError).message).not.toContain(KEY);
    expect((error as ByokKeyError).detail).toContain('[key redacted]');
  });

  it('refuses a blank key at construction, before any request exists', () => {
    const transport = createFakeTransport();
    expect(() =>
      createByokClient({
        agentIndex: 0,
        provider: 'groq',
        model: 'llama-3.1-8b-instant',
        apiKey: '   ',
        fetch: transport.fetch,
      }),
    ).toThrow(ByokKeyError);
    expect(transport.calls()).toHaveLength(0);
  });

  it('refuses a CLI-only provider at construction, before any request exists (AC5)', () => {
    const transport = createFakeTransport();
    expect(() =>
      createByokClient({
        agentIndex: 0,
        provider: 'openrouter',
        model: 'anything',
        apiKey: KEY,
        fetch: transport.fetch,
      }),
    ).toThrow(/is not in this picker/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('gives every failure a sentence with no status code in it', () => {
    // Every member of the union, listed rather than derived: adding a failure
    // and forgetting its sentence is the mistake this catches, and a list built
    // from the switch itself would not catch it.
    for (const failure of [
      'invalid-key',
      'rate-limited',
      'unreachable',
      'unknown-model',
      'provider-error',
      'daily-quota',
      'cannot-finish',
    ] as const) {
      expect(failureSentence(failure).length).toBeGreaterThan(20);
      expect(failureSentence(failure)).not.toMatch(/\b[45]\d\d\b/);
      // INV-3 at the level of a sentence: no failure message may quote a wait.
      expect(failureSentence(failure)).not.toMatch(/\b\d+\s*(ms|s|sec|second|minute|hour)/i);
    }
  });
});

describe('progress is reported without any notion of duration (INV-3)', () => {
  it('counts completed calls and nothing else', async () => {
    const seen: number[] = [];
    const transport = createFakeTransport();
    const client = createByokClient({
      agentIndex: 0,
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      apiKey: KEY,
      fetch: transport.fetch,
      onCall: () => seen.push(seen.length + 1),
    });
    await client.complete(REQUEST);
    await client.complete(REQUEST);
    expect(seen).toStrictEqual([1, 2]);
  });

  it('does not count a call that failed', async () => {
    const seen: number[] = [];
    const transport = createFakeTransport({ statuses: [401], body: () => 'nope' });
    const client = createByokClient({
      agentIndex: 0,
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      apiKey: KEY,
      fetch: transport.fetch,
      onCall: () => seen.push(1),
    });
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(ByokKeyError);
    expect(seen).toStrictEqual([]);
  });
});

/**
 * Story 4.7: a model name that came from a visitor rather than a dropdown, an
 * endpoint that came from one too, and the failure that only matters once both
 * are possible.
 */
describe('a model the provider does not serve is its own failure (4.7, AC7)', () => {
  it('is attributed as an unknown model, not as a generic provider error', async () => {
    const { client } = groqClient({
      model: 'gpt-oss-120b',
      fetch: createFakeTransport({
        statuses: [404],
        body: () =>
          JSON.stringify({
            error: {
              message: 'The model `gpt-oss-120b` does not exist or you do not have access to it.',
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          }),
      }).fetch,
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      name: 'ByokKeyError',
      failure: 'unknown-model',
    });
  });

  it('says the thing a visitor can act on, and names the shape of the fix', () => {
    // A missing `openai/` prefix is the overwhelmingly likely cause once model
    // names can be typed, and the sentence says so rather than making someone
    // guess between their key and their model.
    const sentence = failureSentence('unknown-model');
    expect(sentence).toMatch(/does not serve that model/);
    expect(sentence).toContain('openai/gpt-oss-120b');
  });

  it('still calls a rejected key a rejected key, and a quota a quota', async () => {
    // AC7's value is entirely in these three staying apart. A 401 classified as
    // an unknown model sends a visitor to the wrong place.
    for (const [status, expected] of [
      [401, 'invalid-key'],
      [403, 'invalid-key'],
      [429, 'rate-limited'],
      [500, 'provider-error'],
    ] as const) {
      const { client } = groqClient({
        fetch: createFakeTransport({
          statuses: [status],
          body: () => '{"error":{"message":"something"}}',
        }).fetch,
      });
      await expect(client.complete(REQUEST)).rejects.toMatchObject({ failure: expected });
    }
  });
});

describe('a model on no list at all (4.7, AC3)', () => {
  it('reaches the wire verbatim, on the provider existing endpoint', async () => {
    const transport = createFakeTransport();
    const client = createByokClient({
      agentIndex: 0,
      provider: 'groq',
      model: 'a-model-nobody-listed',
      apiKey: KEY,
      fetch: transport.fetch,
    });

    await client.complete(REQUEST);
    expect(transport.origins()).toStrictEqual([GROQ_ORIGIN]);
    expect(JSON.parse(transport.calls()[0].body)).toMatchObject({ model: 'a-model-nobody-listed' });
    // The URL did not change, which is why this touches INV-8 not at all.
    expect(transport.calls()[0].url).toBe(byokEndpoint('groq', 'llama-3.1-8b-instant'));
    expect(client.model).toBe('a-model-nobody-listed');
  });

  it('is refused where the model is in the URL path, before any request', () => {
    const transport = createFakeTransport();
    expect(() =>
      createByokClient({
        agentIndex: 0,
        provider: 'google-ai-studio',
        model: 'gemini-nobody-allowlisted',
        apiKey: KEY,
        fetch: transport.fetch,
      }),
    ).toThrow(/free-tier allowlist entry/);
    expect(transport.calls()).toHaveLength(0);
  });
});

describe('an endpoint the visitor supplied (4.7, AC5, AC6)', () => {
  it('sends the key to that origin and to no other, ignoring the picker', async () => {
    const transport = createFakeTransport();
    const client = createByokClient({
      agentIndex: 1,
      // Left on Groq deliberately: a base URL replaces the picker rather than
      // overriding it, and a request to api.groq.com here would be the bug.
      provider: 'groq',
      model: 'anthropic/claude-opus-4',
      apiKey: 'sk-or-visitor',
      baseUrl: 'https://openrouter.ai/api/v1',
      fetch: transport.fetch,
    });

    await client.complete(REQUEST);
    expect(transport.origins()).toStrictEqual(['https://openrouter.ai']);
    expect(transport.calls()[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(transport.calls()[0].headers.Authorization).toBe('Bearer sk-or-visitor');
  });

  it('records the visitor endpoint and model, so provenance survives (INV-6)', () => {
    const client = createByokClient({
      agentIndex: 0,
      provider: 'groq',
      model: 'anthropic/claude-opus-4',
      apiKey: 'sk',
      baseUrl: 'https://gw.internal.example:8443/v1',
      fetch: createFakeTransport().fetch,
    });
    expect(client.provider).toBe('byok');
    expect(client.endpoint).toBe('https://gw.internal.example:8443/v1/chat/completions');
    expect(client.model).toBe('anthropic/claude-opus-4');
  });

  it('refuses a plaintext endpoint outright, before any request exists (AC6)', () => {
    const transport = createFakeTransport();
    expect(() =>
      createByokClient({
        agentIndex: 0,
        provider: 'groq',
        model: 'm',
        apiKey: 'k',
        baseUrl: 'http://gw.example/v1',
        fetch: transport.fetch,
      }),
    ).toThrow(/not https/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('names the origin rather than a provider label when a call fails there', async () => {
    const client = createByokClient({
      agentIndex: 0,
      provider: 'groq',
      model: 'm',
      apiKey: 'sk-visitor-key',
      baseUrl: 'https://gw.example/v1',
      fetch: createFakeTransport({ statuses: [401], body: () => '{"error":"nope"}' }).fetch,
    });

    // "Fighter 1's Groq key" would be a lie: the key never went near Groq. The
    // error is captured rather than matched through `.rejects.not`, which
    // passes for a rejection that never happened as readily as for one that
    // did.
    const error = await client.complete(REQUEST).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).message).toContain('https://gw.example');
    expect((error as ByokKeyError).message).not.toContain('Groq');
    expect((error as ByokKeyError).provider).toBe('https://gw.example');
  });

  it('redacts the key from a visitor endpoint error, same as any other (AC2)', async () => {
    const secret = 'sk-visitor-secret-value';
    const client = createByokClient({
      agentIndex: 0,
      provider: 'groq',
      model: 'm',
      apiKey: secret,
      baseUrl: 'https://gw.example/v1',
      fetch: createFakeTransport({
        statuses: [400],
        body: () => JSON.stringify({ error: { message: `bad key ${secret}` } }),
      }).fetch,
    });

    const error = await client.complete(REQUEST).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).detail).toContain('bad key');
    expect((error as ByokKeyError).detail).not.toContain(secret);
    expect((error as ByokKeyError).message).not.toContain(secret);
  });
});

/**
 * Groq's own config with one extra row capped below what a Match costs.
 *
 * The workhorse row stays runnable on purpose. 4.7's `byokProvider` already
 * refuses a provider with *no* usable model at all, so starving every row would
 * test that older guard instead of this one -- and it would miss the case that
 * actually exists, which is a single bad model reachable only by typing or by
 * discovery, on a provider that is otherwise fine.
 */
const CAPPED_MODEL = 'a-capped-model';

function starvedFreeTier(): FreeTierConfig {
  const config = loadFreeTierConfig();
  return loadFreeTierConfig({
    verifiedOn: config.verifiedOn,
    providers: {
      groq: {
        ...(JSON.parse(JSON.stringify(config.providers.groq)) as object),
        models: {
          'llama-3.1-8b-instant': {
            requestsPerMinute: 30,
            requestsPerDay: 14_400,
            tokensPerMinute: 6000,
          },
          // 20 requests a day against up to 60 calls: gemini-2.5-flash's shape,
          // on a provider that puts the model in the request body so nothing
          // else refuses it first.
          [CAPPED_MODEL]: { requestsPerMinute: 30, requestsPerDay: 20, tokensPerMinute: 6000 },
        },
      },
    },
  });
}

describe('a rate limit is a pause, not the end of a Match (4.8)', () => {
  it('waits out a 429 and repeats that same call (AC2)', async () => {
    const transport = createFakeTransport({
      rateLimitAt: [0],
      responseHeaders: { 'retry-after': '2' },
    });
    const { client, waits } = groqClient({ fetch: transport.fetch });

    const response = await client.complete(REQUEST);

    // The Decision Point is decided by the model, not by the Fallback Action.
    expect(response.text).toContain('ACTION: attack');
    expect(transport.calls()).toHaveLength(2);
    // *That same call*, byte for byte. A re-asked decision would carry a
    // different prompt; this carries the same one, which is the whole of the
    // INV-1 distinction the story draws.
    expect(transport.calls()[1].body).toBe(transport.calls()[0].body);
    expect(transport.calls()[1].url).toBe(transport.calls()[0].url);
    expect(waits).toStrictEqual([2000]);
  });

  it('never issues a call that produced an answer a second time (AC4)', async () => {
    // The guard is one `return` in `complete`. Every 200 here must cost exactly
    // one request; mutate that `return` into anything that loops and this goes
    // red on the very first call.
    const transport = createFakeTransport();
    const { client } = groqClient({ fetch: transport.fetch });
    for (const _ignored of [0, 1, 2, 3, 4]) {
      await client.complete(REQUEST);
    }
    expect(transport.calls()).toHaveLength(5);
  });

  it('paces before the limit when the quota headers say to (AC1)', async () => {
    // No 429 occurs anywhere in this test. That is the point: the limit is seen
    // coming from the headers that ride on a *successful* response.
    const transport = createFakeTransport({
      headersFor: (call) =>
        call === 0
          ? { 'x-ratelimit-remaining-tokens': '120', 'x-ratelimit-reset-tokens': '7.66s' }
          : { 'x-ratelimit-remaining-tokens': '50000', 'x-ratelimit-reset-tokens': '7.66s' },
    });
    const { client, waits } = groqClient({ fetch: transport.fetch });

    await client.complete(REQUEST);
    expect(waits).toStrictEqual([]);
    await client.complete(REQUEST);

    expect(waits).toStrictEqual([7660]);
    expect(transport.calls()).toHaveLength(2);
  });

  it('does not pace twice on one exhausted reading', async () => {
    // The wait was sized to refill exactly that bucket, so carrying the reading
    // past it would double every wait. Every response here reports an empty
    // bucket, so a client that failed to forget would wait before every call
    // rather than before every other one.
    const transport = createFakeTransport({
      responseHeaders: { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '5s' },
    });
    const { client, waits } = groqClient({ fetch: transport.fetch });
    await client.complete(REQUEST);
    await client.complete(REQUEST);
    await client.complete(REQUEST);
    expect(waits).toStrictEqual([5000, 5000]);
  });

  it('does not pace at all when the provider reports nothing', async () => {
    // Cerebras and Google publish no such headers. Reactive waiting is the
    // floor for them; proactive pacing must not invent a wait from silence.
    const transport = createFakeTransport();
    const { client, waits } = groqClient({ fetch: transport.fetch });
    await client.complete(REQUEST);
    await client.complete(REQUEST);
    expect(waits).toStrictEqual([]);
  });

  it('stops immediately on a 401 rather than waiting (AC6)', async () => {
    const transport = createFakeTransport({ statuses: [401], body: () => 'Invalid API Key' });
    const { client, waits } = groqClient({ fetch: transport.fetch });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ failure: 'invalid-key' });
    // A wait cannot fix a revoked key, and a tab that pauses for a minute before
    // saying so is worse than one that says so at once.
    expect(waits).toStrictEqual([]);
    expect(transport.calls()).toHaveLength(1);
  });

  it('stops immediately on a 403 rather than waiting (AC6)', async () => {
    const transport = createFakeTransport({ statuses: [403], body: () => 'Forbidden' });
    const { client, waits } = groqClient({ fetch: transport.fetch });
    await expect(client.complete(REQUEST)).rejects.toMatchObject({ failure: 'invalid-key' });
    expect(waits).toStrictEqual([]);
  });

  it('calls a wait measured in hours a daily quota and refuses it (AC6)', async () => {
    const transport = createFakeTransport({
      rateLimitAt: [0],
      responseHeaders: { 'retry-after': '21600' },
    });
    const { client, waits } = groqClient({ fetch: transport.fetch });
    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect((error as ByokKeyError).failure).toBe('daily-quota');
    expect(waits).toStrictEqual([]);
    expect(transport.calls()).toHaveLength(1);
  });

  it('reads a daily cap off the pacing headers before spending a request (AC6)', async () => {
    const transport = createFakeTransport({
      responseHeaders: {
        'x-ratelimit-remaining-requests': '0',
        'x-ratelimit-reset-requests': '6h',
      },
    });
    const { client, waits } = groqClient({ fetch: transport.fetch });
    await client.complete(REQUEST);
    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect((error as ByokKeyError).failure).toBe('daily-quota');
    expect(waits).toStrictEqual([]);
    // The second call was never made: being told beats being refused.
    expect(transport.calls()).toHaveLength(1);
  });

  it('abandons the Match once the wait bound is spent (AC7)', async () => {
    // A provider that refuses forever. Without the bound this is an infinite
    // loop; with it, the Match ends attributed and nothing is recorded.
    const transport = createFakeTransport({
      statuses: [429],
      responseHeaders: { 'retry-after': '1' },
    });
    const budget = createWaitBudget(3);
    const { client, waits } = groqClient({ fetch: transport.fetch, budget });

    const error = await client.complete(REQUEST).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).failure).toBe('rate-limited');
    expect(waits).toStrictEqual([1000, 1000, 1000]);
    // Three waits, four requests: the bound counts waits, and the call that
    // finds the budget spent has already been made.
    expect(transport.calls()).toHaveLength(4);
    expect(budget.taken()).toBe(3);
  });

  it('draws on the budget it was given rather than one of its own (AC7)', async () => {
    // `run.ts` hands both fighters one budget. A client that quietly built its
    // own would let a two-sided stall run twice as long as a one-sided one.
    const budget = createWaitBudget(2);
    const first = groqClient({
      fetch: createFakeTransport({ statuses: [429], responseHeaders: { 'retry-after': '1' } })
        .fetch,
      budget,
    });
    await first.client.complete(REQUEST).catch(() => undefined);
    expect(budget.taken()).toBe(2);

    const second = groqClient({
      fetch: createFakeTransport({ rateLimitAt: [0], responseHeaders: { 'retry-after': '1' } })
        .fetch,
      budget,
    });
    await expect(second.client.complete(REQUEST)).rejects.toMatchObject({
      failure: 'rate-limited',
    });
    expect(second.waits).toStrictEqual([]);
  });

  it('announces a wait only when one happens, and carries nothing (INV-3)', async () => {
    const announced = { count: 0 };
    const transport = createFakeTransport({
      rateLimitAt: [1],
      responseHeaders: { 'retry-after': '2' },
    });
    const { client } = groqClient({
      fetch: transport.fetch,
      onWait: () => {
        announced.count += 1;
      },
    });

    await client.complete(REQUEST);
    expect(announced.count).toBe(0);
    await client.complete(REQUEST);
    expect(announced.count).toBe(1);
  });

  it('refuses a model whose daily cap cannot cover a Match, before any request (AC8)', () => {
    // The shape 4.6 shipped and 4.7 filtered out of the picker. A *typed* or
    // discovered model can still land on a provider default this small, which
    // is the hole a picker filter cannot close.
    const transport = createFakeTransport();
    expect(() =>
      createByokClient({
        agentIndex: 0,
        provider: 'groq',
        model: CAPPED_MODEL,
        apiKey: KEY,
        fetch: transport.fetch,
        freeTier: starvedFreeTier(),
      }),
    ).toThrow(/Cannot finish one Match/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('attributes that refusal to a fighter, like every other failure (AC8)', () => {
    const error = ((): unknown => {
      try {
        createByokClient({
          agentIndex: 1,
          provider: 'groq',
          model: CAPPED_MODEL,
          apiKey: KEY,
          fetch: createFakeTransport().fetch,
          freeTier: starvedFreeTier(),
        });
        return null;
      } catch (caught: unknown) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ByokKeyError);
    expect((error as ByokKeyError).failure).toBe('cannot-finish');
    expect((error as ByokKeyError).message).toContain('Fighter 2');
  });

  it('does not second-guess a visitor endpoint, which publishes no quota (AC8)', () => {
    // Inventing a quota for an endpoint this build has never heard of, purely to
    // refuse the visitor by it, would be worse than letting the Match tell them.
    expect(() =>
      createByokClient({
        agentIndex: 0,
        provider: 'groq',
        model: 'anything',
        apiKey: KEY,
        baseUrl: 'https://gw.example/v1',
        fetch: createFakeTransport().fetch,
        freeTier: starvedFreeTier(),
      }),
    ).not.toThrow();
  });
});
