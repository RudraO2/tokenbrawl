import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import {
  COMMITTED_NONE,
  PHASE_IDLE,
  ZONE_NONE,
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { BASIS_POINTS_FULL, FRAMES_PER_DECISION, type RenderFrame } from '../replay/film';
import type { Canvas2D } from './canvas2d';
import {
  drawCinematicPlate,
  drawCinematicStage,
  drawJuiceOverlay,
  drawJuicedFrame,
} from './juice-draw';
import {
  DEFAULT_JUICE_TUNING,
  buildJuiceTrack,
  type JuiceCinematic,
  type JuiceFrame,
  type JuiceImpact,
  type JuiceKind,
} from './juice';
import { ARENA_PALETTE } from './arena-palette';
import { FLOOR_INSET, cameraForFrame } from './renderer';
import { DEFAULT_ROSTER, ROSTER_NAMES, auraFor } from './roster';
import { THEME } from './theme';
import { ULT_PARTS, createUltSheet, validateUltSheetLayout, type UltSheet } from './ult-sheet';
import {
  createVfxSheet,
  validateVfxSheetLayout,
  type VfxPose,
  type VfxSheet,
} from './vfx-sheet';

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
  /**
   * The two compositing modes in force at the moment of the call (Story 11.2).
   *
   * Recorded rather than merely allowed for: an impact sprite drawn at
   * `globalAlpha = 1` under `'source-over'` is a perfectly valid `drawImage`
   * call with the wrong picture, and the *only* thing that tells the two apart
   * is the state the surface was in when it happened.
   */
  readonly globalAlpha: number;
  readonly globalCompositeOperation: string;
  /**
   * Recorded for the same reason the two above are.
   *
   * `artist.ts` and `backdrop.ts` each force smoothing off inside their *own*
   * `save`/`restore`, so it is back at the canvas default by the time the juice
   * layer runs -- and the canvas default is `true`. A 208px cell resampled to
   * 128 or 260 with smoothing on is a valid `drawImage` with a blurred picture,
   * which is exactly the class of wrongness a call log cannot otherwise see.
   */
  readonly imageSmoothingEnabled: boolean;
}

