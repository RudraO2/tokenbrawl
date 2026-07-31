import type { ProviderId } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import type { HttpFetch, HttpHeaders, HttpRequest } from './http';
import {
  PROBE_SYSTEM_PROMPT,
  PROBE_USER_PROMPT,
  classifyProbeUsage,
  mapProbeUsage,
  probeDeployments,
  probeRequestBody,
  probeWireFamilyFor,
  runMeteringProbe,
} from './metering-probe';

/**
 * Story 3.4, AC1 and AC2.
 *
 * The load-bearing test in this file is "classifies a Deployment that reports
 * only on the plain call as reports-completion-only": its transport reports a
 * deliberation count for a plain body and withholds it for a structured one,
 * so a probe that regressed to the plain call would classify that Deployment
 * as fully honest and the case would fail. That is the story's second AC in
 * full, and it is the reason the probe exists at all.
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const CEREBRAS_ENDPOINT = 'https://api.cerebras.ai/v1/chat/completions';
const FLASH_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const GROQ_MODEL = 'llama-3.1-8b-instant';
const GOOGLE_MODEL = 'gemini-2.5-flash';

const STRUCTURED_COMPLETION = JSON.stringify({ workings: '100 - 51 + 12', answer: 61 });

/** A provider that reports both counts: the only classification that reaches the main leaderboard. */
const OPENAI_BODY_BOTH = JSON.stringify({
  choices: [{ index: 0, message: { role: 'assistant', content: STRUCTURED_COMPLETION } }],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 260,
    completion_tokens_details: { reasoning_tokens: 190 },
  },
});

/** A provider that reports the completion count and nothing about deliberation. */
const OPENAI_BODY_COMPLETION_ONLY = JSON.stringify({
  choices: [{ index: 0, message: { role: 'assistant', content: STRUCTURED_COMPLETION } }],
  usage: { prompt_tokens: 120, completion_tokens: 260 },
});

/** A provider that reports no usage block at all. */
const OPENAI_BODY_NO_USAGE = JSON.stringify({
  choices: [{ index: 0, message: { role: 'assistant', content: STRUCTURED_COMPLETION } }],
});

const GOOGLE_BODY_BOTH = JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text: STRUCTURED_COMPLETION }] } }],
  usageMetadata: { promptTokenCount: 118, candidatesTokenCount: 240, thoughtsTokenCount: 170 },
});

const GOOGLE_BODY_NO_USAGE = JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text: STRUCTURED_COMPLETION }] } }],
});

interface ScriptedResponse {
  readonly status?: number;
  readonly body: string;
}

interface Transport {
  readonly fetch: HttpFetch;
  readonly calls: () => readonly { readonly url: string; readonly request: HttpRequest }[];
}

function noHeaders(): HttpHeaders {
  return { get: () => null };
}

function createTransport(script: readonly ScriptedResponse[]): Transport {
  const calls: { url: string; request: HttpRequest }[] = [];

  return {
    calls: () => calls,
    fetch: (url: string, request: HttpRequest) => {
      if (calls.length >= script.length) {
        throw new Error(`Scripted transport exhausted after ${script.length} response(s).`);
      }
      const scripted = script[calls.length];
      calls.push({ url, request });
      return Promise.resolve({
        status: scripted.status ?? 200,
        headers: noHeaders(),
        text: () => Promise.resolve(scripted.body),
      });
    },
  };
}

/**
 * The documented real behaviour AC2 names: a provider that reports its
 * deliberation count on a plain call and drops it the moment structured output
 * is requested. The transport decides which body to return by looking at what
 * was actually sent, so the assertion is about the probe's request, not about a
 * fixture chosen by hand.
 */
function createDropsUnderStructuredOutputTransport(): Transport {
  const calls: { url: string; request: HttpRequest }[] = [];

  return {
    calls: () => calls,
    fetch: (url: string, request: HttpRequest) => {
      calls.push({ url, request });
      const asked = JSON.parse(request.body) as Record<string, unknown>;
      const structured =
        asked.response_format !== undefined ||
        (asked.generationConfig as Record<string, unknown> | undefined)?.responseSchema !==
          undefined;
      return Promise.resolve({
        status: 200,
        headers: noHeaders(),
        text: () =>
          Promise.resolve(structured ? OPENAI_BODY_COMPLETION_ONLY : OPENAI_BODY_BOTH),
      });
    },
  };
}

