import type { CommandLog } from '@tokenbrawl/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { replayCommandLog } from '../../../../packages/core/src/replay';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { createMockEnvironment } from '../../../../packages/core/src/testing/mock-environment';
import { buildDemoLog } from '../testing/demo-log';
import { BASIS_POINTS_FULL, FRAMES_PER_DECISION, PLAYBACK_FPS, buildReplayFilm } from './film';

/**
 * Story 4.1, AC1, AC2, AC4 and AC5.
 *
 * The load-bearing case is "agrees with replayCommandLog on the final hash".
 * This module steps the environment itself so it can keep the intermediate
 * states the renderer needs, which means there are two loops over one
 * structure -- and two loops drift. That case is what keeps them honest, and
 * it is the one that turns a rendering bug into a test failure.
 */

const SEED = 4_101;

describe('the replay film', () => {
  let log: CommandLog;

  beforeAll(async () => {
    log = await buildDemoLog(SEED);
  });

  it('reproduces visual state by re-running the engine, not by reading stored positions (AC1)', () => {
    const env = createFighterEnvironment();
    const film = buildReplayFilm(log, env);

    // The schema has no per-tick position to read, so the only way states can
    // exist at all is re-simulation. What is checkable is that they are real
    // simulated states: the first is exactly `env.reset(seed)`.
    expect(film.states.length).toBeGreaterThan(1);
    expect(film.states[0]).toStrictEqual(env.reset(SEED));
    expect(film.states[0].tick).toBe(0);

    const ticks = film.states.map((state) => state.tick);
    expect(ticks).toStrictEqual([...ticks].sort((a, b) => a - b));
  });

  it('agrees with replayCommandLog on the final hash (AC5)', () => {
    const env = createFighterEnvironment();
    const film = buildReplayFilm(log, env);
    const authority = replayCommandLog(log, env);

    expect(film.finalStateHash).toBe(authority.finalStateHash);
    expect(film.finalStateHash).toBe(log.finalStateHash);
    expect(film.matchesRecordedHash).toBe(true);
    expect(film.divergences).toStrictEqual([]);
  });

  it('reports a hash mismatch rather than hiding it (AC5)', () => {
    const env = createFighterEnvironment();
    const tampered = { ...log, finalStateHash: 'f'.repeat(64) };
    const film = buildReplayFilm(tampered, env);

    // Still renders. Refusing to build a film would hide the divergence from
    // the one surface a visitor actually looks at.
    expect(film.frames.length).toBeGreaterThan(0);
    expect(film.matchesRecordedHash).toBe(false);
    expect(film.recordedStateHash).not.toBe('f'.repeat(64));
  });

  it('paces on Decision-Point count alone, never on how long anyone thought (AC2)', () => {
    const env = createFighterEnvironment();
    const film = buildReplayFilm(log, env);

    expect(film.frames).toHaveLength((film.states.length - 1) * FRAMES_PER_DECISION);
  });

  it('produces byte-identical films for two logs that differ only in reported usage (AC2)', () => {
    // A "slow" Deployment and a "fast" one differ in nothing the log records
    // about the simulation -- the schema carries no timing field at all. The
    // strongest available statement is that fields a Deployment's speed could
    // plausibly correlate with change nothing about playback.
    const env = createFighterEnvironment();
    const slow: CommandLog = {
      ...log,
      decisions: log.decisions.map((entry) => ({
        ...entry,
        tokensSpent: 8_000,
        reasoningTokens: 7_500,
      })),
    };
    const fast: CommandLog = {
      ...log,
      decisions: log.decisions.map((entry) => ({
        ...entry,
        tokensSpent: 3,
        reasoningTokens: null,
      })),
    };

    const slowFilm = buildReplayFilm(slow, env);
    const fastFilm = buildReplayFilm(fast, env);

    expect(slowFilm.frames).toHaveLength(fastFilm.frames.length);
    expect(slowFilm.states).toStrictEqual(fastFilm.states);
    expect(slowFilm.finalStateHash).toBe(fastFilm.finalStateHash);
  });

  it('renders at a constant 60 frames per playback second (AC4)', () => {
    expect(PLAYBACK_FPS).toBe(60);
    expect(FRAMES_PER_DECISION).toBeGreaterThan(0);
    expect(Number.isSafeInteger(FRAMES_PER_DECISION)).toBe(true);
  });

  it('numbers frames contiguously and keeps progress an integer inside each step', () => {
    const env = createFighterEnvironment();
    const film = buildReplayFilm(log, env);

    for (const [index, frame] of film.frames.entries()) {
      expect(frame.index).toBe(index);
      expect(Number.isSafeInteger(frame.progressBasisPoints)).toBe(true);
      expect(frame.progressBasisPoints).toBeGreaterThanOrEqual(0);
      expect(frame.progressBasisPoints).toBeLessThan(BASIS_POINTS_FULL);
      expect(frame.decisionPoint).toBe(Math.floor(index / FRAMES_PER_DECISION));
    }
  });

  it('starts each Decision Point at progress zero, on the state that Decision Point began in', () => {
    const env = createFighterEnvironment();
    const film = buildReplayFilm(log, env);

    for (let step = 0; step < film.states.length - 1; step += 1) {
      const first = film.frames[step * FRAMES_PER_DECISION];
      expect(first.progressBasisPoints).toBe(0);
      expect(first.from).toStrictEqual(film.states[step]);
      expect(first.to).toStrictEqual(film.states[step + 1]);
    }
  });

  it('rejects an unknown schemaVersion before reading any other field (AD-3)', () => {
    const env = createFighterEnvironment();
    expect(() => buildReplayFilm({ ...log, schemaVersion: '2.0.0' }, env)).toThrow(
      /Unsupported Command Log schemaVersion/,
    );
  });

  it('rejects a log replayed through the wrong adapter', () => {
    expect(() =>
      buildReplayFilm(log, createMockEnvironment() as never),
    ).toThrow(/Environment mismatch/);
  });

  it('returns a frozen film', () => {
    const film = buildReplayFilm(log, createFighterEnvironment());
    expect(Object.isFrozen(film)).toBe(true);
    expect(Object.isFrozen(film.states)).toBe(true);
  });
});