function createRecordingCanvas(): Canvas2D & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  const surface = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    // `true`, which is the real canvas default and *not* what this suite used
    // to construct. A fake that starts smoothing-off asserts nothing about a
    // path that must turn it off itself.
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    calls,
  } as unknown as Canvas2D & { readonly calls: Call[] };

  const record = (op: string, args: readonly (number | string)[]): void => {
    calls.push({
      op,
      args,
      fillStyle: surface.fillStyle,
      globalAlpha: surface.globalAlpha,
      globalCompositeOperation: surface.globalCompositeOperation,
      imageSmoothingEnabled: surface.imageSmoothingEnabled,
    });
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  // Story 11.2 records the source and destination rects rather than the bare
  // op. Which *cell* of the sheet a hit reads from is the acceptance criterion
  // ("`spark_l` for a light hit, `spark_h` for a heavy one"), and a recorder
  // that dropped the arguments could not see it.
  surface.drawImage = (_image, sx, sy, sw, sh, dx, dy, dw, dh) =>
    record('drawImage', [sx, sy, sw, sh, dx, dy, dw, dh]);
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
    impacts: [],
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

describe('the juice is composited in the camera the fighters were drawn in (12.3)', () => {
  /**
   * The gap an independent review of Story 12.3 found, closed.
   *
   * Replacing `applyCamera` in `drawJuicedFrame` with a no-op left the entire
   * suite green -- 1157 tests -- and the visual gate could not see it either,
   * because the gate never fires an Ultimate and never samples a spark frame.
   * The failure that would have shipped is specific and silent: every spark,
   * damage number, impact cell and Ultimate beam drawn at the pre-camera 1:1
   * position, so a beam fired by a fighter standing at world 900 lands hundreds
   * of pixels away from the fighter that threw it. The call sequence would be
   * unchanged and every coordinate would still be the "right" number.
   */
  const noise = juiceFrame({
    sparks: [{ positionBasisPoints: 9_000, offsetPx: 0, heightPx: 96, sizePx: 5 }],
    damageNumbers: [{ damage: 9, positionBasisPoints: 9_000, heightPx: 120 }],
  });

  /** The `translate`/`scale`/`translate` triple `applyCamera` issues, wherever it appears. */
  function cameraTriples(calls: readonly Call[]): readonly (readonly (number | string)[])[] {
    const triples: (readonly (number | string)[])[] = [];
    for (const [index, call] of calls.entries()) {
      if (call.op !== 'scale') continue;
      const before = calls[index - 1];
      const after = calls[index + 1];
      if (before?.op !== 'translate' || after?.op !== 'translate') continue;
      triples.push([...before.args, ...call.args, ...after.args]);
    }
    return triples;
  }

  it('puts the overlay under the same camera the renderer just used', () => {
    const ctx = createRecordingCanvas();
    drawJuicedFrame(ctx, FRAME, noise, OPTIONS);
    const camera = cameraForFrame(FRAME, DEFAULT_FIGHTER_CONFIG, VIEWPORT);
    const expected = [
      VIEWPORT.width / 2,
      GROUND_Y,
      camera.scale,
      camera.scale,
      -camera.x,
      -GROUND_Y,
    ];

    // Twice: once by `drawFrame` around the fighters, once here around the
    // juice. Identical, because both derive it from the same frame.
    expect(cameraTriples(ctx.calls)).toStrictEqual([expected, expected]);
  });

  it('draws the sparks and the numbers inside that transform, not after it', () => {
    const ctx = createRecordingCanvas();
    drawJuicedFrame(ctx, FRAME, noise, OPTIONS);

    const scales = ctx.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.op === 'scale');
    expect(scales).toHaveLength(2);
    const overlayCameraAt = scales[1].index;

    // Between the overlay's camera and the `restore` that closes it sit both
    // marks: the spark's square and the damage number. `findIndex` on the bare
    // op would find the HUD's own `fillText`, which `drawFrame` drew several
    // hundred calls earlier and in screen space, so the window is what makes
    // this an assertion about the overlay rather than about the HUD.
    const closesAt = ctx.calls.findIndex(
      (call, index) => index > overlayCameraAt && call.op === 'restore',
    );
    expect(closesAt).toBeGreaterThan(overlayCameraAt);
    const inside = ctx.calls.slice(overlayCameraAt, closesAt);
    expect(inside.some((call) => call.op === 'fillRect')).toBe(true);
    expect(inside.some((call) => call.op === 'fillText' && String(call.args[0]) === '9')).toBe(
      true,
    );

    // And nothing after the compositor inherits an arena transform.
    expect(ctx.calls[ctx.calls.length - 1].op).toBe('restore');
  });

  it('moves the overlay with the fight: a corner exchange transforms differently', () => {
    const cornered: RenderFrame = {
      ...FRAME,
      from: stateWith({ position: [920, 960] }),
      to: stateWith({ position: [920, 960], health: [100, 91] }),
    };
    const centre = createRecordingCanvas();
    const corner = createRecordingCanvas();
    drawJuicedFrame(centre, FRAME, noise, OPTIONS);
    drawJuicedFrame(corner, cornered, noise, OPTIONS);

    // Same call sequence -- the camera never changes *what* is drawn -- and a
    // different transform, which is the whole of it.
    expect(corner.calls.map((call) => call.op)).toStrictEqual(
      centre.calls.map((call) => call.op),
    );
    expect(cameraTriples(corner.calls)).not.toStrictEqual(cameraTriples(centre.calls));
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
    frames: 130,
    act: 'build',
    letterboxPx: 0,
    vignetteBasisPoints: 0,
    orbRadiusPx: 0,
    bloomBasisPoints: 0,
    portraitBasisPoints: 0,
    portraitWidthPx: 170,
    portraitHeightPx: 228,
    slamTintBasisPoints: 4_000,
    flashBasisPoints: 0,
    title: false,
    reachBasisPoints: 0,
    beamThicknessPx: 36,
    beamHeightPx: 108,
    impactBasisPoints: 2_500,
    impactCovers: false,
    bandPx: 16,
    heightPx: 108,
    streaks: [],
    ...overrides,
  };
}

/**
 * An `UltSheet` bound to fake images, so the per-character path can be driven
 * without a browser.
 *
 * Built through the real `validateUltSheetLayout` and `createUltSheet` rather
 * than as a hand-written object literal: what is being tested is that the
 * *drawing* asks the sheet the right questions, and a stub that answered
 * whatever the drawing happened to ask would pass through a remap of every
 * pose. `chatty`'s cells are deliberately different from `clawde`'s, which is
 * what makes "two fighters produce two different cinematics" checkable.
 */
function ultSheetFor(fighters: readonly string[], options: { portraits?: boolean } = {}): UltSheet {
  // The shipped layout's own cells: clawde is atlas cells 0-2 and chatty 3-5,
  // and cell 5 wraps onto the next row -- which is exactly why they are written
  // out rather than derived from a stride.
  const cells: Record<string, readonly { x: number; y: number }[]> = {
    clawde: [
      { x: 0, y: 0 },
      { x: 208, y: 0 },
      { x: 416, y: 0 },
    ],
    chatty: [
      { x: 624, y: 0 },
      { x: 832, y: 0 },
      { x: 0, y: 208 },
    ],
  };
  const layout = validateUltSheetLayout({
    cellWidth: 208,
    cellHeight: 208,
    fighters: Object.fromEntries(
      fighters.map((id) => [
        id,
        {
          portrait: `/portraits/${id}.png`,
          parts: {
            muzzle: { image: '/fx/fx_ult.png', ...cells[id][0] },
            beam: { image: '/fx/fx_ult.png', ...cells[id][1] },
            impact: { image: '/fx/fx_ult.png', ...cells[id][2] },
          },
        },
      ]),
    ),
  });
  const images = new Map<string, { width: number; height: number }>([
    ['/fx/fx_ult.png', { width: 1_040, height: 1_040 }],
  ]);
  if (options.portraits !== false) {
    for (const id of fighters) {
      images.set(`/portraits/${id}.png`, { width: 512, height: 512 });
    }
  }
  return createUltSheet(images, layout);
}

/**
 * How many layers a glow is stacked from.
 *
 * Written here rather than imported, because the assertion it serves is about
 * the *shape* of the stack: a test that read the count off the table it is
 * checking could never notice the table collapsing to a single entry, which is
 * the flat block the visual gate rejected.
 */
const GLOW_LAYER_COUNT = 8;

/** A frame deep in the release act, with the beam swept out over the target. */
function releasing(overrides: Partial<JuiceCinematic> = {}): JuiceCinematic {
  return cinematicWith({
    act: 'release',
    age: 120,
    reachBasisPoints: 7_500,
    impactBasisPoints: 7_500,
    impactCovers: true,
    ...overrides,
  });
}

describe('the Ultimate cinematic composites in two halves (Story 10.4, 11.4)', () => {
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
    // The split the whole file exists to get right. The beam is struck at a
    // fighter's position and must travel with the camera; the letterbox and the
    // slam are full-viewport fills that must cover the *unshaken* viewport, or
    // a 16px kick leaves a stale band along one edge.
    const ctx = createRecordingCanvas();
    drawJuicedFrame(
      ctx,
      FRAME,
      juiceFrame({
        shakeX: 9,
        shakeY: -9,
        cinematic: releasing({
          flashBasisPoints: BASIS_POINTS_FULL,
          title: true,
          letterboxPx: 52,
          streaks: [{ offsetPx: 40, heightPx: 120, sizePx: 7 }],
        }),
      }),
      OPTIONS,
    );

    // The *outer* restore -- the one that closes the shake -- found by tracking
    // nesting depth rather than by taking the first `restore` in the log. Story
    // 12.3 put a camera transform inside `drawFrame` and a second one around
    // the stage half, so there are now nested save/restore pairs before the
    // shake closes, and "the first restore" stopped meaning "the end of the
    // shaken half" the moment the arena got a camera.
    const restoreAt = (() => {
      let depth = 0;
      for (const [index, call] of ctx.calls.entries()) {
        if (call.op === 'save') depth += 1;
        if (call.op === 'restore') {
          depth -= 1;
          if (depth === 0) return index;
        }
      }
      return -1;
    })();
    expect(restoreAt).toBeGreaterThan(0);

    // The beam and the streak are inside the transform...
    const markAt = ctx.calls.findIndex(
      (call) => call.op === 'fillRect' && call.fillStyle === THEME.accent,
    );
    expect(markAt).toBeGreaterThan(0);
    expect(markAt).toBeLessThan(restoreAt);

    // ...and the letterbox bar is after the restore, spanning the full width of
    // the unshaken viewport.
    const bar = ctx.calls
      .slice(restoreAt)
      .find((call) => call.op === 'fillRect' && call.fillStyle === ARENA_PALETTE.curtain);
    expect(bar?.args).toStrictEqual([0, 0, VIEWPORT.width, 52]);

    // As is the slam, covering the whole viewport.
    const plate = ctx.calls
      .slice(restoreAt)
      .find(
        (call) =>
          call.op === 'fillRect' &&
          call.args[2] === VIEWPORT.width &&
          call.args[3] === VIEWPORT.height &&
          call.fillStyle !== ARENA_PALETTE.curtain,
      );
    expect(plate?.args).toStrictEqual([0, 0, VIEWPORT.width, VIEWPORT.height]);

    // As is the banner, in the warn-as-fill language the armed gauge uses.
    const word = ctx.calls.slice(restoreAt).find((call) => call.op === 'fillText');
    expect(word?.args[0]).toBe('ULTIMATE');
    expect(word?.fillStyle).toBe(THEME.bg);
  });

  it('fires the beam on a whiff but marks no impact', () => {
    // Against the two halves directly, not through `drawJuicedFrame`: the
    // block artist paints agent 0's body in the same accent, so a sweep over
    // the whole composited frame would answer about the fighter rather than
    // about the beam.
    //
    // Story 11.4 separates the beam from the mark. The beam is the Action and
    // fires either way; the accent band is the *hit* mark and is still gated on
    // `connected`, because the juice layer must never claim something the
    // simulation did not do.
    const whiff = createRecordingCanvas();
    drawCinematicStage(whiff, releasing({ connected: false }), VIEWPORT, THEME);
    expect(whiff.calls).toStrictEqual([]);

    const hit = createRecordingCanvas();
    drawCinematicStage(hit, releasing(), VIEWPORT, THEME);
    expect(hit.calls.length).toBeGreaterThan(0);

    // The freeze still happened, and it still says so.
    const plate = createRecordingCanvas();
    drawCinematicPlate(plate, cinematicWith({ connected: false, title: true }), VIEWPORT, THEME);
    expect(plate.calls.some((call) => call.args[0] === 'ULTIMATE')).toBe(true);
  });

  it('draws no beam at all during the build act, whoever the caster is', () => {
    // The whole point of the re-timing: for the first 80 frames there is a
    // build and nothing else on the stage half. A beam on frame 0 would be the
    // front-loaded cinematic this story replaced.
    for (const caster of [undefined, 'clawde' as const]) {
      const ctx = createRecordingCanvas();
      drawCinematicStage(
        ctx,
        cinematicWith({ orbRadiusPx: 12 }),
        VIEWPORT,
        THEME,
        ultSheetFor(['clawde']),
        caster,
      );
      expect(ctx.calls).toStrictEqual([]);
    }
  });

  it('keeps every cinematic square and band inside the stage', () => {
    const ctx = createRecordingCanvas();
    drawCinematicStage(
      ctx,
      releasing({
        casterBasisPoints: BASIS_POINTS_FULL,
        targetBasisPoints: BASIS_POINTS_FULL,
        impactBasisPoints: BASIS_POINTS_FULL,
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
        cinematic: releasing({ flashBasisPoints: 5_000, title: true, letterboxPx: 52 }),
      }),
      { ...OPTIONS, ult: ultSheetFor(['clawde', 'chatty']), roster: DEFAULT_ROSTER },
    );
    const depth = ctx.calls.reduce(
      (open, call) => (call.op === 'save' ? open + 1 : call.op === 'restore' ? open - 1 : open),
      0,
    );
    expect(depth).toBe(0);
  });
});

