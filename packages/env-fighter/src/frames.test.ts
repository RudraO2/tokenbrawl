import { ACTIONS } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import {
  COMMITTED_ATTACK,
  COMMITTED_HITSTUN,
  COMMITTED_JUMP,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_IDLE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
  damageForCode,
  juggleChainTicksElapsed,
  juggleDamageFor,
  juggleHitstunFor,
  jumpFallStepPerTick,
  jumpRiseStepPerTick,
  legalActionsFor,
  phaseOf,
  rangeForCode,
  scaleByJuggleTable,
  windowFor,
  windowTotalTicks,
} from './frames';

describe('windowFor', () => {
  it('returns the attack window for COMMITTED_ATTACK', () => {
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK)).toBe(
      DEFAULT_FIGHTER_CONFIG.attackWindow,
    );
  });

  it('returns the special window for COMMITTED_SPECIAL', () => {
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL)).toBe(
      DEFAULT_FIGHTER_CONFIG.specialWindow,
    );
  });

  it('returns null for COMMITTED_NONE -- no window is open', () => {
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE)).toBeNull();
  });

  it('returns the jump window for COMMITTED_JUMP (AC1, Story 8.2)', () => {
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_JUMP)).toBe(DEFAULT_FIGHTER_CONFIG.jumpWindow);
  });

  it('returns null for an unrecognised code, rather than defaulting to a window', () => {
    // A stray code (a bit-flip, a bad migration) must read as "no window
    // open", not silently fall through to attack's, special's or jump's frame
    // data. 99 rather than 3: 3 is now COMMITTED_JUMP (Story 8.2).
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, 99)).toBeNull();
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, -1)).toBeNull();
  });

  it('returns null for COMMITTED_HITSTUN (Story 8.4) -- hitstun has no phase shape', () => {
    // Hitstun locks a defender out the same way a real Commitment Window
    // does, but it is not one: it has no startup/active/recovery breakdown
    // and attacks nothing, so `phaseOf`/`rangeForCode`/`damageForCode` must
    // never be handed this code.
    expect(windowFor(DEFAULT_FIGHTER_CONFIG, COMMITTED_HITSTUN)).toBeNull();
  });
});

describe('windowTotalTicks', () => {
  it('sums startup + active + recovery', () => {
    expect(windowTotalTicks({ startup: 1, active: 2, recovery: 3 })).toBe(6);
  });

  it('totals 40 ticks for the default attack window (AC1)', () => {
    const frames = DEFAULT_FIGHTER_CONFIG.attackWindow;
    expect(windowTotalTicks(frames)).toBe(frames.startup + frames.active + frames.recovery);
    expect(windowTotalTicks(frames)).toBe(40);
  });

  it('totals 60 ticks for the default special window (AC1)', () => {
    const frames = DEFAULT_FIGHTER_CONFIG.specialWindow;
    expect(windowTotalTicks(frames)).toBe(frames.startup + frames.active + frames.recovery);
    expect(windowTotalTicks(frames)).toBe(60);
  });
});