describe('probe wire families', () => {
  it('routes Google AI Studio to generateContent and everything else to the OpenAI-compatible shape', () => {
    expect(probeWireFamilyFor('google-ai-studio')).toBe('google-generative');
    for (const provider of ['groq', 'cerebras', 'openrouter', 'xai', 'byok'] as const) {
      expect(probeWireFamilyFor(provider)).toBe('openai-compatible');
    }
  });
});

describe('the probe request body', () => {
  it('asks for structured output on the OpenAI-compatible wire (AC2)', () => {
    const body = JSON.parse(probeRequestBody('groq', GROQ_MODEL)) as Record<string, unknown>;
    const format = body.response_format as Record<string, unknown>;

    expect(format.type).toBe('json_schema');
    expect((format.json_schema as Record<string, unknown>).strict).toBe(true);
    expect(body.model).toBe(GROQ_MODEL);
    expect(body.messages).toStrictEqual([
      { role: 'system', content: PROBE_SYSTEM_PROMPT },
      { role: 'user', content: PROBE_USER_PROMPT },
    ]);
  });

  it('asks for structured output on the Google wire (AC2)', () => {
    const body = JSON.parse(probeRequestBody('google-ai-studio', GOOGLE_MODEL)) as Record<
      string,
      unknown
    >;
    const generationConfig = body.generationConfig as Record<string, unknown>;

    expect(generationConfig.responseMimeType).toBe('application/json');
    expect((generationConfig.responseSchema as Record<string, unknown>).type).toBe('OBJECT');
    // The model is in the URL path for this provider, never the body.
    expect(body.model).toBeUndefined();
  });

  it('sends no effort, thinking-budget or output-cap parameter on either wire (INV-4)', () => {
    // Capping the probe would truncate exactly the deliberation it measures,
    // and an effort parameter is forbidden outright.
    const banned = [
      'reasoning_effort',
      'reasoning',
      'thinking',
      'thinkingLevel',
      'thinkingConfig',
      'thinking_budget',
      'max_tokens',
      'maxOutputTokens',
      'temperature',
    ];
    for (const provider of ['groq', 'cerebras', 'google-ai-studio'] as const) {
      const serialised = probeRequestBody(provider, GROQ_MODEL);
      for (const key of banned) {
        expect(serialised).not.toContain(`"${key}"`);
      }
    }
  });

  it('poses a task that provokes deliberation rather than a bare question', () => {
    expect(PROBE_SYSTEM_PROMPT).toContain('step by step');
    expect(PROBE_USER_PROMPT).toContain('workings');
  });
});

describe('classification (INV-5)', () => {
  it('classifies both counts reported as reports-reasoning', () => {
    expect(classifyProbeUsage({ tokensSpent: 260, reasoningTokens: 190 })).toBe(
      'reports-reasoning',
    );
  });

  it('classifies a completion count with no deliberation count as reports-completion-only', () => {
    expect(classifyProbeUsage({ tokensSpent: 260, reasoningTokens: null })).toBe(
      'reports-completion-only',
    );
  });

  it('classifies nothing reported as no-usage-reported', () => {
    expect(classifyProbeUsage({ tokensSpent: null, reasoningTokens: null })).toBe(
      'no-usage-reported',
    );
  });

  it('calls a missing completion count no-usage-reported even when deliberation is reported', () => {
    // The Token Bank debits by completion tokens. Naming this case after the
    // one number it did not report would be the wrong way round.
    expect(classifyProbeUsage({ tokensSpent: null, reasoningTokens: 190 })).toBe(
      'no-usage-reported',
    );
  });

  it('treats an explicitly reported zero as reported, not as absent', () => {
    expect(classifyProbeUsage({ tokensSpent: 260, reasoningTokens: 0 })).toBe('reports-reasoning');
    expect(classifyProbeUsage({ tokensSpent: 0, reasoningTokens: 0 })).toBe('reports-reasoning');
  });

  it('treats a malformed count as unreported rather than as an honest report', () => {
    // The classifier is exported and Story 7.2 will call it with usage read
    // off a Command Log, not only with usage this package just mapped.
    // Classifying a negative or fractional count as a report is the single
    // most consequential way to get INV-5 backwards.
    expect(classifyProbeUsage({ tokensSpent: -5, reasoningTokens: 190 })).toBe('no-usage-reported');
    expect(classifyProbeUsage({ tokensSpent: 260, reasoningTokens: -1 })).toBe(
      'reports-completion-only',
    );
    expect(
      classifyProbeUsage({ tokensSpent: 12.5, reasoningTokens: null } as unknown as {
        tokensSpent: number | null;
        reasoningTokens: number | null;
      }),
    ).toBe('no-usage-reported');
  });
});

