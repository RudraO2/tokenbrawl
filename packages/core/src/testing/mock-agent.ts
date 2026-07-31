import type { Action, Agent, Decision, Observation, Prompt } from '@tokenbrawl/contracts';
import { yieldMicrotasks } from './async-delay';

/** One call's reported usage. Mirrors the two fields of `Decision` a script can vary; everything else about the Decision is fixed. */
export interface ScriptedAgentUsage {
  readonly tokensSpent: number | null;
  readonly reasoningTokens?: number | null;
}

export interface ScriptedAgentConfig {
  readonly id: string;
  readonly kind?: 'deployment' | 'bot';
  /** Actions returned by `decide()` in call order. A `null` entry scripts a Parse Failure -- `decide()` resolves `action: null` for that call. */
  readonly script: readonly (Action | null)[];
  /** Awaited inside `decide()` before resolving. Defaults to a no-op microtask yield -- inject `() => yieldMicrotasks(N)` to simulate latency. */
  readonly delay?: () => Promise<void>;
  /**
   * Per-call usage reports, in call order, indexed the same as `script`.
   * Missing entries (including an omitted array entirely) default to
   * `{ tokensSpent: 0, reasoningTokens: 0 }` -- Token Bank exhaustion and the
   * null-vs-zero distinction (Story 1.5) cannot otherwise be tested against
   * an Agent that always reports 0.
   */
  readonly usage?: readonly ScriptedAgentUsage[];
}

/**
 * A scripted mock `Agent`, plus test-only call-count and Prompt-capture
 * introspection (not part of the frozen `Agent` port; safe to ignore in any
 * code that only depends on the `Agent` interface).
 */
export interface ScriptedAgent extends Agent {
  readonly observeCallCount: () => number;
  readonly decideCallCount: () => number;
  /** Every Prompt this Agent's `observe()` has built, in call order -- what the Harness actually passed, not a re-hand-rolled assumption. */
  readonly capturedPrompts: () => readonly Prompt[];
}

const DEFAULT_USAGE: ScriptedAgentUsage = { tokensSpent: 0, reasoningTokens: 0 };

export function createScriptedAgent(config: ScriptedAgentConfig): ScriptedAgent {
  const { id, script } = config;
  const kind = config.kind ?? 'bot';
  const delay = config.delay ?? (() => yieldMicrotasks(0));

  let cursor = 0;
  let observeCalls = 0;
  let decideCalls = 0;
  const prompts: Prompt[] = [];

  return {
    id,
    kind,

    observeCallCount: () => observeCalls,
    decideCallCount: () => decideCalls,
    capturedPrompts: () => prompts,

    observe(observation: Observation, budgetRemaining: number, reflexMode: boolean): Prompt {
      observeCalls += 1;
      const prompt: Prompt = {
        system: 'mock-scaffold',
        user: observation.state,
        budgetRemaining,
        reflexMode,
      };
      prompts.push(prompt);
      return prompt;
    },

    async decide(prompt: Prompt): Promise<Decision> {
      decideCalls += 1;

      if (cursor >= script.length) {
        throw new Error(`Scripted agent "${id}" exhausted its script after ${script.length} action(s).`);
      }
      const action = script[cursor];
      const usage = config.usage?.[cursor] ?? DEFAULT_USAGE;
      cursor += 1;

      await delay();

      return {
        action,
        tokensSpent: usage.tokensSpent,
        reasoningTokens: usage.reasoningTokens ?? null,
        reasoning: null,
        rawResponse: `${action}:${prompt.user}`,
        provider: 'mock',
        endpoint: 'mock',
      };
    },
  };
}
