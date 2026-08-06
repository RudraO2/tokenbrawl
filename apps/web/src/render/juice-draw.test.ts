import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import {
  COMMITTED_NONE,
  PHASE_IDLE,
  ZONE_NONE,
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import type { Canvas2D } from './canvas2d';
import {
  drawCinematicPlate,
  drawCinematicStage,
  drawJuiceOverlay,
  drawJuicedFrame,
} from './juice-draw';
import type { JuiceCinematic, JuiceFrame } from './juice';
import { FLOOR_INSET } from './renderer';
import { THEME } from './theme';

/**
 * Story 9.5, the compositing half.
 *
 * `juice.ts` decides *what* to draw and this file decides *where*, so the two
 * failure modes are different and want different tests. The ones here are all
 * about the sandwich: that the surface is cleared at identity before the
 * shake's `translate` (a clear inside the transform leaves a band of stale
 * pixels along whichever edge the stage moved away from, which reads as
 * tearing), that `save`/`restore` balance, that zero shake still issues the
 * full sequence, and that a spark lands on a whole pixel inside the stage.
 *
 * Everything runs against a recording fake `Canvas2D` under Vitest's default
 * `node` environment. No DOM, no `canvas` module, no new dependency.
 */

const VIEWPORT = { width: 960, height: 400 };
const GROUND_Y = VIEWPORT.height - FLOOR_INSET;

interface Call {
  readonly op: string;
  readonly args: readonly (number | string)[];
  readonly fillStyle: string;
}

function createRecordingCanvas(): Canvas2D & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  const surface = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    calls,
  } as unknown as Canvas2D & { readonly calls: Call[] };

  const record = (op: string, args: readonly (number | string)[]): void => {
    calls.push({ op, args, fillStyle: surface.fillStyle });
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  surface.drawImage = () => record('drawImage', []);
  surface.save = () => record('save', []);
  surface.restore = () => record('restore', []);
  surface.translate = (x, y) => record('translate', [x, y]);
  surface.scale = (x, y) => record('scale', [x, y]);

  return surface;
}

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

const FRAME: RenderFrame = {
  index: 0,
  decisionPoint: 0,
  progressBasisPoints: 0,
  from: stateWith(),
  to: stateWith({ health: [100, 91] }),
};

function juiceFrame(overrides: Partial<JuiceFrame> = {}): JuiceFrame {
  return {
    filmIndex: 0,
    frozen: false,
    shakeX: 0,
    shakeY: 0,
    sparks: [],
    damageNumbers: [],
    cinematic: null,
    ...overrides,
  };
}

const OPTIONS = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

describe('drawJuicedFrame composites the shake around an untouched drawFrame', () => {
  it('clears and fills at identity, before the translate', () => {
    // The whole reason this file exists. `drawFrame` opens with its own
    // `clearRect`, but that one runs *inside* the translated transform and so
    // leaves a stale band along the edge the shake moved away from.
    const ctx = createRecordingCanvas();
    drawJuicedFrame(ctx, FRAME, juiceFrame({ shakeX: 7, shakeY: -5 }), OPTIONS);

    const [first, second] = ctx.calls;
    expect(first.op).toBe('clearRect');
    expect(first.args).toStrictEqual([0, 0, VIEWPORT.width, VIEWPORT.height]);
    expect(second.op).toBe('fillRect');
    expect(second.args).toStrictEqual([0, 0, VIEWPORT.width, VIEWPORT.height]);
    expect(second.fillStyle).toBe(THEME.bg);

    // And both land before anything shifts the origin.
    const translateAt = ctx.calls.findIndex((call) => call.op === 'translate');
    const saveAt = ctx.calls.findIndex((call) => call.op === 'save');
    expect(saveAt).toBe(2);
    expect(translateAt).toBe(3);
    expect(ctx.calls[translateAt].args).toStrictEqual([7, -5]);
  });

  it('balances every save with a restore', () => {
    const ctx = createRecordingCanvas();
    drawJuicedFrame(
      ctx,
      FRAME,
      juiceFrame({
        shakeX: 3,
        shakeY: 3,
        sparks: [{ positionBasisPoints: 5_000, offsetPx: 0, heightPx: 96, sizePx: 5 }],
        damageNumbers: [{ damage: 9, positionBasisPoints: 5_000, heightPx: 120 }],
      }),
      OPTIONS,
    );

    const depth = ctx.calls.reduce((open, call) => {
      if (call.op === 'save') {
        return open + 1;
      }
      return call.op === 'restore' ? open - 1 : open;
    }, 0);
    expect(depth).toBe(0);
    // Never negative along the way either: a `restore` before its `save` would
    // pop the caller's transform.
    const running = ctx.calls.reduce<{ open: number; floor: number }>(
      (acc, call) => {
        const open = call.op === 'save' ? acc.open + 1 : call.op === 'restore' ? acc.open - 1 : acc.open;
        return { open, floor: Math.min(acc.floor, open) };
      },
      { open: 0, floor: 0 },
    );
    expect(running.floor).toBe(0);
    expect(ctx.calls[ctx.calls.length - 1].op).toBe('restore');
  });

  it('omits nothing at zero shake: the sequence is the same, the offset is (0,0)', () => {
    // A "skip the translate when it is zero" optimisation would make the call
    // sequence depend on the juice, which is exactly the kind of divergence
    // that makes a rendering bug reproduce only on a frame nobody kept.
    const shaken = createRecordingCanvas();
    const still = createRecordingCanvas();
    drawJuicedFrame(shaken, FRAME, juiceFrame({ shakeX: 4, shakeY: 2 }), OPTIONS);
    drawJuicedFrame(still, FRAME, juiceFrame(), OPTIONS);

    expect(still.calls.map((call) => call.op)).toStrictEqual(shaken.calls.map((call) => call.op));
    const translate = still.calls.find((call) => call.op === 'translate');
    expect(translate?.args).toStrictEqual([0, 0]);
  });
});

