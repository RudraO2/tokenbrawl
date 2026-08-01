import type { ProviderRequest, ProviderResponse } from '../../core/src/deployment';

/**
 * Story 4.7: the OpenAI-compatible chat-completions wire format, in one place.
 *
 * It was already in two -- `groq.ts` and `cerebras.ts` carried byte-identical
 * request builders and response mappers differing only in the provider name in
 * their error prose -- and Story 4.7 needs a third for the visitor-supplied
 * endpoint, which may be OpenRouter, xAI, OpenAI, Together, Fireworks,
 * DeepInfra or a local llama.cpp server. Three copies of a mapping that decides
 * what a Token Bank is debited is two too many: `cachedTokens` was added by
 * Story 3.5 and had to be added twice, and the INV-4 guard on `max_tokens`
 * likewise.
 *
 * The `label` parameter exists only so a thrown sentence names the thing the
 * visitor actually configured. It is not a behaviour switch and there is
 * nothing keyed on it.
 */

/** Enough of a failing body to diagnose it, never enough to flood a log. */
const BODY_EXCERPT_LIMIT = 256;

interface OpenAiUsage {
  readonly completion_tokens?: unknown;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: unknown } | null;
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } | null;
}

interface OpenAiMessage {
  readonly content?: string | null;
  readonly reasoning?: string | null;
}

interface OpenAiBody {
  readonly choices?: readonly { readonly message?: OpenAiMessage | null }[];
  readonly usage?: OpenAiUsage | null;
}

export function excerpt(bodyText: string): string {
  return bodyText.length > BODY_EXCERPT_LIMIT
    ? `${bodyText.slice(0, BODY_EXCERPT_LIMIT)}...`
    : bodyText;
}

/**
 * A reported count, or `null` when the provider did not report a usable one.
 *
 * `null` is never coerced to `0` (INV-5): a Deployment that reports nothing has
 * an unmetered budget, and the honest record of that is `null`, which the
 * Metering Probe classifies and the Token Bank leaves alone. A value that is
 * present but not a non-negative safe integer is treated the same way -- as
 * "not reported" -- because the alternative is passing a malformed number into
 * `debitTokenBank`, which throws and takes the Match with it.
 */
export function reportedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

/**
 * The exact JSON sent on the wire.
 *
 * `max_tokens` appears only in Reflex Mode, where `ProviderRequest.maxTokens`
 * carries `REFLEX_MAX_TOKENS` from core. Outside it the key is absent
 * altogether -- not `null`, not a large number -- and there is no effort,
 * thinking, budget or temperature key standing in for one (INV-4: the thinking
 * budget is metered, never set).
 */
export function openAiRequestBody(
  model: string,
  request: ProviderRequest,
  builderName: string,
): string {
  if (
    request.maxTokens !== undefined &&
    !(Number.isSafeInteger(request.maxTokens) && request.maxTokens > 0)
  ) {
    // Only `maxTokensFor` should ever fill this in, and it produces 8 or
    // nothing. A zero, a fraction or a negative would otherwise go on the wire
    // and come back as a remote 400, one wasted request later.
    throw new Error(
      `${builderName}: maxTokens must be a positive safe integer when set, got ${String(request.maxTokens)}`,
    );
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
  };

  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }

  return JSON.stringify(body);
}

/**
 * Provider body text -> `ProviderResponse`. Pure, so every parsing case is
 * testable from a recorded fixture with no network.
 *
 * Throws on a body that is not a chat completion at all. A 200 with no choice
 * is a protocol break, and silently turning it into an empty completion would
 * bill it to the Deployment as a Parse Failure -- a published metric -- rather
 * than to the provider.
 */
export function mapOpenAiResponse(bodyText: string, label: string): ProviderResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`${label} returned a body that is not JSON: ${excerpt(bodyText)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label} returned a body that is not an object: ${excerpt(bodyText)}`);
  }

  const body = parsed as OpenAiBody;
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new Error(`${label} returned no choices: ${excerpt(bodyText)}`);
  }

  const message = choice.message ?? null;
  const content = message?.content;
  const details = body.usage?.completion_tokens_details ?? null;
  const promptDetails = body.usage?.prompt_tokens_details ?? null;
  const separateReasoning = message?.reasoning;

  return {
    // A missing or non-string content is an empty completion, not a throw: a
    // tool-call-shaped reply is well-formed HTTP and a genuine Parse Failure.
    text: typeof content === 'string' ? content : '',
    usage: {
      tokensSpent: reportedCount(body.usage?.completion_tokens),
      reasoningTokens: reportedCount(details?.reasoning_tokens),
      // Story 3.5: the OpenAI-compatible shape reports cached prompt tokens
      // here when it reports them at all. `reportedCount` keeps the same "not
      // reported" vs "reported zero" distinction the other two counts already
      // hold (INV-5, AD-6).
      cachedTokens: reportedCount(promptDetails?.cached_tokens),
    },
    reasoning: typeof separateReasoning === 'string' ? separateReasoning : null,
  };
}
