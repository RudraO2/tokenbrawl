import { describe, expect, it } from 'vitest';
import { ACTIONS, type Action } from '@tokenbrawl/contracts';
import { validateCommandLogV2 } from '../../../../packages/core/src/command-log-v2';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { buildReplayFilm } from '../replay/film';
import { defaultKeyMap, runArcadeMatch, type ArcadeMatchHandle } from './run';

/**
 * Story 9.2, integration: a whole Human-vs-Baseline-Bot Match, headless.
 *
 * No real timers and no DOM -- a scripted sequence of mapped inputs is fed to
 * the running Match on a microtask cadence, standing in for a visitor's own
 * keydowns. `feedInput` is a no-op whenever the human is not the one waiting
 * (mid-Commitment-Window, or already answered this Decision Point), so the
 * loop just keeps offering a rotating key and lets `createHumanAgent`'s own
 * clamp decide what reaches `decide()`.
 */

const KEYS = ['ArrowRight', 'z', 'x', 'c', 'ArrowLeft'] as const;

/** Every key in `KEYS` maps to a distinct Action, so the rotation covers the grammar. */
function driveToTerminal(handle: ArcadeMatchHandle, maxTicks = 5_000): Promise<void> {
  let settled = false;
  void handle.log.then(() => {
    settled = true;
  });

  return (async () => {
    let index = 0;
    let iterations = 0;
    while (!settled && iterations < maxTicks) {
      handle.feedInput(KEYS[index % KEYS.length]);
      index += 1;
      iterations += 1;
      // Yields to the microtask queue so a resolved decide() can carry
      // runMatch's loop forward before the next input is offered.
      await Promise.resolve();
    }
  })();
}

describe('a whole Match runs against a scripted human, headless', () => {
  it('reaches a terminal state and produces a valid CommandLogV2', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    expect(() => validateCommandLogV2(log)).not.toThrow();
    expect(log.schemaVersion).toBe('2.0.0');
    expect(log.decisions.length).toBeGreaterThan(0);
    expect(['p1', 'p2', 'draw']).toContain(log.result.outcome);
  });

  it('marks the human side kind: "human" and the other side kind: "bot"', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    expect(log.agents[0].kind).toBe('human');
    expect(log.agents[1].kind).toBe('bot');
  });

  it('plays the human on side 1 when configured that way', async () => {
    const handle = runArcadeMatch({ seed: 4_602, humanSide: 1, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    expect(log.agents[0].kind).toBe('bot');
    expect(log.agents[1].kind).toBe('human');
  });

  it('writes zero token fields for every decision on either side', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    for (const entry of log.decisions) {
      expect(entry.tokensSpent).toBeUndefined();
      expect(entry.reasoningTokens).toBeUndefined();
      expect(entry.bankRemaining).toBeUndefined();
      expect(entry.reflexMode).toBeUndefined();
    }
  });

  it('only ever logs an Action the human actually fed it, for the human side', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    const fedActions = new Set<Action>(KEYS.map((key) => defaultKeyMap(key)).filter((a): a is Action => a !== null));
    for (const entry of log.decisions) {
      if (entry.agentIndex === 0) {
        expect([...fedActions, 'stand']).toContain(entry.action);
      }
    }
  });

  it('ignores an unmapped key mid-Match without ever crashing the Match', async () => {
    const handle = runArcadeMatch({
      seed: 4_601,
      humanSide: 0,
      mapInput: (raw) => (raw === 'Escape' ? null : defaultKeyMap(raw)),
    });

    let settled = false;
    void handle.log.then(() => {
      settled = true;
    });

    let iterations = 0;
    while (!settled && iterations < 5_000) {
      // Interleave a dead key with the legal rotation; the Match must still
      // finish, since the dead key is dropped rather than blocking anything.
      handle.feedInput('Escape');
      handle.feedInput(KEYS[iterations % KEYS.length]);
      iterations += 1;
      await Promise.resolve();
    }

    const log = await handle.log;
    expect(() => validateCommandLogV2(log)).not.toThrow();
  });

  it('never lets an out-of-grammar action reach a decision entry', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(handle);
    const log = await handle.log;

    const grammar = new Set<string>([...ACTIONS, 'stand']);
    for (const entry of log.decisions) {
      expect(grammar.has(entry.action)).toBe(true);
    }
  });
});

/**
 * Story 12.2: the live-frame tee is a read, and a read cannot move the Match.
 *
 * `onState` observes every `FighterState` the Match passes through so the panel
 * can draw the fight while it is played. The whole safety argument is that
 * wrapping `env.reset`/`env.step` forwards each call's own return value
 * untouched -- so the Command Log and its Final-State Hash must be byte-identical
 * to a headless run, and the states it reports must be exactly the sequence
 * `buildReplayFilm` rebuilds from the finished log.
 */
