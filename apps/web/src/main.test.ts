import { describe, expect, it } from 'vitest';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { decisionPointCount, hashChip, mountPlayer, reasoningPanel, type CanvasSurface } from './main';
import { buildDemoLog } from './testing/demo-log';
import { buildReplayFilm } from './replay/film';
import type { ReasoningLookup } from './replay/sidecar';
import type { Canvas2D } from './render/canvas2d';
import type { DrawnFighter, FighterArtist } from './render/artist';

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

/**
 * Story 4.2: the dressing arrives after the fight has started, and it has to
 * land on the right fighter.
 */

function silentCanvas(): CanvasSurface {
  const context = new Proxy<Record<string, unknown>>(
    { fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', imageSmoothingEnabled: false, globalAlpha: 1 },
    {
      get: (target, property: string): unknown =>
        property in target ? target[property] : (): void => undefined,
      set: (target, property: string, value: unknown): boolean => {
        target[property] = value;
        return true;
      },
    },
  ) as unknown as Canvas2D;
  return { width: 0, height: 0, getContext: () => context };
}

function recordingArtist(id: string, drawn: string[]): FighterArtist {
  return {
    id,
    draw: (_ctx: Canvas2D, fighter: DrawnFighter): void => {
      drawn.push(`${id}->${String(fighter.agentIndex)}`);
    },
  };
}

describe('dressing an already-running fight (4.2)', () => {
  const idleView = { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined };

  it('repaints the frame on screen when an artist arrives, not on the next one', async () => {
    const log = await buildDemoLog();
    const drawn: string[] = [];
    const mounted = mountPlayer(silentCanvas(), log, idleView);

    // Frame zero has already been painted by the block artist at this point.
    expect(drawn).toStrictEqual([]);
    mounted.setArtist(0, recordingArtist('pack-one', drawn));

    // Immediately, without waiting for an animation frame -- which during a
    // finished or paused playback would never come.
    expect(drawn).toStrictEqual(['pack-one->0']);
  });

  it('never dresses both fighters in the pack that happened to decode first', async () => {
    // `drawFrame` falls back from a missing index to index 0, so handing it a
    // sparse `[undefined, packTwo]` would put pack two on *both* fighters --
    // which defeats the whole reason there are two packs.
    const log = await buildDemoLog();
    const drawn: string[] = [];
    const mounted = mountPlayer(silentCanvas(), log, idleView);

    mounted.setArtist(1, recordingArtist('pack-two', drawn));

    expect(drawn).toStrictEqual(['pack-two->1']);
    expect(drawn.filter((entry) => entry.startsWith('pack-two'))).toHaveLength(1);
  });

  it('gives each fighter its own pack once both have decoded', async () => {
    const log = await buildDemoLog();
    const drawn: string[] = [];
    const mounted = mountPlayer(silentCanvas(), log, idleView);

    mounted.setArtist(0, recordingArtist('pack-one', drawn));
    drawn.length = 0;
    mounted.setArtist(1, recordingArtist('pack-two', drawn));

    expect(drawn).toStrictEqual(['pack-one->0', 'pack-two->1']);
  });
});

describe('what the reasoning panel says (4.2 AC4)', () => {
  const base: ReasoningLookup = {
    status: 'ready',
    found: true,
    reasoning: null,
    rawResponse: null,
    reflexMode: false,
    parseFailure: false,
  };

  it('distinguishes loading from unavailable from recorded-nothing', () => {
    const loading = reasoningPanel({ ...base, status: 'loading' }, 'model-a');
    const gone = reasoningPanel({ ...base, status: 'unavailable' }, 'model-a');
    const empty = reasoningPanel(base, 'model-a');

    // Three distinct bodies. Collapsing any pair is how a slow network gets
    // displayed to a visitor as a model that said nothing.
    expect(new Set([loading.body, gone.body, empty.body]).size).toBe(3);
    expect(loading.modifier).toBe('tb-reasoning--loading');
  });

  it('shows the reasoning itself when there is some', () => {
    const panel = reasoningPanel({ ...base, reasoning: 'stay outside its range' }, 'model-a');
    expect(panel.body).toBe('stay outside its range');
    expect(panel.heading).toBe('model-a');
  });

  it('says nothing about how long anything took, in any state (INV-3)', () => {
    // The loading affordance is the obvious place to leak think time, so the
    // copy is swept for every word that would.
    const timing = /\b(ms|second|seconds|elapsed|took|waiting for|slow|still)\b/i;
    for (const status of ['inline', 'loading', 'ready', 'unavailable'] as const) {
      expect(reasoningPanel({ ...base, status }, 'model-a').body).not.toMatch(timing);
    }
  });
});
