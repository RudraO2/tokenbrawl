import { describe, expect, it } from 'vitest';
import { validateTournamentConfig } from './tournament-config';
import type { TournamentDeploymentConfig } from './tournament-config';

/** Story 3.3 AC2 and AC4. */

function deployment(
  overrides: Partial<TournamentDeploymentConfig> & Pick<TournamentDeploymentConfig, 'id' | 'provider'>,
): TournamentDeploymentConfig {
  return { ranked: true, ...overrides };
}

describe('validateTournamentConfig (AC2)', () => {
  it('warns when two ranked Deployments share a provider', () => {
    const result = validateTournamentConfig([
      deployment({ id: 'groq:llama-3.1-8b-instant', provider: 'groq' }),
      deployment({ id: 'groq:llama-3.3-70b', provider: 'groq' }),
      deployment({ id: 'cerebras:llama3.1-8b', provider: 'cerebras' }),
    ]);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/"groq"/);
    expect(result.warnings[0]).toContain('groq:llama-3.1-8b-instant');
    expect(result.warnings[0]).toContain('groq:llama-3.3-70b');
  });

  it('raises no warning when every provider has at most one ranked Deployment', () => {
    const result = validateTournamentConfig([
      deployment({ id: 'groq:model', provider: 'groq' }),
      deployment({ id: 'cerebras:model', provider: 'cerebras' }),
      deployment({ id: 'google-ai-studio:model', provider: 'google-ai-studio' }),
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it('does not count an unranked Deployment on a shared provider', () => {
    const result = validateTournamentConfig([
      deployment({ id: 'groq:ranked', provider: 'groq', ranked: true }),
      deployment({ id: 'groq:reflex-only', provider: 'groq', ranked: false }),
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it('names every ranked Deployment on the offending provider, not just the first two', () => {
    const result = validateTournamentConfig([
      deployment({ id: 'a', provider: 'groq' }),
      deployment({ id: 'b', provider: 'groq' }),
      deployment({ id: 'c', provider: 'groq' }),
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('a');
    expect(result.warnings[0]).toContain('b');
    expect(result.warnings[0]).toContain('c');
  });
});

describe('validateTournamentConfig (AC4)', () => {
  it('rejects an OpenRouter Deployment configured for a tournament', () => {
    expect(() =>
      validateTournamentConfig([deployment({ id: 'openrouter:model', provider: 'openrouter' })]),
    ).toThrow(/OpenRouter/);
  });

  it('rejects OpenRouter even when it is not ranked', () => {
    // 50 RPD is not enough to serve a tournament at any role, ranked or not.
    expect(() =>
      validateTournamentConfig([
        deployment({ id: 'openrouter:model', provider: 'openrouter', ranked: false }),
      ]),
    ).toThrow(/OpenRouter/);
  });

  it('names the offending Deployment id in the rejection', () => {
    expect(() =>
      validateTournamentConfig([deployment({ id: 'openrouter:gpt-oss-20b', provider: 'openrouter' })]),
    ).toThrow(/openrouter:gpt-oss-20b/);
  });

  it('rejects OpenRouter even alongside otherwise-valid Deployments', () => {
    expect(() =>
      validateTournamentConfig([
        deployment({ id: 'groq:model', provider: 'groq' }),
        deployment({ id: 'openrouter:model', provider: 'openrouter' }),
      ]),
    ).toThrow(/OpenRouter/);
  });
});

describe('validateTournamentConfig, degenerate input', () => {
  it('accepts an empty config with no warnings', () => {
    expect(validateTournamentConfig([])).toStrictEqual({ warnings: [] });
  });

  it('returns a frozen result', () => {
    const result = validateTournamentConfig([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });
});
