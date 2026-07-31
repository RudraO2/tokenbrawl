import { describe, expect, it } from 'vitest';
import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  DEFAULT_FIGHTER_CONFIG,
  PHASE_ACTIVE,
  PHASE_IDLE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
  assertIntegerConfig,
  canonicalStringify,
  createAggressiveBot,
  createFighterEnvironment,
  createRandomBot,
  createSpacingBot,
  damageForCode,
  legalActionsFor,
  mixSeed,
  nextRngState,
  phaseOf,
  rangeForCode,
  sha256Hex,
  windowFor,
  windowTotalTicks,
  type CommitmentWindow,
  type CommittedActionCode,
  type PhaseCode,
} from './index';

describe('@tokenbrawl/env-fighter public surface', () => {
  it('exports the environment factory', () => {
    const env = createFighterEnvironment();
    expect(env.id).toBe('fighter-1v1');
    expect(typeof env.hash(env.reset(1))).toBe('string');
  });

  it('exports the frame-data config and its validator', () => {
    expect(DEFAULT_FIGHTER_CONFIG.ticksPerDecision).toBe(30);
    expect(() => assertIntegerConfig(DEFAULT_FIGHTER_CONFIG)).not.toThrow();
  });

  it('exports the hashing primitives the replay player will need', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Hex('')).toHaveLength(64);
  });

  it('exports the PRNG helpers as pure functions', () => {
    expect(mixSeed(0)).not.toBe(0);
    expect(nextRngState(1)).toBe(nextRngState(1));
  });

  it('exposes attackWindow and specialWindow, not the removed specialCommitmentTicks', () => {
    // Story 2.2 replaces the single opaque countdown field 2.1 shipped with a
    // startup/active/recovery breakdown per Action. `specialCommitmentTicks`
    // is gone from FighterConfig entirely -- a stray reference to it would be
    // a compile error, which is why this also guards the barrel's re-exported
    // FighterConfig type rather than just the runtime default object.
    expect(DEFAULT_FIGHTER_CONFIG.attackWindow).toStrictEqual({
      startup: 4,
      active: 4,
      recovery: 32,
    });
    expect(DEFAULT_FIGHTER_CONFIG.specialWindow).toStrictEqual({
      startup: 10,
      active: 5,
      recovery: 45,
    });
    expect('specialCommitmentTicks' in DEFAULT_FIGHTER_CONFIG).toBe(false);
  });

  it('exports the Commitment Window frame-data lookups and codes (Story 2.2)', () => {
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK)).toBe(
      DEFAULT_FIGHTER_CONFIG.attackWindow,
    );
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE)).toBeNull();
    expect(windowTotalTicks(DEFAULT_FIGHTER_CONFIG.attackWindow)).toBe(40);
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK, 40)).toBe(PHASE_STARTUP);
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK, 0)).toBe(PHASE_IDLE);
    expect(rangeForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL)).toBe(
      DEFAULT_FIGHTER_CONFIG.specialRange,
    );
    expect(damageForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL)).toBe(
      DEFAULT_FIGHTER_CONFIG.specialDamage,
    );
    expect(
      legalActionsFor(DEFAULT_FIGHTER_CONFIG, DEFAULT_FIGHTER_CONFIG.specialMeterCost),
    ).toContain('special');
    expect(PHASE_ACTIVE).not.toBe(PHASE_RECOVERY);
  });

  it('exports CommitmentWindow, CommittedActionCode and PhaseCode as usable types', () => {
    // These are type-only exports -- there is no runtime value to assert on,
    // so the regression this guards is a barrel that silently drops the
    // `export type` line. Declaring a typed value fails `tsc --noEmit` if the
    // type is missing, which vitest alone would never catch.
    const window: CommitmentWindow = { startup: 1, active: 2, recovery: 3 };
    expect(windowTotalTicks(window)).toBe(6);

    const code: CommittedActionCode = COMMITTED_SPECIAL;
    expect(code).toBe(COMMITTED_SPECIAL);

    const phase: PhaseCode = PHASE_RECOVERY;
    expect(phase).toBe(PHASE_RECOVERY);
  });

  it('exports the three graded Baseline Bot factories (Story 2.3)', () => {
    expect(createRandomBot('bot:random', 1).kind).toBe('bot');
    expect(createAggressiveBot('bot:aggressive').kind).toBe('bot');
    expect(createSpacingBot('bot:spacing').kind).toBe('bot');
  });
});