describe('the live-frame tee', () => {
  it('reports the exact state sequence buildReplayFilm rebuilds, and agrees on the final hash', async () => {
    const collected: FighterState[] = [];
    const handle = runArcadeMatch({
      seed: 4_601,
      humanSide: 0,
      mapInput: defaultKeyMap,
      onState: (state) => collected.push(state),
    });
    await driveToTerminal(handle);
    const log = await handle.log;

    const env = createFighterEnvironment();
    const film = buildReplayFilm(log, env);

    // The tee saw the reset state plus one state per step -- exactly the film's
    // `states`, state for state.
    expect(collected.length).toBe(film.states.length);
    const hasher = createFighterEnvironment();
    expect(collected.map((state) => hasher.hash(state))).toEqual(
      film.states.map((state) => hasher.hash(state)),
    );
    // And the last state the tee saw is the one the log commits to.
    expect(hasher.hash(collected[collected.length - 1])).toBe(log.finalStateHash);
  });

  it('produces a byte-identical Command Log whether or not the live view is watching', async () => {
    const headless = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveToTerminal(headless);
    const headlessLog = await headless.log;

    const watched = runArcadeMatch({
      seed: 4_601,
      humanSide: 0,
      mapInput: defaultKeyMap,
      onState: () => undefined,
    });
    await driveToTerminal(watched);
    const watchedLog = await watched.log;

    expect(JSON.stringify(watchedLog)).toBe(JSON.stringify(headlessLog));
    expect(watchedLog.finalStateHash).toBe(headlessLog.finalStateHash);
  });

  it('contains a throw from the listener, and reports it exactly once', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (message: unknown): void => {
      warnings.push(String(message));
    };

    try {
      const handle = runArcadeMatch({
        seed: 4_601,
        humanSide: 0,
        mapInput: defaultKeyMap,
        onState: () => {
          throw new Error('a UI callback blew up');
        },
      });
      await driveToTerminal(handle);
      const log = await handle.log;

      // The Match still reached a terminal state despite every state report
      // throwing -- the tee contained each one exactly as the onLegalActions tee
      // does.
      expect(['p1', 'p2', 'draw']).toContain(log.result.outcome);
    } finally {
      console.warn = realWarn;
    }

    // Once, not per frame: a live view that dies must be visible to the visual
    // gate's `console-clean` check, and a per-frame warning would drown the very
    // console it reports through.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Arcade live view failed');
  });
});

/**
 * Story 10.6.
 *
 * `ULTIMATE_KEYS` is the cycle that actually arms the gauge, and finding it was
 * the substantive part of this story -- see `panel.test.ts`'s note. `advance`
 * is in it because the fighters start 320 units apart and an attack thrown from
 * across the stage lands on nobody: a policy of pure attacking finishes a whole
 * Match at 100/100 health and 0 meter on both sides.
 */
const ULTIMATE_KEYS = ['ArrowRight', 'z', 'l'] as const;

function driveWith(
  handle: ArcadeMatchHandle,
  keys: readonly string[],
  maxTicks = 5_000,
): Promise<void> {
  let settled = false;
  void handle.log.then(() => {
    settled = true;
  });

  return (async () => {
    let index = 0;
    let iterations = 0;
    while (!settled && iterations < maxTicks) {
      handle.feedInput(keys[index % keys.length]);
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }
  })();
}

describe('the L binding (Story 10.6, AC4)', () => {
  it('maps both cases of L to special', () => {
    expect(defaultKeyMap('l')).toBe('special');
    expect(defaultKeyMap('L')).toBe('special');
  });

  it('leaves every binding Story 9.2 shipped exactly where it was', () => {
    // AC4 in full. `C` in particular: adding `L` is an addition, not a rebind,
    // and a player who has been pressing `C` since 9.2 must not discover that
    // it silently stopped working.
    expect(defaultKeyMap('ArrowRight')).toBe('advance');
    expect(defaultKeyMap('ArrowLeft')).toBe('retreat');
    expect(defaultKeyMap('z')).toBe('attack');
    expect(defaultKeyMap('Z')).toBe('attack');
    expect(defaultKeyMap('x')).toBe('block');
    expect(defaultKeyMap('X')).toBe('block');
    expect(defaultKeyMap('c')).toBe('special');
    expect(defaultKeyMap('C')).toBe('special');
  });

  it('still maps nothing else, so L did not widen the grammar', () => {
    for (const raw of ['k', 'm', 'Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', '']) {
      expect(defaultKeyMap(raw)).toBeNull();
    }
  });
});

