import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { buildDemoLog } from '../testing/demo-log';
import { createBankReadout } from './token-bank';
import { BASIS_POINTS_FULL } from './film';

/**
 * Story 4.4.
 *
 * The user story states the design goal rather than a mechanism -- "a visitor
 * with no context works out on their own that the fighter is running out of
 * thinking" -- and the two things that would break it are both data shapes
 * rather than drawing bugs: a meter that flickers because the bank is only
 * recorded when an Agent is polled, and a Baseline Bot showing a full Token
 * Bank it does not have.
 */

const TICKS = DEFAULT_FIGHTER_CONFIG.ticksPerDecision;

function log(
  entries: readonly { tick: number; agentIndex: 0 | 1; bankRemaining?: number }[],
  tokenBankStart?: number,
) {
  return { decisions: entries, ...(tokenBankStart === undefined ? {} : { tokenBankStart }) };
}

describe('reading the Token Bank out of a log (AC1)', () => {
  it('reports the level the log recorded at this Decision Point', () => {
    const readout = createBankReadout(
      log(
        [
          { tick: 0, agentIndex: 0, bankRemaining: 24_000 },
          { tick: TICKS, agentIndex: 0, bankRemaining: 23_100 },
        ],
        25_000,
      ),
      TICKS,
    );

    expect(readout.at(0, 0)?.remaining).toBe(24_000);
    expect(readout.at(1, 0)?.remaining).toBe(23_100);
  });

  it('holds the level through Decision Points where the Agent was not polled', () => {
    // A committed fighter is never asked for an Action, so no entry exists and
    // the bank is unchanged rather than absent. Returning null here would make
    // the meter flicker in and out for a large share of the Match.
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 20_000 }], 25_000),
      TICKS,
    );

    for (const decisionPoint of [0, 1, 2, 7]) {
      expect(readout.at(decisionPoint, 0)?.remaining).toBe(20_000);
    }
  });

  it('shows a full bank before the Agent has been polled at all', () => {
    // Otherwise every Match opens announcing Reflex Mode.
    const readout = createBankReadout(
      log([{ tick: 5 * TICKS, agentIndex: 0, bankRemaining: 900 }], 25_000),
      TICKS,
    );

    expect(readout.at(0, 0)).toMatchObject({ remaining: 25_000, exhausted: false });
    expect(readout.at(0, 0)?.filledBasisPoints).toBe(BASIS_POINTS_FULL);
  });

  it('never reads the other Agent bank', () => {
    const readout = createBankReadout(
      log(
        [
          { tick: 0, agentIndex: 0, bankRemaining: 10 },
          { tick: 0, agentIndex: 1, bankRemaining: 9_000 },
        ],
        25_000,
      ),
      TICKS,
    );

    expect(readout.at(0, 0)?.remaining).toBe(10);
    expect(readout.at(0, 1)?.remaining).toBe(9_000);
  });

  it('keeps the fill an integer in basis points, like every other ratio here', () => {
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 8_333 }], 25_000),
      TICKS,
    );
    const reading = readout.at(0, 0);

    expect(reading?.filledBasisPoints).toBe(Math.floor((8_333 * BASIS_POINTS_FULL) / 25_000));
    expect(Number.isSafeInteger(reading?.filledBasisPoints)).toBe(true);
  });
});

describe('a Baseline Bot has no Token Bank at all (AC3)', () => {
  it('is untracked, which is not the same fact as a bank at zero', () => {
    const readout = createBankReadout(
      log([
        { tick: 0, agentIndex: 0 },
        { tick: TICKS, agentIndex: 0 },
      ]),
      TICKS,
    );

    expect(readout.tracked(0)).toBe(false);
    expect(readout.at(0, 0)).toBeNull();
  });

  it('tracks one side of a Deployment-versus-bot Match and not the other', () => {
    const readout = createBankReadout(
      log(
        [
          { tick: 0, agentIndex: 0, bankRemaining: 24_000 },
          { tick: 0, agentIndex: 1 },
        ],
        25_000,
      ),
      TICKS,
    );

    expect(readout.tracked(0)).toBe(true);
    expect(readout.tracked(1)).toBe(false);
    expect(readout.at(0, 1)).toBeNull();
  });

  it('reports the committed demo Match as two untracked Baseline Bots', async () => {
    // The log the page actually opens on. If this ever starts reporting a bank,
    // either the demo changed or the untracked case has stopped working.
    const readout = createBankReadout(await buildDemoLog(), TICKS);

    expect(readout.tracked(0)).toBe(false);
    expect(readout.tracked(1)).toBe(false);
  });
});

