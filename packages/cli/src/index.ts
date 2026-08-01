/**
 * `@tokenbrawl/cli` -- run Matches and tournaments from the command line.
 *
 * A thin wrapper over `packages/core` and `packages/env-fighter`, and the
 * thinness is the point: Story 5.1's first acceptance criterion is "the same
 * Harness and the same Command Log schema as CI -- no forked logic anywhere",
 * so this package owns only what is genuinely CLI-shaped. Config loading, a
 * filesystem port, secret handling, and resume derived from the committed logs
 * (AD-9). Everything else is imported.
 *
 * The executable is `src/cli.ts`; `main()` below is the same thing with an
 * injectable io, which is how the whole runner is tested with no disk.
 */

export { main, parseArgs, EXIT_OK, EXIT_USAGE, USAGE } from './main';
export type { MainDeps } from './main';

export type { CliIo } from './io';
export { createNodeIo } from './node-io';

export {
  AGENT_ID_PATTERN,
  DEFAULT_OUTPUT_DIR,
  agentConfigById,
  loadRunConfig,
  parseRunConfig,
  tournamentWarnings,
} from './config';
export type {
  AgentConfig,
  BotAgentConfig,
  BotKind,
  CliProviderId,
  DeploymentAgentConfig,
  RunConfig,
} from './config';

export { buildAgent, secretsFor } from './agents';
export type { AgentDeps, BuiltAgent } from './agents';

export {
  CLI_ENVIRONMENT_ID,
  CLI_ENVIRONMENT_VERSION,
  cliConfigHash,
  joinPath,
  logFileName,
  outstandingMatches,
  planMatch,
  planTournament,
} from './plan';
export type { PlannedMatch } from './plan';

export { runOneMatch, runPlannedMatches, serialiseCommandLog } from './run';
export type { RunSummary } from './run';

export {
  MIN_API_KEY_LENGTH,
  REDACTED,
  assertNoSecrets,
  guardSecrets,
  redact,
  resolveApiKey,
} from './secrets';