describe('phaseOf', () => {
  /**
   * Every countdown value for a window, from `total` down to `1`. Boundaries
   * are read back from `phaseOf` itself; the expectation in each `it` below
   * is built from the config's own fields, never a hardcoded tick count, so
   * Story 2.4's recalibration of the frame data cannot silently invalidate
   * this test (AC1).
   */
  function walkedPhases(config: FighterConfig, code: number): readonly number[] {
    // Named `frames`, never `window`: `scripts/audit-invariants.sh`'s INV-3
    // sweep bans the token `window` outright and does not exempt test files
    // or comments, so no identifier or sentence in this package may spell it.
    const frames = windowFor(config, code);
    if (frames === null) {
      throw new Error('walkedPhases: code has no Commitment Window to walk');
    }
    const total = windowTotalTicks(frames);
    const phases: number[] = [];
    for (let remaining = total; remaining >= 1; remaining -= 1) {
      phases.push(phaseOf(config, code, remaining));
    }
    return phases;
  }

  function expectedPhases(config: FighterConfig, code: number): readonly number[] {
    const frames = windowFor(config, code);
    if (frames === null) {
      throw new Error('expectedPhases: code has no Commitment Window to walk');
    }
    return [
      ...Array<number>(frames.startup).fill(PHASE_STARTUP),
      ...Array<number>(frames.active).fill(PHASE_ACTIVE),
      ...Array<number>(frames.recovery).fill(PHASE_RECOVERY),
    ];
  }

  it('walks the attack window through startup, active, recovery in order (AC1)', () => {
    expect(walkedPhases(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK)).toStrictEqual(
      expectedPhases(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK),
    );
  });

  it('walks the special window through startup, active, recovery in order (AC1)', () => {
    expect(walkedPhases(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL)).toStrictEqual(
      expectedPhases(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL),
    );
  });

  it('walks the jump window through rise, apex, fall in order (AC1, Story 8.2)', () => {
    // Same machinery, same assertion shape as attack/special above: jump opens
    // no parallel window system, so it must walk through phaseOf identically.
    expect(walkedPhases(DEFAULT_FIGHTER_CONFIG, COMMITTED_JUMP)).toStrictEqual(
      expectedPhases(DEFAULT_FIGHTER_CONFIG, COMMITTED_JUMP),
    );
  });

  it('is PHASE_IDLE once remaining reaches 0, for both windows', () => {
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK, 0)).toBe(PHASE_IDLE);
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL, 0)).toBe(PHASE_IDLE);
  });

  it('is PHASE_IDLE for a negative remaining, which a real countdown should never reach', () => {
    // `commitmentRemaining` only ever decrements to exactly 0 in step(), but
    // phaseOf must not crash or misclassify if it is ever asked about a value
    // past that -- a defensive boundary, not a reachable game state.
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK, -1)).toBe(PHASE_IDLE);
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL, -100)).toBe(PHASE_IDLE);
  });

  it('is PHASE_IDLE for COMMITTED_NONE at any remaining -- no window means no phase', () => {
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE, 0)).toBe(PHASE_IDLE);
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE, 40)).toBe(PHASE_IDLE);
    expect(phaseOf(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE, -5)).toBe(PHASE_IDLE);
  });
});

describe('jump gravity step (AC4, Story 8.2)', () => {
  it('divides jumpHeight evenly across the rise and fall Tick counts by default', () => {
    // The default config was chosen so 32 / 16 has no remainder -- pinned here
    // so a future recalibration that reintroduces one is a visible, deliberate
    // choice rather than a silent drift into a Tick that idles.
    expect(jumpRiseStepPerTick(DEFAULT_FIGHTER_CONFIG)).toBe(2);
    expect(jumpFallStepPerTick(DEFAULT_FIGHTER_CONFIG)).toBe(2);
    expect(jumpRiseStepPerTick(DEFAULT_FIGHTER_CONFIG) * DEFAULT_FIGHTER_CONFIG.jumpWindow.startup).toBe(
      DEFAULT_FIGHTER_CONFIG.jumpHeight,
    );
    expect(jumpFallStepPerTick(DEFAULT_FIGHTER_CONFIG) * DEFAULT_FIGHTER_CONFIG.jumpWindow.recovery).toBe(
      DEFAULT_FIGHTER_CONFIG.jumpHeight,
    );
  });

  it('floors an uneven division rather than producing a float (AD-5)', () => {
    const uneven: FighterConfig = {
      ...DEFAULT_FIGHTER_CONFIG,
      jumpHeight: 10,
      jumpWindow: { startup: 3, active: 1, recovery: 4 },
    };
    expect(jumpRiseStepPerTick(uneven)).toBe(3);
    expect(jumpFallStepPerTick(uneven)).toBe(2);
    expect(Number.isInteger(jumpRiseStepPerTick(uneven))).toBe(true);
    expect(Number.isInteger(jumpFallStepPerTick(uneven))).toBe(true);
  });
});

describe('rangeForCode / damageForCode', () => {
  it('returns the attack range and damage', () => {
    expect(rangeForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK)).toBe(
      DEFAULT_FIGHTER_CONFIG.attackRange,
    );
    expect(damageForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_ATTACK)).toBe(
      DEFAULT_FIGHTER_CONFIG.attackDamage,
    );
  });

  it('returns the special range and damage', () => {
    expect(rangeForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL)).toBe(
      DEFAULT_FIGHTER_CONFIG.specialRange,
    );
    expect(damageForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_SPECIAL)).toBe(
      DEFAULT_FIGHTER_CONFIG.specialDamage,
    );
  });

  it('throws for COMMITTED_NONE naming the code, rather than returning 0', () => {
    // A `0` return would silently mean "connects only at zero separation" (or
    // "deals zero damage") instead of saying a caller asked about a fighter
    // with no window open at all -- a logic error that should be loud.
    expect(() => rangeForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE)).toThrow(
      new RegExp(`committed Action code ${COMMITTED_NONE}`),
    );
    expect(() => damageForCode(DEFAULT_FIGHTER_CONFIG, COMMITTED_NONE)).toThrow(
      new RegExp(`committed Action code ${COMMITTED_NONE}`),
    );
  });
});

