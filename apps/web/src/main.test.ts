import { describe, expect, it } from 'vitest';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { decisionPointCount, hashChip } from './main';
import { buildDemoLog } from './replay/demo-log';
import { buildReplayFilm } from './replay/film';

/**
 * Story 4.1, the page-facing half of AC5.
 *
 * `mountPlayer` and `renderApp` need a DOM and are exercised in a real browser
 * during the visual check rather than here -- adding jsdom to assert that a
 * `<span>` exists would be a dependency bought for very little, and this
 * package is meant to stay at `vite` plus `vitest`. What is worth pinning
 * without a DOM is the decision the page *displays*: a replay that did not
 * verify has to be loud, and that decision is a pure function.
 */

describe('the hash verdict shown on the page (AC5)', () => {
  it('reports a verified replay', async () => {
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());

    expect(film.matchesRecordedHash).toBe(true);
    expect(hashChip(film)).toStrictEqual({
      label: 'HASH VERIFIED',
      modifier: 'tb-chip--verified',
    });
  });

  it('reports a mismatch loudly, in the failure style', async () => {
    const log = await buildDemoLog();
    const film = buildReplayFilm(
      { ...log, finalStateHash: '0'.repeat(64) },
      createFighterEnvironment(),
    );

    const chip = hashChip(film);
    expect(chip.label).toBe('HASH MISMATCH');
    // The failure modifier is the one that carries --tb-warn. It is how a
    // visitor learns the numbers on screen cannot be trusted.
    expect(chip.modifier).toBe('tb-chip--failed');
  });

  it('counts Decision Points as transitions, not as states', async () => {
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());

    expect(decisionPointCount(film)).toBe(film.states.length - 1);
    expect(decisionPointCount(film)).toBeGreaterThan(0);
  });
});

describe('the demo log', () => {
  it('is a real Match whose hash verifies, so the player never opens on a lie', async () => {
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());

    expect(log.environment.id).toBe('fighter-1v1');
    expect(log.decisions.length).toBeGreaterThan(0);
    expect(film.matchesRecordedHash).toBe(true);
  });

  it('is deterministic in its seed, and different seeds give different Matches', async () => {
    const [a, b, other] = await Promise.all([
      buildDemoLog(4_101),
      buildDemoLog(4_101),
      buildDemoLog(9_999),
    ]);

    expect(a.finalStateHash).toBe(b.finalStateHash);
    expect(a.finalStateHash).not.toBe(other.finalStateHash);
  });
});
