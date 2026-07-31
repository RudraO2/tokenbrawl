import type { Action } from '@tokenbrawl/contracts';

/**
 * Placeholder export for Story 1.1 (scaffold only). The real Harness lands
 * in later Epic-1 stories; this package intentionally contains no game
 * logic, no Agent, and no provider adapter yet.
 */
export const placeholder = true;

/**
 * Proves the `@tokenbrawl/contracts` path alias resolves to the frozen
 * `docs/contracts/index.ts` under strict mode. Type-only, so it is erased at
 * runtime and never needs module resolution outside of `tsc`.
 */
export type PlaceholderAction = Action;

// ---------------------------------------------------------------------------
// Story 1.2: Agent port, mock environment, and the blocking match runner.
// ---------------------------------------------------------------------------

export { runMatch } from './match-runner';
export type { MatchDecisionEntry, MatchResult } from './match-runner';

export { yieldMicrotasks } from './testing/async-delay';

export { createMockEnvironment, DEFAULT_MOCK_ENVIRONMENT_CONFIG } from './testing/mock-environment';
export type { MockEnvironmentConfig, MockState } from './testing/mock-environment';

export { createScriptedAgent } from './testing/mock-agent';
export type { ScriptedAgent, ScriptedAgentConfig } from './testing/mock-agent';

// ---------------------------------------------------------------------------
// Story 1.3: Command Log persistence and schema validation.
// ---------------------------------------------------------------------------

export { canonicalStringify, canonicalSha256, sha256Hex } from './canonical-hash';

export {
  buildCommandLog,
  computeConfigHash,
  computeMatchId,
  validateCommandLog,
} from './command-log';
export type { BuildCommandLogParams, ComputeMatchIdParams } from './command-log';

// ---------------------------------------------------------------------------
// Story 1.4: the replay determinism gate (INV-2).
// ---------------------------------------------------------------------------

export { replayCommandLog } from './replay';
export type { ReplayResult } from './replay';
