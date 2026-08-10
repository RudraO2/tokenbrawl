import { readFileSync } from 'node:fs';
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
import {
  FLOOR_INSET,
  HUD_ROW_SPANS,
  ROUND_PIPS_PER_SIDE,
  cameraForFrame,
  drawFrame,
  hudRegions,
  type DrawFrameOptions,
} from './renderer';
import {
  ARCADE_HUD_COLOURS,
  ARMED_PULSE_HOLD_FRAMES,
  FRAME_THICKNESS,
  SUPER_METER_BANDS,
  timerLabel,
  timerReading,
} from './hud';
import { auraFor } from './roster';
import { ARENA_PALETTE } from './arena-palette';
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
  /** Story 11.3: which face a callout was drawn in is now a thing worth asserting. */
  readonly font: string;
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
    calls.push({
      op,
      args,
      fillStyle: surface.fillStyle,
      strokeStyle: surface.strokeStyle,
      font: surface.font,
    });
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  surface.save = () => record('save', []);
  surface.restore = () => record('restore', []);
  // Story 12.3. Recorded, not applied -- which is the point. Every coordinate
  // assertion in this file is about the arithmetic `drawFrame` performs, and
  // the camera deliberately does not touch that arithmetic: it moves the
  // surface underneath it. So these two are here to be *seen* in the sequence
  // (the camera-wiring cases below read them) rather than to change any number
  // recorded around them. The transform's own behaviour is `camera.test.ts`'s.
  surface.translate = (x, y) => record('translate', [x, y]);
  surface.scale = (x, y) => record('scale', [x, y]);
  // Story 12.6. The HUD portrait is the first thing `drawFrame` itself draws
  // through this call -- the sprite artists take their own surface -- so the
  // fake had to grow it. The image is recorded as its first argument, which is
  // how the portrait cases tell one fighter's face from the other's.
  surface.drawImage = (image, sx, sy, sw, sh, dx, dy, dw, dh) =>
    record('drawImage', [String(image), sx, sy, sw, sh, dx, dy, dw, dh]);

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

  it('uses only declared colours -- no hex is invented at draw time', () => {
    // Story 11.3 widens the allowed set for the first time since 4.1, and the
    // widening is the point rather than a concession: `render/` now draws from
    // two declared sources, the brand in `theme.ts` and the arena in
    // `arena-palette.ts`, and `ARCADE_HUD_COLOURS` is the arena half enumerated
    // by the module that emits it. What the sweep still forbids is a colour
    // that belongs to *neither* -- a hex computed at a call site, which is the
    // defect this test has always existed to catch and which `hero/raster.ts`
    // would turn into a throw.
    const allowed = new Set([
      THEME.bg,
      THEME.ink,
      THEME.accent,
      THEME.warn,
      THEME.muted,
      ...ARCADE_HUD_COLOURS,
      '',
    ]);
    const ctx = createRecordingCanvas();
    // Every branch that draws, in one frame: both Commitment Windows open, both
    // HUD stacks populated, one Token Bank draining and one exhausted. Drawing
    // the plain frame here would have left Story 4.4's two new colour paths
    // outside the sweep entirely.
    // Story 10.3 extends the same sweep to the armed Super Gauge: p1 is at
    // exactly `maxMeter`, which is the one meter value that arms it. 11.3 puts
    // the levels on `to`, which is the state the HUD now reads, and damages p2
    // across the step so the ghost layer is swept too.
    drawFrame(
      ctx,
      frameWith(
        stateWith({
          committedAction: [COMMITTED_ATTACK, COMMITTED_SPECIAL],
          commitmentRemaining: [20, 40],
          health: [55, 40],
          meter: [DEFAULT_FIGHTER_CONFIG.maxMeter, 15],
        }),
        stateWith({
          committedAction: [COMMITTED_ATTACK, COMMITTED_SPECIAL],
          commitmentRemaining: [20, 40],
          health: [55, 12],
          meter: [DEFAULT_FIGHTER_CONFIG.maxMeter, 15],
        }),
        3_000,
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

describe('the camera (12.3)', () => {
  /**
   * These are the cases the recorders exist for.
   *
   * An independent review of this story found that deleting the `applyCamera`
   * call from `drawFrame` left every test in `src/render` and `src/spectate`
   * green -- 510 of them -- and failed only the hero GIF's byte-for-byte drift
   * gate, whose message reads "expected 212902 to be 215489". A binary diff is
   * not a description of what broke. So the wiring is pinned here, in the file
   * that owns `drawFrame`'s call sequence, in terms a reader can act on.
   */
  const GROUND_Y = VIEWPORT.height - FLOOR_INSET;

  function transformAfter(ctx: RecordingCanvas, saveIndex: number): readonly RecordedCall[] {
    return ctx.calls().slice(saveIndex + 1, saveIndex + 4);
  }

  it('draws the fighters inside the camera transform and everything else outside it', () => {
    const frame = frameWith(stateWith(), stateWith());
    const ctx = draw(frame);
    const ops = ctx.calls();
    const camera = cameraForFrame(frame, DEFAULT_FIGHTER_CONFIG, VIEWPORT);

    const saveAt = ops.findIndex((call) => call.op === 'save');
    const restoreAt = ops.findIndex((call) => call.op === 'restore');
    expect(saveAt).toBeGreaterThan(0);
    expect(restoreAt).toBeGreaterThan(saveAt);

    expect(transformAfter(ctx, saveAt).map((call) => [call.op, ...call.args])).toStrictEqual([
      ['translate', VIEWPORT.width / 2, GROUND_Y],
      ['scale', camera.scale, camera.scale],
      ['translate', -camera.x, -GROUND_Y],
    ]);

    // The floor rule is laid before the camera, because it spans the frame
    // however the camera is pointed.
    const floorAt = ops.findIndex(
      (call) =>
        call.op === 'fillRect' && call.args[1] === GROUND_Y && call.args[2] === VIEWPORT.width,
    );
    expect(floorAt).toBeGreaterThanOrEqual(0);
    expect(floorAt).toBeLessThan(saveAt);

    // Both fighter bodies are inside it.
    const bodies = ops
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.op === 'fillRect' && call.args[3] === 160);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const { index } of bodies) {
      expect(index).toBeGreaterThan(saveAt);
      expect(index).toBeLessThan(restoreAt);
    }

    // And the HUD is outside it, which is what keeps its screen coordinates
    // unchanged by any camera value.
    const tickAt = ops.findIndex(
      (call) => call.op === 'fillText' && String(call.args[0]).startsWith('TICK'),
    );
    expect(tickAt).toBeGreaterThan(restoreAt);
  });

  it('applies the camera the frame asks for, not a fixed one', () => {
    // Two frames the old 1:1 mapping would have drawn with the same (absent)
    // transform, and which the camera has to distinguish: an opening pair, and
    // a pair jammed into the right corner.
    const opening = frameWith(stateWith(), stateWith());
    const corner = frameWith(
      stateWith({ position: [920, 960] }),
      stateWith({ position: [920, 960] }),
    );

    const openingTransform = (() => {
      const ctx = draw(opening);
      return transformAfter(ctx, ctx.calls().findIndex((call) => call.op === 'save'));
    })();
    const cornerTransform = (() => {
      const ctx = draw(corner);
      return transformAfter(ctx, ctx.calls().findIndex((call) => call.op === 'save'));
    })();

    expect(openingTransform).not.toStrictEqual(cornerTransform);
    expect(cornerTransform[1].args[0]).toBeGreaterThan(Number(openingTransform[1].args[0]));
    expect(Number(cornerTransform[2].args[0])).toBeLessThan(
      Number(openingTransform[2].args[0]),
    );
  });

  it('leaves the HUD in screen space, whatever the camera is doing', () => {
    // The test plan's fourth line, as an assertion: two frames whose fighters
    // are as far apart as this arena allows, drawn at different camera scales
    // and different camera centres, must produce byte-identical HUD calls.
    const hudOf = (frame: RenderFrame): readonly (string | number)[][] => {
      const ops = draw(frame).calls();
      const restoreAt = ops.findIndex((call) => call.op === 'restore');
      return ops.slice(restoreAt + 1).map((call) => [call.op, ...call.args]);
    };
    expect(hudOf(frameWith(stateWith(), stateWith()))).toStrictEqual(
      hudOf(frameWith(stateWith({ position: [920, 960] }), stateWith({ position: [920, 960] }))),
    );
  });

  it('balances its save and restore, so nothing after it inherits the transform', () => {
    const ops = draw(frameWith(stateWith(), stateWith())).calls();
    let depth = 0;
    for (const call of ops) {
      if (call.op === 'save') depth += 1;
      if (call.op === 'restore') depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
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
    //
    // Story 11.3 makes REFLEX an arcade callout, which is two `fillText` calls
    // rather than one: a `hudPlate` shadow and the legible copy on top. So the
    // assertion is about the copy a viewer actually reads -- the last one --
    // and, separately, that warn is never the *text* colour on any pass. The
    // first-match form this test used before would now be inspecting the
    // shadow and would pass for a callout drawn entirely in it.
    const ctx = drawWithBanks([reading(0), null]);
    const reflex = ctx
      .calls()
      .filter((call) => call.op === 'fillText' && String(call.args[0]).includes('REFLEX'));

    expect(reflex).toHaveLength(2);
    expect(reflex[0].fillStyle).toBe(ARENA_PALETTE.hudPlate);
    expect(reflex[1].fillStyle).toBe(THEME.bg);
    for (const call of ctx.calls()) {
      if (call.op === 'fillText') {
        expect(call.fillStyle).not.toBe(THEME.warn);
      }
    }
  });

  it('shows both banks exhausted at once, and keeps drawing the fight (AC4)', () => {
    const ctx = drawWithBanks([reading(0), reading(0)]);

    // Counted on the legible copy, so the pair is two callouts rather than one
    // callout and its shadow.
    const reflex = ctx
      .calls()
      .filter(
        (call) =>
          call.op === 'fillText' &&
          String(call.args[0]).includes('REFLEX') &&
          call.fillStyle === THEME.bg,
      );
    expect(reflex).toHaveLength(2);
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
 * Story 10.3: the Super Gauge.
 *
 * Before this story a meter at 18 and a meter at 100 drew the same 10px
 * hairline in `theme.ink`, and the only way to tell an armed Ultimate from an
 * empty one was to read the `MTR` number beside it. The suite could not have
 * caught that -- both produce a perfectly valid call sequence -- so what is
 * pinned here is the part that *is* mechanical: that the armed state is
 * reachable at exactly one meter value, that it is a different sequence rather
 * than a slightly longer bar, that its one moving part counts `frame.index`,
 * and that Story 4.4's Token Bank row still sits clear beneath it.
 *
 * Appearance itself remains the visual gate's job (`docs/VISUAL-CHECK.md`).
 */
describe('the Super Gauge (10.3)', () => {
  /** Renderer-local layout, mirrored rather than imported -- the constants are not exported. */
  // Story 12.6 relaid the band: the bars moved down to make room for the
  // portrait and name above them, and they widened to 328 because the column
  // now starts where the portrait plate ends.
  const GAUGE_WIDTH = 328;
  const SEGMENT_WIDTH = 76;
  const HEALTH_TOP = 40;
  const METER_TOP = 62;
  const METER_HEIGHT = 16;
  const BANK_TOP = 126;
  const FULL = DEFAULT_FIGHTER_CONFIG.maxMeter;

  /**
   * A frame whose `from` and `to` agree, so the only thing under test is the
   * meter. Story 11.3 reads the HUD's levels off `to` -- see `drawFrame`'s
   * docblock -- and a helper that set them on `from` alone would draw an empty
   * gauge and pass nothing.
   */
  function drawMeter(
    meter: number,
    index = 0,
    banks?: readonly (BankReading | null)[],
    reducedMotion = false,
  ): RecordingCanvas {
    const ctx = createRecordingCanvas();
    const state = stateWith({ meter: [meter, 0] });
    drawFrame(
      ctx,
      { ...frameWith(state, state), index },
      { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT, banks, reducedMotion },
    );
    return ctx;
  }

  /**
   * p1's bar rules: the full-width, frame-thickness fills an arcade bar closes
   * with, which is the arcade HUD's equivalent of the `strokeRect` this suite
   * used to select on. Filtered to the left half of the viewport, because p2's
   * mirrored stack draws the identical shapes on the other side.
   *
   * `width` picks which bar: the health bar and the Token Bank span the whole
   * 320, and the Super Gauge is four 74-wide segments.
   */
  function barRules(ctx: RecordingCanvas, width: number): readonly RecordedCall[] {
    return ctx
      .calls()
      .filter(
        (call) =>
          call.op === 'fillRect' &&
          call.fillStyle === ARENA_PALETTE.hudFrame &&
          call.args[2] === width &&
          call.args[3] === FRAME_THICKNESS &&
          (call.args[0] as number) < VIEWPORT.width / 2,
      );
  }

  /** The distinct vertical positions bars of `width` were ruled at, top to bottom. */
  function ruleTops(ctx: RecordingCanvas, width: number): readonly number[] {
    return [...new Set(barRules(ctx, width).map((call) => call.args[1] as number))].sort(
      (a, b) => a - b,
    );
  }

  /** How many of the gauge's segments are lit -- a bevel is drawn only over a fill. */
  function litSegments(ctx: RecordingCanvas): number {
    return ctx
      .calls()
      .filter(
        (call) =>
          call.op === 'fillRect' &&
          call.fillStyle === ARENA_PALETTE.hudBevel &&
          // Inside the frame, so the bevel sits a frame-thickness down.
          call.args[1] === METER_TOP + FRAME_THICKNESS &&
          (call.args[0] as number) < VIEWPORT.width / 2,
      ).length;
  }

  function texts(ctx: RecordingCanvas): readonly string[] {
    return ctx
      .calls()
      .filter((call) => call.op === 'fillText')
      .map((call) => String(call.args[0]));
  }

  /**
   * The legible copy of each callout: the top pass, not its `hudPlate` shadow.
   *
   * Selected on `gold` since Story 12.6. The callout used to be drawn in
   * `THEME.bg` *on* the gold gauge; it is now drawn in gold on the ground,
   * below the gauge, because `arcadeText`'s hard shadow cannot separate type
   * from a flat gold ground and the visual gate photographed the result.
   */
  function callouts(ctx: RecordingCanvas, word: string): readonly RecordedCall[] {
    return ctx
      .calls()
      .filter(
        (call) =>
          call.op === 'fillText' &&
          String(call.args[0]).includes(word) &&
          call.fillStyle === ARENA_PALETTE.gold,
      );
  }

  it('is sized as a resource rather than as a rule (AC1)', () => {
    // The defect Story 10.3 exists for was a 10px hairline. The floor is set
    // against the health bar beside it (20px): a gauge that reads as a third of
    // its neighbour reads as a divider between two things, which is exactly what
    // a visitor took it for. 11.3 changed how the gauge is drawn and must not
    // change that, so the height is measured off the rules the segments close
    // with rather than off a `strokeRect` that no longer happens.
    const rules = ruleTops(drawMeter(50), SEGMENT_WIDTH);
    expect(rules).toHaveLength(2);
    expect(rules[1] - rules[0] + FRAME_THICKNESS).toBeGreaterThanOrEqual(16);
  });

  it('fills chunk by chunk while charging, so the gauge is countable (AC1)', () => {
    // 11.3 replaces the proportional rail with the reference's four segments.
    // The property is the same one the old test made -- more meter, more gauge
    // -- but a viewer now reads it by counting rather than by measuring.
    expect(litSegments(drawMeter(0))).toBe(0);
    expect(litSegments(drawMeter(25))).toBe(1);
    expect(litSegments(drawMeter(75))).toBe(3);
  });

  it('arms as one solid bar rather than four gapped ones (AC2)', () => {
    // Charging is segmented and armed is solid, which is the reference's own
    // behaviour and is what gives ULTIMATE READY an unbroken ground to sit on.
    // Asserted as a difference in *shape*: a charging gauge is ruled at the
    // segment width, an armed one at the full bar width, and never both.
    expect(ruleTops(drawMeter(75), SEGMENT_WIDTH)).toHaveLength(2);
    expect(ruleTops(drawMeter(FULL), SEGMENT_WIDTH)).toHaveLength(0);
    expect(ruleTops(drawMeter(FULL), GAUGE_WIDTH)).toContain(METER_TOP);
    // And it is filled edge to edge, not merely wide.
    expect(litSegments(drawMeter(FULL))).toBe(1);
  });

  it('charges on the ramp and arms on the gold, so the two states are different colours', () => {
    const chargingFills = new Set(drawMeter(75).calls().map((call) => call.fillStyle));
    const armedFills = new Set(drawMeter(FULL).calls().map((call) => call.fillStyle));

    expect(chargingFills.has(SUPER_METER_BANDS[3])).toBe(true);
    expect(armedFills.has(SUPER_METER_BANDS[3])).toBe(false);
  });

  it('arms at exactly full and at no other value (AC2)', () => {
    expect(texts(drawMeter(FULL))).toContain('ULTIMATE READY');
    expect(texts(drawMeter(FULL - 1)).some((text) => text.includes('ULTIMATE'))).toBe(false);
  });

  it('draws a full gauge as a different sequence, not as a longer bar (AC2)', () => {
    // The property the test plan names: the armed state is actually reachable
    // and actually distinct. A bar that merely reached its right edge would
    // satisfy neither.
    expect(drawMeter(FULL).calls()).not.toStrictEqual(drawMeter(FULL - 1).calls());
  });

  it('draws the callout off the gauge, in gold on the ground (12.6 AC2)', () => {
    // **This assertion is the inverse of the one Story 11.3 wrote here, and the
    // inversion is the story.** 11.3 put ground ink on the gold fill, which is
    // the direction `docs/DESIGN.md` requires of a warn pairing on the page --
    // and it was the wrong reading for a canvas callout, because `arcadeText`
    // draws a `hudPlate` hard shadow under every string and flat arcade gold is
    // the one ground that treatment cannot separate from. Story 12.1's gate
    // photographed `ULTIMATE READY` on the armed gauge and called it
    // unreadable, and Story 12.5's run recorded it a second time.
    //
    // So the pairing moved rather than flipped: gold type on `--tb-bg` at a
    // measured 13.74:1, in rows the gauge does not occupy, with the shadow
    // falling on the dark ground it was designed for.
    const armed = drawMeter(FULL);
    const callout = callouts(armed, 'ULTIMATE');
    expect(callout).toHaveLength(1);
    expect(callout[0].fillStyle).toBe(ARENA_PALETTE.gold);

    // The rows the gauge claims, and the rows the callout claims, do not meet.
    // Measured off the drawn baseline against the bar's own extent rather than
    // off the layout constants, so a future edit that slides one back onto the
    // other fails here as well as in the visual gate.
    const baseline = callout[0].args[2] as number;
    expect(baseline).toBeGreaterThan(METER_TOP + METER_HEIGHT);

    // And the gauge it describes is still an unbroken bar. The word spans more
    // than a quarter of the bar, so a segmented armed gauge would have gaps
    // running through the letters -- which is what the visual gate caught first.
    const goldFills = armed
      .calls()
      .filter(
        (call) =>
          call.op === 'fillRect' &&
          call.args[1] === METER_TOP &&
          call.args[2] === GAUGE_WIDTH &&
          (call.args[0] as number) < VIEWPORT.width / 2,
      );
    expect(goldFills.length).toBeGreaterThan(0);
  });

  it('pulses off the frame counter, never off a clock (AC3)', () => {
    // A replay seeked to the same frame twice must draw the identical gauge.
    expect(drawMeter(FULL, 7).calls()).toStrictEqual(drawMeter(FULL, 7).calls());
    // It holds for a whole step and then changes -- stepped, not eased.
    expect(drawMeter(FULL, 0).calls()).toStrictEqual(
      drawMeter(FULL, ARMED_PULSE_HOLD_FRAMES - 1).calls(),
    );
    expect(drawMeter(FULL, 0).calls()).not.toStrictEqual(
      drawMeter(FULL, ARMED_PULSE_HOLD_FRAMES).calls(),
    );
    // And it comes back round on its own period, which is what makes a scrub to
    // an arbitrary frame draw what playback drew when it passed through.
    expect(drawMeter(FULL, 0).calls()).toStrictEqual(
      drawMeter(FULL, ARMED_PULSE_HOLD_FRAMES * 4).calls(),
    );
  });

  it('stops breathing under reduced motion and changes nothing else (AC5)', () => {
    // The whole of AC5 for this element, stated as the difference it is allowed
    // to make: at a frame the pulse would have moved off level 0, the reduced
    // frame is the level-0 frame exactly -- same layout, same information, same
    // number of calls -- and it stays that way at every index.
    const moved = ARMED_PULSE_HOLD_FRAMES;
    expect(drawMeter(FULL, moved, undefined, true).calls()).toStrictEqual(
      drawMeter(FULL, 0, undefined, false).calls(),
    );
    expect(drawMeter(FULL, moved, undefined, true).calls()).not.toStrictEqual(
      drawMeter(FULL, moved, undefined, false).calls(),
    );
    for (const index of [0, 3, 6, 13, 24, 137]) {
      expect(drawMeter(FULL, index, undefined, true).calls()).toStrictEqual(
        drawMeter(FULL, 0, undefined, true).calls(),
      );
    }
  });

  it('leaves a charging gauge alone under reduced motion, because it never moved (AC5)', () => {
    expect(drawMeter(50, 0, undefined, true).calls()).toStrictEqual(
      drawMeter(50, 0, undefined, false).calls(),
    );
  });

  it('leaves the charging gauge with nothing that moves (AC3)', () => {
    // Only the armed state animates. A charging bar that blinked would be a
    // second thing competing for the eye at every meter value.
    expect(drawMeter(50, 0).calls()).toStrictEqual(drawMeter(50, 137).calls());
  });

  it('keeps the Token Bank row clear beneath it (AC5)', () => {
    const bank: BankReading = {
      remaining: 9_000,
      start: 25_000,
      filledBasisPoints: 3_600,
      exhausted: false,
    };
    // Charging rather than armed, so the gauge is at its *widest* footprint --
    // four segments plus their gaps -- which is the state that would collide
    // with the row beneath it if the layout were wrong.
    const ctx = drawMeter(50, 0, [bank, null]);

    // health, gauge, bank -- still three bars, still in that order down the
    // column, and the gauge still does not overlap the row beneath it.
    expect(ruleTops(ctx, GAUGE_WIDTH)).toStrictEqual([HEALTH_TOP, 56, BANK_TOP, 142]);
    const gaugeRules = ruleTops(ctx, SEGMENT_WIDTH);
    expect(gaugeRules[0]).toBe(METER_TOP);
    expect(BANK_TOP).toBeGreaterThanOrEqual(gaugeRules[1] + FRAME_THICKNESS);
    expect(texts(ctx)).toContain('BANK 9000');
  });

  it('shows a Baseline Bot no bank even with its gauge armed (AC5)', () => {
    const ctx = drawMeter(FULL);
    expect(texts(ctx).some((text) => text.startsWith('BANK'))).toBe(false);
    expect(texts(ctx)).toContain('ULTIMATE READY');
  });

  it('arms both fighters independently and keeps drawing the fight', () => {
    const ctx = createRecordingCanvas();
    const both = stateWith({ meter: [FULL, FULL] });
    drawFrame(ctx, frameWith(both, both), {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport: VIEWPORT,
    });

    // Counted on the legible copy of each callout rather than on every pass, so
    // two fighters armed is two gauges and not one gauge and its shadow.
    expect(callouts(ctx, 'ULTIMATE READY')).toHaveLength(2);
    expect(ctx.calls()[0].op).toBe('clearRect');
  });

  it('says nothing about time (INV-3)', () => {
    for (const text of texts(drawMeter(FULL))) {
      expect(text).not.toMatch(/\b(ms|sec|second|per|rate|elapsed)\b/i);
    }
  });
});

/**
 * Story 11.3's AC3: the callouts take the arcade treatment, the readouts do
 * not, and the split between the two is a deliberate line rather than whichever
 * strings happened to get changed.
 */
describe('the arcade type treatment (11.3 AC3)', () => {
  function callFor(word: string): readonly RecordedCall[] {
    const ctx = createRecordingCanvas();
    const state = stateWith({ meter: [DEFAULT_FIGHTER_CONFIG.maxMeter, 0] });
    drawFrame(ctx, frameWith(state, state), {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport: VIEWPORT,
      banks: [{ remaining: 0, start: 25_000, filledBasisPoints: 0, exhausted: true }, null],
    });
    return ctx.calls().filter((call) => call.op === 'fillText' && String(call.args[0]).includes(word));
  }

  it('draws TICK, ULTIMATE READY and REFLEX in the arcade face, each with its hard shadow', () => {
    // TICK is the one this suite would otherwise have missed entirely: it is
    // neither a bar label nor a state word, so no other case selects it, and it
    // is named in the AC alongside the two that are.
    for (const word of ['TICK', 'ULTIMATE READY', 'REFLEX']) {
      const calls = callFor(word);
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.font).toBe(THEME.arcadeFont);
      }
      expect((calls[0].args[2] as number) - (calls[1].args[2] as number)).toBeGreaterThan(0);
    }
  });

  it('leaves the numeric readouts on the mono face, because they are data and not callouts', () => {
    // `docs/DESIGN.md` reserves Departure Mono for every number a visitor reads
    // as data. `HP … MTR …` and `BANK …` are readouts; moving them to the
    // arcade face would be the story quietly widening its own scope.
    const ctx = createRecordingCanvas();
    drawFrame(ctx, frameWith(stateWith(), stateWith()), {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport: VIEWPORT,
      banks: [{ remaining: 900, start: 25_000, filledBasisPoints: 360, exhausted: false }, null],
    });

    for (const call of ctx.calls()) {
      if (call.op === 'fillText' && /^(HP|BANK) /.test(String(call.args[0]))) {
        expect(call.font).toBe(THEME.monoFont);
      }
    }
  });
});

/**
 * Story 11.3's AC1, the half that is about the *fight* rather than about the
 * bar: a big hit has to be visible as a receding second bar, not only as a
 * number changing.
 *
 * What makes this worth its own block is that the ghost is the one part of the
 * arcade HUD with no counterpart in the reference that could be copied. The
 * reference decays `state.hudGhost` by a fixed amount per rendered frame out of
 * a module-level accumulator -- one of the four mechanisms `docs/DEV-REFERENCE.md`
 * forbids, because a stepped accumulator cannot be scrubbed backwards. So the
 * assertions here are the ones that would catch a port of it sneaking in: the
 * ghost has to be a function of `progressBasisPoints` and of nothing else.
 */
describe('the damage-lag ghost (11.3 AC1)', () => {
  const CONFIG = DEFAULT_FIGHTER_CONFIG;

  function drawHit(progress: number): RecordingCanvas {
    const ctx = createRecordingCanvas();
    drawFrame(
      ctx,
      frameWith(stateWith({ health: [100, 100] }), stateWith({ health: [60, 100] }), progress),
      { config: CONFIG, viewport: VIEWPORT },
    );
    return ctx;
  }

  function ghostWidth(ctx: RecordingCanvas): number {
    const ghost = ctx
      .calls()
      .find((call) => call.op === 'fillRect' && call.fillStyle === ARENA_PALETTE.hudGhost);
    return (ghost?.args[2] as number) ?? 0;
  }

  it('draws a chip layer wider than the live bar the moment a hit lands', () => {
    const ctx = drawHit(0);
    const live = ctx
      .calls()
      .filter(
        (call) =>
          call.op === 'fillRect' &&
          // The health bar's own top row. Story 12.6 moved the band down to
          // make room for the portrait and the name above it.
          call.args[1] === 40 &&
          (call.args[0] as number) < VIEWPORT.width / 2 &&
          call.fillStyle !== ARENA_PALETTE.hudPlate &&
          call.fillStyle !== ARENA_PALETTE.hudGhost &&
          call.fillStyle !== ARENA_PALETTE.hudFrame &&
          call.fillStyle !== ARENA_PALETTE.hudBevel,
      );

    expect(ghostWidth(ctx)).toBeGreaterThan(0);
    expect(ghostWidth(ctx)).toBeGreaterThan(live[0].args[2] as number);
  });

  it('catches the live bar up across the Decision Point, then stops existing', () => {
    expect(ghostWidth(drawHit(0))).toBeGreaterThan(ghostWidth(drawHit(BASIS_POINTS_FULL / 2)));
    expect(ghostWidth(drawHit(BASIS_POINTS_FULL / 2))).toBeGreaterThan(0);
    expect(ghostWidth(drawHit(BASIS_POINTS_FULL))).toBe(0);
  });

  it('draws no ghost at all on a step where nothing was taken', () => {
    const ctx = createRecordingCanvas();
    const still = stateWith({ health: [80, 80] });
    drawFrame(ctx, frameWith(still, still, 4_000), { config: CONFIG, viewport: VIEWPORT });
    expect(ghostWidth(ctx)).toBe(0);
  });

  it('depends on the frame and nothing else, so a scrub reproduces it exactly', () => {
    // The property a ported accumulator would fail: arriving at the same
    // progress twice, out of order, has to draw the same ghost both times.
    const forwards = [0, 2_500, 5_000, 7_500].map((progress) => ghostWidth(drawHit(progress)));
    const backwards = [7_500, 5_000, 2_500, 0].map((progress) => ghostWidth(drawHit(progress)));
    expect(backwards).toStrictEqual([...forwards].reverse());
    expect(drawHit(3_300).calls()).toStrictEqual(drawHit(3_300).calls());
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

/**
 * Story 12.6: the band a viewer reads across the top of the screen.
 *
 * Two kinds of assertion here, and the split is deliberate. The first kind is
 * about *what was drawn* -- a portrait plate, a name, a timer, two pips a side
 * -- which the recording fake answers exactly. The second kind is about the
 * numbers `scripts/visual-gate.mjs` samples with, which no fake can answer: the
 * gate cannot import a `.ts` module, so it carries a copy of the layout, and a
 * copy nothing compares is a copy that goes quietly stale. The last case in
 * this block reads the gate's own literal off disk.
 */
describe('the HUD band (12.6)', () => {
  const CONFIG = DEFAULT_FIGHTER_CONFIG;
  const PAIR = ['gemini', 'grokk'] as const;

  function drawBand(options: Partial<DrawFrameOptions> = {}): RecordingCanvas {
    const ctx = createRecordingCanvas();
    drawFrame(ctx, frameWith(stateWith(), stateWith()), {
      config: CONFIG,
      viewport: VIEWPORT,
      roster: PAIR,
      ...options,
    });
    return ctx;
  }

  const textsOf = (ctx: RecordingCanvas): readonly string[] =>
    ctx.calls().filter((call) => call.op === 'fillText').map((call) => String(call.args[0]));

  it('names both fighters from the roster it was handed, not from a constant', () => {
    expect(textsOf(drawBand())).toContain('GEMINI');
    expect(textsOf(drawBand())).toContain('GROKK');
    expect(textsOf(drawBand({ roster: ['clawde', 'chatty'] }))).toContain('CLAWDE');
  });

  it('leaves the plates unnamed rather than guessing when nobody said who is fighting', () => {
    const unnamed = textsOf(drawBand({ roster: undefined }));
    for (const name of ['CLAWDE', 'CHATTY', 'GEMINI', 'GROKK']) {
      expect(unnamed).not.toContain(name);
    }
  });

  it("fills each portrait plate with that fighter's own aura", () => {
    // The plate is what says *whose side this is* on a surface whose portrait
    // never decoded -- and on the hero raster, where `drawImage` throws, it is
    // the whole plate. Two fighters glowing in one colour would be Story 11.4's
    // keying silently unwired, which is the defect 12.5 found in the cinematic.
    const fills = new Set(drawBand().calls().map((call) => call.fillStyle));
    expect(fills).toContain(auraFor('gemini'));
    expect(fills).toContain(auraFor('grokk'));
  });

  it('draws the portrait itself only when a sheet supplied one, and never throws without', () => {
    expect(drawBand().calls().some((call) => call.op === 'drawImage')).toBe(false);

    const portrait = { image: 'PORTRAIT', sx: 0, sy: 0, sw: 208, sh: 208 };
    const sheet = {
      fighters: PAIR,
      imageUrls: [],
      partFor: (): undefined => undefined,
      portraitFor: (id: string) => (id === 'gemini' ? portrait : undefined),
    };
    const drawn = drawBand({ ult: sheet as never })
      .calls()
      .filter((call) => call.op === 'drawImage');
    // One fighter's portrait resolved and the other's did not, and the plate is
    // still drawn for both: the degrade is per fighter, not per surface.
    expect(drawn).toHaveLength(1);
    expect(drawn[0].args[0]).toBe('PORTRAIT');
  });

  it('draws both pip groups empty when no round has been won (AC5)', () => {
    // A pip that appeared only once it was earned would be a HUD element that
    // moves under the viewer mid-set, and a viewer would have no way to know
    // how many rounds the set is.
    const pips = (rounds?: readonly [number, number]): readonly RecordedCall[] =>
      drawBand({ roundsWon: rounds })
        .calls()
        .filter((call) => call.op === 'fillRect' && call.args[2] === 12 && call.args[3] === 12);

    expect(pips()).toHaveLength(ROUND_PIPS_PER_SIDE * 2);
    expect(pips().every((call) => call.fillStyle === ARENA_PALETTE.hudPlate)).toBe(true);
    // And a won round fills one, which is what 12.7 will make reachable.
    expect(pips([1, 0]).filter((call) => call.fillStyle === ARENA_PALETTE.gold)).toHaveLength(1);
    expect(pips([2, 2]).filter((call) => call.fillStyle === ARENA_PALETTE.gold)).toHaveLength(4);
  });

  it('shows a timer that is a function of the tick and of nothing else (INV-1, INV-3)', () => {
    const drawnAt = (tick: number): readonly string[] => {
      const ctx = createRecordingCanvas();
      const state = stateWith({ tick });
      drawFrame(ctx, frameWith(state, state), {
        config: CONFIG,
        viewport: VIEWPORT,
        roster: PAIR,
      });
      return textsOf(ctx);
    };

    expect(drawnAt(0)).toContain('99');
    expect(drawnAt(600)).toContain('49');
    expect(drawnAt(CONFIG.maxTicks)).toContain('00');

    // A thousand reads of the same index give the same string. The point is not
    // that the function is deterministic in the abstract -- it is that nothing
    // in it has been counting since the page loaded, which is the one way a
    // timer could leak how long a Deployment thought.
    const repeated = new Set(Array.from({ length: 1_000 }, () => timerLabel(437, CONFIG.maxTicks)));
    expect([...repeated]).toStrictEqual([timerLabel(437, CONFIG.maxTicks)]);
    expect(timerReading(437, CONFIG.maxTicks)).toBe(62);
  });

  it('keeps the callout clear of the gauge at every pulse level', () => {
    // The defect, stated as the property that would have caught it. Every armed
    // frame, not just the one the pulse happens to be on when a test runs: the
    // callout's baseline sits below the gauge's last row whatever ramp the
    // breath is drawing.
    for (const index of [0, ARMED_PULSE_HOLD_FRAMES, ARMED_PULSE_HOLD_FRAMES * 2, 137]) {
      const armed = stateWith({ meter: [CONFIG.maxMeter, CONFIG.maxMeter] });
      const ctx = createRecordingCanvas();
      drawFrame(
        ctx,
        { index, decisionPoint: 0, progressBasisPoints: 0, from: armed, to: armed },
        { config: CONFIG, viewport: VIEWPORT, roster: PAIR },
      );

      const gaugeRows = ctx
        .calls()
        .filter(
          (call) =>
            call.op === 'fillRect' &&
            call.args[2] === 328 &&
            (call.args[1] as number) >= 62 &&
            (call.args[1] as number) < 78,
        );
      expect(gaugeRows.length).toBeGreaterThan(0);
      // Two fighters armed, each callout drawn twice: the shadow pass and the
      // legible one. Every baseline is below the gauge's last row.
      const callouts = ctx
        .calls()
        .filter((call) => call.op === 'fillText' && String(call.args[0]) === 'ULTIMATE READY');
      expect(callouts).toHaveLength(4);
      for (const call of callouts) {
        expect(call.args[2] as number).toBeGreaterThan(78);
      }
    }
  });

  it("pins the visual gate's copy of the band to the layout that is actually drawn", () => {
    // `scripts/visual-gate.mjs` is dependency-free ESM run straight by Node and
    // cannot import this module, so it carries a copy of the row spans and the
    // sampling boxes. A copy nothing compares is a copy that goes stale, and a
    // stale copy makes the gate sample empty rows and report a HUD element as
    // missing -- or, worse, report a moved one as present.
    const gate = readFileSync(new URL('../../../../scripts/visual-gate.mjs', import.meta.url), 'utf8');
    const literal = /const HUD_BAND = JSON\.parse\(`([\s\S]*?)`\)/.exec(gate);
    expect(literal).not.toBeNull();
    const band = JSON.parse(String(literal?.[1])) as {
      rows: readonly Record<string, unknown>[];
      regions: readonly Record<string, unknown>[];
    };

    expect(band.rows).toStrictEqual(HUD_ROW_SPANS.map((span) => ({ ...span })));
    expect(band.regions).toStrictEqual(
      hudRegions({ width: 960, height: 400 }).map((region) => ({ ...region })),
    );

    // And the criterion the gate computes off that copy holds: no two row spans
    // in this band intersect. Asserted here as well as there, because the gate
    // needs a browser and this does not.
    for (const [index, row] of HUD_ROW_SPANS.entries()) {
      for (const other of HUD_ROW_SPANS.slice(index + 1)) {
        expect(row.top < other.bottom && other.top < row.bottom).toBe(false);
      }
    }
  });
});
