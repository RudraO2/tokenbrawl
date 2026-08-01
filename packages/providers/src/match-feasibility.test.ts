import { describe, expect, it } from 'vitest';
import type { FreeTierLimits } from './free-tier';
import { freeTierLimitsFor, loadFreeTierConfig } from './free-tier';
import {
  MATCH_TOKENS_PER_CALL,
  MATCH_WORST_CASE_CALLS,
  SLOW_MATCH_MINUTES,
  feasibilityNotice,
  matchFeasibility,
} from './match-feasibility';

/**
 * Story 4.7, AC1 and AC2.
 *
 * The check that matters is not "does the arithmetic run" -- it is *does this
 * module reproduce the table a human wrote from a dashboard*. Every expectation
 * in the first block is transcribed from `docs/reports/byok-provider-limits.md`
 * rather than computed here, so a change to the formula that no longer agrees
 * with the published tables fails immediately.
 */

const limits = (
  requestsPerMinute: number,
  requestsPerDay: number,
  tokensPerMinute: number,
): FreeTierLimits => ({ requestsPerMinute, requestsPerDay, tokensPerMinute });

describe('the report tables, reproduced (AC1, AC2)', () => {
  it('counts Matches per day the way the report does', () => {
    // "Matches/day (RPD / 60)" -- the report's own column heading.
    expect(matchFeasibility(limits(30, 14_400, 6_000)).matchesPerDay).toBe(240);
    expect(matchFeasibility(limits(30, 1_000, 12_000)).matchesPerDay).toBe(16);
    expect(matchFeasibility(limits(15, 500, 250_000)).matchesPerDay).toBe(8);
    expect(matchFeasibility(limits(30, 250, 70_000)).matchesPerDay).toBe(4);
  });

  it('calls the 20-RPD rows unrunnable, which is the whole finding (AC1)', () => {
    // Gemini 2.5 Flash: 20 requests a day against a Match of up to sixty
    // calls. Story 4.6 offered it as the default Google option.
    const flash = matchFeasibility(limits(5, 20, 250_000));
    expect(flash.matchesPerDay).toBe(0);
    expect(flash.runnable).toBe(false);

    // And one call short of a Match is still short of a Match.
    expect(matchFeasibility(limits(30, MATCH_WORST_CASE_CALLS - 1, 6_000)).runnable).toBe(false);
    expect(matchFeasibility(limits(30, MATCH_WORST_CASE_CALLS, 6_000)).runnable).toBe(true);
  });

  it('takes the larger of the two ceilings, and says which one bound', () => {
    // Groq's 8B row: 30 RPM would allow two minutes, 6K TPM allows ten. The
    // report's "Minutes/match (TPM / ~1K per call)" column says ~10.
    const groq8b = matchFeasibility(limits(30, 14_400, 6_000));
    expect(groq8b.minutesPerMatch).toBe(10);
    expect(groq8b.boundBy).toBe('tokens');

    // Cerebras: 30K TPM would allow two minutes, 5 RPM allows twelve. The
    // report states the twelve explicitly.
    const cerebras = matchFeasibility(limits(5, 1_000, 30_000));
    expect(cerebras.minutesPerMatch).toBe(12);
    expect(cerebras.boundBy).toBe('requests');
  });

  it('rounds minutes up, never down', () => {
    // 60 calls at 8K TPM is 7.5 minutes. Reporting 7 would understate every
    // slow model by up to a minute, and it is the direction that misleads.
    expect(matchFeasibility(limits(30, 1_000, 8_000)).minutesPerMatch).toBe(8);
    // 60 calls at 7 RPM is 8.57 minutes.
    expect(matchFeasibility(limits(7, 1_000, 250_000)).minutesPerMatch).toBe(9);
  });

  it('returns whole integers for every field a picker renders', () => {
    for (const candidate of [
      limits(30, 14_400, 6_000),
      limits(5, 1_000, 30_000),
      limits(15, 500, 250_000),
      limits(1, 1, 1),
    ]) {
      const feasibility = matchFeasibility(candidate);
      expect(Number.isSafeInteger(feasibility.matchesPerDay)).toBe(true);
      expect(Number.isSafeInteger(feasibility.minutesPerMatch)).toBe(true);
    }
  });

  it('flags slow at the threshold, not one minute past it', () => {
    expect(matchFeasibility(limits(30, 14_400, 6_000)).slow).toBe(true);
    // 60 calls at 12K TPM is five minutes, comfortably inside.
    expect(matchFeasibility(limits(30, 1_000, 12_000)).slow).toBe(false);

    // The boundary itself, expressed through the constant rather than a
    // literal, so moving the threshold moves this case with it.
    const atThreshold = limits(
      MATCH_WORST_CASE_CALLS / SLOW_MATCH_MINUTES,
      MATCH_WORST_CASE_CALLS,
      250_000,
    );
    expect(matchFeasibility(atThreshold).minutesPerMatch).toBe(SLOW_MATCH_MINUTES);
    expect(matchFeasibility(atThreshold).slow).toBe(true);
  });
});

describe('the sentence a picker shows (AC2)', () => {
  it('says nothing when there is nothing unusual to say', () => {
    // 16 Matches a day at five minutes each. The RPM/RPD on the option itself
    // already carry this; a notice here would be noise on every row.
    expect(feasibilityNotice(limits(30, 1_000, 12_000))).toBe('');
  });

  it('leads with the daily cap when a Match cannot finish at all', () => {
    const notice = feasibilityNotice(limits(5, 20, 250_000));
    expect(notice).toContain('Cannot finish one Match');
    expect(notice).toContain('20 requests a day');
    expect(notice).toContain(String(MATCH_WORST_CASE_CALLS));
  });

  it('states the minutes and what caused them, before the visitor starts', () => {
    const cerebras = feasibilityNotice(limits(5, 1_000, 30_000));
    expect(cerebras).toContain('12 minutes');
    expect(cerebras).toContain('5 requests a minute');

    const tokenBound = feasibilityNotice(limits(30, 14_400, 6_000));
    expect(tokenBound).toContain('10 minutes');
    expect(tokenBound).toContain('6000 tokens a minute');
  });

  it('prefers the unrunnable sentence over the slow one when both apply', () => {
    // 20 RPD and 5 RPM: both true, and only one of them is worth saying.
    expect(feasibilityNotice(limits(5, 20, 30_000))).toContain('Cannot finish one Match');
  });
});

describe('the committed configuration, measured through this module', () => {
  it('offers no model that cannot finish a Match (AC1)', () => {
    const config = loadFreeTierConfig();
    const unrunnable: string[] = [];
    for (const [provider, entry] of Object.entries(config.providers)) {
      for (const model of Object.keys(entry.models)) {
        if (!matchFeasibility(freeTierLimitsFor(provider, model, config)).runnable) {
          unrunnable.push(`${provider}:${model}`);
        }
      }
      // The defaults matter as much: a discovered model with no row of its own
      // inherits them, and an unrunnable default would offer every unlisted
      // model as if it worked.
      if (!matchFeasibility(entry.defaults).runnable) {
        unrunnable.push(`${provider}:<defaults>`);
      }
    }
    expect(unrunnable).toStrictEqual([]);
  });

  it('keeps the two constants the report tables were computed with', () => {
    expect(MATCH_WORST_CASE_CALLS).toBe(60);
    expect(MATCH_TOKENS_PER_CALL).toBe(1_000);
  });
});
