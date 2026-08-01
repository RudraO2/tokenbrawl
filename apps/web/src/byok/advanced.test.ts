import { describe, expect, it } from 'vitest';
import { originOf } from '../../../../packages/providers/src/discovery';
import {
  ADVANCED_PRESETS,
  discoverByokModels,
  discoveredModelOptions,
  originVerdict,
} from './advanced';
import { createFakeTransport } from '../testing/byok-transport';

/**
 * Story 4.7, AC4 and AC6.
 *
 * AC6 is the one that is a security property rather than a convenience: "the
 * exact origin the key will be sent to is shown back to the visitor before the
 * first request, and a plaintext URL is refused outright." Both halves are
 * asserted here, and the refusal is asserted a second time at the client, where
 * it is a throw rather than a message.
 */

const GROQ_ORIGIN = 'https://api.groq.com';

const OPENAI_LIST = JSON.stringify({
  data: [{ id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-20b' }, { id: 'a-brand-new-model' }],
});

const GOOGLE_LIST = JSON.stringify({
  models: [
    { name: 'models/gemma-4-31b' },
    { name: 'models/gemini-2.5-flash' },
    { name: 'models/veo-3' },
  ],
});

describe('the origin a visitor is shown before their key moves (AC6)', () => {
  it('names the origin, and says it is the only one', () => {
    const verdict = originVerdict('https://openrouter.ai/api/v1');
    expect(verdict.ok).toBe(true);
    expect(verdict.origin).toBe('https://openrouter.ai');
    expect(verdict.message).toContain('https://openrouter.ai');
    expect(verdict.message).toContain('no other origin');
    // The full path too, so nothing about where the request goes is hidden.
    expect(verdict.message).toContain('https://openrouter.ai/api/v1/chat/completions');
  });

  it('refuses plaintext, in the message as well as at the client', () => {
    const verdict = originVerdict('http://openrouter.ai/api/v1');
    expect(verdict.ok).toBe(false);
    expect(verdict.origin).toBe('');
    expect(verdict.message).toMatch(/not https/);
    expect(verdict.message).toMatch(/clear text/);
  });

  it('says nothing at all about an empty field', () => {
    // This runs on every keystroke. "Not a URL yet" is the normal state of a
    // field someone is halfway through, and it is not an error to show in red.
    for (const blank of ['', '   ']) {
      const verdict = originVerdict(blank);
      expect(verdict.ok).toBe(false);
      expect(verdict.message).toBe('');
    }
  });

  it('answers a half-typed URL without throwing', () => {
    for (const partial of ['h', 'https:/', 'openrouter.ai']) {
      expect(() => originVerdict(partial)).not.toThrow();
      expect(originVerdict(partial).ok).toBe(false);
    }
  });

  it('distinguishes a port, because a port is part of an origin', () => {
    expect(originVerdict('https://gw.example:8443/v1').origin).toBe('https://gw.example:8443');
    expect(originVerdict('https://gw.example/v1').origin).toBe('https://gw.example');
  });
});

describe('the preset list', () => {
  it('is https only, and carries no invented quota', () => {
    expect(ADVANCED_PRESETS.length).toBeGreaterThan(0);
    for (const preset of ADVANCED_PRESETS) {
      expect(preset.baseUrl.startsWith('https://')).toBe(true);
      expect(originVerdict(preset.baseUrl).ok).toBe(true);
      // A preset is a URL and a name. The moment one carries an RPM it becomes
      // a number nobody measured, which is the failure this story corrects.
      expect(Object.keys(preset).sort()).toStrictEqual(['baseUrl', 'label']);
    }
  });

  it('covers the two providers the picker cannot offer', () => {
    const labels = ADVANCED_PRESETS.map((preset) => preset.label);
    expect(labels).toContain('OpenRouter');
    expect(labels).toContain('xAI');
  });
});

describe('fetching the models a key can use (AC4)', () => {
  it('asks the picked provider, at its own origin and no other', async () => {
    const transport = createFakeTransport({ body: () => OPENAI_LIST });
    const models = await discoverByokModels({
      provider: 'groq',
      baseUrl: '',
      apiKey: 'gsk_visitor',
      fetch: transport.fetch,
    });

    expect(models).toContain('a-brand-new-model');
    expect(transport.calls()).toHaveLength(1);
    expect(originOf(transport.calls()[0].url)).toBe(GROQ_ORIGIN);
    expect(transport.calls()[0].headers.Authorization).toBe('Bearer gsk_visitor');
  });

  it('asks the endpoint the visitor set, ignoring the picker', async () => {
    const transport = createFakeTransport({ body: () => OPENAI_LIST });
    await discoverByokModels({
      // Deliberately left on Groq: a base URL is not an override of the picker,
      // it replaces it. A request to api.groq.com here would be the bug.
      provider: 'groq',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-visitor',
      fetch: transport.fetch,
    });

    expect(transport.calls()).toHaveLength(1);
    expect(transport.calls()[0].url).toBe('https://openrouter.ai/api/v1/models');
    expect(originOf(transport.calls()[0].url)).toBe('https://openrouter.ai');
  });

  it('refuses a plaintext endpoint before any request exists (AC6)', async () => {
    const transport = createFakeTransport({ body: () => OPENAI_LIST });
    await expect(
      discoverByokModels({
        provider: 'groq',
        baseUrl: 'http://openrouter.ai/api/v1',
        apiKey: 'k',
        fetch: transport.fetch,
      }),
    ).rejects.toThrow(/not https/);
    expect(transport.calls()).toHaveLength(0);
  });

  it('reads the Google shape, on the Google header', async () => {
    const transport = createFakeTransport({ body: () => GOOGLE_LIST });
    const models = await discoverByokModels({
      provider: 'google-ai-studio',
      baseUrl: '',
      apiKey: 'AIza_visitor',
      fetch: transport.fetch,
    });

    expect(models).toContain('gemma-4-31b');
    expect(transport.calls()[0].headers['x-goog-api-key']).toBe('AIza_visitor');
    expect(originOf(transport.calls()[0].url)).toBe('https://generativelanguage.googleapis.com');
  });
});

describe('what a discovered list may actually be offered as', () => {
  it('keeps every model a body-addressed provider could be asked for', () => {
    // Groq puts the model in the request body, so anything the provider named
    // is usable with no allowlist change at all.
    expect(
      discoveredModelOptions('groq', ['llama-3.1-8b-instant', 'a-brand-new-model']),
    ).toStrictEqual(['llama-3.1-8b-instant', 'a-brand-new-model']);
  });

  it('drops a Google model this build has no allowlisted URL for', () => {
    // The provider will happily list `gemini-2.5-flash` and `veo-3`. Neither
    // has a free-tier endpoint here, and offering one would put a selection in
    // the picker that fails the moment it is used -- the shape AC5 exists to
    // prevent, arriving by a new route.
    expect(
      discoveredModelOptions('google-ai-studio', ['gemma-4-31b', 'gemini-2.5-flash', 'veo-3']),
    ).toStrictEqual(['gemma-4-31b']);
  });

  it('drops everything for a provider that cannot run here at all', () => {
    expect(discoveredModelOptions('openrouter', ['anything'])).toStrictEqual([]);
  });
});
