import { describe, expect, it } from 'vitest';
import { discoverModels, mapModelList, modelListEndpointFor, originOf } from './discovery';
import type { HttpFetch, HttpRequest, HttpResponse } from './http';

/**
 * Story 4.7, AC4: "given a pasted key, when the visitor asks for their models,
 * then the picker is populated from that provider's own model endpoint, called
 * with that visitor's key, sent to that provider's origin **and to no other**."
 *
 * The last clause is the one worth a test rather than a comment, and it is
 * asserted against a recorded transport rather than reasoned about.
 */

const GROQ_COMPLETIONS = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_COMPLETIONS = 'https://api.cerebras.ai/v1/chat/completions';
const GOOGLE_COMPLETIONS =
  'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b:generateContent';

/** A real Groq response, trimmed to the fields this module reads. */
const OPENAI_LIST = JSON.stringify({
  object: 'list',
  data: [
    { id: 'llama-3.3-70b-versatile', object: 'model', owned_by: 'Meta' },
    { id: 'openai/gpt-oss-120b', object: 'model', owned_by: 'OpenAI' },
    { id: 'llama-3.1-8b-instant', object: 'model', owned_by: 'Meta' },
  ],
});

/** A real Google `ListModels` response, trimmed the same way. */
const GOOGLE_LIST = JSON.stringify({
  models: [
    { name: 'models/gemma-4-31b', displayName: 'Gemma 4 31B' },
    { name: 'models/gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' },
  ],
});

interface RecordedCall {
  readonly url: string;
  readonly request: HttpRequest;
}

interface Transport {
  readonly fetch: HttpFetch;
  calls(): readonly RecordedCall[];
}

function createTransport(status: number, body: string): Transport {
  const calls: RecordedCall[] = [];
  const fetch: HttpFetch = (url, request) => {
    calls.push({ url, request });
    const response: HttpResponse = {
      status,
      headers: { get: (): string | null => null },
      text: () => Promise.resolve(body),
    };
    return Promise.resolve(response);
  };
  return { fetch, calls: () => calls };
}

