import { describe, expect, it } from 'vitest';
import { BASIS_POINTS_FULL, FRAMES_PER_DECISION } from '../replay/film';
import { ARENA_PALETTE } from './arena-palette';
import type { Canvas2D } from './canvas2d';
import {
  ARCADE_HUD_COLOURS,
  ARCADE_TEXT_SHADOW,
  ARMED_PULSE_BANDS,
  ARMED_PULSE_HOLD_FRAMES,
  ARMED_PULSE_LEVELS,
  BAND_COUNT,
  BANK_BANDS,
  BEVEL_ROWS,
  FRAME_THICKNESS,
  HP_HIGH_BANDS,
  HP_LOW_BANDS,
  HP_MID_BANDS,
  SUPER_METER_BANDS,
  type ArcadeBar,
  type ArcadeSegments,
  arcadeText,
  bandOf,
  drawArcadeBar,
  drawArcadePip,
  drawArcadePlate,
  drawArcadeSegments,
  drawPortraitPlate,
  gradientBands,
  healthBands,
  pulseLevel,
  skewOffset,
  timerLabel,
  timerReading,
} from './hud';
import { ROSTER_IDS, auraFor } from './roster';
import { THEME } from './theme';

/**
 * Story 11.3, the drawing half.
 *
 * The same recording fake `renderer.test.ts` uses, and for the same reason: the
 * properties worth pinning about a HUD are *what was drawn where and in what
 * colour*, which a call log answers exactly and a pixel buffer answers only by
 * inference.
 *
 * The one thing this file must be careful about is not re-asserting the picture
 * in a form that only restates the implementation. A test that recomputed
 * `skewOffset` and checked the renderer used it would go green for a bar drawn
 * upside down. So the assertions below are about *observable consequences* --
 * the top row leans further than the bottom one, a mirrored bar drains from the
 * far edge, a ghost appears only when there is damage to show -- each of which
 * is a statement a viewer could check by looking.
 */

interface RecordedCall {
  readonly op: string;
  readonly args: readonly (number | string)[];
  readonly fillStyle: string;
  readonly font: string;
  readonly textAlign: string;
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
      font: surface.font,
      textAlign: surface.textAlign,
    });
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  surface.save = () => record('save', []);
  surface.restore = () => record('restore', []);
  // Story 12.6: the portrait plate is the first thing in this module that draws
  // an image, and the destination rectangle is what the inset case reads.
  surface.drawImage = (image, sx, sy, sw, sh, dx, dy, dw, dh) =>
    record('drawImage', [String(image), sx, sy, sw, sh, dx, dy, dw, dh]);

  return surface;
}

/**
 * A bar with every knob at a neutral value, so each case varies exactly one.
 *
 * Typed as `ArcadeBar` rather than `as const`: the const assertion narrows
 * every field to its own literal type, which makes `Partial<typeof BAR>` a
 * shape that accepts only the values already written here.
 */
const BAR: ArcadeBar = {
  x: 32,
  y: 24,
  width: 320,
  height: 20,
  mirror: false,
  fillBasisPoints: BASIS_POINTS_FULL,
  ghostBasisPoints: 0,
  bands: HP_HIGH_BANDS,
};

function drawBar(overrides: Partial<ArcadeBar> = {}): RecordingCanvas {
  const ctx = createRecordingCanvas();
  drawArcadeBar(ctx, { ...BAR, ...overrides });
  return ctx;
}

function fillsOf(ctx: RecordingCanvas, colour: string): readonly RecordedCall[] {
  return ctx.calls().filter((call) => call.op === 'fillRect' && call.fillStyle === colour);
}