describe('legalActionsFor', () => {
  it('returns the full frozen ACTIONS list when meter covers the special cost', () => {
    expect(
      legalActionsFor(DEFAULT_FIGHTER_CONFIG, DEFAULT_FIGHTER_CONFIG.specialMeterCost + 1),
    ).toStrictEqual(ACTIONS);
  });

  it('includes special at exactly the cost -- the boundary is inclusive', () => {
    expect(
      legalActionsFor(DEFAULT_FIGHTER_CONFIG, DEFAULT_FIGHTER_CONFIG.specialMeterCost),
    ).toStrictEqual(ACTIONS);
  });

  it('omits special below cost, keeping the other four Actions in frozen order (AC3)', () => {
    const result = legalActionsFor(
      DEFAULT_FIGHTER_CONFIG,
      DEFAULT_FIGHTER_CONFIG.specialMeterCost - 1,
    );
    expect(result).toStrictEqual(ACTIONS.filter((action) => action !== 'special'));
    expect(result).not.toContain('special');
  });

  it('always includes special when specialMeterCost is 0', () => {
    const freeSpecial: FighterConfig = { ...DEFAULT_FIGHTER_CONFIG, specialMeterCost: 0 };
    expect(legalActionsFor(freeSpecial, 0)).toStrictEqual(ACTIONS);
  });
});

describe('juggle scaling table (Story 8.4)', () => {
  const TABLE = [100, 80, 40, 0];

  it('scales by the percentage at the exact index', () => {
    expect(scaleByJuggleTable(10, TABLE, 0)).toBe(10);
    expect(scaleByJuggleTable(10, TABLE, 1)).toBe(8);
    expect(scaleByJuggleTable(10, TABLE, 2)).toBe(4);
    expect(scaleByJuggleTable(10, TABLE, 3)).toBe(0);
  });

  it('clamps a Juggle Count past the table to its last entry, rather than throwing', () => {
    expect(scaleByJuggleTable(10, TABLE, 4)).toBe(0);
    expect(scaleByJuggleTable(10, TABLE, 999)).toBe(0);
  });

  it('clamps a negative Juggle Count to the table\'s first entry', () => {
    expect(scaleByJuggleTable(10, TABLE, -1)).toBe(10);
  });

  it('floors an uneven scale rather than producing a float (AD-5)', () => {
    const result = scaleByJuggleTable(7, [50], 0);
    expect(result).toBe(3);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('juggleDamageFor and juggleHitstunFor read from their own configured tables', () => {
    const config: FighterConfig = {
      ...DEFAULT_FIGHTER_CONFIG,
      hitstunTicks: 20,
      juggleDamageScalePercent: [100, 50],
      juggleHitstunScalePercent: [100, 25],
    };
    expect(juggleDamageFor(config, 8, 0)).toBe(8);
    expect(juggleDamageFor(config, 8, 1)).toBe(4);
    expect(juggleHitstunFor(config, 0)).toBe(20);
    expect(juggleHitstunFor(config, 1)).toBe(5);
  });

  it('juggleChainTicksElapsed sums hitstun across the chain so far, excluding the hit at juggleCount', () => {
    const config: FighterConfig = {
      ...DEFAULT_FIGHTER_CONFIG,
      hitstunTicks: 10,
      juggleHitstunScalePercent: [100, 100, 50, 0],
    };
    expect(juggleChainTicksElapsed(config, 0)).toBe(0);
    expect(juggleChainTicksElapsed(config, 1)).toBe(10);
    expect(juggleChainTicksElapsed(config, 2)).toBe(20);
    expect(juggleChainTicksElapsed(config, 3)).toBe(25);
    expect(juggleChainTicksElapsed(config, 4)).toBe(25);
  });

  it("the default config's juggleTickCap is exactly the sum its own table produces", () => {
    // Pinned so a future recalibration of either table drifts the cap along
    // with it rather than silently falling out of sync (config.ts's comment
    // states this as a provable property, not a coincidence).
    expect(juggleChainTicksElapsed(DEFAULT_FIGHTER_CONFIG, DEFAULT_FIGHTER_CONFIG.juggleMaxCount)).toBe(
      DEFAULT_FIGHTER_CONFIG.juggleTickCap,
    );
  });
});