describe('usage mapping', () => {
  it('reads the OpenAI-compatible usage block raw', () => {
    expect(mapProbeUsage('groq', OPENAI_BODY_BOTH)).toStrictEqual({
      tokensSpent: 260,
      reasoningTokens: 190,
    });
  });

  it('reads the Google usageMetadata block raw', () => {
    expect(mapProbeUsage('google-ai-studio', GOOGLE_BODY_BOTH)).toStrictEqual({
      tokensSpent: 240,
      reasoningTokens: 170,
    });
  });

  it('reports null rather than zero for every absent count (INV-5)', () => {
    expect(mapProbeUsage('groq', OPENAI_BODY_NO_USAGE)).toStrictEqual({
      tokensSpent: null,
      reasoningTokens: null,
    });
    expect(mapProbeUsage('google-ai-studio', GOOGLE_BODY_NO_USAGE)).toStrictEqual({
      tokensSpent: null,
      reasoningTokens: null,
    });
  });

  it('treats a malformed count as not reported rather than passing it on', () => {
    const body = JSON.stringify({
      usage: { completion_tokens: 'lots', completion_tokens_details: { reasoning_tokens: -4 } },
    });
    expect(mapProbeUsage('groq', body)).toStrictEqual({ tokensSpent: null, reasoningTokens: null });
  });

  it('classifies a usage block even when the body carries no completion at all', () => {
    // Deliberately unlike `mapGroqResponse`, which throws here. A missing
    // completion is a Parse Failure at a Decision Point; it is not a metering
    // failure, and reporting it as one would blame the provider for the model.
    const body = JSON.stringify({ choices: [], usage: { completion_tokens: 12 } });
    expect(mapProbeUsage('groq', body)).toStrictEqual({ tokensSpent: 12, reasoningTokens: null });
  });

  it('throws on a body that is not JSON, naming the provider', () => {
    expect(() => mapProbeUsage('groq', '<html>502</html>')).toThrow(/groq returned a body that is not JSON/);
  });

  it('throws on a JSON body that is not an object', () => {
    expect(() => mapProbeUsage('groq', '[]')).toThrow(/not an object/);
  });
});

