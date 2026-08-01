import { describe, expect, it } from 'vitest';
import { loadFreeTierConfig } from '../../../../packages/providers/src/free-tier';
import {
  byokCatalogue,
  byokEndpoint,
  byokModelOption,
  byokProvider,
  groupDigits,
  modelOptionLabel,
  modelOptionNotice,
  type ByokModelOption,
} from './catalogue';

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

  it('marks the unoffered providers with a reason, and names where they DO work (4.7)', () => {
    for (const option of byokCatalogue().filter((entry) => entry.access === 'cli-only')) {
      expect(option.cliOnlyReason).toMatch(/Not in this picker/);
      // Story 4.7's change to this text, and it is the substantive half:
      // neither is refused by CORS and both are OpenAI-compatible, so Advanced
      // reaches them. Telling someone a thing is impossible when it is one
      // panel away is worse than not listing it at all.
      expect(option.cliOnlyReason).toMatch(/Advanced/);
      expect(option.cliOnlyReason).toMatch(/https:\/\//);
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

  it('resolves an off-list model to the provider existing endpoint, for a body-addressed provider (4.7, AC3)', () => {
    // Story 4.6 refused this outright. Story 4.7 does not, and the reason is
    // an invariant one rather than a convenience: for Groq the model travels
    // in the request *body* and the URL is unchanged, so an unlisted name
    // needs no new allowlist entry and touches INV-8 not at all.
    const option = byokModelOption('groq', 'some-model-nobody-listed');
    expect(option.endpoint).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(option.limitsKnown).toBe(false);
    // Inheriting the provider defaults, which are deliberately the tightest
    // published numbers rather than the workhorse model's allowance.
    expect(option.limits).toStrictEqual(loadFreeTierConfig().providers.groq.defaults);
  });

  it('refuses an off-list model where the model is in the URL path (4.7, INV-8)', () => {
    // Google is the case the split exists for: a custom name here would need a
    // URL no allowlist entry names, so it is refused before a request is built
    // rather than discovered as a 404 halfway through a Match.
    expect(() => byokModelOption('google-ai-studio', 'gemini-nobody-allowlisted')).toThrow(
      /would need its own free-tier allowlist entry/,
    );
    expect(() => byokEndpoint('google-ai-studio', 'gemini-nobody-allowlisted')).toThrow(/INV-8/);
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
    expect(groq?.cliOnlyReason).toMatch(/lists no model for this provider/);
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

/**
 * Story 4.7, AC1 and AC2. The picker's data, measured against the report the
 * story is built on rather than against itself.
 */
describe('every offered model exists and can finish a Match (4.7, AC1)', () => {
  /**
   * Transcribed by hand from `docs/reports/byok-provider-limits.md`, which is a
   * capture of the project owner's dashboards. This list is the *contract*: a
   * model in the picker that is not here is a model nobody measured, which is
   * exactly the failure Story 4.6 shipped and this story exists to correct.
   */
  const MODELS_IN_THE_REPORT: ReadonlySet<string> = new Set([
    // Groq
    'llama-3.1-8b-instant',
    'llama-3.3-70b-versatile',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'openai/gpt-oss-safeguard-20b',
    'qwen/qwen3.6-27b',
    'groq/compound',
    'groq/compound-mini',
    // Google AI Studio
    'gemma-4-31b',
    'gemma-4-26b',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    // Cerebras
    'gpt-oss-120b',
    'zai-glm-4.7',
  ]);

  it('offers only models the report has a row for', () => {
    const offered = byokCatalogue().flatMap((option) => option.models.map((model) => model.model));
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((model) => !MODELS_IN_THE_REPORT.has(model))).toStrictEqual([]);
  });

  it('offers the two Gemma rows Story 4.6 left out, which are the best free option anywhere', () => {
    const google = byokCatalogue().find((option) => option.id === 'google-ai-studio');
    const models = (google?.models ?? []).map((model) => model.model);
    expect(models).toContain('gemma-4-31b');
    expect(models).toContain('gemma-4-26b');
  });

  it('offers neither model that cannot complete one Match', () => {
    // The whole finding. `gemini-2.5-flash` was 4.6's default Google option and
    // has a 20-request daily cap; `gemini-2.5-pro` has no free quota at all.
    const offered = byokCatalogue().flatMap((option) => option.models.map((model) => model.model));
    expect(offered).not.toContain('gemini-2.5-flash');
    expect(offered).not.toContain('gemini-2.5-pro');
  });

  it('offers nothing whose daily cap cannot cover a Match, whatever the config says', () => {
    // Deleting two bad rows fixed today; this is the line that keeps the
    // promise when someone adds a third. Every offered option, by arithmetic
    // rather than by the model's name.
    for (const provider of byokCatalogue()) {
      for (const model of provider.models) {
        expect(model.feasibility.runnable).toBe(true);
        expect(model.feasibility.matchesPerDay).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('refuses an unrunnable model even when the config offers one', () => {
    const config = loadFreeTierConfig();
    const withABadRow = loadFreeTierConfig({
      verifiedOn: '2026-08-01',
      providers: {
        groq: {
          ...(JSON.parse(JSON.stringify(config.providers.groq)) as object),
          models: {
            // 20 requests a day: gemini-2.5-flash's shape, on a provider whose
            // URL does not name the model, so nothing else refuses it first.
            'a-capped-model': { requestsPerMinute: 30, requestsPerDay: 20, tokensPerMinute: 6000 },
            'llama-3.1-8b-instant': {
              requestsPerMinute: 30,
              requestsPerDay: 14_400,
              tokensPerMinute: 6000,
            },
          },
        },
      },
    });
    const groq = byokCatalogue(withABadRow).find((option) => option.id === 'groq');
    expect(groq?.models.map((model) => model.model)).toStrictEqual(['llama-3.1-8b-instant']);
  });
});

describe('what a visitor is told about a model before choosing it (4.7, AC2)', () => {
  it('puts RPM and RPD in the option label itself', () => {
    const groq = byokCatalogue().find((option) => option.id === 'groq');
    const eightB = groq?.models.find((model) => model.model === 'llama-3.1-8b-instant');
    expect(eightB).toBeDefined();
    const label = modelOptionLabel(eightB as ByokModelOption);
    expect(label).toContain('llama-3.1-8b-instant');
    expect(label).toContain('30 RPM');
    expect(label).toContain('14,400 RPD');
    expect(label).toContain('240 matches/day');
  });

  it('states an unusually long Match before the visitor starts, not after', () => {
    // Cerebras is 5 RPM, so a sixty-call Match takes a minimum of twelve
    // minutes. The report states that number explicitly and the picker must
    // too -- 4.6 let a visitor discover it halfway through.
    const cerebras = byokCatalogue().find((option) => option.id === 'cerebras');
    const notice = modelOptionNotice(cerebras?.models[0] as ByokModelOption);
    expect(notice).toContain('12 minutes');
    expect(notice).toContain('5 requests a minute');
  });

  it('says nothing about a model with nothing unusual to say', () => {
    const google = byokCatalogue().find((option) => option.id === 'google-ai-studio');
    const gemma = google?.models.find((model) => model.model === 'gemma-4-31b');
    expect(modelOptionNotice(gemma as ByokModelOption)).toBe('');
  });

  it('marks an off-list model as inheriting the provider defaults, rather than presenting a guess', () => {
    const custom = byokModelOption('groq', 'a-model-from-discovery');
    expect(custom.limitsKnown).toBe(false);
    expect(modelOptionLabel(custom)).toContain('provider defaults');
    expect(modelOptionNotice(custom)).toContain('No measured free-tier row');
  });

  it('groups digits with no locale involved, so the label reads the same everywhere', () => {
    expect(groupDigits(14_400)).toBe('14,400');
    expect(groupDigits(500)).toBe('500');
    expect(groupDigits(1_000_000)).toBe('1,000,000');
    expect(groupDigits(0)).toBe('0');
  });
});
