import type {
  Action,
  Agent,
  Decision,
  DecisionEntry,
  EnvironmentAdapter,
  LoggedAction,
  TerminalResult,
} from '@tokenbrawl/contracts';

/**
 * Token Bank metering (INV-4) is out of scope for this story (see the
 * story's "Never" list). Every Agent is observed with an effectively
 * unmetered budget and Reflex Mode never engages; a later Token Bank story
 * replaces these constants with real accounting threaded through match
 * state.
 */
const UNMETERED_BUDGET = Number.MAX_SAFE_INTEGER;
const REFLEX_MODE = false;

/**
 * One logged decision for one Agent at one Decision Point.
 *
 * Extends the frozen `DecisionEntry` shape (tick/agentIndex/etc. are
 * unchanged) but widens `action` to allow `null`, which `DecisionEntry`
 * itself cannot express. `null` here records that the Agent was not
 * actionable for this Decision Point (inside a Commitment Window) and was
 * never polled -- distinct from a real chosen Action, and distinct from a
 * Parse Failure (out of scope; see `runMatch`).
 */
export interface MatchDecisionEntry extends Omit<DecisionEntry, 'action'> {
  readonly action: LoggedAction | null;
}

/**
 * Bundles one Match's ordered decisions, its `TerminalResult`, and its
 * final-state hash. Deliberately reuses the frozen `TerminalResult` type and
 * the `env.hash(state)` value rather than inventing a new serialisation --
 * this is the in-memory precursor to a `CommandLog`, not a competing format.
 */
export interface MatchResult {
  readonly decisions: readonly MatchDecisionEntry[];
  readonly result: TerminalResult;
  readonly finalStateHash: string;
}

/**
 * The blocking Harness loop (INV-1's proof surface).
 *
 * Per Decision Point: poll `decide()` only for Agents where
 * `env.isActionable` is true; kick off both actionable Agents' `decide()`
 * calls and await them together via `Promise.all` *before* calling
 * `env.step`, so simultaneity holds structurally (neither Agent's
 * Prompt/Observation can expose the other's pending choice, since both are
 * built from the pre-step state before either Agent's Decision exists).
 *
 * No default Action is ever substituted: if a `decide()` promise never
 * resolves, the `Promise.all` below never resolves, and this function's
 * returned promise simply stays pending forever. There is no timeout path.
 */
export async function runMatch<TState>(
  env: EnvironmentAdapter<TState>,
  agents: readonly [Agent, Agent],
  seed: number,
): Promise<MatchResult> {
  let state = env.reset(seed);
  const decisions: MatchDecisionEntry[] = [];
  let tick = 0;
  let terminalResult = env.terminal(state);

  while (terminalResult === null) {
    const actionable: readonly [boolean, boolean] = [env.isActionable(state, 0), env.isActionable(state, 1)];

    const decisionResults: [Decision | null, Decision | null] = [null, null];
    const pending: Array<Promise<void>> = [];

    for (const agentIndex of [0, 1] as const) {
      if (!actionable[agentIndex]) {
        continue;
      }

      const observation = env.observe(state, agentIndex);
      const prompt = agents[agentIndex].observe(observation, UNMETERED_BUDGET, REFLEX_MODE);
      const decidePromise = agents[agentIndex].decide(prompt);
      pending.push(
        decidePromise.then((decision) => {
          decisionResults[agentIndex] = decision;
        }),
      );
    }

    // Both in-flight decide() calls are awaited together, never one after
    // the other -- this is what makes simultaneity structural rather than a
    // convention that could quietly regress.
    await Promise.all(pending);

    const actionsForStep: [LoggedAction | null, LoggedAction | null] = [null, null];

    for (const agentIndex of [0, 1] as const) {
      if (!actionable[agentIndex]) {
        decisions.push({ tick, agentIndex, action: null });
        continue;
      }

      const decision = decisionResults[agentIndex];

      if (decision === null) {
        // A resolved decide() must yield a Decision, never null -- the
        // "not polled" case is already handled by the actionable check
        // above, so a null here means an Agent violated its own contract.
        throw new Error(`Agent "${agents[agentIndex].id}" decide() resolved without a Decision.`);
      }

      if (decision.action === null) {
        // Parse-failure fallback (the Fallback Action `stand`) is explicitly
        // out of scope for this story. Scripted mock Agents never return a
        // null Action, so reaching this branch means runMatch was driven
        // with something other than the mock Agents this story ships.
        throw new Error(
          `Agent "${agents[agentIndex].id}" returned a null Action; parse-failure fallback is out of scope for this story.`,
        );
      }

      const action: Action = decision.action;
      actionsForStep[agentIndex] = action;
      decisions.push({
        tick,
        agentIndex,
        action,
        tokensSpent: decision.tokensSpent ?? undefined,
        reasoningTokens: decision.reasoningTokens ?? undefined,
        reasoning: decision.reasoning,
        rawResponse: decision.rawResponse,
        provider: decision.provider,
        endpoint: decision.endpoint,
      });
    }

    state = env.step(state, actionsForStep);
    tick += env.ticksPerDecision;
    terminalResult = env.terminal(state);
  }

  return {
    decisions,
    result: terminalResult,
    finalStateHash: env.hash(state),
  };
}