describe('the band ramp (AC1, AC2)', () => {
  it('reaches both declared stops exactly, so the recorded contrast ratios describe a colour that is drawn', () => {
    // arena-palette.ts records `hpLow.to` at 3.35:1 against the plate and calls
    // it the tightest pair in the palette. That claim is only true if the ramp
    // actually paints `hpLow.to` somewhere. A lerp that stopped at 2/3 of the
    // way would leave every documented ratio describing a colour nothing draws.
    const bands = gradientBands(ARENA_PALETTE.hpLow);
    expect(bands[0]).toBe(ARENA_PALETTE.hpLow.from);
    expect(bands[BAND_COUNT - 1]).toBe(ARENA_PALETTE.hpLow.to);
  });

  it('is four stops, which is what a 20px bar resolves a two-stop gradient to', () => {
    expect(gradientBands(ARENA_PALETTE.superMeter)).toHaveLength(BAND_COUNT);
  });

  it('walks in one direction rather than wandering, on every channel that moves', () => {
    // The point of a ramp is that it ramps. A lerp with a sign error still hits
    // both endpoints and still has four entries; what it does not do is stay
    // monotone in between.
    const bands = gradientBands(ARENA_PALETTE.hpHigh);
    const green = bands.map((colour) => Number.parseInt(colour.slice(3, 5), 16));
    for (const index of [1, 2, 3]) {
      expect(green[index]).toBeLessThanOrEqual(green[index - 1]);
    }
    expect(green[3]).toBeLessThan(green[0]);
  });

  it('emits well-formed six-digit hex at every stop, whatever the arithmetic does', () => {
    for (const gradient of [
      ARENA_PALETTE.hpHigh,
      ARENA_PALETTE.hpMid,
      ARENA_PALETTE.hpLow,
      ARENA_PALETTE.superMeter,
      ARENA_PALETTE.superMeterFull,
      ARENA_PALETTE.bank,
    ]) {
      for (const stop of gradientBands(gradient)) {
        expect(stop).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('collapses a single-colour ramp to that colour, which is how the warn fill stays flat', () => {
    // `drawTokenBank` expresses its exhausted state as `{ from: warn, to: warn }`
    // rather than as a special case inside the bar. That only works if the ramp
    // is the identity on a degenerate gradient -- and the four stops have to be
    // the *same string* the theme declares, because `hero/raster.ts` resolves
    // `fillStyle` through a Map and a re-cased duplicate is a throw.
    expect(gradientBands({ from: THEME.warn, to: THEME.warn })).toStrictEqual([
      THEME.warn,
      THEME.warn,
      THEME.warn,
      THEME.warn,
    ]);
  });
});

describe('the health tiers (AC1)', () => {
  it('is green above a half, gold above a quarter, red at or below it', () => {
    expect(healthBands(BASIS_POINTS_FULL)).toBe(HP_HIGH_BANDS);
    expect(healthBands(4_000)).toBe(HP_MID_BANDS);
    expect(healthBands(1_000)).toBe(HP_LOW_BANDS);
  });

  it('puts each boundary in the lower tier, exactly as the reference does', () => {
    // `screens.js:2454` tests strictly greater than, so a bar at exactly 50%
    // is gold and one at exactly 25% is red. Off-by-one here would be invisible
    // on screen and would still be wrong.
    expect(healthBands(BASIS_POINTS_FULL / 2)).toBe(HP_MID_BANDS);
    expect(healthBands(BASIS_POINTS_FULL / 2 + 1)).toBe(HP_HIGH_BANDS);
    expect(healthBands(BASIS_POINTS_FULL / 4)).toBe(HP_LOW_BANDS);
    expect(healthBands(BASIS_POINTS_FULL / 4 + 1)).toBe(HP_MID_BANDS);
  });

  it('gives the three tiers three different ramps, so a tier change is visible', () => {
    expect(new Set([HP_HIGH_BANDS[3], HP_MID_BANDS[3], HP_LOW_BANDS[3]]).size).toBe(3);
  });
});

describe('the armed pulse (AC4, AC5, INV-1, INV-3)', () => {
  it('breathes across two Decision Points, which is the cadence claimed for it', () => {
    // Written with the number in it, deliberately, and this is the second
    // attempt at this test. The first expressed every case in terms of
    // `ARMED_PULSE_HOLD_FRAMES` itself -- "holds for HOLD - 1 and changes at
    // HOLD" -- which is true of *every* value the constant could take. A
    // mutation to 1 passed the whole suite. A test phrased in the units of the
    // thing it is pinning pins nothing.
    //
    // So the cadence is asserted twice over: as the literal it is, and against
    // the film's own sampling rate, which is where the six came from. The
    // source deliberately does not import `FRAMES_PER_DECISION` -- a later
    // change to the film's sampling must not silently retune the HUD -- but
    // asserting that the two currently agree costs nothing and makes the
    // retune a visible, deliberate edit here.
    expect(ARMED_PULSE_HOLD_FRAMES).toBe(6);
    expect(ARMED_PULSE_HOLD_FRAMES * 4).toBe(FRAMES_PER_DECISION * 2);
  });

  it('holds each step for six frames and then steps -- stepped, never eased', () => {
    expect(pulseLevel(0, false)).toBe(pulseLevel(5, false));
    expect(pulseLevel(0, false)).not.toBe(pulseLevel(6, false));
    expect(pulseLevel(6, false)).toBe(pulseLevel(11, false));
    expect(pulseLevel(6, false)).not.toBe(pulseLevel(12, false));
  });

  it('runs a 24-frame cycle, not a shorter one that merely repeats', () => {
    // The other half of what the mutation got past: a hold of 1 gives a
    // four-frame cycle that satisfies every *relative* assertion about the
    // triangle's shape. The period is the observable thing a viewer sees.
    const walk = Array.from({ length: 24 }, (_unused, index) => pulseLevel(index, false));
    expect(walk).toStrictEqual([
      0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1,
    ]);
  });

  it('walks up and back down rather than snapping, so the gauge breathes', () => {
    const walk = [0, 1, 2, 3].map((step) => pulseLevel(step * ARMED_PULSE_HOLD_FRAMES, false));
    expect(walk).toStrictEqual([0, 1, 2, 1]);
  });

  it('repeats on its own period, so a scrub to any frame draws what playback drew', () => {
    const period = ARMED_PULSE_HOLD_FRAMES * 4;
    for (const index of [0, 3, 7, 13, 19, 23]) {
      expect(pulseLevel(index + period, false)).toBe(pulseLevel(index, false));
      expect(pulseLevel(index + period * 11, false)).toBe(pulseLevel(index, false));
    }
  });

  it('reaches every declared level, so no ramp is precomputed and never shown', () => {
    const seen = new Set(
      Array.from({ length: ARMED_PULSE_HOLD_FRAMES * 4 }, (_unused, index) =>
        pulseLevel(index, false),
      ),
    );
    expect(seen.size).toBe(ARMED_PULSE_LEVELS);
  });

  it('is pinned to one level under reduced motion, at every frame index (AC5)', () => {
    for (const index of [0, 5, 6, 12, 18, 23, 24, 137, 5_000]) {
      expect(pulseLevel(index, true)).toBe(0);
    }
  });

  it('keeps the gauge gold when it stops breathing, rather than switching it off', () => {
    // AC5 is "the pulse is switched off and the HUD is otherwise unchanged --
    // same layout, same colours, same information". A reduced-motion gauge that
    // fell back to the charging ramp would be a different *reading*, not a
    // stiller one, so level 0 has to be an armed ramp.
    expect(ARMED_PULSE_BANDS[0]).not.toStrictEqual(SUPER_METER_BANDS);
    expect(ARMED_PULSE_BANDS[0]).toStrictEqual(gradientBands(ARENA_PALETTE.superMeterFull));
  });

  it('clamps a negative index instead of indexing off the end of the triangle', () => {
    // Not reachable from the film, and cheap to make impossible anyway:
    // `Math.floor(-1 / 6) % 4` is -1, and `bands[-1]` is `undefined` reaching a
    // `fillStyle`, which the hero raster turns into a throw.
    expect(pulseLevel(-1, false)).toBe(0);
    expect(pulseLevel(-97, false)).toBe(0);
  });
});

describe('the skew (AC1)', () => {
  it('leans the top of a bar and leaves its bottom where it is', () => {
    expect(skewOffset(0, 20)).toBeGreaterThan(skewOffset(19, 20));
    expect(skewOffset(20, 20)).toBe(0);
  });

  it('leans a taller bar further, which is what makes it a parallelogram and not a shear', () => {
    expect(skewOffset(0, 40)).toBeGreaterThan(skewOffset(0, 20));
  });

  it('bands a bar top to bottom with every band reachable', () => {
    const bands = Array.from({ length: 20 }, (_unused, row) => bandOf(row, 20));
    expect(new Set(bands).size).toBe(BAND_COUNT);
    expect(bands[0]).toBe(0);
    expect(bands[19]).toBe(BAND_COUNT - 1);
  });

  it('keeps a one-row bar inside the band table rather than off its end', () => {
    expect(bandOf(0, 1)).toBeLessThan(BAND_COUNT);
    expect(bandOf(5, 0)).toBeLessThan(BAND_COUNT);
  });
});

describe('drawing one arcade bar (AC1)', () => {
  it('lays a plate under the whole bar, whatever the fill is', () => {
    expect(fillsOf(drawBar({ fillBasisPoints: 0 }), ARENA_PALETTE.hudPlate)).toHaveLength(
      BAR.height,
    );
  });

  it('draws plate, then fill, then bevel, then frame -- so nothing overpaints the outline', () => {
    const order = drawBar()
      .calls()
      .map((call) => call.fillStyle);
    const firstOf = (colour: string): number => order.indexOf(colour);

    expect(firstOf(ARENA_PALETTE.hudPlate)).toBeLessThan(firstOf(HP_HIGH_BANDS[0]));
    expect(firstOf(HP_HIGH_BANDS[0])).toBeLessThan(firstOf(ARENA_PALETTE.hudBevel));
    expect(firstOf(ARENA_PALETTE.hudBevel)).toBeLessThan(firstOf(ARENA_PALETTE.hudFrame));
    expect(order.lastIndexOf(ARENA_PALETTE.hudFrame)).toBe(order.length - 1);
  });

  it('bevels only the lit top edge, not a second bar', () => {
    const bevels = fillsOf(drawBar(), ARENA_PALETTE.hudBevel);
    expect(bevels).toHaveLength(1);
    expect(bevels[0].args[3]).toBe(BEVEL_ROWS);
  });

  it('puts the bevel inside the frame, where it survives being drawn', () => {
    // The frame is drawn last and is `FRAME_THICKNESS` deep, so a bevel on the
    // bar's own top row is overpainted completely -- and *the call sequence is
    // still perfectly valid*, which is why this needs an assertion about
    // geometry rather than about calls. It was caught by `hero.test.ts`, where
    // pixels are actually composited, and this is the unit-level guard so the
    // next equivalent slip does not need the hero to find it.
    const bar = drawBar();
    const bevel = fillsOf(bar, ARENA_PALETTE.hudBevel)[0];
    const topRule = fillsOf(bar, ARENA_PALETTE.hudFrame).find(
      (call) => call.args[2] === BAR.width && call.args[1] === BAR.y,
    );

    expect(topRule).toBeDefined();
    expect(bevel.args[1] as number).toBeGreaterThanOrEqual(
      (topRule?.args[1] as number) + (topRule?.args[3] as number),
    );
    expect((bevel.args[1] as number) + BEVEL_ROWS).toBeLessThanOrEqual(BAR.y + BAR.height);
  });

  it('keeps the bevel inside a bar too short to hold both it and the frame', () => {
    for (const height of [1, 2, 3, 4]) {
      const bevel = fillsOf(drawBar({ height }), ARENA_PALETTE.hudBevel)[0];
      expect(bevel.args[1] as number).toBeGreaterThanOrEqual(BAR.y);
      expect((bevel.args[1] as number) + BEVEL_ROWS).toBeLessThanOrEqual(BAR.y + height);
    }
  });

  it('paints every band of the ramp across the bar, rather than one flat colour', () => {
    const ctx = drawBar();
    for (const band of HP_HIGH_BANDS) {
      expect(fillsOf(ctx, band).length).toBeGreaterThan(0);
    }
  });

  it('shows a ghost only when there is damage behind the live bar (AC1)', () => {
    const hit = drawBar({ fillBasisPoints: 4_000, ghostBasisPoints: 7_000 });
    const settled = drawBar({ fillBasisPoints: 4_000, ghostBasisPoints: 4_000 });

    expect(fillsOf(hit, ARENA_PALETTE.hudGhost).length).toBeGreaterThan(0);
    // A ghost level equal to the live bar is invisible by definition. Drawing
    // it anyway would put "a hit landed" in the call sequence on every frame
    // where none did, which is the assertion 11.6 will lean on for Spectate.
    expect(fillsOf(settled, ARENA_PALETTE.hudGhost)).toHaveLength(0);
  });

  it('puts the ghost behind the live bar and wider than it, so the chip recedes', () => {
    const ctx = drawBar({ fillBasisPoints: 4_000, ghostBasisPoints: 7_000 });
    const ghost = fillsOf(ctx, ARENA_PALETTE.hudGhost)[0];
    const live = fillsOf(ctx, HP_HIGH_BANDS[0])[0];

    expect(ghost.args[2] as number).toBeGreaterThan(live.args[2] as number);
    expect(ctx.calls().indexOf(ghost)).toBeLessThan(ctx.calls().indexOf(live));
  });

  it('never lets a ghost below the live bar eat into it', () => {
    // `ghost = max(fill, ghost)`, so a stale reading cannot draw a *shorter*
    // second bar over the live one and make a fighter look healthier than they
    // are. Nothing produces this today; it is one rounding away from doing so.
    const ctx = drawBar({ fillBasisPoints: 7_000, ghostBasisPoints: 1_000 });
    expect(fillsOf(ctx, ARENA_PALETTE.hudGhost)).toHaveLength(0);
  });

  it('drains a mirrored bar from the far edge, so the pair faces each other', () => {
    const left = drawBar({ fillBasisPoints: 3_000 });
    const right = drawBar({ fillBasisPoints: 3_000, mirror: true });

    const fillX = (ctx: RecordingCanvas): number => fillsOf(ctx, HP_HIGH_BANDS[0])[0].args[0] as number;
    // Unmirrored, a short fill starts at the bar's own left edge; mirrored, it
    // starts near the right one. Both are 30% wide -- only the anchor moves.
    expect(fillX(right)).toBeGreaterThan(fillX(left));
    expect(fillsOf(right, HP_HIGH_BANDS[0])[0].args[2]).toBe(
      fillsOf(left, HP_HIGH_BANDS[0])[0].args[2],
    );
  });

  it('leans a mirrored bar the other way, rather than drawing the same parallelogram twice', () => {
    const leftTop = fillsOf(drawBar(), ARENA_PALETTE.hudPlate)[0].args[0] as number;
    const rightTop = fillsOf(drawBar({ mirror: true }), ARENA_PALETTE.hudPlate)[0].args[0] as number;
    expect(rightTop).toBeLessThan(leftTop);
  });

  it('frames both ends and both edges, at the declared thickness', () => {
    const frames = fillsOf(drawBar(), ARENA_PALETTE.hudFrame);
    expect(frames.length).toBeGreaterThan(BAR.height);
    for (const call of frames) {
      expect(Math.min(call.args[2] as number, call.args[3] as number)).toBeLessThanOrEqual(
        FRAME_THICKNESS,
      );
    }
  });

  it('draws nothing at all for a bar with no height or no width', () => {
    expect(drawBar({ height: 0 }).calls()).toHaveLength(0);
    expect(drawBar({ width: 0 }).calls()).toHaveLength(0);
  });

  it('clamps a degenerate level instead of painting NaN or overrunning the bar', () => {
    for (const level of [Number.NaN, Number.POSITIVE_INFINITY, -5_000, BASIS_POINTS_FULL * 3]) {
      const ctx = drawBar({ fillBasisPoints: level, ghostBasisPoints: level });
      expect(ctx.calls().length).toBeGreaterThan(0);
      for (const call of ctx.calls()) {
        for (const arg of call.args) {
          expect(Number.isFinite(arg as number)).toBe(true);
        }
        expect(call.args[2] as number).toBeLessThanOrEqual(BAR.width);
      }
    }
  });

  it('lands every edge on a whole pixel, because a half-pixel fill is a blur', () => {
    // The one rule `docs/DESIGN.md` keeps on both sides of Story 11.1's fence.
    for (const call of drawBar({ fillBasisPoints: 3_333 }).calls()) {
      for (const arg of call.args) {
        expect(Number.isInteger(arg as number)).toBe(true);
      }
    }
  });

  it('is a pure function of its argument: the same bar drawn twice is call-identical', () => {
    expect(drawBar({ fillBasisPoints: 6_100, ghostBasisPoints: 8_700 }).calls()).toStrictEqual(
      drawBar({ fillBasisPoints: 6_100, ghostBasisPoints: 8_700 }).calls(),
    );
  });
});

describe('the segmented meter (AC2)', () => {
  const METER: ArcadeSegments = {
    x: 32,
    y: 60,
    width: 320,
    height: 18,
    mirror: false,
    count: 4,
    gap: 8,
    fillBasisPoints: BASIS_POINTS_FULL,
    bands: SUPER_METER_BANDS,
  };

  function drawMeter(overrides: Partial<ArcadeSegments> = {}): RecordingCanvas {
    const ctx = createRecordingCanvas();
    drawArcadeSegments(ctx, { ...METER, ...overrides });
    return ctx;
  }

  /** One plate row per segment per row: the plate is drawn for every segment, always. */
  function segmentCount(ctx: RecordingCanvas): number {
    return fillsOf(ctx, ARENA_PALETTE.hudPlate).length / METER.height;
  }

  it('draws the declared number of chunks, so the gauge is countable', () => {
    expect(segmentCount(drawMeter())).toBe(4);
    expect(segmentCount(drawMeter({ count: 6 }))).toBe(6);
  });

  it('fills chunk by chunk rather than as one edge sliding along a rail', () => {
    // The property that makes a segmented meter worth having: at a quarter, one
    // whole chunk is lit and the rest are dark, which a viewer reads at a glance
    // at five Decision Points a second.
    const quarter = drawMeter({ fillBasisPoints: BASIS_POINTS_FULL / 4 });
    const lit = fillsOf(quarter, SUPER_METER_BANDS[0]);
    const bevels = fillsOf(quarter, ARENA_PALETTE.hudBevel);
    expect(bevels).toHaveLength(1);
    expect(lit.length).toBeGreaterThan(0);
  });

  it('lights more chunks as it charges, and all of them at full', () => {
    const litSegments = (fill: number): number =>
      fillsOf(drawMeter({ fillBasisPoints: fill }), ARENA_PALETTE.hudBevel).length;

    expect(litSegments(0)).toBe(0);
    expect(litSegments(BASIS_POINTS_FULL / 4)).toBe(1);
    expect(litSegments(BASIS_POINTS_FULL / 2)).toBe(2);
    expect(litSegments(BASIS_POINTS_FULL)).toBe(4);
  });

  it('starts a mirrored meter at the outer edge, so the two gauges mirror', () => {
    const leftFirst = fillsOf(drawMeter({ fillBasisPoints: 2_500 }), ARENA_PALETTE.hudBevel)[0];
    const rightFirst = fillsOf(
      drawMeter({ fillBasisPoints: 2_500, mirror: true }),
      ARENA_PALETTE.hudBevel,
    )[0];
    expect(rightFirst.args[0] as number).toBeGreaterThan(leftFirst.args[0] as number);
  });

  it('keeps every segment on a whole pixel, gaps included', () => {
    for (const call of drawMeter().calls()) {
      for (const arg of call.args) {
        expect(Number.isInteger(arg as number)).toBe(true);
      }
    }
  });

  it('draws nothing rather than inverting when the gaps exceed the width', () => {
    expect(drawMeter({ count: 40, gap: 20 }).calls()).toHaveLength(0);
  });

  it('survives a degenerate count instead of dividing by zero', () => {
    expect(drawMeter({ count: 0 }).calls().length).toBeGreaterThan(0);
    for (const call of drawMeter({ count: 0 }).calls()) {
      for (const arg of call.args) {
        expect(Number.isFinite(arg as number)).toBe(true);
      }
    }
  });
});

describe('the arcade callout (AC3)', () => {
  function drawText(colour = THEME.accent): RecordingCanvas {
    const ctx = createRecordingCanvas();
    arcadeText(ctx, THEME, 'ULTIMATE READY', 100, 50, 'left', colour);
    return ctx;
  }

  it('is the display face at HUD size, not the mono readout face', () => {
    const call = drawText().calls()[0];
    expect(call.font).toBe(THEME.arcadeFont);
    expect(call.font).not.toBe(THEME.monoFont);
  });

  it('names no family the two declared faces do not already name', () => {
    // The whole reason `docs/DESIGN.md`'s fourth audited rule survives this
    // story: one size step down the display face, not a third family.
    const families = (font: string): string => font.slice(font.indexOf("'"));
    expect(families(THEME.arcadeFont)).toBe(families(THEME.displayFont));
  });

  it('draws a hard offset shadow -- two passes, no blur, exactly the declared offset', () => {
    const [shadow, top] = drawText().calls();
    expect(drawText().calls()).toHaveLength(2);
    expect((shadow.args[1] as number) - (top.args[1] as number)).toBe(ARCADE_TEXT_SHADOW);
    expect((shadow.args[2] as number) - (top.args[2] as number)).toBe(ARCADE_TEXT_SHADOW);
  });

  it('puts the shadow underneath and the requested colour on top', () => {
    const [shadow, top] = drawText(THEME.bg).calls();
    expect(shadow.fillStyle).toBe(ARENA_PALETTE.hudPlate);
    expect(top.fillStyle).toBe(THEME.bg);
  });

  it('says the same words twice, so the shadow is a shadow and not a second callout', () => {
    const [shadow, top] = drawText().calls();
    expect(shadow.args[0]).toBe(top.args[0]);
  });

  it('honours the alignment it was given', () => {
    const ctx = createRecordingCanvas();
    arcadeText(ctx, THEME, 'TICK 0', 480, 44, 'center', THEME.muted);
    expect(ctx.calls()[0].textAlign).toBe('center');
  });
});

describe('the colour set the hero has to hold (AC6)', () => {
  it('holds no value twice, so the GIF colour table is not padded with duplicates', () => {
    expect(new Set(ARCADE_HUD_COLOURS).size).toBe(ARCADE_HUD_COLOURS.length);
  });

  it('is every colour this module can actually set, swept over every state it draws', () => {
    // The drift guard, and the reason it is worth its length: `hero/raster.ts`
    // resolves `fillStyle` through a Map and **throws** on a miss, so a band
    // table added and forgotten here is a hero build failure. Sweeping the
    // drawing functions rather than trusting the export is what makes that
    // failure land in the change that caused it.
    const ctx = createRecordingCanvas();
    const bands = [
      HP_HIGH_BANDS,
      HP_MID_BANDS,
      HP_LOW_BANDS,
      SUPER_METER_BANDS,
      BANK_BANDS,
      ...ARMED_PULSE_BANDS,
    ];

    for (const band of bands) {
      for (const level of [0, 2_500, 5_000, 9_999, BASIS_POINTS_FULL]) {
        for (const mirror of [false, true]) {
          drawArcadeBar(ctx, {
            ...BAR,
            mirror,
            fillBasisPoints: level,
            ghostBasisPoints: BASIS_POINTS_FULL,
            bands: band,
          });
          drawArcadeSegments(ctx, {
            x: 32,
            y: 60,
            width: 320,
            height: 18,
            mirror,
            count: 4,
            gap: 8,
            fillBasisPoints: level,
            bands: band,
          });
        }
      }
    }

    // Story 12.6's two new elements, swept the same way. A pip is the only
    // thing in this module that paints flat `gold`, and a portrait plate is the
    // only thing that paints an aura -- and the aura is drawn on *every* frame
    // of the hero, where `drawImage` throws and the plate is all there is, so a
    // fighter missing from this loop is a README build that dies on whoever
    // happens to be on that side.
    for (const won of [false, true]) {
      drawArcadePip(ctx, 400, 26, 12, won);
    }
    for (const id of ROSTER_IDS) {
      drawPortraitPlate(ctx, { x: 24, y: 12, width: 44, height: 44, fill: auraFor(id) });
    }

    const emitted = new Set(ctx.calls().map((call) => call.fillStyle));
    for (const colour of emitted) {
      expect(ARCADE_HUD_COLOURS).toContain(colour);
    }
    // And the other direction: nothing declared is unreachable, which would
    // mean the hero's colour table carried a slot for a colour never painted.
    expect(emitted.size).toBe(ARCADE_HUD_COLOURS.length);
  });

  it('carries the plate the callout shadows with, which no bar band would supply', () => {
    expect(ARCADE_HUD_COLOURS).toContain(ARENA_PALETTE.hudPlate);
  });

  it('is frozen, so a consumer cannot quietly extend the hero palette at runtime', () => {
    expect(Object.isFrozen(ARCADE_HUD_COLOURS)).toBe(true);
  });
});

/**
 * Story 12.6's two new primitives and its timer.
 *
 * The plate is the HUD's one non-bar surface and the timer is the one number on
 * the canvas that a careless reading could turn into a clock, so both get cases
 * about the failure rather than about the happy path.
 */
describe('the plate, the pip and the timer (12.6)', () => {
  it('draws a plate that stays inside the box it was given', () => {
    // Four `fillRect` edges rather than a `strokeRect`, because a stroke is
    // centred on its path and would put the outline a pixel outside the
    // declared rectangle. The band packs the portrait, the bars and the pips
    // against measured gaps, so an edge that overhangs its own box is how a
    // HUD element starts overlapping the one beside it.
    const ctx = createRecordingCanvas();
    drawArcadePlate(ctx, { x: 24, y: 12, width: 44, height: 44, fill: ARENA_PALETTE.hudPlate });

    expect(ctx.calls().every((call) => call.op === 'fillRect')).toBe(true);
    for (const call of ctx.calls()) {
      const [x, y, width, height] = call.args as readonly number[];
      expect(x).toBeGreaterThanOrEqual(24);
      expect(y).toBeGreaterThanOrEqual(12);
      expect(x + width).toBeLessThanOrEqual(24 + 44);
      expect(y + height).toBeLessThanOrEqual(12 + 44);
    }
  });

  it('draws nothing at all for a degenerate plate rather than a negative rectangle', () => {
    const ctx = createRecordingCanvas();
    drawArcadePlate(ctx, { x: 0, y: 0, width: 0, height: 44, fill: ARENA_PALETTE.hudPlate });
    drawArcadePlate(ctx, { x: 0, y: 0, width: 44, height: -3, fill: ARENA_PALETTE.hudPlate });
    expect(ctx.calls()).toStrictEqual([]);
  });

  it('insets the portrait inside its frame, so the face never paints over the outline', () => {
    const ctx = createRecordingCanvas();
    drawPortraitPlate(
      ctx,
      { x: 24, y: 12, width: 44, height: 44, fill: ARENA_PALETTE.hudPlate },
      { image: 'FACE', sx: 0, sy: 0, sw: 208, sh: 208 },
    );

    const drawn = ctx.calls().find((call) => call.op === 'drawImage');
    expect(drawn).toBeDefined();
    // dx, dy, dw, dh -- the box less one frame thickness on every side.
    expect((drawn?.args ?? []).slice(5)).toStrictEqual([
      24 + FRAME_THICKNESS,
      12 + FRAME_THICKNESS,
      44 - FRAME_THICKNESS * 2,
      44 - FRAME_THICKNESS * 2,
    ]);
  });

  it('counts down two digits over the whole Match and clamps at both ends', () => {
    expect(timerLabel(0, 1_200)).toBe('99');
    expect(timerLabel(1_200, 1_200)).toBe('00');
    // Past the end, and before the beginning. Neither can arise from the film,
    // and both would print something a viewer cannot read if they did.
    expect(timerLabel(5_000, 1_200)).toBe('00');
    expect(timerLabel(-40, 1_200)).toBe('99');
    // A hand-built config, which `assertIntegerConfig` rejects upstream: the
    // honest failure for a readout is to clamp, not to divide by zero and put
    // `Infinity` through `String()`.
    expect(timerLabel(10, 0)).toBe('00');
    expect(timerReading(10, Number.NaN)).toBe(0);
  });

  it('never rises as the Match runs, which is the one thing a countdown must not do', () => {
    // Monotone over every tick of the shipped length, asserted rather than
    // reasoned about: integer division is exactly where an off-by-one turns
    // into a timer that ticks back up for one frame.
    const readings = Array.from({ length: 1_201 }, (_unused, tick) => timerReading(tick, 1_200));
    for (const [tick, reading] of readings.entries()) {
      if (tick > 0) {
        expect(reading).toBeLessThanOrEqual(readings[tick - 1]);
      }
    }
    expect(readings[0]).toBe(99);
    expect(readings[1_200]).toBe(0);
  });
});
