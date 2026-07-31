import { ACTIONS, type Action } from '@tokenbrawl/contracts';

/**
 * Story 3.1: the Action grammar (AD-7 -- core owns it, never an adapter).
 *
 * The text a model is shown and the rule its answer is judged by live in this
 * one file on purpose. Split across two modules they drift, and the drift is
 * invisible: the suite still passes while every Deployment quietly fails to
 * parse, and the damage shows up as a parse-failure rate that looks like a
 * model weakness rather than a bug of ours.
 *
 * The grammar is identical for every Deployment (INV-7). Nothing here takes a
 * provider, a model, or an endpoint as input.
 */

/** The five Actions, in the fixed order the model is shown them. Never re-ordered per Deployment. */
const ACTION_LIST = ACTIONS.join(', ');

/**
 * The response format, embedded verbatim in the Scaffold.
 *
 * A model may reason for as long as it likes first -- INV-4 meters thinking and
 * never caps it -- so the contract is about the *final* line only.
 */
export const ACTION_GRAMMAR = `Reply with your chosen Action. You may reason first, but the last line you write must be exactly:

ACTION: <action>

where <action> is exactly one of: ${ACTION_LIST}

Write nothing after that line. Any other final line is scored as a failure to follow the format, and a fixed inert Action is submitted on your behalf.`;

/** Matches the optional `ACTION:` label, in any casing, at the start of the answer line. */
const ACTION_LABEL = /^action\s*:\s*/i;

/** Leading/trailing decoration a model wraps its answer in: markdown, quotes, bullets, terminal punctuation. */
const LEADING_DECORATION = /^[^A-Za-z]+/;
const TRAILING_DECORATION = /[^A-Za-z]+$/;

const ACTION_SET: ReadonlySet<string> = new Set<string>(ACTIONS);

/**
 * Reads a provider's raw completion back into an Action, or `null` for a Parse
 * Failure (Story 1.6 turns that `null` into the Fallback Action and a
 * `parseFailure: true` log entry; nothing here throws, and nothing here
 * retries).
 *
 * The rule, uniform across every Deployment:
 *
 *   1. Take the last line containing at least one letter. Blank lines and a
 *      bare closing code fence are skipped, so a fenced answer still parses;
 *      trailing prose after the answer does not, which is the point.
 *   2. Strip leading and trailing non-letters -- `**ACTION: Special.**` and
 *      `"advance"` are the same answer written with different decoration.
 *   3. Drop an optional `ACTION:` label, then strip decoration again.
 *   4. Lowercase, and accept only if the whole remaining token is one of the
 *      five Actions.
 *
 * Step 4 compares the *entire* token, so `attacking` and `counterattack` are
 * failures rather than near-misses, and prose naming two Actions
 * (`I will advance or attack`) is a failure rather than a coin flip.
 *
 * `stand` is never accepted: it is the Fallback Action, and an Agent that could
 * choose it would be choosing the outcome of failing, which is exactly what
 * `LoggedAction` excluding it from `Action` exists to prevent.
 *
 * Legality is deliberately not checked here. A well-formed `special` that the
 * Agent cannot currently afford is *parsed*, and the Environment Adapter's own
 * legalisation substitutes the Fallback Action. Folding illegality into Parse
 * Failure would corrupt the published parse-failure rate with a different
 * mistake wearing its name.
 */
export function parseAction(raw: string): Action | null {
  const lines = raw.split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/[A-Za-z]/.test(line)) {
      continue;
    }

    const undecorated = line.replace(LEADING_DECORATION, '').replace(TRAILING_DECORATION, '');
    const token = undecorated
      .replace(ACTION_LABEL, '')
      .replace(LEADING_DECORATION, '')
      .replace(TRAILING_DECORATION, '')
      .toLowerCase();

    return ACTION_SET.has(token) ? (token as Action) : null;
  }

  return null;
}