describe('the panel is told when the gauge arms (Story 10.6, AC3)', () => {
  it('reports the human side’s legalActions on every Decision Point it is polled on', async () => {
    const reports: (readonly string[])[] = [];
    const handle = runArcadeMatch({
      seed: 9_201,
      humanSide: 0,
      mapInput: defaultKeyMap,
      onLegalActions: (legalActions) => {
        reports.push([...legalActions]);
      },
    });
    await driveWith(handle, ULTIMATE_KEYS);
    const log = await handle.log;

    // One report per Decision Point the human was actually polled on.
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.length).toBe(log.decisions.filter((entry) => entry.agentIndex === 0).length);
    // It starts locked -- the bar is empty at Tick 0 -- and unlocks later. Both
    // halves matter: a list that always contained `special` would make the
    // affordance permanent, and one that never did would make it dead.
    expect(reports[0]).not.toContain('special');
    expect(reports.some((entry) => entry.includes('special'))).toBe(true);
  });

  it('is a report and not a gate: a listener that throws does not break the Match', async () => {
    // It sits on the Agent's `observe`, which is inside the Harness's own loop.
    // A UI callback must not be able to fail a Decision Point.
    const handle = runArcadeMatch({
      seed: 9_201,
      humanSide: 0,
      mapInput: defaultKeyMap,
      onLegalActions: () => {
        throw new Error('the panel blew up');
      },
    });
    await driveWith(handle, ULTIMATE_KEYS);
    const log = await handle.log;

    expect(() => validateCommandLogV2(log)).not.toThrow();
    expect(log.decisions.length).toBeGreaterThan(0);
  });

  it('runs identically with no listener supplied at all', async () => {
    const withListener = runArcadeMatch({
      seed: 9_201,
      humanSide: 0,
      mapInput: defaultKeyMap,
      onLegalActions: () => undefined,
    });
    const without = runArcadeMatch({ seed: 9_201, humanSide: 0, mapInput: defaultKeyMap });
    await Promise.all([driveWith(withListener, ULTIMATE_KEYS), driveWith(without, ULTIMATE_KEYS)]);

    const [a, b] = await Promise.all([withListener.log, without.log]);
    expect(a.finalStateHash).toBe(b.finalStateHash);
    expect(a.decisions.map((entry) => entry.action)).toStrictEqual(
      b.decisions.map((entry) => entry.action),
    );
  });
});

describe('a human really can fill the gauge and throw the Ultimate (Story 10.6, AC1)', () => {
  it('banks a full bar and logs a special from the human side', async () => {
    // The story's central claim, and the one Story 10.4's visual check doubted:
    // it measured peak gauge fills of 62%, 55%, 1% and 1% by hand and warned
    // that this story "must not assume the gauge will be armed". The warning was
    // right about the risk and wrong about the cause -- the two 1% runs were
    // whiffs, because attacks thrown from the starting distance reach nobody.
    // A policy that closes the distance banks a full bar with room to spare.
    const handle = runArcadeMatch({ seed: 9_201, humanSide: 0, mapInput: defaultKeyMap });
    await driveWith(handle, ULTIMATE_KEYS);
    const log = await handle.log;

    const human = log.decisions.filter((entry) => entry.agentIndex === 0);
    expect(human.some((entry) => entry.action === 'special')).toBe(true);
  });

  it('does the same on a second seed, so the case above is not one lucky Match', async () => {
    const handle = runArcadeMatch({ seed: 4_601, humanSide: 0, mapInput: defaultKeyMap });
    await driveWith(handle, ULTIMATE_KEYS);
    const log = await handle.log;

    expect(
      log.decisions.some((entry) => entry.agentIndex === 0 && entry.action === 'special'),
    ).toBe(true);
  });

  it('lands the Ultimate only after the gauge reported itself full', async () => {
    // Ordering, which is the property that says the key is gated on the meter
    // rather than merely coinciding with it: no `special` is ever logged for the
    // human before the first Decision Point whose `legalActions` contained it.
    const armedAt: number[] = [];
    let polled = 0;
    const handle = runArcadeMatch({
      seed: 9_201,
      humanSide: 0,
      mapInput: defaultKeyMap,
      onLegalActions: (legalActions) => {
        if (legalActions.includes('special')) {
          armedAt.push(polled);
        }
        polled += 1;
      },
    });
    await driveWith(handle, ULTIMATE_KEYS);
    const log = await handle.log;

    const human = log.decisions.filter((entry) => entry.agentIndex === 0);
    const firstUltimate = human.findIndex((entry) => entry.action === 'special');
    expect(firstUltimate).toBeGreaterThanOrEqual(0);
    expect(armedAt.length).toBeGreaterThan(0);
    expect(firstUltimate).toBeGreaterThanOrEqual(armedAt[0]);
  });
});
