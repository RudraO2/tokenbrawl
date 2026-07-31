import type { MeteringProbeResult, ProviderId } from '@tokenbrawl/contracts';
import type { ProviderUsage } from '../../core/src/deployment';
import type { FreeTierConfig } from './free-tier';
import { assertFreeTierEndpoint, freeTierProvider, loadFreeTierConfig } from './free-tier';
import type { HttpFetch } from './http';
import { defaultHttpFetch } from './http';

/**
 * Story 3.4: the Metering Probe -- INV-5's producer.
 *
 * `MeteringProbeResult` and `DeploymentIdentity.meteringProbe` have been in the
 * frozen contracts since Story 1.1 with nothing to fill them in. This file
 * fills them in, and `track.ts` acts on what it finds.
 *
 * Why the probe does not go through `ProviderClient.complete()`: the failure
 * the story is looking for only appears when a task that provokes deliberation
 * is combined with a structured-output directive, and `ProviderRequest` carries
 * `system`/`user`/`maxTokens` and deliberately nothing else. Widening it so an
 * adapter could be told "and also ask for JSON" would put a per-call knob on
 * the one path INV-7 exists to keep uniform across every Deployment. So the
 * probe shapes its own request over the same injected `HttpFetch` port the
 * adapters use, and the Match path stays structurally incapable of asking for
 * structured output.
 *
 * INV-4 applies here as hard as anywhere: no effort, thinking-level or budget
 * parameter is sent, and there is no output cap either -- capping the probe
 * would truncate exactly the deliberation it is trying to measure.
 *
 * AD-6/INV-5: every count is read raw and is `null` when the provider reported
 * nothing. A `null` is never coerced to `0`; that coercion is the specific bug
 * this whole invariant exists to prevent.
 */

/**
 * Two wire families, not five providers -- the same split the adapters already
 * make. A sixth provider on either shape needs no edit here.
 */
export type ProbeWireFamily = 'openai-compatible' | 'google-generative';

/** Enough of a failing body to diagnose it, never enough to flood a log. */
const BODY_EXCERPT_LIMIT = 256;

const GOOGLE_FAMILY_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['google-ai-studio']);

/**
 * Everything that is not Google's `generateContent` speaks the OpenAI-compatible
 * chat-completions shape (`groq`, `cerebras`, `openrouter`, `xai`, `byok`), so
 * that is the default rather than an enumerated list -- a provider added to
 * `ProviderId` gets the majority shape instead of an unhandled-case throw.
 */
export function probeWireFamilyFor(provider: ProviderId): ProbeWireFamily {
  return GOOGLE_FAMILY_PROVIDERS.has(provider) ? 'google-generative' : 'openai-compatible';
}

/**
 * The probe task. It has to provoke deliberation -- a model that answers
 * without deliberating reports no separate count and would be classified the
 * same way as one that hides it -- while still being cheap and stable enough to
 * run once per Deployment at startup.
 *
 * It is deliberately not a Tokenbrawl Action prompt. The probe measures the
 * provider's reporting honesty, not the model's play, and reusing the game
 * prompt here would make INV-7's "identical across Deployments" claim depend on
 * a file that is allowed to change for probe reasons.
 */
export const PROBE_SYSTEM_PROMPT =
  'You are a metering probe. Work the problem through step by step before you answer, ' +
  'then reply with JSON matching the schema you were given and nothing else.';

export const PROBE_USER_PROMPT =
  'A fighter starts at 100 health. It takes three hits of 17 damage each, blocks one hit ' +
  'that would have done 9, then recovers 12 health. Work out the health remaining, and put ' +
  'your step-by-step working in the "workings" field and the final number in "answer".';

/**
 * The response schema, in both dialects.
 *
 * The field names are `workings` and `answer` on purpose. `audit-invariants.sh`
 * INV-4 greps every shipped `.ts` under `packages/` for the quoted token that
 * names a thinking parameter, comments included -- naming a schema field after
 * it would fail the audit while sending nothing of the kind. Two harmless words
 * cost nothing and keep the check honest for the cases it is actually for.
 */
const OPENAI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    workings: { type: 'string' },
    answer: { type: 'integer' },
  },
  required: ['workings', 'answer'],
  additionalProperties: false,
};

/**
 * Google's `responseSchema` is an OpenAPI-subset Schema, not JSON Schema: the
 * type names are the proto enum's (upper case) and `additionalProperties` is
 * not part of it.
 */
const GOOGLE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    workings: { type: 'STRING' },
    answer: { type: 'INTEGER' },
  },
  required: ['workings', 'answer'],
};

