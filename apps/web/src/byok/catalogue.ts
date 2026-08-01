import type { ProviderId } from '@tokenbrawl/contracts';
import type { ModelListFamily } from '../../../../packages/providers/src/discovery';
import type { FreeTierConfig, FreeTierLimits } from '../../../../packages/providers/src/free-tier';
import {
  assertFreeTierEndpoint,
  freeTierLimitsFor,
  loadFreeTierConfig,
} from '../../../../packages/providers/src/free-tier';
import type { MatchFeasibility } from '../../../../packages/providers/src/match-feasibility';
import {
  feasibilityNotice,
  matchFeasibility,
} from '../../../../packages/providers/src/match-feasibility';

/**
 * Story 4.6, AC5: what the picker may offer, and what it must instead label
 * CLI-only.
 *
 * "Verify CORS support per provider before offering it in the picker" is the
 * story's own instruction, and the verification is a CORS preflight -- an
 * `OPTIONS` carrying `Origin`, `Access-Control-Request-Method: POST` and the
 * exact auth header the matching adapter sends. A preflight needs no API key,
 * so every verdict below was measured rather than assumed. Recorded here beside
 * the data it justifies, because a measurement in a commit message is a
 * measurement nobody re-reads.
 *
 * Measured 2026-08-01:
 *
 * | provider          | preflight | access-control-allow-origin |
 * |-------------------|-----------|-----------------------------|
 * | groq              | 204       | `*`                         |
 * | cerebras          | 200       | `*`                         |
 * | google-ai-studio  | 200       | echoes the Origin           |
 * | openrouter        | 204       | `*`                         |
 * | xai               | 200       | `*`                         |
 *
 * So no configured provider is refused by CORS today, and the CLI-only branch
 * is carried by the two `ProviderId`s this build has no adapter for. That is
 * deliberately the *same* verdict rather than a second one: from the picker's
 * side "the endpoint refuses a browser" and "there is no browser adapter for
 * it" are one fact -- it cannot run here, so it must not be offerable here, and
 * the visitor must be told before they paste a key rather than after a request
 * fails. Each option carries its own reason text so the two cases stay
 * distinguishable to a reader.
 *
 * Re-verify when `free-tier.config.json`'s `verifiedOn` moves. A provider that
 * starts refusing cross-origin requests becomes `cli-only` here, and nothing
 * else in the app has to change.
 *
 * ---------------------------------------------------------------------------
 * Story 4.7 added three things to the same structure.
 * ---------------------------------------------------------------------------
 *
 * 1. **Every option carries its quotas and what they imply.** AC2 asks that a
 *    model's RPM and RPD be shown *with it*, and that an unusually long Match be
 *    stated before the visitor starts rather than discovered halfway through.
 *    Both come from `matchFeasibility`, which divides the numbers already in
 *    `free-tier.config.json` -- see `match-feasibility.ts` for the arithmetic
 *    and the report it reproduces.
 *
 * 2. **A model does not have to be on the list.** For every provider except
 *    Google the model travels in the request *body* and the URL is unchanged,
 *    so a name typed by a visitor or returned by discovery resolves to the
 *    provider's existing allowlisted endpoint and touches INV-8 not at all.
 *    `modelInBody` is the property that decides it, and it is read from the
 *    shape of the data rather than keyed on a provider name.
 *
 * 3. **The two CLI-only entries now say where they *are* reachable.** OpenRouter
 *    and xAI are OpenAI-compatible and their preflights pass, so Advanced mode
 *    reaches both with the visitor's own key. Telling someone a thing is
 *    impossible when it is one panel away is worse than not listing it.
 */

export type ByokAccess = 'browser' | 'cli-only';

export interface ByokModelOption {
  readonly model: string;
  /** The one URL a key for this selection may ever be sent to (AC1). Allowlisted per INV-8. */
  readonly endpoint: string;
  /** This model's free-tier quotas, or the provider's defaults when it has none of its own. */
  readonly limits: FreeTierLimits;
  /** What those quotas mean for a Match: can it finish, and roughly how long (AC1, AC2). */
  readonly feasibility: MatchFeasibility;
  /**
   * False when the model has no row in `free-tier.config.json` -- a name the
   * visitor typed, or one discovery returned. The limits are then the
   * provider's defaults, and the picker says so rather than presenting a
   * guess as a measurement.
   */
  readonly limitsKnown: boolean;
}