describe('deriving the model list URL (AC4)', () => {
  it('turns an OpenAI-compatible completions URL into its collection', () => {
    expect(modelListEndpointFor(GROQ_COMPLETIONS, 'openai')).toBe(
      'https://api.groq.com/openai/v1/models',
    );
    expect(modelListEndpointFor(CEREBRAS_COMPLETIONS, 'openai')).toBe(
      'https://api.cerebras.ai/v1/models',
    );
    expect(modelListEndpointFor('https://openrouter.ai/api/v1/chat/completions', 'openai')).toBe(
      'https://openrouter.ai/api/v1/models',
    );
  });

  it('cuts the model and the verb off a Google path-addressed URL', () => {
    expect(modelListEndpointFor(GOOGLE_COMPLETIONS, 'google')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
  });

  it('never leaves the origin the key was already going to (AC4)', () => {
    // The property, stated directly rather than inferred from the three cases
    // above: whatever a completions URL is, its model list is on the same host.
    for (const [endpoint, family] of [
      [GROQ_COMPLETIONS, 'openai'],
      [CEREBRAS_COMPLETIONS, 'openai'],
      [GOOGLE_COMPLETIONS, 'google'],
      ['https://gateway.internal.example:8443/v1/chat/completions', 'openai'],
    ] as const) {
      expect(originOf(modelListEndpointFor(endpoint, family))).toBe(originOf(endpoint));
    }
  });

  it('refuses a URL it cannot derive from, rather than guessing a host', () => {
    expect(() => modelListEndpointFor('https://api.groq.com/openai/v1', 'openai')).toThrow(
      /Cannot derive a model list/,
    );
    expect(() => modelListEndpointFor('https://example.com/v1beta/generate', 'google')).toThrow(
      /Cannot derive a model list/,
    );
    expect(() => originOf('not a url')).toThrow(/Not a URL/);
  });
});

describe('mapping a model list', () => {
  it('reads OpenAI-compatible ids, sorted and deduplicated', () => {
    expect(mapModelList('openai', OPENAI_LIST)).toStrictEqual([
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
    ]);
  });

  it('strips the Google models/ prefix, because a request body has none', () => {
    expect(mapModelList('google', GOOGLE_LIST)).toStrictEqual([
      'gemini-3.1-flash-lite',
      'gemma-4-31b',
    ]);
  });

  it('skips an unusable row instead of failing the whole list', () => {
    // One bad row out of two hundred is not a reason to refuse the other 199.
    const mixed = JSON.stringify({ data: [{ id: 'good' }, { id: 42 }, {}, { id: '  ' }] });
    expect(mapModelList('openai', mixed)).toStrictEqual(['good']);
  });

  it('throws on a body that is not a model list at all', () => {
    // An empty list and "this is not a model list" must not look the same: one
    // means "your key can use nothing", which is a very different thing to say.
    expect(() => mapModelList('openai', 'not json')).toThrow(/not JSON/);
    expect(() => mapModelList('openai', '"a string"')).toThrow(/not an object/);
    expect(() => mapModelList('openai', '{}')).toThrow(/carries no data array/);
    expect(() => mapModelList('google', '{}')).toThrow(/carries no models array/);
    expect(mapModelList('openai', '{"data":[]}')).toStrictEqual([]);
  });
});

describe('calling a provider for its models (AC4)', () => {
  it('issues exactly one GET, to one origin, with the key on the right header', async () => {
    const transport = createTransport(200, OPENAI_LIST);
    const models = await discoverModels({
      completionEndpoint: GROQ_COMPLETIONS,
      family: 'openai',
      apiKey: 'gsk_visitor_key',
      keyHeader: 'Authorization',
      fetch: transport.fetch,
    });

    expect(models).toContain('openai/gpt-oss-120b');
    expect(transport.calls()).toHaveLength(1);

    const call = transport.calls()[0];
    expect(call.url).toBe('https://api.groq.com/openai/v1/models');
    expect(originOf(call.url)).toBe(originOf(GROQ_COMPLETIONS));
    expect(call.request.method).toBe('GET');
    expect(call.request.headers.Authorization).toBe('Bearer gsk_visitor_key');
  });

  it('sends a Google key bare on its own header, never as a bearer and never in the URL', async () => {
    const transport = createTransport(200, GOOGLE_LIST);
    await discoverModels({
      completionEndpoint: GOOGLE_COMPLETIONS,
      family: 'google',
      apiKey: 'AIza_visitor_key',
      keyHeader: 'x-goog-api-key',
      fetch: transport.fetch,
    });

    const call = transport.calls()[0];
    expect(call.request.headers['x-goog-api-key']).toBe('AIza_visitor_key');
    // A `?key=` would end up in a Command Log's `endpoint` field (INV-6).
    expect(call.url).not.toContain('AIza_visitor_key');
  });

  it('carries no body, because a GET that does is a fetch that throws', async () => {
    const transport = createTransport(200, OPENAI_LIST);
    await discoverModels({
      completionEndpoint: GROQ_COMPLETIONS,
      family: 'openai',
      apiKey: 'k',
      keyHeader: 'Authorization',
      fetch: transport.fetch,
    });
    expect(transport.calls()[0].request).not.toHaveProperty('body');
  });

  it('refuses a blank key before any request exists', async () => {
    const transport = createTransport(200, OPENAI_LIST);
    await expect(
      discoverModels({
        completionEndpoint: GROQ_COMPLETIONS,
        family: 'openai',
        apiKey: '   ',
        keyHeader: 'Authorization',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/A key is needed/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('reports a rejected key rather than an empty picker, and never retries', async () => {
    const transport = createTransport(401, '{"error":{"message":"Invalid API Key"}}');
    await expect(
      discoverModels({
        completionEndpoint: GROQ_COMPLETIONS,
        family: 'openai',
        apiKey: 'wrong',
        keyHeader: 'Authorization',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/failed with status 401/);
    // INV-1's no-retry rule is not suspended because a human is watching.
    expect(transport.calls()).toHaveLength(1);
  });
});