/**
 * Story 11.4's fail-soft criterion is three states, not two, and each one is a
 * different picture. These are the cases that tell them apart.
 */
describe('the cinematic degrades in three named steps (Story 11.4)', () => {
  /** Every `drawImage` issued by the stage half. */
  function stageImages(cinematic: JuiceCinematic, ult?: UltSheet, caster?: 'clawde' | 'chatty') {
    const ctx = createRecordingCanvas();
    drawCinematicStage(ctx, cinematic, VIEWPORT, THEME, ult, caster);
    return ctx.calls.filter((call) => call.op === 'drawImage');
  }

  it('level 1: draws the caster own beam, muzzle and impact art', () => {
    const ult = ultSheetFor(['clawde', 'chatty']);
    const calls = stageImages(releasing(), ult, 'clawde');
    expect(calls.length).toBeGreaterThan(0);
    // Additive, and nearest-neighbour: an impact sheet drawn bilinear over a
    // stage is the one thing in the arena that would not look like a sprite.
    for (const call of calls) {
      expect(call.globalCompositeOperation).toBe('lighter');
      expect(call.imageSmoothingEnabled).toBe(false);
    }

    // **All three parts, by their own source rectangles.** "Some drawImage
    // happened" is satisfied by a beam alone -- the muzzle could be dropped
    // entirely and every assertion above would still pass, which is exactly
    // what mutation M10 did. The cells are read back off the sheet rather than
    // written out, so this stays true of a re-authored layout and false of a
    // part that stopped being drawn.
    const drawn = new Set(calls.map((call) => `${String(call.args[0])},${String(call.args[1])}`));
    for (const part of ULT_PARTS) {
      const cell = ult.partFor('clawde', part);
      expect(drawn.has(`${String(cell?.sx)},${String(cell?.sy)}`), part).toBe(true);
    }
    // And the beam is tiled rather than stretched: more segments than parts.
    expect(calls.length).toBeGreaterThan(ULT_PARTS.length);
  });

  it('level 1: draws the beam on a whiff and withholds only the impact art', () => {
    // The whiff case, driven through the *sprite* path. The existing whiff case
    // runs with no sheet, so it exercises the level-3 fallback and would pass
    // with the sprite path's `connected` check removed entirely -- which is
    // what mutation M7 did.
    const ult = ultSheetFor(['clawde']);
    const impact = ult.partFor('clawde', 'impact');
    const beam = ult.partFor('clawde', 'beam');

    const hit = stageImages(releasing(), ult, 'clawde');
    const whiff = stageImages(releasing({ connected: false }), ult, 'clawde');

    const cells = (calls: readonly Call[]): Set<string> =>
      new Set(calls.map((call) => `${String(call.args[0])},${String(call.args[1])}`));

    // The beam fires either way -- the fighter threw it.
    expect(cells(whiff).has(`${String(beam?.sx)},${String(beam?.sy)}`)).toBe(true);
    // The impact art is the damage, and only the connecting case has any.
    expect(cells(hit).has(`${String(impact?.sx)},${String(impact?.sy)}`)).toBe(true);
    expect(cells(whiff).has(`${String(impact?.sx)},${String(impact?.sy)}`)).toBe(false);
    expect(whiff.length).toBe(hit.length - 1);
  });

  it('level 1: two fighters produce two different cinematics', () => {
    // The Story 9.7 failure, guarded: four packs shipped and two wired, with
    // nothing saying so. Per-character art is only per-character if the source
    // rectangles actually differ.
    const ult = ultSheetFor(['clawde', 'chatty']);
    const clawde = ult.partFor('clawde', 'beam');
    const chatty = ult.partFor('chatty', 'beam');
    expect(clawde).toBeDefined();
    expect(chatty).toBeDefined();
    expect(clawde?.sx).not.toBe(chatty?.sx);

    // And the aura they glow in differs too, which is the other half of whose.
    expect(auraFor('clawde')).not.toBe(auraFor('chatty'));

    // Through the real compositor, both fighters and both directions.
    const first = createRecordingCanvas();
    const second = createRecordingCanvas();
    drawJuicedFrame(first, FRAME, juiceFrame({ cinematic: releasing({ agentIndex: 0 }) }), {
      ...OPTIONS,
      ult,
      roster: DEFAULT_ROSTER,
    });
    drawJuicedFrame(second, FRAME, juiceFrame({ cinematic: releasing({ agentIndex: 1 }) }), {
      ...OPTIONS,
      ult,
      roster: DEFAULT_ROSTER,
    });
    expect(first.calls).not.toStrictEqual(second.calls);
  });

  it('level 2: no sheet, but a known caster, draws a procedural beam in their aura', () => {
    const ctx = createRecordingCanvas();
    drawCinematicStage(ctx, releasing(), VIEWPORT, THEME, undefined, 'clawde');
    const fills = ctx.calls.filter((call) => call.op === 'fillRect');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.some((call) => call.fillStyle === auraFor('clawde'))).toBe(true);
    expect(fills.some((call) => call.fillStyle === ARENA_PALETTE.ultFlash)).toBe(true);
    // And nothing in the site accent, which is the level-3 fallback's colour.
    expect(fills.some((call) => call.fillStyle === THEME.accent)).toBe(false);
    expect(ctx.calls.some((call) => call.op === 'drawImage')).toBe(false);
  });

  it('level 3: no roster at all falls all the way back to Story 10.4', () => {
    const ctx = createRecordingCanvas();
    drawCinematicStage(ctx, releasing(), VIEWPORT, THEME, ultSheetFor(['clawde']), undefined);
    const fills = ctx.calls.filter((call) => call.op === 'fillRect');
    expect(fills.length).toBeGreaterThan(0);
    // The accent band and its cap, exactly as 10.4 drew them.
    for (const call of fills) {
      expect(call.fillStyle).toBe(THEME.accent);
    }
    expect(ctx.calls.some((call) => call.op === 'drawImage')).toBe(false);
  });

  it('draws the caster portrait and their name, and the banner without one', () => {
    const withPortrait = createRecordingCanvas();
    drawCinematicPlate(
      withPortrait,
      cinematicWith({ portraitBasisPoints: BASIS_POINTS_FULL, letterboxPx: 52, title: true }),
      VIEWPORT,
      THEME,
      ultSheetFor(['clawde']),
      'clawde',
    );
    expect(withPortrait.calls.some((call) => call.op === 'drawImage')).toBe(true);
    const names = withPortrait.calls.filter((call) => call.op === 'fillText');
    expect(names.map((call) => call.args[0])).toStrictEqual([
      ROSTER_NAMES.clawde,
      ROSTER_NAMES.clawde,
    ]);
    // Twice: the hard offset shadow, which is the treatment Story 11.3 settled
    // on rather than a third typeface.
    expect(names[0].args[1]).not.toBe(names[1].args[1]);
    expect(withPortrait.font).toBe(THEME.arcadeFont);
    // The banner is *not* drawn over a portrait -- a full-width warn plate
    // through a letterboxed cutscene is the thing this replaced.
    expect(names.some((call) => call.args[0] === 'ULTIMATE')).toBe(false);
  });

  it('stands the banner in when the portrait alone is missing', () => {
    // A fighter whose beam decoded and whose portrait 404'd. The two are
    // separate files, so they are dropped separately.
    const sheet = ultSheetFor(['clawde'], { portraits: false });
    expect(sheet.partFor('clawde', 'beam')).toBeDefined();
    expect(sheet.portraitFor('clawde')).toBeUndefined();

    const ctx = createRecordingCanvas();
    drawCinematicPlate(
      ctx,
      cinematicWith({ portraitBasisPoints: BASIS_POINTS_FULL, letterboxPx: 52, title: true }),
      VIEWPORT,
      THEME,
      sheet,
      'clawde',
    );
    expect(ctx.calls.some((call) => call.op === 'drawImage')).toBe(false);
    expect(ctx.calls.some((call) => call.args[0] === 'ULTIMATE')).toBe(true);
  });

  it('never throws on any combination of absent art and unknown caster', () => {
    // The acceptance criterion as a sweep rather than as three cases: whatever
    // is missing, the Ultimate is still thrown, without throwing.
    for (const ult of [undefined, ultSheetFor(['clawde']), ultSheetFor(['clawde'], { portraits: false })]) {
      for (const caster of [undefined, 'clawde' as const, 'chatty' as const]) {
        for (const record of [cinematicWith({ orbRadiusPx: 20, letterboxPx: 52 }), releasing()]) {
          expect(() => {
            const ctx = createRecordingCanvas();
            drawCinematicStage(ctx, record, VIEWPORT, THEME, ult, caster);
            drawCinematicPlate(ctx, record, VIEWPORT, THEME, ult, caster);
          }).not.toThrow();
        }
      }
    }
  });

  it('restores both compositing modes after every additive layer', () => {
    // `lighter` left set would additively blend the *next* frame's backdrop and
    // fighters, which reads as the whole stage catching fire on the frame after
    // an Ultimate. The same failure `paintImpacts` guards against, in a path
    // that sets the mode a dozen times a frame rather than once.
    const ctx = createRecordingCanvas();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    drawCinematicStage(ctx, releasing(), VIEWPORT, THEME, ultSheetFor(['clawde']), 'clawde');
    drawCinematicPlate(
      ctx,
      releasing({ flashBasisPoints: 4_000, letterboxPx: 52, portraitBasisPoints: BASIS_POINTS_FULL }),
      VIEWPORT,
      THEME,
      ultSheetFor(['clawde']),
      'clawde',
    );
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(ctx.globalAlpha).toBe(1);
  });

  it('grades every layered glow outward-in: wider means dimmer', () => {
    // Round 1 shipped all three of these inverted -- the widest layer at full
    // opacity -- and every call-sequence assertion in this file passed. A glow
    // drawn that way is not a glow: it is a solid square with two smaller
    // squares on it, and no amount of checking *that* the calls happened can
    // see it. So the ordering is what is asserted.
    //
    // Written as "strictly wider implies strictly dimmer" rather than against
    // the alpha table's own numbers, which would hold for any table including
    // the inverted one.
    const cases: readonly [string, () => readonly Call[]][] = [
      [
        'the orb at the caster hand',
        () => {
          const ctx = createRecordingCanvas();
          drawCinematicPlate(
            ctx,
            cinematicWith({ orbRadiusPx: 24, portraitBasisPoints: BASIS_POINTS_FULL, letterboxPx: 52 }),
            VIEWPORT,
            THEME,
            undefined,
            'clawde',
          );
          return ctx.calls;
        },
      ],
      [
        'the procedural beam',
        () => {
          const ctx = createRecordingCanvas();
          // `impactCovers: false` so only the beam's own stack is recorded:
          // the impact flare is a fourth additive fill and belongs to a
          // different question.
          drawCinematicStage(
            ctx,
            releasing({ impactCovers: false }),
            VIEWPORT,
            THEME,
            undefined,
            'clawde',
          );
          return ctx.calls;
        },
      ],
    ];

    for (const [what, run] of cases) {
      const fills = run().filter((call) => call.op === 'fillRect');
      expect(fills.length, what).toBeGreaterThanOrEqual(GLOW_LAYER_COUNT);

      // Every additive layer, in the order it was drawn, as (extent, alpha).
      const layers = fills
        .filter((call) => call.globalCompositeOperation === 'lighter')
        .map((call) => ({
          // The *narrow* axis. A layered orb varies on both, but a beam layer
          // varies only in thickness -- its length is the sweep and is the same
          // for all three -- so the wide axis would report every layer as
          // equally large and the ordering would go unchecked.
          extent: Math.min(call.args[2] as number, call.args[3] as number),
          alpha: call.globalAlpha,
        }));
      expect(layers.length % GLOW_LAYER_COUNT, what).toBe(0);
      expect(layers.length, what).toBeGreaterThanOrEqual(GLOW_LAYER_COUNT);

      // One plate frame can carry two stacks -- the wash behind the portrait
      // and the orb at the hand -- so they are checked a stack at a time
      // rather than as one run. Across a stack boundary the extent legitimately
      // jumps back up, and a flat sweep would read that as an inversion.
      for (let at = 0; at < layers.length; at += GLOW_LAYER_COUNT) {
        const stack = layers.slice(at, at + GLOW_LAYER_COUNT);
        for (const [index, layer] of stack.entries()) {
          if (index === 0) {
            continue;
          }
          const previous = stack[index - 1];
          // Each successive layer is no wider than the last, and where it is
          // strictly narrower it must be strictly brighter.
          expect(layer.extent, what).toBeLessThanOrEqual(previous.extent);
          if (layer.extent < previous.extent) {
            expect(layer.alpha, what).toBeGreaterThan(previous.alpha);
          }
        }
        // And the widest layer is never fully opaque, which is what made the
        // inverted version read as a block rather than as light.
        expect(stack[0].alpha, what).toBeLessThan(1);
        expect(stack[stack.length - 1].alpha, what).toBeGreaterThan(stack[0].alpha);
        expect(stack[stack.length - 1].extent, what).toBeLessThan(stack[0].extent);
      }
    }
  });

  it('grades the vignette darkest at the edge, not evenly across the frame', () => {
    // Round 1 divided one strength equally between six *disjoint* rings, which
    // darkens the centre exactly as much as the edge -- a grey wash rather than
    // a vignette. The rings do not overlap, so the alpha has to fall inward on
    // its own.
    const ctx = createRecordingCanvas();
    drawCinematicPlate(
      ctx,
      cinematicWith({ vignetteBasisPoints: 6_500 }),
      VIEWPORT,
      THEME,
    );
    const rings = ctx.calls.filter(
      (call) => call.op === 'fillRect' && call.fillStyle === ARENA_PALETTE.curtain,
    );
    expect(rings.length).toBeGreaterThan(4);

    // The alpha of the ring at each inset, outermost first.
    const byInset = new Map<number, number>();
    for (const ring of rings) {
      const inset = Math.min(ring.args[0] as number, ring.args[1] as number);
      byInset.set(inset, ring.globalAlpha);
    }
    const insets = [...byInset.keys()].sort((a, b) => a - b);
    expect(insets.length).toBeGreaterThan(4);
    for (const [index, inset] of insets.entries()) {
      if (index === 0) {
        continue;
      }
      expect(byInset.get(inset)).toBeLessThan(byInset.get(insets[index - 1]) ?? 0);
    }
    // The innermost ring is nearly clear and the outermost is not, which is
    // what "vignette" means and what an even division could never produce.
    expect(byInset.get(insets[0])).toBeGreaterThan(byInset.get(insets[insets.length - 1]) ?? 0);
  });

  it('tints the slam with the caster aura rather than painting flat white', () => {
    const ctx = createRecordingCanvas();
    drawCinematicPlate(
      ctx,
      releasing({ flashBasisPoints: BASIS_POINTS_FULL }),
      VIEWPORT,
      THEME,
      undefined,
      'clawde',
    );
    const plate = ctx.calls.find(
      (call) => call.op === 'fillRect' && call.args[3] === VIEWPORT.height,
    );
    expect(plate).toBeDefined();
    expect(plate?.fillStyle).not.toBe(ARENA_PALETTE.ultFlash);
    expect(plate?.fillStyle).not.toBe(auraFor('clawde'));
    // 40% of clawde's aura into `#ffffff`, worked out by hand rather than
    // read back off the mixer: 255 - 0.4*(255-217) = 240 = `f0`,
    // 255 - 0.4*(255-119) = 201 = `c9`, 255 - 0.4*(255-6) = 155 = `9b`.
    expect(plate?.fillStyle).toMatch(/^#[0-9a-f]{6}$/);
    expect(plate?.fillStyle).toBe('#f0c99b');
  });
});

