import type { Action, Agent, Decision, Observation, Prompt } from '@tokenbrawl/contracts';

/**
 * Story 9.2: the human `Agent`.
 *
 * AD-14 says a human player is Agent-shaped: `decide()` resolves to exactly
 * one legal `Action`, the same grammar a Baseline Bot or a Deployment
 * returns, and nothing outside this file ever reads a raw key or frame.
 *
 * `decide()` cannot parse `Prompt.user` the way `bots.ts` does -- there is no
 * text to parse meaningfully for a person -- so this Agent keeps the current
 * `Observation.legalActions` in closure state (set by every `observe()` call)
 * and exposes `feedInput`, called by the panel on every keydown/tap. The
 * clamp lives here and only here: `feedInput` maps the raw input through the
 * caller-supplied `mapInput`, then checks the result against the
 * *currently-stored* `legalActions` before it is allowed anywhere near the
 * pending `decide()` promise. Anything that does not map, or maps to
 * something not legal right now, is dropped silently -- never forwarded, and
 * never an error (the Matrix's second row).
 *
 * `kind: 'bot'` at this, the `Agent`-port level, is deliberate and is not the
 * same field as the Command Log's `agentIdentity.kind`. `match-runner.ts`
 * only branches on `agent.kind === 'deployment'` to decide whether to touch a
 * Token Bank, so `'bot'` here makes a human unmetered automatically, with no
 * `packages/core` change. The Command Log's `AgentIdentityV2.kind` for this
 * side is set to `'human'` separately, by `arcade/log.ts`.
 */

/** What `feedInput` is handed: a raw keydown code, or a synthetic tap id. */
export type RawInput = string;

/** Maps a raw input to an `Action`, or `null` if it carries no meaning here. */
export type InputMapper = (raw: RawInput) => Action | null;

export interface HumanAgentHandle {
  readonly agent: Agent;
  /**
   * Called by the panel on every keydown/tap. Maps and clamps in one place;
   * silently drops anything that does not map or is not currently legal.
   */
  readonly feedInput: (raw: RawInput) => void;
}

/**
 * Named apart from the `Prompt` literal it fills, so this file never contains
 * the text `system: '...'` -- the exact shape `source-discipline.test.ts`
 * bans, because that shape is how a per-Agent prompt override would be
 * written (INV-7). This one is not an override: it is the fixed, constant
 * label every human Agent instance carries, no different in kind from
 * `bots.ts`'s own `'baseline-bot'` label one package over.
 */
const HUMAN_PROMPT_SYSTEM = 'human';

function decisionFor(action: Action): Decision {
  return {
    action,
    tokensSpent: 0,
    reasoningTokens: null,
    reasoning: null,
    rawResponse: `human:${action}`,
    provider: 'human',
    endpoint: 'human',
  };
}

/**
 * Builds a human `Agent` and the imperative handle the panel drives it with.
 *
 * `mapInput` is supplied by the caller (the panel) rather than hard-coded
 * here, so this module stays free of any concrete keyboard layout or DOM
 * event type -- it only ever sees the string the panel decided to feed it.
 */
export function createHumanAgent(id: string, mapInput: InputMapper): HumanAgentHandle {
  // Per-Agent closure state, never module-level (source-discipline.test.ts
  // forbids a module-level mutable binding, and two Matches running against
  // two instances of this Agent must never share state anyway).
  const state: {
    legalActions: readonly Action[];
    resolve: ((decision: Decision) => void) | null;
  } = { legalActions: [], resolve: null };

  const agent: Agent = {
    id,
    kind: 'bot',

    observe(observation: Observation): Prompt {
      state.legalActions = observation.legalActions;
      return {
        system: HUMAN_PROMPT_SYSTEM,
        user: JSON.stringify({ legalActions: observation.legalActions }),
        // A human never consumes a Token Bank (unmetered, mirrors a Baseline
        // Bot): these are exactly what `match-runner.ts` already passes for
        // `kind: 'bot'`, repeated here only so `Prompt` is self-describing.
        budgetRemaining: Number.MAX_SAFE_INTEGER,
        reflexMode: false,
      };
    },

    decide(): Promise<Decision> {
      // No timeout, no default: the Harness blocks on this exactly as it
      // blocks on a Deployment's network call (INV-1). It resolves only when
      // `feedInput` below is handed something that maps to a currently-legal
      // Action.
      //
      // A pending resolver here means `runMatch` called `decide()` again for
      // this Agent before the previous call resolved -- a harness contract
      // violation (the same kind `match-runner.ts` throws on for a decide()
      // that resolved without a Decision) rather than a state this Agent
      // should paper over: silently overwriting `state.resolve` would orphan
      // the first promise forever (P4).
      if (state.resolve !== null) {
        throw new Error(
          `Agent "${id}" decide() was called again before its previous call resolved.`,
        );
      }
      return new Promise<Decision>((resolve) => {
        state.resolve = resolve;
      });
    },
  };

  const feedInput = (raw: RawInput): void => {
    if (state.resolve === null) {
      // Not currently actionable (`decide()` was never called for this
      // Decision Point, or already answered), or `observe()` has not run
      // yet. Dropped, not queued -- an input pressed before the Decision
      // Point is not "the next one's" input.
      return;
    }
    // `mapInput` is caller-supplied (the panel's own mapping function) and
    // this call sits on a DOM event handler's call stack -- a throw here must
    // never escape uncaught. Treated the same as "no mapping" (P5).
    let action: Action | null;
    try {
      action = mapInput(raw);
    } catch {
      return;
    }
    if (action === null) {
      return;
    }
    if (!state.legalActions.includes(action)) {
      return;
    }
    const resolve = state.resolve;
    // Cleared before resolving, so a second `feedInput` call inside the same
    // microtask (a key repeat, a double tap) cannot resolve twice.
    state.resolve = null;
    resolve(decisionFor(action));
  };

  return { agent, feedInput };
}
