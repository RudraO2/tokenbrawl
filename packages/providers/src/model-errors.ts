/**
 * Story 4.7, AC7: "a model name the provider rejects as unknown or retired"
 * must be told to the visitor as *that specific thing*, not as a generic
 * provider error.
 *
 * This matters far more once a model name can be typed than it did when it came
 * from a dropdown. A visitor who pastes `gpt-oss-120b` where the provider wants
 * `openai/gpt-oss-120b` gets a 404, and "the provider returned an error" sends
 * them looking at their key.
 *
 * **Codes, never prose.** Story 4.6's review settled the general rule -- a
 * message is text a later release may reword, and a regex over one silently
 * reclassifies everything the day it changes. The same rule applies to a
 * *provider's* prose, so this reads the HTTP status and the machine-readable
 * `code`/`status`/`param` fields that both wire families carry, and reads no
 * `message` at all. The recorded bodies in the tests are the evidence.
 *
 * Known shapes, all of them 404 in practice, all of them machine-tagged:
 *
 * - OpenAI-compatible (Groq, Cerebras, OpenAI):
 *   `{"error":{"type":"invalid_request_error","code":"model_not_found","param":"model"}}`
 * - Google AI Studio:
 *   `{"error":{"code":404,"status":"NOT_FOUND"}}`
 *
 * A provider that signals an unknown model only in prose falls through to the
 * generic classification, which is the honest outcome: guessing from a sentence
 * would be worse than saying less.
 */

const NOT_FOUND = 404;

/** Machine tags that mean "that model" rather than "that request" or "that key". */
const UNKNOWN_MODEL_CODES: ReadonlySet<string> = new Set([
  'model_not_found',
  'model_not_available',
  'model_terminated',
  'model_decommissioned',
  'not_found',
]);

function fieldOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.toLowerCase() : '';
}

export function isUnknownModelResponse(status: number, bodyText: string): boolean {
  // A 404 from a completions endpoint is about the resource being addressed,
  // and for every provider here the model is the only variable part of that
  // address. A bad key is 401/403 and a quota is 429, so there is no overlap.
  if (status === NOT_FOUND) {
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }

  // Both families nest under `error`; a few gateways flatten it. Checking both
  // costs one line and covers every OpenAI-compatible endpoint Advanced mode
  // can be pointed at.
  const root = parsed as Record<string, unknown>;
  const nested = root.error;
  const record =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : root;

  if (UNKNOWN_MODEL_CODES.has(fieldOf(record, 'code'))) {
    return true;
  }
  if (UNKNOWN_MODEL_CODES.has(fieldOf(record, 'status'))) {
    return true;
  }
  // `param: "model"` is the OpenAI-compatible way of saying which field of the
  // request was the problem. It is a field name, not a sentence.
  return fieldOf(record, 'param') === 'model';
}
