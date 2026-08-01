import { describe, expect, it } from 'vitest';
import * as cli from './index';

/**
 * The package's public surface, as one assertion.
 *
 * The Story 1.1 `placeholder` export is gone -- it existed to prove the
 * `@tokenbrawl/contracts` alias resolved here, which every module in this
 * package now demonstrates by importing real work through it.
 */
describe('@tokenbrawl/cli', () => {
  it('exports the entry point and the pieces a caller composes', () => {
    expect(Object.keys(cli).sort()).toStrictEqual([
      'AGENT_ID_PATTERN',
      'CLI_ENVIRONMENT_ID',
      'CLI_ENVIRONMENT_VERSION',
      'DEFAULT_OUTPUT_DIR',
      'EXIT_OK',
      'EXIT_USAGE',
      'MIN_API_KEY_LENGTH',
      'REDACTED',
      'USAGE',
      'agentConfigById',
      'assertNoSecrets',
      'buildAgent',
      'cliConfigHash',
      'createNodeIo',
      'guardSecrets',
      'joinPath',
      'loadRunConfig',
      'logFileName',
      'main',
      'outstandingMatches',
      'parseArgs',
      'parseRunConfig',
      'planMatch',
      'planTournament',
      'redact',
      'resolveApiKey',
      'runOneMatch',
      'runPlannedMatches',
      'secretsFor',
      'serialiseCommandLog',
      'tournamentWarnings',
    ]);
  });

  it('no longer exports the Story 1.1 scaffold placeholder', () => {
    expect('placeholder' in cli).toBe(false);
  });
});
