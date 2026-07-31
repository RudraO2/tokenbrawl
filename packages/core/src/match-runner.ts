import {
  FALLBACK_ACTION,
  type Agent,
  type Decision,
  type DecisionEntry,
  type EnvironmentAdapter,
  type LoggedAction,
  type TerminalResult,
} from '@tokenbrawl/contracts';
import { DEFAULT_TOKEN_BANK_START, createTokenBank, debitTokenBank } from './token-bank';
import type { TokenBank } from './token-bank';

/**
 * Optional per-Match configuration. A trailing options object (rather than a
 * new positional parameter) so the three existing call sites
 * (`match-runner.test.ts`, `command-log.test.ts`, `make-determinism-fixture.ts`)
 * keep compiling unchanged, and the determinism fixture's inputs stay
 * identical -- a hash move during regeneration is then unambiguously a real
 * bug rather than a signature artefact.
 */
export interface MatchOptions {
  /** Starting Token Bank per Agent. Defaults to `DEFAULT_TOKEN_BANK_START`. */
  readonly tokenBankStart?: number;
}

/**
 * One logged decision for one Agent at one Decision Point.
 *
 * Extends the frozen `DecisionEntry` shape (tick/agentIndex/etc. are
 * unchanged) but widens `action` to allow `null`, which `DecisionEntry`
 * itself cannot express. `null` here records that the Agent was not
 * actionable for this Decision Point (inside a Commitment Window) and was
 * never polled -- distinct from a real chosen Action, and distinct from a
 * Parse Failure, which is logged as the Fallback Action (`'stand'`) with
 * `parseFailure: true`, never as `null`.
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
  /** The Token Bank size every Agent started this Match with (Story 1.5). */
  readonly tokenBankStart: number;
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
  options?: MatchOptions,
): Promise<MatchResult> {
  const tokenBankStart = options?.tokenBankStart ?? DEFAULT_TOKEN_BANK_START;
  // Both banks are constructed before any Agent is polled, so a bad config
  // value throws before a single decide() call ever fires.
  const banks: [TokenBank, TokenBank] = [createTokenBank(tokenBankStart), createTokenBank(tokenBankStart)];

  let state = env.reset(seed);
  const decisions: MatchDecisionEntry[] = [];
  let tick = 0;
  let terminalResult = env.terminal(state);

  while (terminalResult === null) {
    const actionable: readonly [boolean, boolean] = [env.isActionable(state, 0), env.isActionable(state, 1)];

    const decisionResults: [Decision | null, Decision | null] = [null, null];
    const pending: Array<Promise<void>> = [];
    // What the poll pass actually told each Agent's observe() this tick --
    // threaded into the collect pass below rather than recomputed there, so
    // the two can never disagree even if a future change touches `banks`
    // between the passes (Story 1.5).
    const polled: Array<{ budgetRemaining: number; reflexMode: boolean } | null> = [null, null];

    for (const agentIndex of [0, 1] as const) {
      if (!actionable[agentIndex]) {
        continue;
      }

      const observation = env.observe(state, agentIndex);
      const agent = agents[agentIndex];
      // A Baseline Bot consumes nothing (Story 1.5): it is never read from,
      // debited against, or validated by a Token Bank at all -- only a
      // Deployment's own bank drives its budget/Reflex Mode. Read before
      // this call, never after: the call that empties a Deployment's bank
      // is not itself in Reflex Mode, only the next one is.
      const { budgetRemaining, reflexMode } =
        agent.kind === 'deployment'
          ? { budgetRemaining: banks[agentIndex].remaining, reflexMode: banks[agentIndex].remaining === 0 }
          : { budgetRemaining: Number.MAX_SAFE_INTEGER, reflexMode: false };
      polled[agentIndex] = { budgetRemaining, reflexMode };
      const prompt = agent.observe(observation, budgetRemaining, reflexMode);
      const decidePromise = agent.decide(prompt);
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

      // Parse Failure: no valid Action could be extracted. The Fallback
      // Action (`stand`) is applied and never retried -- `decide()` above was
      // already called exactly once for this Agent at this Decision Point,
      // Parse Failure or not, so "no retry" falls out of there being no loop
      // here rather than needing a guard (INV-1). The Fallback Action is a
      // fixed constant, never derived from the previous Action, so it can
      // never repeat it.
      const parseFailure = decision.action === null;
      const action: LoggedAction = parseFailure ? FALLBACK_ACTION : decision.action;
      actionsForStep[agentIndex] = action;

      const agent = agents[agentIndex];
      const pollResult = polled[agentIndex];

      // Only a Deployment's bank is ever debited -- a Bot is never read from
      // one above, so it is never validated or written to one here either.
      // A Bot whose `decide()` reports garbage `tokensSpent` therefore
      // cannot abort a Match: it "consumes nothing" structurally, not merely
      // in what gets logged. A Parse Failure still debits normally -- the
      // provider still spent the tokens that produced the unparseable text.
      if (agent.kind === 'deployment') {
        if (pollResult === null) {
          throw new Error(`Agent "${agent.id}" was actionable but never polled -- this is a runMatch bug.`);
        }
        banks[agentIndex] = debitTokenBank(banks[agentIndex], decision.tokensSpent, agent.id);

        decisions.push({
          tick,
          agentIndex,
          action,
          tokensSpent: decision.tokensSpent,
          reasoningTokens: decision.reasoningTokens,
          bankRemaining: banks[agentIndex].remaining,
          reflexMode: pollResult.reflexMode,
          ...(parseFailure ? { parseFailure: true } : {}),
          reasoning: decision.reasoning,
          rawResponse: decision.rawResponse,
          provider: decision.provider,
          endpoint: decision.endpoint,
        });
      } else {
        // Banking fields are written only for a Deployment (INV-4/Story
        // 1.5): a Baseline Bot consumes nothing, so all four stay absent
        // rather than being derived from a zero value, which would collapse
        // "cannot consume" and "consumed nothing" into one shape.
        decisions.push({
          tick,
          agentIndex,
          action,
          ...(parseFailure ? { parseFailure: true } : {}),
          reasoning: decision.reasoning,
          rawResponse: decision.rawResponse,
          provider: decision.provider,
          endpoint: decision.endpoint,
        });
      }
    }

    state = env.step(state, actionsForStep);
    tick += env.ticksPerDecision;
    terminalResult = env.terminal(state);
  }

  return {
    decisions,
    result: terminalResult,
    finalStateHash: env.hash(state),
    tokenBankStart,
  };
}
