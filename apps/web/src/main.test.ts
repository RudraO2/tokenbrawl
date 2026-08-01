import { describe, expect, it } from 'vitest';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { decisionPointCount, hashChip, mountPlayer, reasoningView, type CanvasSurface } from './main';
import { buildDemoLog } from './testing/demo-log';
import { buildReplayFilm } from './replay/film';
import type { ReasoningLookup } from './replay/sidecar';
import type { ResolvedDecision } from './replay/decision-point';
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


/**
 * Story 4.3: what the panel says, as three facts that are not each other.
 *
 * Reflex Mode, a Parse Failure and an Agent that recorded nothing are three
 * different things about a Deployment, and the story asks for all three by
 * name. A panel that renders any two of them identically has answered a
 * question the visitor did not ask.
 */

const READY: ReasoningLookup = {
  status: 'ready',
  found: true,
  reasoning: null,
  rawResponse: null,
  reflexMode: false,
  parseFailure: false,
};

const HERE: ResolvedDecision = { tick: 120, decisionPoint: 4, polled: true };
const COMMITTED: ResolvedDecision = { tick: 90, decisionPoint: 3, polled: false };

describe('the reasoning panel (4.3)', () => {
  it('shows the reasoning and the tick it belongs to', () => {
    const view = reasoningView({ ...READY, reasoning: 'stay outside its range' }, HERE, 'model-a');

    expect(view.body).toBe('stay outside its range');
    expect(view.tickLabel).toBe('Tick 120');
    expect(view.heading).toBe('model-a');
    expect(view.chips).toStrictEqual([]);
  });

  it('says a committed fighter is still executing an earlier decision (AC1)', () => {
    // Not "nearest neighbour" -- the tick is the one this fighter is carrying
    // out, and the panel says so rather than letting it read as a fresh choice.
    const view = reasoningView({ ...READY, reasoning: 'commit to the attack' }, COMMITTED, 'model-a');

    expect(view.tickLabel).toBe('Tick 90');
    expect(view.chips.map((chip) => chip.label)).toStrictEqual(['Still committed']);
  });

  it('displays Reflex Mode as itself, never as blank reasoning (AC2)', () => {
    const view = reasoningView({ ...READY, reflexMode: true }, HERE, 'model-a');

    expect(view.chips.map((chip) => chip.label)).toContain('Reflex mode');
    expect(view.body).toMatch(/Token Bank/);
    expect(view.body).toMatch(/eight tokens/);
    // The distinguishing test: it must not read like the ordinary empty case.
    expect(view.body).not.toBe(reasoningView(READY, HERE, 'model-a').body);
  });

  it('says a Parse Failure happened and shows the raw response (AC3)', () => {
    const view = reasoningView(
      { ...READY, parseFailure: true, rawResponse: 'I think I shall advance!' },
      HERE,
      'model-a',
    );

    expect(view.chips.map((chip) => chip.label)).toContain('Parse failure');
    expect(view.chips.find((chip) => chip.label === 'Parse failure')?.modifier).toBe(
      'tb-chip--failed',
    );
    expect(view.rawResponse).toBe('I think I shall advance!');
    expect(view.body).toMatch(/Fallback Action/);
    // Story 1.6: never retried, and the visitor is told that too.
    expect(view.body).toMatch(/not retried/i);
  });

  it('shows both chips when a Reflex-Mode call also failed to parse', () => {
    const view = reasoningView(
      { ...READY, reflexMode: true, parseFailure: true, rawResponse: 'ummm' },
      HERE,
      'model-a',
    );

    const labels = view.chips.map((chip) => chip.label);
    expect(labels).toContain('Reflex mode');
    expect(labels).toContain('Parse failure');
    // The failure owns the body: it is the fact that changed the Action.
    expect(view.body).toMatch(/Fallback Action/);
    expect(view.rawResponse).toBe('ummm');
  });

  it('keeps the raw response visible for an ordinary call too', () => {
    // A Baseline Bot records no reasoning but does emit a line, and that line is
    // the only thing the page can honestly show for it.
    const view = reasoningView({ ...READY, rawResponse: 'aggressive:advance' }, HERE, 'bot:aggressive');

    expect(view.body).toMatch(/No reasoning recorded/);
    expect(view.rawResponse).toBe('aggressive:advance');
  });

  it('has copy for a fighter that has not acted yet', () => {
    const view = reasoningView(READY, null, 'model-a');

    expect(view.tickLabel).toBe('');
    expect(view.body).toMatch(/has not acted yet/);
  });

  it('keeps 4.2 AC4: a sidecar in flight is a loading state, not an empty model', () => {
    const view = reasoningView({ ...READY, status: 'loading' }, HERE, 'model-a');

    expect(view.bodyModifier).toBe('tb-reasoning--loading');
    expect(view.tickLabel).toBe('Tick 120');
  });

  it('gives a screen reader the whole panel in one string (AC5)', () => {
    const view = reasoningView(
      { ...READY, reflexMode: true, rawResponse: 'ok' },
      COMMITTED,
      'model-a',
    );

    for (const part of ['model-a', 'Tick 90', 'Still committed', 'Reflex mode']) {
      expect(view.announcement).toContain(part);
    }
  });

  it('says nothing about how long anything took, in any state (INV-3)', () => {
    // Ticks are simulation time -- identical for a fast Match and a slow one.
    // Everything else that could stand in for a duration is swept for.
    const timing = /\b(ms|millisecond|second|seconds|minute|elapsed|took|latency|waiting for|slow)\b/i;
    const lookups: ReasoningLookup[] = [
      READY,
      { ...READY, status: 'loading' },
      { ...READY, status: 'unavailable' },
      { ...READY, reflexMode: true },
      { ...READY, parseFailure: true, rawResponse: 'x' },
      { ...READY, reasoning: 'close the gap' },
    ];
    for (const lookup of lookups) {
      for (const resolved of [HERE, COMMITTED, null]) {
        const view = reasoningView(lookup, resolved, 'model-a');
        expect(view.body).not.toMatch(timing);
        expect(view.tickLabel).not.toMatch(timing);
        expect(view.chips.map((chip) => chip.label).join(' ')).not.toMatch(timing);
      }
    }
  });
});
