import { describe, expect, it } from 'vitest';
import type { CommandLogV2, TerminalResult } from '@tokenbrawl/contracts';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { defaultKeyMap, type ArcadeMatchHandle, type ArcadeRunConfig } from './run';
import {
  MAX_ROUNDS,
  ROUNDS_TO_WIN_SET,
  matchSeedFor,
  roundWinner,
  runArcadeSession,
  setIsOver,
  type ArcadeSetEnd,
} from './session';

/**
 * Story 12.7: the best-of-three set, driven with a fake `run` so the whole
 * set's logic -- seeds, tally, first-to-two, up-to-three-logs -- is provable
 * with no real Match and no DOM.
 */

const MAX_SEED = 4_294_967_295;

function logWith(outcome: 'p1' | 'p2' | 'draw'): CommandLogV2 {
  const result: TerminalResult = {
    outcome,
    endTick: 1200,
    endReason: 'timeout',
    healthRemaining: [0, 0],
  };
  return {
    schemaVersion: '2.0.0',
    result,
    agents: [
      { id: 'p1:human', kind: 'human' },
      { id: 'p2:bot:random', kind: 'bot' },
    ],
  } as unknown as CommandLogV2;
}

interface FakeRun {
  readonly run: (config: ArcadeRunConfig) => ArcadeMatchHandle;
  readonly calls: readonly ArcadeRunConfig[];
  readonly fed: readonly string[][];
  readonly resolve: (round: number, log: CommandLogV2) => void;
}

function createFakeRun(): FakeRun {
  const calls: ArcadeRunConfig[] = [];
  const fed: string[][] = [];
  const resolvers: ((log: CommandLogV2) => void)[] = [];
  return {
    run: (config): ArcadeMatchHandle => {
      const index = calls.length;
      calls.push(config);
      fed[index] = [];
      return {
        log: new Promise<CommandLogV2>((resolve) => {
          resolvers[index] = resolve;
        }),
        feedInput: (raw: string): void => {
          fed[index].push(raw);
        },
      };
    },
    calls,
    fed,
    resolve: (round: number, log: CommandLogV2): void => resolvers[round]?.(log),
  };
}

/** Drains the microtask queue the async round-transition rides on. */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('the seed derivation (12.7)', () => {
  it('is deterministic, inside the frozen seed bound, and different per round', () => {
    for (const seed of [0, 1, 9_201, MAX_SEED]) {
      const seeds = [0, 1, 2].map((round) => matchSeedFor(seed, round));
      for (const derived of seeds) {
        expect(Number.isSafeInteger(derived)).toBe(true);
        expect(derived).toBeGreaterThanOrEqual(0);
        expect(derived).toBeLessThanOrEqual(MAX_SEED);
      }
      expect(new Set(seeds).size).toBe(3);
      // Same inputs, same output -- a thousand times.
      expect(new Set(Array.from({ length: 1_000 }, () => matchSeedFor(seed, 1))).size).toBe(1);
    }
    expect(matchSeedFor(1, 0)).not.toBe(matchSeedFor(2, 0));
  });
});

describe('reading a round off its result (12.7)', () => {
  it('names the winning side, or nobody for a draw', () => {
    expect(roundWinner(logWith('p1').result)).toBe(0);
    expect(roundWinner(logWith('p2').result)).toBe(1);
    expect(roundWinner(logWith('draw').result)).toBeNull();
  });

  it('ends the set at two wins or three rounds', () => {
    expect(setIsOver([1, 0], 1)).toBe(false);
    expect(setIsOver([ROUNDS_TO_WIN_SET, 0], 2)).toBe(true);
    expect(setIsOver([1, 1], MAX_ROUNDS)).toBe(true);
  });
});

describe('the set runs as best-of-three (12.7)', () => {
  it('stops at two wins, so a 2-0 set runs two Matches and not three', async () => {
    const fake = createFakeRun();
    const rounds: number[] = [];
    const setEnds: ArcadeSetEnd[] = [];
    runArcadeSession({
      seed: 100,
      humanSide: 0,
      mapInput: defaultKeyMap,
      run: fake.run,
      onRoundEnd: (event) => {
        rounds.push(event.round);
      },
      onSetEnd: (event) => {
        setEnds.push(event);
      },
    });

    expect(fake.calls).toHaveLength(1);
    fake.resolve(0, logWith('p1'));
    await tick();
    expect(fake.calls).toHaveLength(2);
    fake.resolve(1, logWith('p1'));
    await tick();

    // No third Match: the human took two in a row.
    expect(fake.calls).toHaveLength(2);
    expect(rounds).toStrictEqual([0, 1]);
    expect(setEnds).toHaveLength(1);
    expect(setEnds[0].roundsWon).toStrictEqual([2, 0]);
    expect(setEnds[0].humanWon).toBe(true);
    expect(setEnds[0].logs).toHaveLength(2);
  });

  it('plays a third Match when the set is split, and hands over all three logs', async () => {
    const fake = createFakeRun();
    const setEnds: ArcadeSetEnd[] = [];
    runArcadeSession({
      seed: 7,
      humanSide: 1,
      mapInput: defaultKeyMap,
      run: fake.run,
      onSetEnd: (event) => {
        setEnds.push(event);
      },
    });

    fake.resolve(0, logWith('p1'));
    await tick();
    fake.resolve(1, logWith('p2'));
    await tick();
    expect(fake.calls).toHaveLength(3);
    fake.resolve(2, logWith('p2'));
    await tick();

    expect(setEnds[0].roundsWon).toStrictEqual([1, 2]);
    expect(setEnds[0].logs).toHaveLength(3);
  });

  it('caps at three rounds even when a draw leaves neither side at two', async () => {
    const fake = createFakeRun();
    const setEnds: ArcadeSetEnd[] = [];
    runArcadeSession({
      seed: 3,
      humanSide: 0,
      mapInput: defaultKeyMap,
      run: fake.run,
      onSetEnd: (event) => {
        setEnds.push(event);
      },
    });

    fake.resolve(0, logWith('p1'));
    await tick();
    fake.resolve(1, logWith('draw'));
    await tick();
    fake.resolve(2, logWith('p2'));
    await tick();

    expect(fake.calls).toHaveLength(3);
    expect(setEnds[0].roundsWon).toStrictEqual([1, 1]);
    // A 1-1 set with a draw is not a win for the visitor.
    expect(setEnds[0].humanWon).toBe(false);
  });

  it('derives each round its own seed from the session seed', async () => {
    const fake = createFakeRun();
    runArcadeSession({ seed: 9_201, humanSide: 0, mapInput: defaultKeyMap, run: fake.run });

    fake.resolve(0, logWith('p1'));
    await tick();
    fake.resolve(1, logWith('p2'));
    await tick();

    expect(fake.calls[0].seed).toBe(matchSeedFor(9_201, 0));
    expect(fake.calls[1].seed).toBe(matchSeedFor(9_201, 1));
    expect(fake.calls[2].seed).toBe(matchSeedFor(9_201, 2));
    // And the whole set carries the visitor's chosen side unchanged.
    expect(fake.calls.every((call) => call.humanSide === 0)).toBe(true);
  });
});

