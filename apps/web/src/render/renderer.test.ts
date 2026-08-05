import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_IDLE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
  ZONE_NONE,
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import type { RenderFrame } from '../replay/film';
import type { BankReading } from '../replay/token-bank';
import { BASIS_POINTS_FULL } from '../replay/film';
import type { Canvas2D } from './canvas2d';
import { createBlockArtist } from './artist';
import { drawFrame } from './renderer';
import { THEME, phaseFill } from './theme';

/**
 * Story 4.1, the drawing half.
 *
 * Every case runs against a recording fake rather than a real canvas. That is
 * not a compromise: the assertions worth making here are about *what was
 * drawn where*, which a call log answers exactly and a pixel buffer answers
 * only by inference. It also keeps `apps/web` on Vitest's default `node`
 * environment with no jsdom and no new dependency.
 */

interface RecordedCall {
  readonly op: string;
  readonly args: readonly (number | string)[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
}

interface RecordingCanvas extends Canvas2D {
  readonly calls: () => readonly RecordedCall[];
}

function createRecordingCanvas(): RecordingCanvas {
  const calls: RecordedCall[] = [];
  const surface = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    calls: () => calls,
  } as unknown as RecordingCanvas;

  const record = (op: string, args: readonly (number | string)[]): void => {
    calls.push({ op, args, fillStyle: surface.fillStyle, strokeStyle: surface.strokeStyle });
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  surface.save = () => record('save', []);
  surface.restore = () => record('restore', []);

  return surface;
}

const VIEWPORT = { width: 960, height: 540 };

function stateWith(overrides: Partial<FighterState> = {}): FighterState {
  return {
    tick: 0,
    rngState: 1,
    health: [100, 100],
    position: [320, 640],
    meter: [0, 0],
    commitmentRemaining: [0, 0],
    committedAction: [COMMITTED_NONE, COMMITTED_NONE],
    windowHitLanded: [0, 0],
    verticalPosition: [0, 0],
    airState: [PHASE_IDLE, PHASE_IDLE],
    committedZone: [ZONE_NONE, ZONE_NONE],
    juggleCount: [0, 0],
    ...overrides,
  };
}

function frameWith(from: FighterState, to: FighterState, progress = 0): RenderFrame {
  return { index: 0, decisionPoint: 0, progressBasisPoints: progress, from, to };
}

function draw(frame: RenderFrame): RecordingCanvas {
  const ctx = createRecordingCanvas();
  drawFrame(ctx, frame, { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT });
  return ctx;
}

describe('drawing a frame', () => {
  it('clears, lays the ground, then draws both fighters and both HUD blocks', () => {
    const ctx = draw(frameWith(stateWith(), stateWith()));
    const ops = ctx.calls().map((call) => call.op);

    expect(ops[0]).toBe('clearRect');
    expect(ops).toContain('strokeRect');
    expect(ops).toContain('fillText');
    // Two fighters, two health bars, two meters -- a great many rects, and the
    // exact count is not the property worth pinning. That both fighters were
    // drawn is.
    expect(ops.filter((op) => op === 'fillRect').length).toBeGreaterThan(6);
  });

  it('is pure: the same frame drawn twice issues the same calls', () => {
    const frame = frameWith(stateWith({ health: [72, 91], meter: [30, 60] }), stateWith());
    expect(draw(frame).calls()).toStrictEqual(draw(frame).calls());
  });

  it('reads no clock: the drawn output depends only on the frame it was given', () => {
    // Two identical frames constructed independently must draw identically.
    // If anything on this path consulted a clock, these would diverge.
    const a = frameWith(stateWith({ tick: 90 }), stateWith({ tick: 120 }), 5_000);
    const b = frameWith(stateWith({ tick: 90 }), stateWith({ tick: 120 }), 5_000);
    expect(draw(a).calls()).toStrictEqual(draw(b).calls());
  });

  it('interpolates position between the two states rather than snapping', () => {
    const from = stateWith({ position: [100, 800] });
    const to = stateWith({ position: [300, 800] });

    const xAt = (progress: number): number => {
      const ctx = draw(frameWith(from, to, progress));
      // The first fillRect after the floor rule is p1's shadow; its x tracks
      // the interpolated position.
      const rects = ctx.calls().filter((call) => call.op === 'fillRect');
      return rects[2].args[0] as number;
    };

    const start = xAt(0);
    const mid = xAt(BASIS_POINTS_FULL / 2);
    const late = xAt(BASIS_POINTS_FULL - 1);

    expect(mid).toBeGreaterThan(start);
    expect(late).toBeGreaterThan(mid);
  });

  it('scales arena units onto the viewport', () => {
    const left = draw(frameWith(stateWith({ position: [0, 960] }), stateWith({ position: [0, 960] })));
    const right = draw(
      frameWith(stateWith({ position: [960, 0] }), stateWith({ position: [960, 0] })),
    );

    const firstBodyX = (ctx: RecordingCanvas): number =>
      ctx.calls().filter((call) => call.op === 'fillRect')[2].args[0] as number;

    expect(firstBodyX(left)).toBeLessThan(firstBodyX(right));
  });

  it('survives a degenerate arena instead of painting NaN', () => {
    const ctx = createRecordingCanvas();
    drawFrame(ctx, frameWith(stateWith(), stateWith()), {
      config: { ...DEFAULT_FIGHTER_CONFIG, arenaMin: 400, arenaMax: 400 },
      viewport: VIEWPORT,
    });

    for (const call of ctx.calls()) {
      for (const arg of call.args) {
        if (typeof arg === 'number') {
          expect(Number.isNaN(arg)).toBe(false);
        }
      }
    }
  });

  it('draws a strike bar only while a Commitment Window is open', () => {
    const idle = draw(frameWith(stateWith(), stateWith()));
    const attacking = draw(
      frameWith(
        stateWith({
          committedAction: [COMMITTED_ATTACK, COMMITTED_NONE],
          commitmentRemaining: [20, 0],
        }),
        stateWith(),
      ),
    );

    expect(attacking.calls().length).toBeGreaterThan(idle.calls().length);
  });

  it('gives each Commitment Window phase a distinct fill', () => {
    const fills = [PHASE_IDLE, PHASE_STARTUP, PHASE_ACTIVE, PHASE_RECOVERY].map((phase) =>
      phaseFill(THEME, phase),
    );
    expect(new Set(fills).size).toBe(4);
  });

  it('falls back to the neutral fill for an unrecognised phase rather than throwing', () => {
    expect(phaseFill(THEME, 99)).toBe(THEME.ink);
  });

  it('uses only theme colours -- no hex is invented at draw time', () => {
    const allowed = new Set([THEME.bg, THEME.ink, THEME.accent, THEME.warn, THEME.muted, '']);
    const ctx = createRecordingCanvas();
    // Every branch that draws, in one frame: both Commitment Windows open, both
    // HUD stacks populated, one Token Bank draining and one exhausted. Drawing
    // the plain frame here would have left Story 4.4's two new colour paths
    // outside the sweep entirely.
    drawFrame(
      ctx,
      frameWith(
        stateWith({
          committedAction: [COMMITTED_ATTACK, COMMITTED_SPECIAL],
          commitmentRemaining: [20, 40],
          health: [55, 12],
          meter: [80, 15],
        }),
        stateWith(),
      ),
      {
        config: DEFAULT_FIGHTER_CONFIG,
        viewport: VIEWPORT,
        banks: [
          { remaining: 9_000, start: 25_000, filledBasisPoints: 3_600, exhausted: false },
          { remaining: 0, start: 25_000, filledBasisPoints: 0, exhausted: true },
        ],
      },
    );

    for (const call of ctx.calls()) {
      expect(allowed.has(call.fillStyle)).toBe(true);
      expect(allowed.has(call.strokeStyle)).toBe(true);
    }
  });
});

describe('the block artist', () => {
  it('draws a shadow, a body and a border, in that order', () => {
    const ctx = createRecordingCanvas();
    createBlockArtist().draw(
      ctx,
      { x: 200, groundY: 400, facing: 1, phase: PHASE_IDLE, committedAction: COMMITTED_NONE, agentIndex: 0, animation: { clip: 'idle', frame: 0 } },
      THEME,
    );

    const ops = ctx.calls().map((call) => call.op);
    expect(ops).toStrictEqual(['fillRect', 'fillRect', 'strokeRect']);
  });

  it('offsets the shadow by the theme offset, never blurs it', () => {
    const ctx = createRecordingCanvas();
    createBlockArtist().draw(
      ctx,
      { x: 200, groundY: 400, facing: 1, phase: PHASE_IDLE, committedAction: COMMITTED_NONE, agentIndex: 0, animation: { clip: 'idle', frame: 0 } },
      THEME,
    );

    const [shadow, body] = ctx.calls();
    // A canvas fillRect cannot blur, which is the medium enforcing the house
    // style for free. What is checkable is that the offset is the token's.
    expect((body.args[0] as number) - (shadow.args[0] as number)).toBe(THEME.shadowOffset);
    expect((shadow.args[1] as number) - (body.args[1] as number)).toBe(THEME.shadowOffset);
  });

  it('reaches the strike bar in the direction the fighter faces', () => {
    const rightward = createRecordingCanvas();
    createBlockArtist().draw(
      rightward,
      { x: 200, groundY: 400, facing: 1, phase: PHASE_ACTIVE, committedAction: COMMITTED_ATTACK, agentIndex: 0, animation: { clip: 'idle', frame: 0 } },
      THEME,
    );
    const leftward = createRecordingCanvas();
    createBlockArtist().draw(
      leftward,
      { x: 200, groundY: 400, facing: -1, phase: PHASE_ACTIVE, committedAction: COMMITTED_ATTACK, agentIndex: 1, animation: { clip: 'idle', frame: 0 } },
      THEME,
    );

    const strikeX = (ctx: RecordingCanvas): number =>
      ctx.calls().filter((call) => call.op === 'fillRect')[2].args[0] as number;

    expect(strikeX(rightward)).toBeGreaterThan(200);
    expect(strikeX(leftward)).toBeLessThan(200);
  });
});

/**
 * Story 4.4: the Token Bank meter.
 *
 * The story is judged by eye as much as by test, so what is pinned here is the
 * part an eye cannot check reliably: that an Agent without a bank gets no meter
 * at all, that zero is drawn as a different thing rather than as a short bar,
 * and that omitting the option leaves Story 4.1's output untouched.
 */
describe('the Token Bank meter (4.4)', () => {
  function drawWithBanks(banks: readonly (BankReading | null)[]): RecordingCanvas {
    const ctx = createRecordingCanvas();
    drawFrame(ctx, frameWith(stateWith(), stateWith()), {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport: VIEWPORT,
      banks,
    });
    return ctx;
  }

  function reading(remaining: number, start = 25_000): BankReading {
    return {
      remaining,
      start,
      filledBasisPoints: Math.floor((Math.max(0, remaining) * 10_000) / start),
      exhausted: remaining <= 0,
    };
  }

  function texts(ctx: RecordingCanvas): readonly string[] {
    return ctx
      .calls()
      .filter((call) => call.op === 'fillText')
      .map((call) => String(call.args[0]));
  }

  it('draws nothing extra when no bank is supplied, so 4.1 output is unchanged', () => {
    const withNone = draw(frameWith(stateWith(), stateWith()));
    const withNulls = drawWithBanks([null, null]);

    expect(withNulls.calls()).toStrictEqual(withNone.calls());
  });

  it('shows the recorded level for a metered Agent (AC1)', () => {
    const ctx = drawWithBanks([reading(18_400), null]);
    expect(texts(ctx)).toContain('BANK 18400');
  });

  it('shows exactly one meter in a Deployment-versus-bot Match (AC3)', () => {
    const ctx = drawWithBanks([reading(18_400), null]);
    expect(texts(ctx).filter((text) => text.startsWith('BANK')).length).toBe(1);
  });

  it('renders an exhausted bank as a different thing, not a short bar (AC2)', () => {
    const empty = drawWithBanks([reading(0), null]);
    const nearlyEmpty = drawWithBanks([reading(1), null]);

    // Loud, and legible without reading anything: the word, on a warn fill.
    expect(texts(empty).some((text) => text.includes('REFLEX'))).toBe(true);
    expect(texts(nearlyEmpty).some((text) => text.includes('REFLEX'))).toBe(false);

    const warnFills = empty
      .calls()
      .filter((call) => call.op === 'fillRect' && call.fillStyle === THEME.warn);
    expect(warnFills.length).toBeGreaterThan(0);
  });

  it('puts ground ink on the warn fill, never warn text on the ground', () => {
    // --tb-warn on --tb-bg measures 4.26:1 and misses the 4.5:1 floor. The pair
    // the other way round is what docs/DESIGN.md sanctions.
    const ctx = drawWithBanks([reading(0), null]);
    const reflex = ctx
      .calls()
      .find((call) => call.op === 'fillText' && String(call.args[0]).includes('REFLEX'));

    expect(reflex?.fillStyle).toBe(THEME.bg);
  });

  it('shows both banks exhausted at once, and keeps drawing the fight (AC4)', () => {
    const ctx = drawWithBanks([reading(0), reading(0)]);

    expect(texts(ctx).filter((text) => text.includes('REFLEX')).length).toBe(2);
    // The fighters and the arena are still there.
    expect(ctx.calls()[0].op).toBe('clearRect');
    expect(texts(ctx).some((text) => text.startsWith('HP '))).toBe(true);
  });

  it('is pure: the same reading drawn twice issues the same calls', () => {
    expect(drawWithBanks([reading(7_000), reading(0)]).calls()).toStrictEqual(
      drawWithBanks([reading(7_000), reading(0)]).calls(),
    );
  });

  it('says nothing about time (INV-3)', () => {
    // The meter shows tokens. A rate or a duration here would be the UI
    // hinting at how long a Deployment thought.
    const ctx = drawWithBanks([reading(12_500), reading(0)]);
    for (const text of texts(ctx)) {
      expect(text).not.toMatch(/\b(ms|sec|second|per|rate|elapsed)\b/i);
    }
  });
});

/**
 * Story 4.5, AC1 and AC3 -- and the reason they need a test rather than code.
 *
 * `buildReplayFilm` re-simulates the whole Match forward from `env.reset(seed)`
 * and keeps every state; every playback frame indexes into that array. So a
 * seek reads the same `states[n]` a play-through reads, because it is the same
 * array produced by the same single forward pass. There is no reverse
 * simulation to get wrong and no cached frame data to drift (AD-4).
 *
 * That argument is only worth as much as its evidence. INV-2 says "a seek that
 * produces different state than continuous playback is a determinism bug", so
 * what is asserted here is the drawn output at a position reached two
 * different ways -- forwards, and by jumping straight to it.
 */
describe('seeking equals playing through (4.5 AC1, AC3)', () => {
  async function filmOfTheDemoMatch(): Promise<Awaited<ReturnType<typeof buildFilm>>> {
    return buildFilm();
  }

  async function buildFilm() {
    const { createFighterEnvironment } = await import(
      '../../../../packages/env-fighter/src/environment'
    );
    const { buildReplayFilm } = await import('../replay/film');
    const { buildDemoLog } = await import('../testing/demo-log');
    return buildReplayFilm(await buildDemoLog(), createFighterEnvironment());
  }

  function drawAt(film: Awaited<ReturnType<typeof buildFilm>>, index: number): RecordingCanvas {
    const ctx = createRecordingCanvas();
    drawFrame(ctx, film.frames[index], {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport: VIEWPORT,
      artists: [createBlockArtist(), createBlockArtist()],
    });
    return ctx;
  }

  it('draws a sampled position identically whether reached forwards or by jumping', async () => {
    const film = await filmOfTheDemoMatch();
    const last = film.frames.length - 1;
    const sampled = [0, 1, 11, 12, Math.floor(last / 2), last - 1, last];

    for (const index of sampled) {
      // "Playing through": draw every frame from zero up to the target, as the
      // clock does, keeping only what the last one drew. "Seeking": draw the
      // target alone. The renderer holds no state between frames, so if these
      // ever diverged it would mean something on this path had started
      // remembering the frame before -- which is exactly INV-2's "a seek that
      // produces different state than continuous playback is a determinism bug".
      //
      // Each frame gets its own recorder rather than one shared log sliced at
      // the end: different frames issue different numbers of calls (an open
      // Commitment Window draws a strike bar), so a fixed-length tail slice
      // would compare the target against part of its predecessor.
      const played: RecordedCall[] = [];
      for (let n = 0; n <= index; n += 1) {
        played.length = 0;
        played.push(...drawAt(film, n).calls());
      }

      expect(played).toStrictEqual(drawAt(film, index).calls());
    }
  });

  it('draws the same thing seeking backwards as it did going forwards (AC3)', async () => {
    const film = await filmOfTheDemoMatch();
    const target = 7;

    const forwards = drawAt(film, target);
    // Run to the very end first, then come back. Nothing may carry over.
    for (let n = 0; n < film.frames.length; n += 1) {
      drawAt(film, n);
    }
    const backwards = drawAt(film, target);

    expect(backwards.calls()).toStrictEqual(forwards.calls());
  });

  it('keeps the strike visible at a scrub position, not only during playback', async () => {
    // The constraint Story 4.1 recorded for this story by name: an attack's
    // startup and active frames fall strictly BETWEEN two Decision Point
    // samples, and `liveWindow` reconstructs them from `progressBasisPoints`.
    // A seek that snapped to a Decision Point boundary would make the swing
    // invisible again at every scrub position.
    const { animationFor: _unused } = await import('./animation');
    const film = await filmOfTheDemoMatch();

    const clips = new Set<string>();
    const spy = {
      id: 'spy',
      draw: (_ctx: unknown, fighter: { animation: { clip: string } }) =>
        clips.add(fighter.animation.clip),
    };
    // Seek to every frame, in a deliberately scrambled order.
    const order = film.frames.map((_, index) => index).sort((a, b) => ((a * 7) % 13) - ((b * 7) % 13));
    for (const index of order) {
      drawFrame(createRecordingCanvas(), film.frames[index], {
        config: DEFAULT_FIGHTER_CONFIG,
        viewport: VIEWPORT,
        artists: [spy as never, spy as never],
      });
    }

    expect(clips).toContain('attack-startup');
    expect(clips).toContain('attack-active');
  });
});