export interface ByokProviderOption {
  readonly id: ProviderId;
  readonly label: string;
  readonly access: ByokAccess;
  /** The header the adapter puts the key on. Displayed, so a visitor can see what leaves the tab. */
  readonly keyHeader: string;
  /**
   * Whether the model travels in the request body rather than the URL path.
   *
   * True for every OpenAI-compatible provider, false for Google AI Studio,
   * which addresses a model as `/models/<id>:generateContent`. That difference
   * is the whole of why a custom model name is free for one and needs an
   * allowlist entry for the other (INV-8).
   */
  readonly modelInBody: boolean;
  /** Which `GET .../models` shape this provider answers with (AC4). */
  readonly modelListFamily: ModelListFamily;
  readonly models: readonly ByokModelOption[];
  /** Present exactly when `access === 'cli-only'`. Rendered verbatim in the picker. */
  readonly cliOnlyReason: string | null;
}

/**
 * Providers with a browser-capable adapter in this build, in picker order.
 *
 * The models are not listed here: they come from `free-tier.config.json`, which
 * is the file INV-8 makes authoritative. Listing them twice is how a model that
 * was removed from the allowlist stays selectable in the picker.
 */
interface BrowserProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly keyHeader: string;
  readonly modelInBody: boolean;
  readonly modelListFamily: ModelListFamily;
}

const BROWSER_PROVIDERS: readonly BrowserProvider[] = [
  {
    id: 'groq',
    label: 'Groq',
    keyHeader: 'Authorization',
    modelInBody: true,
    modelListFamily: 'openai',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    keyHeader: 'Authorization',
    modelInBody: true,
    modelListFamily: 'openai',
  },
  {
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    keyHeader: 'x-goog-api-key',
    // The model is in the URL path here, so a custom name is a new allowlist
    // entry rather than a different request body.
    modelInBody: false,
    modelListFamily: 'google',
  },
];

/**
 * Providers in the frozen `ProviderId` enum that this picker does not offer,
 * with the reason a visitor gets to read.
 *
 * Story 4.7 changed what these reasons say, and the change matters. Neither is
 * a CORS problem -- both preflights pass, measured today and recorded in
 * `docs/reports/byok-cors-preflight.md` -- and both are OpenAI-compatible, so
 * Advanced mode reaches them with the visitor's own key. What each lacks is a
 * *measured free-tier row*: `docs/reports/byok-provider-limits.md` has no table
 * for either, and inventing quota numbers to fill a dropdown is exactly the
 * failure this whole story exists to correct.
 *
 * So the reason text now names the base URL that works, rather than telling
 * someone a thing is impossible when it is one panel away.
 */
const CLI_ONLY_PROVIDERS: readonly { readonly id: ProviderId; readonly label: string; readonly reason: string }[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    reason:
      'Not in this picker — no measured free-tier row exists for it, and its free tier is reserved for the Metering Probe. Reachable under Advanced with your own key and base URL https://openrouter.ai/api/v1',
  },
  {
    id: 'xai',
    label: 'xAI',
    reason:
      'Not in this picker — no free-tier endpoint on the allowlist. Reachable under Advanced with your own key and base URL https://api.x.ai/v1',
  },
];

/**
 * Resolves the endpoint for one model.
 *
 * Google AI Studio bakes the model into the URL path, so each of its models is
 * its own allowlist entry; the other two providers serve every model from one
 * URL. Matching on `/models/<model>:` rather than on the provider id keeps that
 * a property of the data instead of a special case keyed on a name -- a fourth
 * provider with path-addressed models needs no edit here.
 *
 * Every endpoint returned goes through `assertFreeTierEndpoint` first. It is
 * already true by construction (the candidates come from the allowlist itself),
 * and it is asserted anyway: this is the one function that decides where a
 * visitor's key is sent, and INV-8's check costing nothing is not a reason to
 * skip it.
 */
