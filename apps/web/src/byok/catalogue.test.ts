import { describe, expect, it } from 'vitest';
import { loadFreeTierConfig } from '../../../../packages/providers/src/free-tier';
import { byokCatalogue, byokEndpoint, byokProvider } from './catalogue';

/**
 * Story 4.6 AC5: "a provider that does not permit direct browser calls is
 * listed as CLI-only rather than failing at request time."
 *
 * Two halves, and both are tested: the picker *lists* it, and the runner
 * *refuses* it before a request exists. A picker that merely hid it would
 * satisfy neither -- a visitor would go looking for the provider, and any code
 * path that got past the UI would still make the call.
 */

describe('the picker offers only what a browser can reach (AC5)', () => {
  it('lists every provider, browser-capable or not', () => {
    const ids = byokCatalogue().map((option) => option.id);
    expect(ids).toStrictEqual(['groq', 'cerebras', 'google-ai-studio', 'openrouter', 'xai']);
  });

  it('marks the providers with no browser adapter CLI-only, with a reason a visitor can read', () => {
    for (const option of byokCatalogue().filter((entry) => entry.access === 'cli-only')) {
      expect(option.cliOnlyReason).toMatch(/CLI only/);
      expect(option.models).toStrictEqual([]);
    }
    expect(byokCatalogue().filter((option) => option.access === 'cli-only').map((option) => option.id)).toStrictEqual([
      'openrouter',
      'xai',
    ]);
  });

  it('refuses a CLI-only provider before any request is built', () => {
    // The whole of "rather than failing at request time": this throws during
    // construction, with no endpoint resolved and no transport touched.
    expect(() => byokProvider('openrouter')).toThrow(/cannot be run from a browser/);
    expect(() => byokProvider('xai')).toThrow(/cannot be run from a browser/);
  });

  it('refuses a provider that is not in the catalogue at all', () => {
    expect(() => byokProvider('some-other-provider')).toThrow(/No such provider/);
  });

  it('gives every browser provider at least one model and a named key header', () => {
    for (const option of byokCatalogue().filter((entry) => entry.access === 'browser')) {
      expect(option.models.length).toBeGreaterThan(0);
      expect(option.keyHeader.length).toBeGreaterThan(0);
      expect(option.cliOnlyReason).toBeNull();
    }
  });
});

describe('every offered endpoint is on the free-tier allowlist (INV-8)', () => {
  it('resolves each model to an allowlisted URL and to nothing else', () => {
    const config = loadFreeTierConfig();
    for (const option of byokCatalogue().filter((entry) => entry.access === 'browser')) {
      const allowed = config.providers[option.id].endpoints;
      for (const model of option.models) {
        expect(allowed).toContain(model.endpoint);
        expect(byokEndpoint(option.id, model.model)).toBe(model.endpoint);
      }
    }
  });

  it('gives each path-addressed Google model its own endpoint', () => {
    // Google AI Studio bakes the model into the URL, so two models must not
    // resolve to one endpoint -- that would send a gemini-2.5-pro selection to
    // the flash endpoint and record a model that never ran.
    const google = byokCatalogue().find((option) => option.id === 'google-ai-studio');
    const endpoints = new Set(google?.models.map((model) => model.endpoint));
    expect(endpoints.size).toBe(google?.models.length);
    for (const model of google?.models ?? []) {
      expect(model.endpoint).toContain(`/models/${model.model}:`);
    }
  });

  it('refuses a model that is not on the allowlist, naming what is', () => {
    expect(() => byokEndpoint('groq', 'llama-3.3-70b-versatile')).toThrow(/has no free-tier model/);
  });

  it('refuses a provider that has an endpoint but no listed model', () => {
    // `free-tier.config.json` permits `models: {}` -- only `endpoints` must be
    // non-empty -- so this configuration is reachable by editing one file. The
    // picker must not offer a provider it cannot resolve a model for; the
    // failure belongs before the key is pasted, not at request time (AC5).
    const config = loadFreeTierConfig();
    const modelless = loadFreeTierConfig({
      verifiedOn: '2026-08-01',
      providers: {
        groq: { ...JSON.parse(JSON.stringify(config.providers.groq)) as object, models: {} },
      },
    });
    const groq = byokCatalogue(modelless).find((option) => option.id === 'groq');
    expect(groq?.access).toBe('cli-only');
    expect(groq?.cliOnlyReason).toMatch(/no free-tier model/);
    expect(() => byokProvider('groq', modelless)).toThrow(/cannot be run from a browser/);
  });

  it('drops a provider whose free-tier entry has been removed rather than guessing an endpoint', () => {
    // Editing `free-tier.config.json` is how a provider is retired (INV-8 makes
    // that file authoritative). The picker must follow it, not a hard-coded list.
    const withoutGroq = loadFreeTierConfig({
      verifiedOn: '2026-08-01',
      providers: {
        cerebras: JSON.parse(JSON.stringify(loadFreeTierConfig().providers.cerebras)) as unknown,
      },
    });
    expect(byokCatalogue(withoutGroq).map((option) => option.id)).toStrictEqual([
      'cerebras',
      'openrouter',
      'xai',
    ]);
    expect(() => byokProvider('groq', withoutGroq)).toThrow(/No such provider/);
  });
});