describe('running the probe', () => {
  it('classifies a reporting Deployment as reports-reasoning over the real request path (AC1)', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    const outcome = await runMeteringProbe({
      provider: 'groq',
      model: GROQ_MODEL,
      apiKey: 'test-key',
      fetch: transport.fetch,
    });

    expect(outcome.result).toBe('reports-reasoning');
    expect(outcome.usage).toStrictEqual({ tokensSpent: 260, reasoningTokens: 190 });
    expect(outcome.id).toBe(`groq:${GROQ_MODEL}`);
    expect(outcome.endpoint).toBe(GROQ_ENDPOINT);
    expect(transport.calls()).toHaveLength(1);
  });

  it('classifies a silent Deployment as no-usage-reported (AC1)', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_NO_USAGE }]);
    const outcome = await runMeteringProbe({
      provider: 'cerebras',
      model: 'llama3.1-8b',
      apiKey: 'test-key',
      fetch: transport.fetch,
    });

    expect(outcome.result).toBe('no-usage-reported');
    expect(outcome.endpoint).toBe(CEREBRAS_ENDPOINT);
  });

  it('classifies a Deployment that reports only on the plain call as reports-completion-only (AC2)', async () => {
    // The transport branches on what was actually sent. A probe that issued a
    // plain call would be handed the reporting body and would wrongly return
    // `reports-reasoning`, so this case is the AC and not a restatement of it.
    const transport = createDropsUnderStructuredOutputTransport();
    const outcome = await runMeteringProbe({
      provider: 'groq',
      model: GROQ_MODEL,
      apiKey: 'test-key',
      fetch: transport.fetch,
    });

    expect(outcome.result).toBe('reports-completion-only');
    expect(outcome.usage).toStrictEqual({ tokensSpent: 260, reasoningTokens: null });

    const sent = JSON.parse(transport.calls()[0].request.body) as Record<string, unknown>;
    expect(sent.response_format).toBeDefined();
  });

  it('sends the same combination on the Google wire, and classifies it', async () => {
    const transport = createTransport([{ body: GOOGLE_BODY_BOTH }]);
    const outcome = await runMeteringProbe({
      provider: 'google-ai-studio',
      model: GOOGLE_MODEL,
      apiKey: 'test-key',
      fetch: transport.fetch,
    });

    expect(outcome.result).toBe('reports-reasoning');
    expect(outcome.endpoint).toBe(FLASH_ENDPOINT);

    const call = transport.calls()[0];
    const sent = JSON.parse(call.request.body) as Record<string, unknown>;
    expect((sent.generationConfig as Record<string, unknown>).responseSchema).toBeDefined();
  });

  it('carries the Google key on a header, never in the URL (INV-6)', async () => {
    const transport = createTransport([{ body: GOOGLE_BODY_BOTH }]);
    await runMeteringProbe({
      provider: 'google-ai-studio',
      model: GOOGLE_MODEL,
      apiKey: 'secret-key',
      fetch: transport.fetch,
    });

    const call = transport.calls()[0];
    expect(call.request.headers['x-goog-api-key']).toBe('secret-key');
    expect(call.url).not.toContain('secret-key');
    expect(call.url).not.toContain('key=');
  });

  it('carries the bearer key on the OpenAI-compatible wire', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    await runMeteringProbe({
      provider: 'groq',
      model: GROQ_MODEL,
      apiKey: 'secret-key',
      fetch: transport.fetch,
    });

    expect(transport.calls()[0].request.headers.Authorization).toBe('Bearer secret-key');
  });

  it('throws on a rate limit rather than classifying it', async () => {
    // Absorbing a 429 the way the adapters do mid-Match would classify an
    // honest Deployment as `no-usage-reported` and strand it on the Reflex
    // Track for the rest of the tournament on a transient quota blip.
    const transport = createTransport([{ status: 429, body: '{"error":{"code":"rate_limit"}}' }]);
    await expect(
      runMeteringProbe({
        provider: 'groq',
        model: GROQ_MODEL,
        apiKey: 'test-key',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/failed with status 429[\s\S]*not a classification/);
  });

  it('throws on any other non-2xx', async () => {
    for (const status of [400, 401, 404, 500, 503]) {
      const transport = createTransport([{ status, body: '{"error":"nope"}' }]);
      await expect(
        runMeteringProbe({
          provider: 'groq',
          model: GROQ_MODEL,
          apiKey: 'test-key',
          fetch: transport.fetch,
        }),
      ).rejects.toThrow(new RegExp(`failed with status ${status}`));
    }
  });

  it('refuses an endpoint that is not on the free-tier allowlist, before any request (INV-8)', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    await expect(
      runMeteringProbe({
        provider: 'groq',
        model: GROQ_MODEL,
        apiKey: 'test-key',
        endpoint: 'https://api.groq.com/openai/v1/paid/chat/completions',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/not on the free-tier allowlist/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('refuses a Google model with no allowlisted endpoint', async () => {
    const transport = createTransport([{ body: GOOGLE_BODY_BOTH }]);
    await expect(
      runMeteringProbe({
        provider: 'google-ai-studio',
        model: 'gemini-9.9-imaginary',
        apiKey: 'test-key',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/no free-tier endpoint/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('refuses a provider with no free-tier configuration at all', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    await expect(
      runMeteringProbe({
        provider: 'xai' as ProviderId,
        model: 'grok-fast',
        apiKey: 'test-key',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/No free-tier configuration for provider "xai"/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('refuses a blank key or model before issuing a request', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    for (const target of [
      { provider: 'groq' as ProviderId, model: GROQ_MODEL, apiKey: '   ' },
      { provider: 'groq' as ProviderId, model: '  ', apiKey: 'test-key' },
    ]) {
      await expect(runMeteringProbe({ ...target, fetch: transport.fetch })).rejects.toThrow(
        /must be a non-empty string/,
      );
    }
    expect(transport.calls()).toHaveLength(0);
  });

  it('honours an explicit id and an explicit allowlisted endpoint', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    const outcome = await runMeteringProbe({
      id: 'contender-a',
      provider: 'groq',
      model: GROQ_MODEL,
      apiKey: 'test-key',
      endpoint: GROQ_ENDPOINT,
      fetch: transport.fetch,
    });

    expect(outcome.id).toBe('contender-a');
    expect(transport.calls()[0].url).toBe(GROQ_ENDPOINT);
  });

  it('returns a frozen outcome', async () => {
    const transport = createTransport([{ body: OPENAI_BODY_BOTH }]);
    const outcome = await runMeteringProbe({
      provider: 'groq',
      model: GROQ_MODEL,
      apiKey: 'test-key',
      fetch: transport.fetch,
    });

    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.usage)).toBe(true);
  });
});

describe('probing a set of Deployments (AC1)', () => {
  it('classifies at least one as reports-reasoning and at least one as no-usage-reported', async () => {
    const reporting = createTransport([{ body: OPENAI_BODY_BOTH }]);
    const silent = createTransport([{ body: OPENAI_BODY_NO_USAGE }]);
    const partial = createDropsUnderStructuredOutputTransport();

    const outcomes = await probeDeployments([
      { provider: 'groq', model: GROQ_MODEL, apiKey: 'k', fetch: reporting.fetch },
      { provider: 'cerebras', model: 'llama3.1-8b', apiKey: 'k', fetch: silent.fetch },
      { provider: 'google-ai-studio', model: GOOGLE_MODEL, apiKey: 'k', fetch: partial.fetch },
    ]);

    expect(outcomes.map((outcome) => outcome.result)).toStrictEqual([
      'reports-reasoning',
      'no-usage-reported',
      // The Google target is served by the plain-vs-structured transport, whose
      // structured body is the OpenAI-compatible one -- which carries no
      // `usageMetadata`, so Google's mapping reports nothing. The point of the
      // case is the set, not this entry's shape.
      'no-usage-reported',
    ]);
  });

  it('probes sequentially, so a shared free-tier RPM is not spent all at once', async () => {
    const order: string[] = [];
    const watch = (label: string, body: string): HttpFetch => {
      return () => {
        order.push(label);
        return Promise.resolve({
          status: 200,
          headers: noHeaders(),
          text: () => Promise.resolve(body),
        });
      };
    };

    await probeDeployments([
      { provider: 'groq', model: GROQ_MODEL, apiKey: 'k', fetch: watch('a', OPENAI_BODY_BOTH) },
      {
        provider: 'cerebras',
        model: 'llama3.1-8b',
        apiKey: 'k',
        fetch: watch('b', OPENAI_BODY_BOTH),
      },
    ]);

    expect(order).toStrictEqual(['a', 'b']);
  });

  it('returns a frozen empty list for an empty set', async () => {
    const outcomes = await probeDeployments([]);
    expect(outcomes).toStrictEqual([]);
    expect(Object.isFrozen(outcomes)).toBe(true);
  });
});
