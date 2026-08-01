import { describe, expect, it } from 'vitest';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { buildDemoLog } from '../testing/demo-log';
import { buildReplayFilm } from './film';
import { createReasoningSource } from './sidecar';
import { resolveDecision } from './decision-point';

/**
 * Story 4.3, AC1: "the reasoning shown is for the Decision Point at that exact
 * position -- not the nearest neighbour."
 *
 * The cases below are split in two on purpose. The first block runs against a
 * hand-written predicate, because that is the only way to state the rule
 * itself without a Match's particular shape getting in the way. The second runs
 * across every position of the committed demo Match, because a rule that holds
 * for hand-picked inputs and not for the log the page actually opens on is not
 * a rule anyone benefits from.
 */

const TICKS = DEFAULT_FIGHTER_CONFIG.ticksPerDecision;

/** Polled at the ticks listed, for agent 0 only unless stated. */
function polledAt(ticks: readonly number[], agentIndex: 0 | 1 = 0) {
  return (tick: number, agent: 0 | 1): boolean => agent === agentIndex && ticks.includes(tick);
}

describe('resolveDecision', () => {
  it('returns this exact Decision Point when the Agent was polled here', () => {
    const resolved = resolveDecision(3, 0, polledAt([0, TICKS, 2 * TICKS, 3 * TICKS]), TICKS);

    expect(resolved).toStrictEqual({ tick: 3 * TICKS, decisionPoint: 3, polled: true });
  });

  it('names the decision a committed fighter is still executing, and flags it', () => {
    // Polled at Decision Point 1 and then committed through 2, 3 and 4 -- an
    // `attack` window is 40 ticks against a 30-tick Decision Point, so this is
    // the ordinary case rather than a contrived one.
    const resolved = resolveDecision(4, 0, polledAt([0, TICKS]), TICKS);

    expect(resolved).toStrictEqual({ tick: TICKS, decisionPoint: 1, polled: false });
  });

  it('never looks forward, even when the next Decision Point is nearer', () => {
    // Polled at 0 and at 10. Asked about 9: the nearest logged entry is 10, and
    // a nearest-neighbour resolver would return it -- showing a decision that
    // has not been taken yet at this position. AC1 forbids exactly this.
    const resolved = resolveDecision(9, 0, polledAt([0, 10 * TICKS]), TICKS);

    expect(resolved?.decisionPoint).toBe(0);
    expect(resolved?.tick).toBe(0);
  });

  it('never crosses to the other Agent history', () => {
    // Agent 1 was polled everywhere; agent 0 never was. Agent 0 must resolve to
    // nothing rather than borrowing its opponent's reasoning.
    const bothTicks = [0, TICKS, 2 * TICKS];
    expect(resolveDecision(2, 0, polledAt(bothTicks, 1), TICKS)).toBeNull();
    expect(resolveDecision(2, 1, polledAt(bothTicks, 1), TICKS)?.polled).toBe(true);
  });

  it('returns null when the Agent has not acted yet', () => {
    expect(resolveDecision(0, 0, () => false, TICKS)).toBeNull();
  });

  it('returns null for a position that is not a whole non-negative Decision Point', () => {
    expect(resolveDecision(-1, 0, () => true, TICKS)).toBeNull();
    expect(resolveDecision(1.5, 0, () => true, TICKS)).toBeNull();
  });

  it('refuses a degenerate ticksPerDecision rather than looping on tick zero', () => {
    // With a pacing of 0 every Decision Point maps to tick 0, so the resolver
    // would answer "Decision Point 0" for every position on the timeline and
    // look entirely healthy doing it.
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveDecision(3, 0, () => true, bad)).toThrow(/positive safe integer/);
    }
  });

  it('is frozen, like every other value the player passes around', () => {
    const resolved = resolveDecision(0, 0, () => true, TICKS);
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});

describe('across every position of the committed demo Match (AC1)', () => {
  it('resolves to a tick that is never ahead of the position, for either fighter', async () => {
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const reasoning = createReasoningSource(log);
    const wasPolled = (tick: number, agent: 0 | 1): boolean => reasoning.at(tick, agent).found;

    let polledHere = 0;
    let stillCommitted = 0;

    for (const frame of film.frames) {
      for (const agentIndex of [0, 1] as const) {
        const resolved = resolveDecision(frame.decisionPoint, agentIndex, wasPolled, TICKS);
        if (resolved === null) {
          continue;
        }
        expect(resolved.tick).toBeLessThanOrEqual(frame.decisionPoint * TICKS);
        expect(wasPolled(resolved.tick, agentIndex)).toBe(true);
        expect(resolved.polled).toBe(resolved.decisionPoint === frame.decisionPoint);
        if (resolved.polled) {
          polledHere += 1;
        } else {
          stillCommitted += 1;
        }
      }
    }

    // Both branches are genuinely exercised by the log the page opens on. If
    // `stillCommitted` were zero this whole module would be untested in
    // practice while every case above still passed.
    expect(polledHere).toBeGreaterThan(0);
    expect(stillCommitted).toBeGreaterThan(0);
  });

  it('gives every frame of one Decision Point the same answer', async () => {
    // AC1 is about a position, and every playback frame inside one Decision
    // Point is the same position as far as the log is concerned. A resolver
    // that drifted within a step would make the panel flicker between two
    // entries while the fighter did one thing.
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const reasoning = createReasoningSource(log);
    const wasPolled = (tick: number, agent: 0 | 1): boolean => reasoning.at(tick, agent).found;

    const byDecisionPoint = new Map<string, string>();
    for (const frame of film.frames) {
      for (const agentIndex of [0, 1] as const) {
        const resolved = resolveDecision(frame.decisionPoint, agentIndex, wasPolled, TICKS);
        const key = `${String(frame.decisionPoint)}:${String(agentIndex)}`;
        const answer = JSON.stringify(resolved);
        expect(byDecisionPoint.get(key) ?? answer).toBe(answer);
        byDecisionPoint.set(key, answer);
      }
    }
    expect(byDecisionPoint.size).toBeGreaterThan(0);
  });
});
