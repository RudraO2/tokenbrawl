import type { ProviderId } from '@tokenbrawl/contracts';
import type { FreeTierConfig } from '../../../../packages/providers/src/free-tier';
import { assertFreeTierEndpoint, loadFreeTierConfig } from '../../../../packages/providers/src/free-tier';

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
 */

export type ByokAccess = 'browser' | 'cli-only';

export interface ByokModelOption {
  readonly model: string;
  /** The one URL a key for this selection may ever be sent to (AC1). Allowlisted per INV-8. */
  readonly endpoint: string;
}

export interface ByokProviderOption {
  readonly id: ProviderId;
  readonly label: string;
  readonly access: ByokAccess;
  /** The header the adapter puts the key on. Displayed, so a visitor can see what leaves the tab. */
  readonly keyHeader: string;
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
const BROWSER_PROVIDERS: readonly { readonly id: ProviderId; readonly label: string; readonly keyHeader: string }[] = [
  { id: 'groq', label: 'Groq', keyHeader: 'Authorization' },
  { id: 'cerebras', label: 'Cerebras', keyHeader: 'Authorization' },
  { id: 'google-ai-studio', label: 'Google AI Studio', keyHeader: 'x-goog-api-key' },
];

/**
 * Providers in the frozen `ProviderId` enum that this build cannot run in a
 * browser, with the reason a visitor gets to read.
 *
 * OpenRouter's is not a CORS problem and the text says so: its free tier is 50
 * requests a day and `tournament-config.ts` already reserves it for the
 * Metering Probe, so no adapter was ever built for it.
 */
const CLI_ONLY_PROVIDERS: readonly { readonly id: ProviderId; readonly label: string; readonly reason: string }[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    reason:
      'CLI only — no browser adapter in this build. Its free tier is 50 requests a day and is reserved for the Metering Probe.',
  },
  {
    id: 'xai',
    label: 'xAI',
    reason: 'CLI only — no browser adapter in this build, and no free-tier endpoint on the allowlist.',
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

/**
 * The picker's whole contents: browser-capable providers first, CLI-only ones
 * after, every one of them listed. A provider that is simply missing from the
 * list is a provider a visitor will go looking for; AC5 asks for it to be shown
 * and labelled instead.
 */
export function byokCatalogue(config: FreeTierConfig = loadFreeTierConfig()): readonly ByokProviderOption[] {
  const browser = BROWSER_PROVIDERS.filter((entry) => config.providers[entry.id] !== undefined).map(
    (entry) => {
      const providerConfig = config.providers[entry.id];
      const models = Object.keys(providerConfig.models)
        .sort()
        .map((model) => ({
          model,
          endpoint: endpointForModel(entry.id, model, providerConfig.endpoints, config),
        }));
      return Object.freeze({
        id: entry.id,
        label: entry.label,
        access: 'browser' as const,
        keyHeader: entry.keyHeader,
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

/** The endpoint one (provider, model) selection resolves to, or a thrown sentence. */
export function byokEndpoint(
  providerId: string,
  model: string,
  config: FreeTierConfig = loadFreeTierConfig(),
): string {
  const option = byokProvider(providerId, config);
  const entry = option.models.find((candidate) => candidate.model === model);
  if (entry === undefined) {
    throw new Error(
      `${option.label} has no free-tier model "${model}". Available: ${option.models
        .map((candidate) => candidate.model)
        .join(', ')}`,
    );
  }
  return entry.endpoint;
}