interface OpenAiProbeUsage {
  readonly completion_tokens?: unknown;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown } | null;
}

interface OpenAiProbeBody {
  readonly usage?: OpenAiProbeUsage | null;
}

interface GoogleProbeUsageMetadata {
  readonly candidatesTokenCount?: unknown;
  readonly thoughtsTokenCount?: unknown;
}

interface GoogleProbeBody {
  readonly usageMetadata?: GoogleProbeUsageMetadata | null;
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`runMeteringProbe: ${field} must be a non-empty string.`);
  }
}

function excerpt(bodyText: string): string {
  return bodyText.length > BODY_EXCERPT_LIMIT
    ? `${bodyText.slice(0, BODY_EXCERPT_LIMIT)}...`
    : bodyText;
}

/** A reported count, or `null` when the provider did not report a usable one (INV-5). */
function reportedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * The exact JSON sent on the wire.
 *
 * Every probe request carries a structured-output directive, because the
 * combination is the whole point: a Deployment that reports its deliberation
 * on a plain call and drops it under structured output is precisely what the
 * story asks to be caught, and a probe that issued the plain call would
 * classify that Deployment as fully honest.
 *
 * No effort, thinking-level or budget key, and no output cap of any kind
 * (INV-4).
 */
export function probeRequestBody(provider: ProviderId, model: string): string {
  if (probeWireFamilyFor(provider) === 'google-generative') {
    return JSON.stringify({
      systemInstruction: { parts: [{ text: PROBE_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: PROBE_USER_PROMPT }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GOOGLE_RESPONSE_SCHEMA,
      },
    });
  }

  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: PROBE_SYSTEM_PROMPT },
      { role: 'user', content: PROBE_USER_PROMPT },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'metering_probe',
        strict: true,
        schema: OPENAI_RESPONSE_SCHEMA,
      },
    },
  });
}

/**
 * Provider body text -> raw usage. Pure, so every classification case is
 * testable from a recorded fixture with no network.
 *
 * Deliberately not `mapGroqResponse`/`mapGoogleResponse`: those throw when a
 * body carries no completion, which is right for a Decision Point and wrong
 * here. A body whose completion is missing but whose usage block is intact is
 * still a perfectly good answer to the only question the probe asks, and
 * throwing on it would report a metering failure the provider did not commit.
 */
export function mapProbeUsage(provider: ProviderId, bodyText: string): ProviderUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Metering probe: ${provider} returned a body that is not JSON: ${excerpt(bodyText)}`);
  }

  // `Array.isArray` matters more here than it does in the adapters. There, an
  // array body falls through to a "no choices" throw a line later; here there
  // is no such downstream check, so an array would read as an object with no
  // usage block and be published as a metering failure the provider never
  // committed.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Metering probe: ${provider} returned a body that is not an object: ${excerpt(bodyText)}`,
    );
  }

  if (probeWireFamilyFor(provider) === 'google-generative') {
    const body = parsed as GoogleProbeBody;
    return {
      tokensSpent: reportedCount(body.usageMetadata?.candidatesTokenCount),
      reasoningTokens: reportedCount(body.usageMetadata?.thoughtsTokenCount),
    };
  }

  const body = parsed as OpenAiProbeBody;
  return {
    tokensSpent: reportedCount(body.usage?.completion_tokens),
    reasoningTokens: reportedCount(body.usage?.completion_tokens_details?.reasoning_tokens),
  };
}

/**
 * The classification, and the only place the three frozen values are produced.
 *
 * `tokensSpent === null` is checked first and wins even when a deliberation
 * count is present: the Token Bank debits by completion tokens, so a
 * Deployment that did not report one cannot be metered at all, and calling
 * that `reports-completion-only` would name it after the one number it did not
 * report.
 *
 * A reported `0` counts as reported. The field being present is the honesty
 * this probe can actually observe; a provider that always reports zero is
 * indistinguishable from one whose model never deliberates, and inventing a
 * fourth answer for that would need the frozen contract widened.
 *
 * The classification is conservative by construction: a plain instruct model
 * that genuinely does not deliberate reports no separate count and lands on
 * `reports-completion-only`, hence the Reflex Track. That is the safe
 * direction -- the contract offers exactly one value that reaches the main
 * leaderboard, and guessing which silence is innocent is not something a
 * usage block can support.
 */
export function classifyProbeUsage(usage: ProviderUsage): MeteringProbeResult {
  if (usage.tokensSpent === null) {
    return 'no-usage-reported';
  }
  return usage.reasoningTokens === null ? 'reports-completion-only' : 'reports-reasoning';
}

