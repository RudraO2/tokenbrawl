import type { Action, Agent, Decision, Observation, Prompt } from '@tokenbrawl/contracts';
import { yieldMicrotasks } from './async-delay';

export interface ScriptedAgentConfig {
  readonly id: string;
  readonly kind?: 'deployment' | 'bot';
  /** Actions returned by `decide()` in call order. Mock Agents always return a valid `Action` -- parse-failure handling is out of scope. */
  readonly script: readonly Action[];
  /** Awaited inside `decide()` before resolving. Defaults to a no-op microtask yield -- inject `() => yieldMicrotasks(N)` to simulate latency. */
  readonly delay?: () => Promise<void>;
}

/**
 * A scripted mock `Agent`, plus test-only call-count introspection (not part
 * of the frozen `Agent` port; safe to ignore in any code that only depends
 * on the `Agent` interface).
 */
export interface ScriptedAgent extends Agent {
  readonly observeCallCount: () => number;
  readonly decideCallCount: () => number;
}

export function createScriptedAgent(config: ScriptedAgentConfig): ScriptedAgent {
  const { id, script } = config;
  const kind = config.kind ?? 'bot';
  const delay = config.delay ?? (() => yieldMicrotasks(0));

  let cursor = 0;
  let observeCalls = 0;
  let decideCalls = 0;

  return {
    id,
    kind,

    observeCallCount: () => observeCalls,
    decideCallCount: () => decideCalls,

    observe(observation: Observation, budgetRemaining: number, reflexMode: boolean): Prompt {
      observeCalls += 1;
      return {
        system: 'mock-scaffold',
        user: observation.state,
        budgetRemaining,
        reflexMode,
      };
    },

    async decide(prompt: Prompt): Promise<Decision> {
      decideCalls += 1;

      if (cursor >= script.length) {
        throw new Error(`Scripted agent "${id}" exhausted its script after ${script.length} action(s).`);
      }
      const action = script[cursor];
      cursor += 1;

      await delay();

      return {
        action,
        tokensSpent: 0,
        reasoningTokens: 0,
        reasoning: null,
        rawResponse: `${action}:${prompt.user}`,
        provider: 'mock',
        endpoint: 'mock',
      };
    },
  };
}
