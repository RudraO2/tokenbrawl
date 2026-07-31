import type { Agent, Decision, Prompt, ProviderId } from '@tokenbrawl/contracts';
import { parseAction } from './action-grammar';
import { assemblePrompt } from './scaffold';
import { maxTokensFor } from './token-bank';

/**
 * Story 3.1: the Deployment -- an `Agent` whose Decision comes from a model
 * over HTTP -- and the port it delegates that call to.
 *
 * The port lives here, in `packages/core`, and not in `packages/providers`.
 * That is forced rather than chosen: AD-1 (machine-enforced in
 * `eslint.config.js`) forbids core from importing an adapter package, so the
 * consumer owns the interface and each adapter implements it. Nothing in this
 * file does I/O; `ProviderClient` is injected, which is also what lets the
 * whole Deployment path be tested without a network.
 *
 * AD-6 is the division of labour: this file reports whatever usage the
 * provider reported, verbatim, and performs no arithmetic on it whatsoever.
 * `runMatch` and `debitTokenBank` own the Token Bank. A `null` count means the
 * provider reported nothing and is passed through as `null` -- collapsing it to
 * `0` would hand an unmetered Deployment an unlimited budget while the log
 * still looked well-formed (INV-5).
 */

/**
 * One call's request body, in provider-neutral terms. An adapter maps this
 * onto its own wire format and adds nothing to it: `system` and `user` arrive
 * already assembled by core, and there is deliberately no field an adapter
 * could use to rebuild or amend a prompt (INV-7, AD-7).
 */
export interface ProviderRequest {
  readonly system: string;
  readonly user: string;
  /**
   * Present only in Reflex Mode, where it is `REFLEX_MAX_TOKENS`. `undefined`
   * otherwise: no cap at all, and never an effort or budget parameter standing
   * in for one (INV-4 -- thinking is metered, never set).
   */
  readonly maxTokens: number | undefined;
}

/** Raw counts as the provider reported them. `null` is "not reported", never "zero". */
export interface ProviderUsage {
  readonly tokensSpent: number | null;
  readonly reasoningTokens: number | null;
  /**
   * Cached-prompt tokens this call served from the provider's own prompt
   * cache, when the provider reports cache signal at all (Story 3.5, AD-11).
   * Absent or `null` both mean "no cache signal" -- never coerced to `0`,
   * which would falsely claim a reported 100% cache miss.
   */
  readonly cachedTokens?: number | null;
}

export interface ProviderResponse {
  /** The completion text, verbatim. Logged as `rawResponse` whether or not it parses. */
  readonly text: string;
  readonly usage: ProviderUsage;
  readonly reasoning?: string | null;
  /**
   * Per-call identity overrides (INV-6). Omitted means "the client's own",
   * which is the normal case; an adapter that rerouted mid-Match sets them so
   * the log records what actually served the call rather than what was
   * configured.
   */
  readonly provider?: string;
  readonly endpoint?: string;
}

/**
 * The provider port. Stateless per call by contract (AD-9): backoff, quota
 * bookkeeping, and retry policy belong to the runner, never here.
 */
export interface ProviderClient {
  readonly provider: ProviderId;
  readonly endpoint: string;
  readonly model: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/**
 * A Deployment's `Decision`, widened with the one field the frozen `Decision`
 * shape has no room for (Story 3.5). `cachedTokens` never reaches a Command
 * Log entry -- the schema is frozen and untouched -- it exists purely so
 * `runMatch` can exclude cached tokens from the Token Bank debit (AC4/AC5)
 * without core reaching back into a `ProviderResponse` it no longer has.
 */
export interface DeploymentDecision extends Decision {
  readonly cachedTokens: number | null;
}

export interface DeploymentConfig {
  readonly client: ProviderClient;
  /**
   * Overrides the Agent id. Defaults to `provider:model`, the Command Log
   * schema's stated convention for a Deployment.
   */
  readonly id?: string;
}

/** Rejects a blank field at construction rather than emitting a Command Log that fails schema validation an hour into a tournament. */
function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`createDeployment: ${field} must be a non-empty string.`);
  }
}

/**
 * Builds a Deployment.
 *
 * `observe` is `assemblePrompt` itself, not a wrapper around it: a wrapper is
 * precisely where a per-Deployment prompt tweak would eventually be added, and
 * there is no such seam here. Every Deployment built by this function therefore
 * produces the same Scaffold for the same Reflex-Mode state, byte for byte,
 * because they all call the same function with the same arguments.
 *
 * `decide` issues exactly one `complete()` call and never retries: a response
 * that does not parse resolves as `action: null`, which `runMatch` records as
 * the Fallback Action with `parseFailure: true` (Story 1.6). Re-asking would
 * make a Match's outcome depend on how many attempts a model happened to need,
 * which is the confound INV-1 forbids.
 */
export function createDeployment(config: DeploymentConfig): Agent {
  const { client } = config;
  assertNonBlank(client.endpoint, 'client.endpoint');
  assertNonBlank(client.model, 'client.model');

  const id = config.id ?? `${client.provider}:${client.model}`;
  assertNonBlank(id, 'id');

  return {
    id,
    kind: 'deployment',

    observe: assemblePrompt,

    async decide(prompt: Prompt): Promise<DeploymentDecision> {
      const response = await client.complete({
        system: prompt.system,
        user: prompt.user,
        maxTokens: maxTokensFor(prompt),
      });

      return {
        action: parseAction(response.text),
        tokensSpent: response.usage.tokensSpent,
        reasoningTokens: response.usage.reasoningTokens,
        reasoning: response.reasoning ?? null,
        rawResponse: response.text,
        provider: response.provider ?? client.provider,
        endpoint: response.endpoint ?? client.endpoint,
        cachedTokens: response.usage.cachedTokens ?? null,
      };
    },
  };
}