export interface MeteringProbeTarget {
  /** Defaults to `provider:model`, the Command Log's stated convention for a Deployment. */
  readonly id?: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly apiKey: string;
  /** Defaults to the provider's allowlisted free-tier endpoint for this model. */
  readonly endpoint?: string;
  readonly fetch?: HttpFetch;
  /** Overridable for tests. Production reads the committed config file. */
  readonly freeTier?: FreeTierConfig;
}

export interface MeteringProbeOutcome {
  readonly id: string;
  readonly provider: ProviderId;
  readonly endpoint: string;
  readonly model: string;
  readonly result: MeteringProbeResult;
  /** The raw counts the classification was made from, kept so a published exclusion can show its evidence. */
  readonly usage: ProviderUsage;
}

/**
 * Resolves the endpoint the probe will call, and refuses one that is not on the
 * free-tier allowlist (INV-8). Google bakes the model into the URL path, so the
 * default is the allowlist entry naming this model; every other family has a
 * single endpoint per provider.
 */
function resolveProbeEndpoint(target: MeteringProbeTarget, freeTier: FreeTierConfig): string {
  const providerConfig = freeTierProvider(target.provider, freeTier);
  const discovered =
    probeWireFamilyFor(target.provider) === 'google-generative'
      ? providerConfig.endpoints.find((url) => url.includes(`/models/${target.model}:`))
      : providerConfig.endpoints[0];
  const requested = target.endpoint ?? discovered;
  if (requested === undefined) {
    throw new Error(
      `runMeteringProbe: no free-tier endpoint for provider "${target.provider}" model "${target.model}". ` +
        `Add one to free-tier.config.json before probing it (INV-8).`,
    );
  }
  assertFreeTierEndpoint(target.provider, requested, freeTier);
  return requested;
}

function probeHeaders(provider: ProviderId, apiKey: string): Readonly<Record<string, string>> {
  // Google's key rides on a header rather than the `?key=` query form its docs
  // often show, for the same reason `google.ts` does it: the endpoint is
  // written to every Command Log entry (INV-6), and a query-string key would
  // put the credential on disk in every log that Deployment ever produced.
  return probeWireFamilyFor(provider) === 'google-generative'
    ? { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

/**
 * Probes one Deployment: exactly one HTTP call, combining a task that provokes
 * deliberation with a structured-output directive.
 *
 * Any non-2xx **throws**, including a 429. That is the opposite of what the
 * adapters do mid-Match, and deliberately so: a rate-limited body reports no
 * usage, so absorbing it here would classify a perfectly honest Deployment as
 * `no-usage-reported` and strand it on the Reflex Track for the rest of the
 * tournament on the strength of a transient quota blip. A probe that cannot
 * complete has no answer, and saying so loudly is the only honest option.
 */
export async function runMeteringProbe(
  target: MeteringProbeTarget,
): Promise<MeteringProbeOutcome> {
  const { provider, model, apiKey } = target;

  assertNonBlank(apiKey, 'apiKey');
  assertNonBlank(model, 'model');

  // Routed through the loader even when supplied, so an injected config is
  // validated exactly as the committed one is (INV-8).
  const freeTier = loadFreeTierConfig(target.freeTier);
  const endpoint = resolveProbeEndpoint(target, freeTier);
  const httpFetch = target.fetch ?? defaultHttpFetch();

  const response = await httpFetch(endpoint, {
    method: 'POST',
    headers: probeHeaders(provider, apiKey),
    body: probeRequestBody(provider, model),
  });

  const bodyText = await response.text();

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Metering probe of ${provider} model "${model}" at ${endpoint} failed with status ${response.status}: ${excerpt(bodyText)}. ` +
        `A probe that did not complete is not a classification.`,
    );
  }

  const usage = mapProbeUsage(provider, bodyText);

  return Object.freeze({
    id: target.id ?? `${provider}:${model}`,
    provider,
    endpoint,
    model,
    result: classifyProbeUsage(usage),
    usage: Object.freeze({ ...usage }),
  });
}

/**
 * Probes a set of Deployments, one after another rather than concurrently.
 *
 * Free-tier requests-per-minute allowances are small and several Deployments
 * can share a provider, so a concurrent fan-out is the shape most likely to
 * rate-limit the probe itself -- and a rate-limited probe throws, which would
 * turn a startup check into a startup failure.
 */
export async function probeDeployments(
  targets: readonly MeteringProbeTarget[],
): Promise<readonly MeteringProbeOutcome[]> {
  const outcomes: MeteringProbeOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await runMeteringProbe(target));
  }
  return Object.freeze(outcomes);
}