describe('drawJuiceOverlay places sparks and numbers', () => {
  it('draws nothing at all for an empty juice frame', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(ctx, juiceFrame(), VIEWPORT, THEME);
    expect(ctx.calls).toStrictEqual([]);
  });

  it('scales the impact point by the viewport and adds the pixel scatter', () => {
    // The one viewport multiplication in the juice path lives here, which is
    // why the track carries basis points plus a px offset rather than a
    // pre-converted coordinate.
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({
        sparks: [
          { positionBasisPoints: BASIS_POINTS_FULL / 2, offsetPx: 20, heightPx: 100, sizePx: 6 },
        ],
      }),
      VIEWPORT,
      THEME,
    );

    const [spark] = ctx.calls;
    expect(spark.op).toBe('fillRect');
    expect(spark.fillStyle).toBe(THEME.accent);
    // Centre = half the 960-wide stage, plus 20px of scatter, less half a
    // 6px square.
    expect(spark.args).toStrictEqual([480 + 20 - 3, GROUND_Y - 100 - 3, 6, 6]);
  });

  it('rounds every spark to a whole pixel', () => {
    // The module's own docblock argues a rect on a half-pixel is a blur, and
    // the shipped sizes are odd numbers, so `x - size / 2` lands on .5 unless
    // it is rounded.
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({
        sparks: [
          { positionBasisPoints: 1_234, offsetPx: 7, heightPx: 71, sizePx: 5 },
          { positionBasisPoints: 4_321, offsetPx: -3, heightPx: 33, sizePx: 3 },
        ],
      }),
      VIEWPORT,
      THEME,
    );

    expect(ctx.calls).toHaveLength(2);
    for (const call of ctx.calls) {
      for (const arg of call.args) {
        expect(Number.isInteger(arg)).toBe(true);
      }
    }
  });

  it('keeps every square inside the stage, however far it scattered', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({
        sparks: [
          { positionBasisPoints: 0, offsetPx: -4_000, heightPx: 0, sizePx: 5 },
          { positionBasisPoints: BASIS_POINTS_FULL, offsetPx: 4_000, heightPx: 9_000, sizePx: 5 },
        ],
      }),
      VIEWPORT,
      THEME,
    );

    for (const call of ctx.calls) {
      const [x, y, w, h] = call.args as readonly number[];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(VIEWPORT.width);
      expect(y + h).toBeLessThanOrEqual(GROUND_Y);
    }
  });

  it('centres the damage number on the impact point, above the floor', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({ damageNumbers: [{ damage: 13, positionBasisPoints: 2_500, heightPx: 120 }] }),
      VIEWPORT,
      THEME,
    );

    const [number] = ctx.calls;
    expect(number.op).toBe('fillText');
    expect(number.args).toStrictEqual(['13', 240, GROUND_Y - 120]);
    expect(number.fillStyle).toBe(THEME.warn);
    expect(ctx.textAlign).toBe('center');
    expect(ctx.font).toBe(THEME.displayFont);
  });
});

/**
 * Story 10.4. The cinematic's compositing, which is the half `cinematic.ts`'s
 * own tests cannot see: *where* each part of it lands relative to the shake.
 */
function cinematicWith(overrides: Partial<JuiceCinematic> = {}): JuiceCinematic {
  return {
    agentIndex: 0,
    casterBasisPoints: 2_500,
    targetBasisPoints: 7_500,
    connected: true,
    age: 0,
    frames: 91,
    flash: false,
    title: false,
    reachBasisPoints: 0,
    bandPx: 16,
    heightPx: 108,
    streaks: [],
    ...overrides,
  };
}