function endpointForModel(
  providerId: ProviderId,
  model: string,
  endpoints: readonly string[],
  config: FreeTierConfig,
): string {
  const pathAddressed = endpoints.find((url) => url.includes(`/models/${model}:`));
  const endpoint = pathAddressed ?? endpoints[0];
  assertFreeTierEndpoint(providerId, endpoint, config);
  return endpoint;
}

/** Whether this model has a row of its own, or is inheriting the provider defaults. */
function hasOwnLimits(providerId: ProviderId, model: string, config: FreeTierConfig): boolean {
  return config.providers[providerId]?.models[model] !== undefined;
}

function buildModelOption(
  providerId: ProviderId,
  model: string,
  endpoints: readonly string[],
  config: FreeTierConfig,
): ByokModelOption {
  const limits = freeTierLimitsFor(providerId, model, config);
  return Object.freeze({
    model,
    endpoint: endpointForModel(providerId, model, endpoints, config),
    limits,
    feasibility: matchFeasibility(limits),
    limitsKnown: hasOwnLimits(providerId, model, config),
  });
}

/** Thousands separated, with no locale involved: `14400` reads as `14,400` everywhere. */
export function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * What one model reads as in the picker (AC2).
 *
 * RPM and RPD go in the option's own label rather than only in a line beside
 * the `<select>`, because AC2 says the limits are shown *with* the model -- a
 * visitor comparing two models is looking at the open dropdown, not at whatever
 * the currently-selected one happens to have put underneath it. Matches per day
 * follows because it is the number that decides whether a choice is usable at
 * all, and it is the one the raw quotas do not make obvious.
 */
export function modelOptionLabel(option: ByokModelOption): string {
  const { limits, feasibility } = option;
  const quotas = `${groupDigits(limits.requestsPerMinute)} RPM / ${groupDigits(limits.requestsPerDay)} RPD`;
  if (!feasibility.runnable) {
    return `${option.model} — ${quotas} — cannot finish a Match`;
  }
  const known = option.limitsKnown ? '' : ' (provider defaults)';
  return `${option.model} — ${quotas} — ${groupDigits(feasibility.matchesPerDay)} matches/day${known}`;
}

/**
 * The warning line under the picker, or `''` when there is nothing unusual to
 * say. Empty for every ordinary model, which is what keeps it worth reading.
 */
export function modelOptionNotice(option: ByokModelOption): string {
  const measured = feasibilityNotice(option.limits);
  if (option.limitsKnown) {
    return measured;
  }
  // A model nobody measured: the numbers shown are the provider defaults, and
  // saying so is the difference between a fact and a guess presented as one.
  const inherited =
    'No measured free-tier row for this model — the numbers above are the provider defaults.';
  return measured.length === 0 ? inherited : `${inherited} ${measured}`;
}

/**
 * The picker's whole contents: browser-capable providers first, the rest after,
 * every one of them listed. A provider that is simply missing from the list is
 * a provider a visitor will go looking for; AC5 asks for it to be shown and
 * labelled instead.
 */
