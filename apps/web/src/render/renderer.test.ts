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
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import type { RenderFrame } from '../replay/film';
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
    const ctx = draw(
      frameWith(
        stateWith({
          committedAction: [COMMITTED_ATTACK, COMMITTED_SPECIAL],
          commitmentRemaining: [20, 40],
          health: [55, 12],
          meter: [80, 15],
        }),
        stateWith(),
      ),
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
      { x: 200, groundY: 400, facing: 1, phase: PHASE_IDLE, committedAction: COMMITTED_NONE, agentIndex: 0 },
      THEME,
    );

    const ops = ctx.calls().map((call) => call.op);
    expect(ops).toStrictEqual(['fillRect', 'fillRect', 'strokeRect']);
  });

  it('offsets the shadow by the theme offset, never blurs it', () => {
    const ctx = createRecordingCanvas();
    createBlockArtist().draw(
      ctx,
      { x: 200, groundY: 400, facing: 1, phase: PHASE_IDLE, committedAction: COMMITTED_NONE, agentIndex: 0 },
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
      { x: 200, groundY: 400, facing: 1, phase: PHASE_ACTIVE, committedAction: COMMITTED_ATTACK, agentIndex: 0 },
      THEME,
    );
    const leftward = createRecordingCanvas();
    createBlockArtist().draw(
      leftward,
      { x: 200, groundY: 400, facing: -1, phase: PHASE_ACTIVE, committedAction: COMMITTED_ATTACK, agentIndex: 1 },
      THEME,
    );

    const strikeX = (ctx: RecordingCanvas): number =>
      ctx.calls().filter((call) => call.op === 'fillRect')[2].args[0] as number;

    expect(strikeX(rightward)).toBeGreaterThan(200);
    expect(strikeX(leftward)).toBeLessThan(200);
  });
});
