import { describe, expect, it } from 'vitest';
import { createFakeTransport, chatCompletionBody } from '../testing/byok-transport';
import { byokEndpoint } from './catalogue';
import { ByokKeyError, createByokClient, failureSentence } from './client';

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
  const client = createByokClient({
    agentIndex: 0,
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    apiKey: KEY,
    fetch: transport.fetch,
    ...overrides,
  });
  return { client, transport };
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
      model: 'gemini-2.5-flash',
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

  it('calls a 429 rate-limited, and does not let it become a Parse Failure', async () => {
    // The tournament adapter *resolves* a 429 so an unattended Match can carry
    // on with the Fallback Action. Here that would publish a Match the
    // visitor's quota never played, so it must reject instead.
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
    // Exactly one request. A retry is what INV-1 forbids and what a quota
    // failure most invites.
    expect(transport.calls()).toHaveLength(1);
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
    ).toThrow(/cannot be run from a browser/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('gives every failure a sentence with no status code in it', () => {
    for (const failure of ['invalid-key', 'rate-limited', 'unreachable', 'provider-error'] as const) {
      expect(failureSentence(failure).length).toBeGreaterThan(20);
      expect(failureSentence(failure)).not.toMatch(/\b[45]\d\d\b/);
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