describe('the Ultimate cinematic composites in two halves (Story 10.4)', () => {
  it('draws nothing at all when no cinematic owns the frame', () => {
    // The Baseline Bot promise, at the drawing layer: a Match with no Ultimate
    // must issue the exact call sequence it issued before this story.
    const withCinematic = createRecordingCanvas();
    const without = createRecordingCanvas();
    drawJuicedFrame(withCinematic, FRAME, juiceFrame(), OPTIONS);
    drawJuicedFrame(without, FRAME, juiceFrame({ cinematic: null }), OPTIONS);
    expect(withCinematic.calls).toStrictEqual(without.calls);
  });

  it('paints the stage half inside the shake and the plate half at identity', () => {
    // The split the whole file exists to get right. The impact mark is struck
    // at a fighter's position and must travel with the camera; the plate is a
    // full-viewport fill that must cover the *unshaken* viewport, or a 16px
    // kick leaves a stale band along one edge.
    const ctx = createRecordingCanvas();
    drawJuicedFrame(
      ctx,
      FRAME,
      juiceFrame({
        shakeX: 9,
        shakeY: -9,
        cinematic: cinematicWith({ flash: true, title: true, reachBasisPoints: 1_400, streaks: [{ offsetPx: 40, heightPx: 120, sizePx: 7 }] }),
      }),
      OPTIONS,
    );

    const restoreAt = ctx.calls.findIndex((call) => call.op === 'restore');
    expect(restoreAt).toBeGreaterThan(0);

    // The mark and the streak are inside the transform...
    const markAt = ctx.calls.findIndex(
      (call) => call.op === 'fillRect' && call.fillStyle === THEME.accent,
    );
    expect(markAt).toBeGreaterThan(0);
    expect(markAt).toBeLessThan(restoreAt);

    // ...and the plate is after the restore, covering the whole viewport.
    const plate = ctx.calls
      .slice(restoreAt)
      .find((call) => call.op === 'fillRect' && call.fillStyle === THEME.ink);
    expect(plate?.args).toStrictEqual([0, 0, VIEWPORT.width, VIEWPORT.height]);

    // As is the banner, in the warn-as-fill language the armed gauge uses.
    const word = ctx.calls.slice(restoreAt).find((call) => call.op === 'fillText');
    expect(word?.args[0]).toBe('ULTIMATE');
    expect(word?.fillStyle).toBe(THEME.bg);
  });

  it('draws no impact mark for a whiffed Ultimate', () => {
    // Against the two halves directly, not through `drawJuicedFrame`: the
    // block artist paints agent 0's body in the same accent, so a sweep over
    // the whole composited frame would answer about the fighter rather than
    // about the mark.
    const stage = createRecordingCanvas();
    drawCinematicStage(stage, cinematicWith({ connected: false, reachBasisPoints: 0 }), VIEWPORT, THEME);
    expect(stage.calls).toStrictEqual([]);

    // The freeze still happened, and it still says so.
    const plate = createRecordingCanvas();
    drawCinematicPlate(plate, cinematicWith({ connected: false, title: true }), VIEWPORT, THEME);
    expect(plate.calls.some((call) => call.args[0] === 'ULTIMATE')).toBe(true);
  });

  it('keeps every cinematic square and band inside the stage', () => {
    const ctx = createRecordingCanvas();
    drawCinematicStage(
      ctx,
      cinematicWith({
        casterBasisPoints: BASIS_POINTS_FULL,
        targetBasisPoints: BASIS_POINTS_FULL,
        reachBasisPoints: 9_000,
        heightPx: 9_000,
        streaks: [
          { offsetPx: 9_000, heightPx: 9_000, sizePx: 7 },
          { offsetPx: -9_000, heightPx: 0, sizePx: 7 },
        ],
      }),
      VIEWPORT,
      THEME,
    );

    expect(ctx.calls.length).toBeGreaterThan(0);
    for (const call of ctx.calls) {
      const [x, y, w, h] = call.args as readonly number[];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(VIEWPORT.width);
      expect(y + h).toBeLessThanOrEqual(GROUND_Y);
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    }
  });

  it('balances every save with a restore, cinematic included', () => {
    const ctx = createRecordingCanvas();
    drawJuicedFrame(
      ctx,
      FRAME,
      juiceFrame({
        shakeX: 4,
        cinematic: cinematicWith({ flash: true, title: true, reachBasisPoints: 1_200 }),
      }),
      OPTIONS,
    );
    const depth = ctx.calls.reduce(
      (open, call) => (call.op === 'save' ? open + 1 : call.op === 'restore' ? open - 1 : open),
      0,
    );
    expect(depth).toBe(0);
  });
});