/**
 * Story 11.2. The impact FX sheet, at the compositing layer.
 *
 * Everything here runs against the *shape* of the shipped sheet -- a 1040x1040
 * image of 208px cells -- built through the real `validateVfxSheetLayout` and
 * `createVfxSheet` rather than a hand-rolled stub, so these cases exercise the
 * loader the page runs.
 *
 * The layout *values* below are nonetheless a hand copy of
 * `public/fx/layout.json`, and this file would stay green if that file were
 * retuned. That is deliberate: this suite is about the compositing -- which
 * source rect, which blend mode, which alpha -- and pinning it to numbers that
 * a later story is expected to change would make every retune look like a
 * regression here. The drift between the shipped layout and the tuning is
 * caught in exactly one place, `juice.test.ts`, which reads the file from disk.
 *
 * The image is a bare `{ width, height }`: `createVfxSheet` needs nothing more
 * of it, and `drawImage`'s first argument is `unknown` by design in the port.
 */
const FX_IMAGE = '/fx/fx_sheet.png';

function vfxSheet(): VfxSheet {
  return createVfxSheet(
    new Map([[FX_IMAGE, { width: 1_040, height: 1_040 }]]),
    validateVfxSheetLayout({
      frameWidth: 208,
      frameHeight: 208,
      poses: {
        spark_l: { image: FX_IMAGE, x: 0, y: 0, frames: 4, holdFrames: 3 },
        spark_h: { image: FX_IMAGE, x: 0, y: 208, frames: 4, holdFrames: 3 },
        ko_burst: { image: FX_IMAGE, x: 0, y: 832, frames: 5, holdFrames: 4 },
      },
    }),
  );
}

