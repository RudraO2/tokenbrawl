import { assertVisitorSuppliedEndpoint } from '../../../../packages/providers/src/byok-direct';
import { discoverModels } from '../../../../packages/providers/src/discovery';
import type { FreeTierConfig } from '../../../../packages/providers/src/free-tier';
import type { HttpFetch } from '../../../../packages/providers/src/http';
import { byokModelOption, byokProvider } from './catalogue';

/**
 * Story 4.7: the Advanced half of the panel -- what a visitor is told before
 * their key moves, and how the picker gets filled from their own account.
 *
 * Everything here is behind one disclosure control. The default view stays
 * exactly what Story 4.6 shipped: pick a provider, pick a model, paste a key. A
 * visitor who wants the simple thing must not have to read about base URLs to
 * find it, and that is a requirement of the story rather than a preference.
 *
 * The module holds no key. Both functions take one and hand it straight to the
 * transport, the same way `client.ts` does -- the credential lives in one
 * closure and this is not it.
 */

/**
 * AC6's answer, in a shape a panel can render without a `try`.
 *
 * A verdict rather than a throw, because this runs on every keystroke in the
 * base-URL field: "not a URL yet" is the normal state of a field someone is
 * halfway through typing, and it is not an error to show in red. The *client*
 * still throws on the same input, which is what makes the guarantee real -- this
 * is the message, `assertVisitorSuppliedEndpoint` is the gate.
 */
export interface OriginVerdict {
  readonly ok: boolean;
  /** The exact origin the key will be sent to. `''` when the URL is not usable. */
  readonly origin: string;
  /** Always displayable: the origin sentence when ok, the refusal when not. */
  readonly message: string;
}

export function originVerdict(baseUrl: string): OriginVerdict {
  if (baseUrl.trim().length === 0) {
    return Object.freeze({ ok: false, origin: '', message: '' });
  }

  try {
    const resolved = assertVisitorSuppliedEndpoint(baseUrl);
    return Object.freeze({
      ok: true,
      origin: resolved.origin,
      // The origin, not the full path, because the origin is the unit a
      // credential is scoped to and the thing the visitor is being asked to
      // agree to. The path is shown too so nothing is hidden.
      message: `Your key will be sent to ${resolved.origin} and to no other origin. Requests go to ${resolved.completions}`,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      origin: '',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Base URLs worth one click, and nothing else.
 *
 * This list is the whole of "an OpenRouter adapter": the wire format is the one
 * `groq.ts` already speaks, so a vendor needs a URL rather than a file. Every
 * entry's preflight was measured -- see `docs/reports/byok-cors-preflight.md` --
 * and no entry carries a quota number, because no dashboard capture exists for
 * these and inventing one is the failure this story was written to correct.
 *
 * A preset fills the field. It is not a mode: the visitor can overwrite it with
 * anything, which is the point of Advanced.
 */
export const ADVANCED_PRESETS: readonly { readonly label: string; readonly baseUrl: string }[] =
  Object.freeze([
    Object.freeze({ label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }),
    Object.freeze({ label: 'xAI', baseUrl: 'https://api.x.ai/v1' }),
    Object.freeze({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }),
    Object.freeze({ label: 'Together', baseUrl: 'https://api.together.xyz/v1' }),
  ]);

export interface ByokDiscoveryConfig {
  /** The picker's provider. Ignored entirely when `baseUrl` is set. */
  readonly provider: string;
  /** Advanced. When non-blank, the models come from this origin instead. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: HttpFetch;
  readonly freeTier?: FreeTierConfig;
}

/**
 * "Show me my models" (AC4).
 *
 * One request, to one origin, with the visitor's key, and the origin is not
 * chosen here: it is derived from the completions endpoint the key was already
 * going to be sent to. That is why there is no hostname in this file.
 *
 * The Advanced branch reuses the model list `assertVisitorSuppliedEndpoint`
 * resolved from the same base URL, so the two cannot disagree about where the
 * visitor pointed.
 */
export async function discoverByokModels(
  config: ByokDiscoveryConfig,
): Promise<readonly string[]> {
  const baseUrl = config.baseUrl.trim();

  if (baseUrl.length > 0) {
    const resolved = assertVisitorSuppliedEndpoint(baseUrl);
    return discoverModels({
      completionEndpoint: resolved.completions,
      family: 'openai',
      apiKey: config.apiKey,
      keyHeader: 'Authorization',
      fetch: config.fetch,
    });
  }

  const option = byokProvider(config.provider, config.freeTier);
  // Any of the provider's own models resolves to the endpoint whose origin the
  // list lives on. Google is the case that makes this non-trivial: each of its
  // models has its own URL, and they all share one origin, which is exactly
  // what `modelListEndpointFor` needs and all it needs.
  const anyModel = option.models[0];
  if (anyModel === undefined) {
    throw new Error(`${option.label} has no endpoint to ask for a model list.`);
  }

  return discoverModels({
    completionEndpoint: anyModel.endpoint,
    family: option.modelListFamily,
    apiKey: config.apiKey,
    keyHeader: option.keyHeader,
    fetch: config.fetch,
  });
}

/**
 * Turns a discovered model id back into a full picker option.
 *
 * A discovered model usually has no free-tier row, so it inherits the
 * provider's defaults with `limitsKnown: false`. A model the provider serves
 * but this build cannot address -- a Google model with no allowlist entry -- is
 * dropped rather than offered, because offering it would put a selection in the
 * picker that fails the moment it is used.
 */
export function discoveredModelOptions(
  providerId: string,
  models: readonly string[],
  config?: FreeTierConfig,
): readonly string[] {
  const usable: string[] = [];
  for (const model of models) {
    try {
      byokModelOption(providerId, model, config);
      usable.push(model);
    } catch {
      continue;
    }
  }
  return Object.freeze(usable);
}
