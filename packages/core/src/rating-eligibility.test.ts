import { describe, expect, it } from 'vitest';
import type { AgentIdentity } from '@tokenbrawl/contracts';
import { isRatingEligible, ratingEligibility } from './rating-eligibility';

/**
 * Story 4.6 AC4's second half: "excluded from all rating computation".
 *
 * The exclusion is asserted here rather than in `apps/web` because the consumer
 * it has to bind is Story 7.2, which lives in this package. A test that only
 * ran in the browser app would prove the page displays a badge, not that a
 * rating can never be computed from one.
 */

function deployment(provider: string): AgentIdentity {
  return {
    id: `${provider}:some-model`,
    kind: 'deployment',
    deployment: {
      provider: provider as never,
      endpoint: 'https://api.example.com/v1/chat/completions',
      model: 'some-model',
    },
  };
}

const BOT: AgentIdentity = { id: 'bot:spacing', kind: 'bot' };

describe('AD-11: BYOK Matches never enter the leaderboard', () => {
  it('excludes a Match with two BYOK Deployments', () => {
    const verdict = ratingEligibility({ agents: [deployment('byok'), deployment('byok')] });
    expect(verdict.eligible).toBe(false);
    expect(verdict.exclusion).toBe('byok');
    expect(verdict.reason).toContain('byok');
  });

  it('excludes a Match where only one side is BYOK', () => {
    // Half an auditable Match is not half a rating. A Deployment on somebody's
    // personal key is unverifiable whatever it was fighting.
    expect(isRatingEligible({ agents: [deployment('byok'), BOT] })).toBe(false);
    expect(isRatingEligible({ agents: [BOT, deployment('byok')] })).toBe(false);
  });

  it('rates an ordinary tournament Match', () => {
    const verdict = ratingEligibility({ agents: [deployment('groq'), deployment('cerebras')] });
    expect(verdict.eligible).toBe(true);
    expect(verdict.exclusion).toBeNull();
    expect(verdict.reason).toBeNull();
  });

  it('rates a Baseline-Bot Match, which carries no deployment block at all', () => {
    expect(isRatingEligible({ agents: [BOT, BOT] })).toBe(true);
  });

  it('states a displayable reason, so a missing leaderboard row is never a silent gap', () => {
    const verdict = ratingEligibility({ agents: [deployment('byok'), BOT] });
    expect(verdict.reason).toMatch(/AD-11/);
    expect(verdict.reason).toMatch(/excluded/i);
  });

  it('reads the provider rather than the agent id, which a visitor could otherwise spoof', () => {
    // An id is a label. `deployment.provider` is the enum the frozen schema
    // validates, and it is the only field this rule may trust.
    const disguised: AgentIdentity = {
      id: 'groq:llama-3.1-8b-instant',
      kind: 'deployment',
      deployment: {
        provider: 'byok',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.1-8b-instant',
      },
    };
    expect(isRatingEligible({ agents: [disguised, BOT] })).toBe(false);
  });
});