function impactOf(kind: JuiceKind, overrides: Partial<JuiceImpact> = {}): JuiceImpact {
  return {
    kind,
    positionBasisPoints: BASIS_POINTS_FULL / 2,
    heightPx: 96,
    ageFrames: 0,
    alphaBasisPoints: BASIS_POINTS_FULL,
    sizePx: 128,
    ...overrides,
  };
}

/** Every `drawImage` a paint issued, in order. */
function sprites(calls: readonly Call[]): readonly Call[] {
  return calls.filter((call) => call.op === 'drawImage');
}

describe('a hit throws its grade of impact art at the contact point', () => {
  it('reads a different source rect for a light hit than for a heavy one', () => {
    // The acceptance criterion, exactly as written: `spark_l` for a light hit,
    // `spark_h` for a heavy one. Both are cells in column 0; what separates
    // them is the row, so `sy` is the assertion that matters.
    const light = createRecordingCanvas();
    const heavy = createRecordingCanvas();
    drawJuiceOverlay(light, juiceFrame({ impacts: [impactOf('hit')] }), VIEWPORT, THEME, vfxSheet());
    drawJuiceOverlay(heavy, juiceFrame({ impacts: [impactOf('heavy')] }), VIEWPORT, THEME, vfxSheet());

    const [lightSprite] = sprites(light.calls);
    const [heavySprite] = sprites(heavy.calls);
    expect(lightSprite.args.slice(0, 4)).toStrictEqual([0, 0, 208, 208]);
    expect(heavySprite.args.slice(0, 4)).toStrictEqual([0, 208, 208, 208]);
    expect(lightSprite.args).not.toStrictEqual(heavySprite.args);
  });

  it('selects the ko_burst row for a KO, so the last hit does not look like the first', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(ctx, juiceFrame({ impacts: [impactOf('ko')] }), VIEWPORT, THEME, vfxSheet());

    const [sprite] = sprites(ctx.calls);
    // Cell 20 of a 5-wide grid of 208px cells: row 4, column 0.
    expect(sprite.args.slice(0, 4)).toStrictEqual([0, 832, 208, 208]);
  });

  it('advances one atlas frame per holdFrames, and never on a wall clock', () => {
    // The whole animation is a function of one integer: how many clock frames
    // have elapsed since the hit landed. Ages 0-2 read cell 0, 3-5 cell 1.
    const columns = [0, 1, 2, 3, 4, 5, 6, 9].map((ageFrames) => {
      const ctx = createRecordingCanvas();
      drawJuiceOverlay(
        ctx,
        juiceFrame({ impacts: [impactOf('hit', { ageFrames })] }),
        VIEWPORT,
        THEME,
        vfxSheet(),
      );
      return (sprites(ctx.calls)[0].args[0] as number) / 208;
    });
    expect(columns).toStrictEqual([0, 0, 0, 1, 1, 1, 2, 3]);
  });

  it('clamps to the last cell of a pose rather than reading off the strip', () => {
    // The I/O matrix's "impact outlives its pose" row, at the drawing layer.
    // A source rect past the end of the image is not an exception a canvas
    // raises -- it silently draws nothing, which reads as a hit that had no
    // effect.
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({ impacts: [impactOf('hit', { ageFrames: 10_000 })] }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );
    const [sprite] = sprites(ctx.calls);
    const [sx, , sw] = sprite.args as readonly number[];
    expect(sx).toBe(3 * 208);
    expect(sx + sw).toBeLessThanOrEqual(1_040);
  });

  it('draws additively, at the tuned alpha, and restores both modes afterwards', () => {
    // Story 11.1 released the arena from the flat-surface rule and this is what
    // 11.2 spends it on. `lighter` left set would additively blend the *next*
    // frame's backdrop and fighters, which reads as the whole stage catching
    // fire on the frame after a hit -- so the restore is asserted, not assumed.
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({
        impacts: [impactOf('hit', { alphaBasisPoints: 4_000 })],
        damageNumbers: [{ damage: 9, positionBasisPoints: 5_000, heightPx: 120 }],
      }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );

    const [sprite] = sprites(ctx.calls);
    expect(sprite.globalCompositeOperation).toBe('lighter');
    // The single float in the whole impact path: basis points divided once, at
    // the canvas boundary.
    expect(sprite.globalAlpha).toBeCloseTo(0.4, 10);

    // And the number drawn after it is back to an ordinary opaque draw.
    const number = ctx.calls.find((call) => call.op === 'fillText');
    expect(number?.globalAlpha).toBe(1);
    expect(number?.globalCompositeOperation).toBe('source-over');
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe('source-over');
  });

  it('puts back the modes it was handed, not the ones it expected', () => {
    // The case above cannot see the difference: its recorder is *constructed*
    // at `1` / `'source-over'`, so hardcoding those two literals at the end of
    // `paintImpacts` would pass it. `drawJuicedFrame` wraps this in
    // `save`/`restore` and would hide the difference too -- but
    // `drawJuiceOverlay` is exported, and a caller mid-way through its own
    // fade would silently get full opacity back.
    const ctx = createRecordingCanvas();
    ctx.globalAlpha = 0.25;
    ctx.globalCompositeOperation = 'multiply';

    drawJuiceOverlay(
      ctx,
      juiceFrame({ impacts: [impactOf('hit', { alphaBasisPoints: 4_000 })] }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );

    expect(ctx.globalAlpha).toBe(0.25);
    expect(ctx.globalCompositeOperation).toBe('multiply');
  });

  it('draws the sheet unsmoothed, and puts the flag back as it found it', () => {
    // `artist.ts` and `backdrop.ts` set `imageSmoothingEnabled = false` inside
    // their own `save`/`restore` pairs, so the flag is at the canvas default --
    // `true` -- by the time the juice layer runs. These cells are 208px pixel
    // art drawn down to 128 for a `hit` and up to 260 for a `ko`; inheriting
    // that default makes the impact sheet the one thing in the arena drawn
    // bilinear, and every other assertion in this file passes while it happens.
    const ctx = createRecordingCanvas();
    expect(ctx.imageSmoothingEnabled).toBe(true);

    drawJuiceOverlay(
      ctx,
      juiceFrame({ impacts: [impactOf('hit', { alphaBasisPoints: 10_000 })] }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );

    const [sprite] = sprites(ctx.calls);
    expect(sprite.imageSmoothingEnabled).toBe(false);
    // Restored to what it was handed, not to `false`: `drawJuiceOverlay` is
    // exported, and a caller that had smoothing on for its own photographic
    // layer must get it back.
    expect(ctx.imageSmoothingEnabled).toBe(true);
  });

  it('centres the sprite on the contact point, at whole pixels, above the floor', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({
        impacts: [impactOf('heavy', { positionBasisPoints: 2_500, heightPx: 100, sizePx: 176 })],
      }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );

    const [sprite] = sprites(ctx.calls);
    const [, , , , dx, dy, dw, dh] = sprite.args as readonly number[];
    // A quarter across a 960-wide stage, less half a 176px sprite.
    expect(dx).toBe(240 - 88);
    expect(dy).toBe(GROUND_Y - 100 - 88);
    expect(dw).toBe(176);
    expect(dh).toBe(176);
    for (const value of [dx, dy, dw, dh]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('draws the squares as well as the sprite: no debris is removed', () => {
    // AC1's "in addition to the existing scatter squares, and no square is
    // removed". The sprite is an addition to the burst, not a replacement for
    // it, and the burst is also the fallback -- so a change that dropped the
    // squares would break the fail-soft path invisibly.
    const spark = { positionBasisPoints: 5_000, offsetPx: 12, heightPx: 96, sizePx: 5 };
    const withSheet = createRecordingCanvas();
    const without = createRecordingCanvas();
    drawJuiceOverlay(
      withSheet,
      juiceFrame({ sparks: [spark], impacts: [impactOf('hit')] }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );
    drawJuiceOverlay(without, juiceFrame({ sparks: [spark], impacts: [impactOf('hit')] }), VIEWPORT, THEME);

    const squares = (calls: readonly Call[]): readonly Call[] =>
      calls.filter((call) => call.op === 'fillRect');
    expect(squares(withSheet.calls)).toStrictEqual(squares(without.calls));
    // The debris is drawn *before* the flash, and the damage number after both,
    // so the one thing on screen that has to be read is never under an
    // additive sprite.
    expect(withSheet.calls[0].op).toBe('fillRect');
    expect(sprites(withSheet.calls)).toHaveLength(1);
  });

  it('draws one sprite per impact, in the order the track listed them', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(
      ctx,
      juiceFrame({
        impacts: [
          impactOf('hit', { positionBasisPoints: 1_000 }),
          impactOf('ko', { positionBasisPoints: 9_000 }),
        ],
      }),
      VIEWPORT,
      THEME,
      vfxSheet(),
    );

    const drawn = sprites(ctx.calls);
    expect(drawn).toHaveLength(2);
    expect(drawn[0].args[1]).toBe(0);
    expect(drawn[1].args[1]).toBe(832);
  });
});

describe('with no sheet loaded, the square-spark path draws and nothing throws', () => {
  it('issues the exact call sequence it issued before this story', () => {
    // The fail-soft claim, as an equality rather than as an absence. A sheet
    // that 404s, will not parse or will not decode leaves `vfx` undefined, and
    // what a visitor then sees must be the Story 9.5 picture unchanged.
    const frame = juiceFrame({
      shakeX: 5,
      shakeY: -3,
      sparks: [{ positionBasisPoints: 5_000, offsetPx: 9, heightPx: 96, sizePx: 5 }],
      impacts: [impactOf('heavy')],
      damageNumbers: [{ damage: 14, positionBasisPoints: 5_000, heightPx: 120 }],
    });
    const noSheet = createRecordingCanvas();
    const noImpacts = createRecordingCanvas();

    expect(() => {
      drawJuicedFrame(noSheet, FRAME, frame, OPTIONS);
    }).not.toThrow();
    drawJuicedFrame(noImpacts, FRAME, { ...frame, impacts: [] }, OPTIONS);

    expect(noSheet.calls).toStrictEqual(noImpacts.calls);
    expect(sprites(noSheet.calls)).toStrictEqual([]);
    // And the squares really were drawn, so the case is not vacuous.
    expect(noSheet.calls.filter((call) => call.fillStyle === THEME.accent).length).toBeGreaterThan(0);
  });

  it('skips an impact whose image never decoded, rather than throwing mid-paint', () => {
    // A sheet whose layout validated and whose image is missing from the map
    // cannot be built by `createVfxSheet` -- it fails at creation. This is the
    // belt-and-braces half: a `frameFor` naming a file `imageFor` cannot
    // resolve draws nothing instead of aborting the animation-frame callback.
    const sheet = vfxSheet();
    const lying: VfxSheet = Object.freeze({
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
      imageUrls: sheet.imageUrls,
      imageFor: (): undefined => undefined,
      frameFor: (pose: VfxPose, ageFrames: number) => sheet.frameFor(pose, ageFrames),
      lifeFramesFor: (pose: VfxPose) => sheet.lifeFramesFor(pose),
    });
    const ctx = createRecordingCanvas();
    expect(() => {
      drawJuiceOverlay(ctx, juiceFrame({ impacts: [impactOf('ko')] }), VIEWPORT, THEME, lying);
    }).not.toThrow();
    expect(sprites(ctx.calls)).toStrictEqual([]);
  });

  it('draws nothing at all for a frame with no sparks, numbers or impacts', () => {
    const ctx = createRecordingCanvas();
    drawJuiceOverlay(ctx, juiceFrame(), VIEWPORT, THEME, vfxSheet());
    expect(ctx.calls).toStrictEqual([]);
  });
});

/**
 * The scrub property, at the drawing layer.
 *
 * `juice.ts` already proves its *track* answers identically however a frame was
 * reached. This is the other half: that the same track entry, drawn twice,
 * issues byte-identical calls -- including the source rects, the alpha and the
 * composite mode, which are the three things this story added and the three
 * a `toStrictEqual` on the previous recorder could not have seen.
 */
function stateWithHealth(health: readonly [number, number], tick = 0): FighterState {
  return stateWith({ health: [...health], tick });
}

/** A short exchange: a light hit, a heavy one, then a KO, one per Decision Point. */
function exchangeFilm(): readonly RenderFrame[] {
  const pairs: readonly (readonly [FighterState, FighterState])[] = [
    [stateWithHealth([100, 100]), stateWithHealth([100, 92], 30)],
    [stateWithHealth([100, 92], 30), stateWithHealth([100, 68], 60)],
    [stateWithHealth([100, 68], 60), stateWithHealth([100, 0], 90)],
    [stateWithHealth([100, 0], 90), stateWithHealth([100, 0], 120)],
  ];
  const frames: RenderFrame[] = [];
  for (const [step, pair] of pairs.entries()) {
    for (let offset = 0; offset < FRAMES_PER_DECISION; offset += 1) {
      frames.push({
        index: step * FRAMES_PER_DECISION + offset,
        decisionPoint: step,
        progressBasisPoints: Math.floor((offset * BASIS_POINTS_FULL) / FRAMES_PER_DECISION),
        from: pair[0],
        to: pair[1],
      });
    }
  }
  return frames;
}

/** Every call one clock frame's paint issued, as comparable strings. */
function paintAt(
  track: ReturnType<typeof buildJuiceTrack>,
  frames: readonly RenderFrame[],
  clockIndex: number,
  vfx: VfxSheet | undefined,
): readonly string[] {
  const ctx = createRecordingCanvas();
  drawJuicedFrame(ctx, frames[track.filmIndexAt(clockIndex)], track.at(clockIndex), {
    ...OPTIONS,
    vfx,
  });
  return ctx.calls.map(
    (call) =>
      `${call.op}(${call.args.join(',')})@${call.fillStyle}|${String(call.globalAlpha)}|${call.globalCompositeOperation}`,
  );
}

describe('the same clock index draws the same picture, however it was reached', () => {
  it('issues an identical call sequence for the same index drawn twice', () => {
    const frames = exchangeFilm();
    const track = buildJuiceTrack(frames, DEFAULT_JUICE_TUNING);
    const sheet = vfxSheet();

    for (let index = 0; index < track.frameCount; index += 1) {
      expect(paintAt(track, frames, index, sheet)).toStrictEqual(
        paintAt(track, frames, index, sheet),
      );
    }
  });

  it('reproduces identical frames seeking backwards and forwards across the exchange', () => {
    // AC3 as a test rather than as an intention. Playback walks the exchange
    // forward and keeps every frame; the scrub then asks for the same indexes
    // out of order and backwards, and must get the same pictures.
    const frames = exchangeFilm();
    const track = buildJuiceTrack(frames, DEFAULT_JUICE_TUNING);
    const sheet = vfxSheet();

    const played = Array.from({ length: track.frameCount }, (_unused, index) =>
      paintAt(track, frames, index, sheet),
    );
    const seekOrder = [track.frameCount - 1, 0, 7, 41, 3, 30, 18, 2, track.frameCount - 2];
    for (const index of seekOrder) {
      const target = Math.max(0, Math.min(track.frameCount - 1, index));
      expect(paintAt(track, frames, target, sheet)).toStrictEqual(played[target]);
    }

    // And the exchange really did throw impact art, so the case is not vacuous.
    const drew = played.filter((calls) => calls.some((call) => call.startsWith('drawImage(')));
    expect(drew.length).toBeGreaterThan(0);
  });

  it('throws all three grades across the exchange, each from its own row', () => {
    // A light hit, a heavy hit and a KO in one film, so the pose selection is
    // exercised end to end through the real track rather than through a
    // hand-built `JuiceFrame`.
    const frames = exchangeFilm();
    const track = buildJuiceTrack(frames, DEFAULT_JUICE_TUNING);
    const sheet = vfxSheet();
    const kinds = new Set<JuiceKind>();
    const rows = new Set<number>();
    for (let index = 0; index < track.frameCount; index += 1) {
      for (const impact of track.at(index).impacts) {
        kinds.add(impact.kind);
      }
      for (const call of paintAt(track, frames, index, sheet)) {
        const match = /^drawImage\(\d+,(\d+),/.exec(call);
        if (match !== null) {
          rows.add(Number(match[1]));
        }
      }
    }
    expect([...kinds].sort()).toStrictEqual(['heavy', 'hit', 'ko']);
    expect([...rows].sort((a, b) => a - b)).toStrictEqual([0, 208, 832]);
  });
});