export function byokCatalogue(config: FreeTierConfig = loadFreeTierConfig()): readonly ByokProviderOption[] {
  const browser = BROWSER_PROVIDERS.filter((entry) => config.providers[entry.id] !== undefined).map(
    (entry) => {
      const providerConfig = config.providers[entry.id];
      const models = Object.keys(providerConfig.models)
        .sort()
        .map((model) => buildModelOption(entry.id, model, providerConfig.endpoints, config))
        // AC1: a model whose daily cap cannot cover one Match is not offered at
        // all. Story 4.7 removed the two such rows from the config, and this is
        // the line that keeps the promise if a future edit puts one back --
        // deleting bad data fixes today, refusing to offer it fixes the next one.
        .filter((option) => option.feasibility.runnable);

      // A provider with an allowlisted endpoint but no *runnable* model is a
      // degenerate configuration: `free-tier.config.json` permits it (only
      // `endpoints` must be non-empty), and offering it would put a selectable
      // provider in the picker with an empty model list behind it, which fails
      // at run time with "has no free-tier model" -- exactly the shape AC5 says
      // must not happen. It is refused here instead, with the reason said out
      // loud rather than left as an empty dropdown for a visitor to interpret.
      if (models.length === 0) {
        return Object.freeze({
          id: entry.id,
          label: entry.label,
          access: 'cli-only' as const,
          keyHeader: entry.keyHeader,
          modelInBody: entry.modelInBody,
          modelListFamily: entry.modelListFamily,
          models: Object.freeze([] as ByokModelOption[]),
          cliOnlyReason:
            'Not offered — free-tier.config.json lists no model for this provider that could finish one Match.',
        });
      }

      return Object.freeze({
        id: entry.id,
        label: entry.label,
        access: 'browser' as const,
        keyHeader: entry.keyHeader,
        modelInBody: entry.modelInBody,
        modelListFamily: entry.modelListFamily,
        models: Object.freeze(models),
        cliOnlyReason: null,
      });
    },
  );

  const cliOnly = CLI_ONLY_PROVIDERS.map((entry) =>
    Object.freeze({
      id: entry.id,
      label: entry.label,
      access: 'cli-only' as const,
      keyHeader: '',
      modelInBody: true,
      modelListFamily: 'openai' as const,
      models: Object.freeze([] as ByokModelOption[]),
      cliOnlyReason: entry.reason,
    }),
  );

  return Object.freeze([...browser, ...cliOnly]);
}

/**
 * One option by id, or a thrown sentence naming what went wrong.
 *
 * A CLI-only provider throws here rather than being silently dropped: this is
 * the function the runner calls, and AC5's "rather than failing at request
 * time" is only true if the refusal happens before a request is built. It is
 * the second gate -- the picker will not let one be selected -- and it exists
 * because the first gate is a UI and this one is not.
 */
export function byokProvider(
  id: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): ByokProviderOption {
  const option = byokCatalogue(config).find((entry) => entry.id === id);
  if (option === undefined) {
    throw new Error(`No such provider: "${id}".`);
  }
  if (option.access === 'cli-only') {
    throw new Error(`${option.label} cannot be run from a browser. ${option.cliOnlyReason ?? ''}`.trim());
  }
  return option;
}

/**
 * One (provider, model) selection resolved to everything the app needs about
 * it, whether or not the model is on any list (AC3).
 *
 * This is where the story's INV-8 reading becomes code, and the split is the
 * whole point:
 *
 * - **The model is in the request body** (Groq, Cerebras, and every
 *   OpenAI-compatible endpoint). The URL does not change, so a name the visitor
 *   typed or discovery returned resolves to the provider's existing allowlisted
 *   endpoint and touches INV-8 not at all. Nothing to decide.
 * - **The model is in the URL path** (Google AI Studio). A custom name would
 *   need a URL no allowlist entry names, so it is refused *here*, with the
 *   reason -- not at request time with a 404, which is exactly the shape AC7
 *   exists to prevent.
 *
 * An off-list model inherits the provider's `defaults`, which are deliberately
 * the tightest published numbers, and `limitsKnown` is false so the picker can
 * say the numbers are inherited rather than measured.
 */
export function byokModelOption(
  providerId: string,
  model: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): ByokModelOption {
  const option = byokProvider(providerId, config);
  const listed = option.models.find((candidate) => candidate.model === model);
  if (listed !== undefined) {
    return listed;
  }

  if (model.trim().length === 0) {
    throw new Error(`Choose a model for ${option.label}, or type one under Advanced.`);
  }

  if (!option.modelInBody) {
    throw new Error(
      `${option.label} puts the model in the URL path, so "${model}" would need its own free-tier allowlist entry (INV-8). Offered: ${option.models
        .map((candidate) => candidate.model)
        .join(', ')}`,
    );
  }

  const endpoints = config.providers[option.id].endpoints;
  return buildModelOption(option.id, model, endpoints, config);
}

/** The endpoint one (provider, model) selection resolves to, or a thrown sentence. */
export function byokEndpoint(
  providerId: string,
  model: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): string {
  return byokModelOption(providerId, model, config).endpoint;
}
