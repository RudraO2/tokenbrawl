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
export type { MatchDecisionEntry, MatchOptions, MatchResult } from './match-runner';

export { yieldMicrotasks } from './testing/async-delay';

export { createMockEnvironment, DEFAULT_MOCK_ENVIRONMENT_CONFIG } from './testing/mock-environment';
export type { MockEnvironmentConfig, MockState } from './testing/mock-environment';

export { createScriptedAgent } from './testing/mock-agent';
export type { ScriptedAgent, ScriptedAgentConfig, ScriptedAgentUsage } from './testing/mock-agent';

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

// ---------------------------------------------------------------------------
// Story 1.5: Token Bank metering and Reflex Mode.
// ---------------------------------------------------------------------------

export { DEFAULT_TOKEN_BANK_START, REFLEX_MAX_TOKENS, maxTokensFor } from './token-bank';
export type { TokenBank } from './token-bank';

// ---------------------------------------------------------------------------
// Story 1.6: Parse failures as a first-class metric.
// ---------------------------------------------------------------------------

export { computeParseFailureRates } from './metrics';
export type { ParseFailureRate } from './metrics';

// ---------------------------------------------------------------------------
// Story 3.1: the Scaffold, the Action grammar, and the Deployment Agent.
// ---------------------------------------------------------------------------

export { ACTION_GRAMMAR, parseAction } from './action-grammar';

export { REFLEX_SCAFFOLD, SCAFFOLD, assemblePrompt, selectScaffold } from './scaffold';

export { createDeployment } from './deployment';
export type {
  DeploymentConfig,
  DeploymentDecision,
  ProviderClient,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
} from './deployment';

export { createMockProviderClient } from './testing/mock-provider';
export type { MockProviderClient, MockProviderConfig } from './testing/mock-provider';

// ---------------------------------------------------------------------------
// Story 3.5: per-call provenance (already carried by the frozen contracts)
// and prompt-cache accounting -- conservative debiting and a per-Match,
// per-Agent cache-hit report.
// ---------------------------------------------------------------------------

export { computeCacheStats, formatCacheDeviations } from './caching';
export type { CacheStats } from './caching';

// ---------------------------------------------------------------------------
// Story 4.6: AD-11 as a predicate. BYOK Matches never enter the leaderboard,
// and Story 7.2's rating computation imports this rather than re-deriving it.
// ---------------------------------------------------------------------------

export { isRatingEligible, ratingEligibility } from './rating-eligibility';
export type { RatableLog, RatingEligibility, RatingExclusion } from './rating-eligibility';

// ---------------------------------------------------------------------------
// Story 7.1: mirrored seeds and side swaps. A pairing played from one side
// only cannot tell a side advantage in the Environment apart from a skill
// difference, so coverage is a rating precondition (AC3) and the residual
// side advantage is measured rather than assumed away (AC4).
// ---------------------------------------------------------------------------

export {
  MINIMUM_MATCHES_PER_PAIRING,
  MINIMUM_MIRRORED_SEEDS_PER_PAIRING,
  isPairingRatable,
  summarisePairingCoverage,
} from './pairing-coverage';
export type { CoverageMatch, PairingCoverage, PairingExclusion } from './pairing-coverage';

export {
  NEUTRAL_SIDE_SCORE_BASIS_POINTS,
  side0Score,
  summariseSideAdvantage,
} from './side-advantage';
export type {
  MirroredPair,
  SideAdvantageMatch,
  SideAdvantageParams,
  SideAdvantageSummary,
} from './side-advantage';

// ---------------------------------------------------------------------------
// Story 7.2: ratings with bootstrapped confidence intervals, and the one
// renderer allowed to publish a rating table.
// ---------------------------------------------------------------------------

export { computeLeaderboard } from './ratings';
export type {
  Leaderboard,
  LeaderboardMatch,
  LeaderboardParams,
  MatchExclusion,
  MatchExclusionReason,
  OpponentRecord,
  RatingRow,
  RatingTrack,
  UnratedAgent,
} from './ratings';

export { NOT_REPORTED, buildLeaderboardReport, renderLeaderboardMarkdown } from './ratings-report';
export type {
  LeaderboardReport,
  LeaderboardReportMeta,
  ReportBehaviourRow,
  ReportRatingRow,
} from './ratings-report';

// ---------------------------------------------------------------------------
// Story 7.3: behavioural metrics -- how a Deployment spent its thinking, with
// "not reported" kept distinct from zero all the way to the reader (INV-5).
// ---------------------------------------------------------------------------

export {
  computeBehaviouralMetrics,
  isRateLimitedResponse,
  unreportedBehaviour,
} from './behavioural-metrics';
export type { AgentBehaviour } from './behavioural-metrics';

export {
  BASIS_POINTS_SCALE,
  DEFAULT_CONFIDENCE_BASIS_POINTS,
  bootstrapMeanInterval,
  deriveSeed,
  formatBasisPoints,
  meanBasisPoints,
} from './statistics';
export type { BootstrapInterval, BootstrapParams } from './statistics';

// ---------------------------------------------------------------------------
// Story 8.1: Command Log schema v2 -- a strict superset of v1 adding vertical
// position, Zone, Juggle Count, a 'jump' Action, and a 'human' Agent kind.
// v1's validator and exports are untouched; this is the v2-only reader.
// ---------------------------------------------------------------------------

export { validateCommandLogV2 } from './command-log-v2';
export type {
  ActionV2,
  AgentIdentityV2,
  CommandLogV2,
  DecisionEntryV2,
  LoggedActionV2,
} from '@tokenbrawl/contracts';

// ---------------------------------------------------------------------------
// Story 9.2: the v2 sibling of the replay determinism gate, so a v2 Command
// Log (including one with a `'human'` Agent) can be replayed the same way a
// v1 log always has been.
// ---------------------------------------------------------------------------

export { replayCommandLogV2 } from './replay';