describe('driving the set (12.7)', () => {
  it('forwards input to the round in play and never to a finished one', async () => {
    const fake = createFakeRun();
    const session = runArcadeSession({
      seed: 5,
      humanSide: 0,
      mapInput: defaultKeyMap,
      run: fake.run,
    });

    session.feedInput('z');
    expect(fake.fed[0]).toStrictEqual(['z']);

    fake.resolve(0, logWith('p1'));
    await tick();
    session.feedInput('x');
    expect(fake.fed[1]).toStrictEqual(['x']);
    // The finished round got nothing more.
    expect(fake.fed[0]).toStrictEqual(['z']);
  });

  it('awaits the caller between rounds, holding the next Match until the pause resolves', async () => {
    const fake = createFakeRun();
    let release: (() => void) | undefined;
    runArcadeSession({
      seed: 5,
      humanSide: 0,
      mapInput: defaultKeyMap,
      run: fake.run,
      onRoundEnd: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });

    fake.resolve(0, logWith('p1'));
    await tick();
    // The overlay hold is still open, so the next Match has not begun.
    expect(fake.calls).toHaveLength(1);
    release?.();
    await tick();
    expect(fake.calls).toHaveLength(2);
  });

  it('stops starting rounds once cancelled', async () => {
    const fake = createFakeRun();
    const session = runArcadeSession({
      seed: 5,
      humanSide: 0,
      mapInput: defaultKeyMap,
      run: fake.run,
    });

    session.cancel();
    fake.resolve(0, logWith('p1'));
    await tick();
    // The cancelled set does not open a second round.
    expect(fake.calls).toHaveLength(1);
  });

  it('reports the round logs it collected, untouched (AC: up to three valid CommandLogV2)', async () => {
    const fake = createFakeRun();
    const collected: CommandLogV2[] = [];
    runArcadeSession({
      seed: 5,
      humanSide: 0,
      mapInput: defaultKeyMap,
      run: fake.run,
      onSetEnd: (event) => collected.push(...event.logs),
    });

    const first = logWith('p1');
    const second = logWith('p1');
    fake.resolve(0, first);
    await tick();
    fake.resolve(1, second);
    await tick();

    // The session collects, it does not rebuild: each log is the very object
    // `run` produced, so the human identity and the v2 schema `runArcadeMatch`
    // stamps survive to the set result unchanged.
    expect(collected).toStrictEqual([first, second]);
    expect(collected.every((log) => log.agents[0].kind === 'human')).toBe(true);
  });
});

describe('a real set produces up-to-three verifying logs (12.7, AC: inspect the logs)', () => {
  it('drives a whole set of real Matches and every log verifies its own hash', async () => {
    const collected: CommandLogV2[] = [];
    let over = false;
    const session = runArcadeSession({
      seed: 4_601,
      humanSide: 0,
      mapInput: defaultKeyMap,
      // Default `run` -- runArcadeMatch -- so these are full, unmodified Matches.
      onSetEnd: (event) => {
        collected.push(...event.logs);
        over = true;
      },
    });

    const KEYS = ['ArrowRight', 'z', 'x', 'ArrowLeft', 'c'];
    let step = 0;
    // Between rounds `feedInput` is briefly a no-op (the next round has not
    // started yet); feeding straight through is harmless and keeps the set
    // moving without modelling the gap.
    while (!over && step < 40_000) {
      session.feedInput(KEYS[step % KEYS.length]);
      step += 1;
      await Promise.resolve();
    }

    expect(over).toBe(true);
    expect(collected.length).toBeGreaterThanOrEqual(2);
    expect(collected.length).toBeLessThanOrEqual(3);

    const env = createFighterEnvironment();
    for (const log of collected) {
      // Each is a full, unmodified CommandLogV2: schema v2, a human Agent kept
      // out of the ratings (AD-14), and a Final-State Hash that verifies against
      // an independent replay -- the frozen contract honoured, no round field.
      expect(log.schemaVersion).toBe('2.0.0');
      expect(log.agents.some((agent) => agent.kind === 'human')).toBe(true);
      expect(buildReplayFilm(log, env).matchesRecordedHash).toBe(true);
    }
  });
});