describe('the exhausted state (AC2, AC4)', () => {
  it('marks a bank at zero exhausted', () => {
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 0 }], 25_000),
      TICKS,
    );

    expect(readout.at(0, 0)).toMatchObject({ exhausted: true, filledBasisPoints: 0 });
  });

  it('does not call one token left exhausted', () => {
    // The boundary matters: Reflex Mode engages at zero, not near it, and a
    // meter that gave up early would announce the moment before it happened.
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 1 }], 25_000),
      TICKS,
    );

    expect(readout.at(0, 0)?.exhausted).toBe(false);
  });

  it('lets both banks be exhausted at once (AC4)', () => {
    const readout = createBankReadout(
      log(
        [
          { tick: 0, agentIndex: 0, bankRemaining: 0 },
          { tick: 0, agentIndex: 1, bankRemaining: 0 },
        ],
        25_000,
      ),
      TICKS,
    );

    expect(readout.at(0, 0)?.exhausted).toBe(true);
    expect(readout.at(0, 1)?.exhausted).toBe(true);
  });
});

describe('degenerate documents', () => {
  it('falls back to the highest level seen when the log omits tokenBankStart', () => {
    // The field is optional in the frozen schema, and the bank only ever
    // decreases, so the first reading is the closest thing to a starting budget
    // the document contains.
    const readout = createBankReadout(
      log([
        { tick: 0, agentIndex: 0, bankRemaining: 900 },
        { tick: TICKS, agentIndex: 0, bankRemaining: 450 },
      ]),
      TICKS,
    );

    expect(readout.at(0, 0)?.start).toBe(900);
    expect(readout.at(1, 0)?.filledBasisPoints).toBe(5_000);
  });

  it('produces no NaN width when the start is zero', () => {
    // A NaN width is drawn by the canvas as nothing at all, which looks exactly
    // like a meter that was never wired up.
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 0 }], 0),
      TICKS,
    );

    expect(readout.at(0, 0)?.filledBasisPoints).toBe(0);
    expect(Number.isNaN(readout.at(0, 0)?.filledBasisPoints)).toBe(false);
  });

  it('clamps a level that claims more than the bank started with', () => {
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 90_000 }], 25_000),
      TICKS,
    );

    expect(readout.at(0, 0)?.filledBasisPoints).toBe(BASIS_POINTS_FULL);
  });

  it('ignores a malformed level rather than declaring the Agent untracked', () => {
    const readout = createBankReadout(
      log(
        [
          { tick: 0, agentIndex: 0, bankRemaining: -5 },
          { tick: TICKS, agentIndex: 0, bankRemaining: 12_000 },
        ],
        25_000,
      ),
      TICKS,
    );

    expect(readout.tracked(0)).toBe(true);
    expect(readout.at(1, 0)?.remaining).toBe(12_000);
  });

  it('refuses a degenerate ticksPerDecision', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => createBankReadout(log([]), bad)).toThrow(/positive safe integer/);
    }
  });

  it('returns a frozen reading', () => {
    const readout = createBankReadout(
      log([{ tick: 0, agentIndex: 0, bankRemaining: 1 }], 2),
      TICKS,
    );
    expect(Object.isFrozen(readout.at(0, 0))).toBe(true);
  });
});

describe('across every position of a real Match', () => {
  it('never refills: the level a viewer watches only ever goes down', async () => {
    // The property a visitor actually perceives, and the one a subtle bug in
    // the walk-back breaks. A resolver that failed to carry the level through
    // unpolled Decision Points falls back to the start value, so the meter
    // jumps back to full between polls -- which reads as a bank that refills
    // and destroys the whole point of the HUD. Neither the per-Decision-Point
    // assertions above nor the end-to-end draw tests catch that on their own.
    const base = await buildDemoLog();
    let level = 25_000;
    const metered = {
      ...base,
      tokenBankStart: 25_000,
      decisions: base.decisions.map((entry) => {
        if (entry.agentIndex !== 0) {
          return entry;
        }
        level = Math.max(0, level - 900);
        return { ...entry, bankRemaining: level };
      }),
    };

    const readout = createBankReadout(metered, TICKS);
    const lastDecisionPoint = Math.floor(
      Math.max(...metered.decisions.map((entry) => entry.tick)) / TICKS,
    );

    let previous = Number.POSITIVE_INFINITY;
    let distinct = 0;
    for (let decisionPoint = 0; decisionPoint <= lastDecisionPoint; decisionPoint += 1) {
      const remaining = readout.at(decisionPoint, 0)?.remaining ?? 0;
      expect(remaining).toBeLessThanOrEqual(previous);
      if (remaining !== previous) {
        distinct += 1;
      }
      previous = remaining;
    }

    // And it really did drain, rather than sitting on one value the whole way.
    expect(distinct).toBeGreaterThan(3);
    expect(previous).toBeLessThan(25_000);
  });
});
