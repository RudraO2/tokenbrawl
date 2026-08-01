import { describe, expect, it } from 'vitest';
import { assertFreeTierEndpoint } from './free-tier';
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


/**
 * Story 4.7, AC8: "given tournament configuration, when anything in this story
 * lands, then it still refuses every non-free-tier endpoint and still refuses
 * OpenRouter, unchanged."
 *
 * Story 4.7 gave a *visitor* the ability to call any endpoint they like. This
 * block is the assertion that none of that reached tournament configuration.
 * It is deliberately here rather than only in `free-tier.test.ts`: the two
 * halves of AC8 are one claim, and a reader checking it should find both in
 * one place.
 */
describe('Story 4.7 changed nothing about what a tournament may configure (AC8)', () => {
  it('still refuses an OpenRouter Deployment, ranked or not', () => {
    for (const ranked of [true, false]) {
      expect(() =>
        validateTournamentConfig([{ id: 'or:any-model', provider: 'openrouter', ranked }]),
      ).toThrow(/OpenRouter/);
    }
  });

  it('still refuses every endpoint that is not on the free-tier allowlist', () => {
    for (const [provider, endpoint] of [
      ['groq', 'https://api.groq.com/openai/v1/dedicated/chat/completions'],
      ['cerebras', 'https://api.cerebras.ai/v1/dedicated/chat/completions'],
      ['groq', 'https://openrouter.ai/api/v1/chat/completions'],
      ['groq', 'https://api.openai.com/v1/chat/completions'],
    ] as const) {
      expect(() => {
        assertFreeTierEndpoint(provider, endpoint);
      }).toThrow(/not on the free-tier allowlist/);
    }
  });

  it('cannot be waved through by any extra argument', () => {
    // The shape the story warned against: a flag threaded into the existing
    // check, one edit away from "just this once" in tournament configuration.
    // Story 4.7's answer was a separate factory in a file the package does not
    // export, so this call must still throw however it is invoked.
    const waveThrough = assertFreeTierEndpoint as unknown as (...args: unknown[]) => void;
    for (const extra of [true, 'force', { allow: true }, 1]) {
      expect(() => {
        waveThrough('groq', 'https://api.openai.com/v1/chat/completions', undefined, extra);
      }).toThrow(/not on the free-tier allowlist/);
    }
  });
});
