import { BASIS_POINTS_FULL } from '../replay/film';
import { ARENA_PALETTE, type ArenaGradient } from './arena-palette';
import type { Canvas2D } from './canvas2d';
import type { Theme } from './theme';

/**
 * Story 11.3: the arcade HUD, drawn as rows.
 *
 * The owner ruled on 2026-08-07 that the canvas HUD counts as **game**, so the
 * flat instrument panel Story 4.1 drew -- square `fillRect` bars, a flat fill,
 * a 4px ink border -- is replaced by the reference's skewed, gradient-filled,
 * bevelled bars with a damage-lag ghost and a pulsing gold super meter. This
 * module owns the drawing; `renderer.ts` owns the layout and keeps every one of
 * its layout constants where Story 10.4 left them.
 *
 * ## Why rows of `fillRect` and not `Path2D` + `createLinearGradient`
 *
 * Not a simplification -- a constraint, and it is the load-bearing fact about
 * this file. `hero/raster.ts` is a **second real implementation of `Canvas2D`**
 * over a buffer of palette indices, and it resolves every `fillStyle` through a
 * `Map` that **throws** on a miss. A `CanvasGradient` is an object with no
 * palette entry; `clip` and `fill(path)` have no meaning over a byte array.
 * Widening the port would mean either writing a rasteriser into the hero or
 * forking the HUD in two, and the hero exists precisely so that a change to how
 * the player looks changes the README image too.
 *
 * Rows give the same picture through calls both surfaces already have. The
 * reference's parallelogram (`<REF>/game_source/js/screens.js:2283`,
 * `hudParaPath`) is a linear skew per scanline, and its `hudVGrad`
 * (`screens.js:2302`) is a vertical ramp -- which a four-band strip reproduces
 * at a 20px bar height, because four bands over twenty rows is five rows a
 * band and the eye reads that as a gradient at HUD size. It also keeps the
 * drift guard cheap: the set of colours this file can emit stays finite,
 * enumerable and exported as `ARCADE_HUD_COLOURS`.
 *
 * ## Nothing here is a clock, and nothing here remembers
 *
 * Every value drawn is a function of its arguments, and every argument comes
 * from the `RenderFrame` or the config. The reference's damage-lag ghost decays
 * through `state.hudGhost`, a mutable module-level accumulator -- one of the
 * four mechanisms `docs/DEV-REFERENCE.md` says may never come across, because a
 * stepped accumulator cannot be scrubbed backwards. The replacement is an ease
 * across `progressBasisPoints`, which is pure and gives the same picture. The
 * reference's full-meter pulse is `globalAlpha = 0.6 + 0.4·|sin(t/8)|`, which
 * the hero raster declares and does not honour and which generates unbounded
 * colours a palette cannot hold; the replacement is a `0,1,2,1` triangle over
 * `frame.index` selecting one of three precomputed gold ramps.
 *
 * No colour literal appears below. `style-discipline.test.ts` allows a hex in
 * three declared sources and this is not one of them, so every value is either
 * an `ARENA_PALETTE` entry or is *computed* from two of them by integer channel
 * lerp.
 */

/**
 * The reference's `HUD_SKEW`, as basis points (`screens.js:2420` --
 * `HUD_SKEW = 0.3249`).
 *
 * Integer, because a float constant in a presentation module is the shape of a
 * value that later drifts by a rounding: the lean is `(height - row) * 3249 /
 * 10000` and both ends of that are exact.
 */
export const HUD_SKEW_BASIS_POINTS = 3_249;

/** Bands per bar. Four, which is what `hudVGrad`'s two stops resolve to at 20px. */
export const BAND_COUNT = 4;

/** The lit top edge, in rows. One: a bevel is a highlight, not a second bar. */
export const BEVEL_ROWS = 1;

/** The skewed outline's thickness, in pixels. */
export const FRAME_THICKNESS = 2;

/** How far the arcade callout's hard shadow is offset, in pixels, on both axes. */
export const ARCADE_TEXT_SHADOW = 2;

/**
 * Frames the armed gauge holds each step of its pulse.
 *
 * Counted, never timed (INV-1, INV-3). Six frames a step over a four-step
 * triangle is a 24-frame breathe -- two Decision Points at the film's twelve
 * frames each, which is slow enough to read as breathing rather than as a
 * flicker and fast enough that a viewer sees a whole cycle before the next
 * exchange. Because the phase is `frame.index`'s alone, a scrub to frame 90
 * draws the same step as a play-through that reaches frame 90.
 */
export const ARMED_PULSE_HOLD_FRAMES = 6;

/**
 * The pulse, enumerated. Up, over, down, and hold at the bottom -- a triangle
 * rather than a sawtooth, so the gauge breathes instead of snapping back.
 */
const ARMED_PULSE_TRIANGLE: readonly number[] = Object.freeze([0, 1, 2, 1]);

/** How many gold ramps the pulse cycles through. */
export const ARMED_PULSE_LEVELS = 3;

/**
 * Where row `row` of a bar `height` tall starts, relative to the bar's own left
 * edge, before mirroring.
 *
 * The top row leans furthest (`height * 0.3249`) and the bottom row not at all,
 * which is the reference's parallelogram: `hudParaPath` shifts the *top* two
 * corners by `h * HUD_SKEW` and leaves the bottom two where they are.
 */
export function skewOffset(row: number, height: number): number {
  return ((height - row) * HUD_SKEW_BASIS_POINTS) / BASIS_POINTS_FULL;
}

/** Which of the four bands row `row` of a bar `height` tall falls in. */
export function bandOf(row: number, height: number): number {
  return Math.min(BAND_COUNT - 1, Math.floor((row * BAND_COUNT) / Math.max(1, height)));
}

/** One channel of a `#rrggbb`, as a byte. */
function channelOf(colour: string, channel: number): number {
  return Number.parseInt(colour.slice(1 + channel * 2, 3 + channel * 2), 16);
}

/** A byte as two lowercase hex digits, clamped so no arithmetic can produce a malformed colour. */
function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

/**
 * `from` moved `numerator/denominator` of the way to `to`, per channel.
 *
 * Integer channel lerp rather than any perceptual space, deliberately: the
 * reference's ramps are `createLinearGradient` stops, which browsers interpolate
 * in exactly this naive sRGB way, so this reproduces what the reference looks
 * like rather than improving on it.
 */
function lerpColour(from: string, to: string, numerator: number, denominator: number): string {
  const channels = [0, 1, 2].map((channel) => {
    const start = channelOf(from, channel);
    const end = channelOf(to, channel);
    return hexByte(start + ((end - start) * numerator) / Math.max(1, denominator));
  });
  return `#${channels.join('')}`;
}

/**
 * A two-stop `ArenaGradient` flattened to four `#rrggbb` band stops.
 *
 * `i = 0` is exactly `gradient.from` and `i = 3` is exactly `gradient.to`, which
 * is the property `hud.test.ts` pins: a banding scheme that failed to reach its
 * own declared endpoints would mean the palette's recorded contrast ratios
 * described a colour nothing ever draws.
 */
export function gradientBands(gradient: ArenaGradient): readonly string[] {
  return Object.freeze(
    Array.from({ length: BAND_COUNT }, (_unused, index) =>
      lerpColour(gradient.from, gradient.to, index, BAND_COUNT - 1),
    ),
  );
}

/** Health above the first tier boundary. */
export const HP_HIGH_BANDS = gradientBands(ARENA_PALETTE.hpHigh);
/** Health in the middle tier -- the warning that a round is turning. */
export const HP_MID_BANDS = gradientBands(ARENA_PALETTE.hpMid);
/** Health in the last tier, where one exchange ends the round. */
export const HP_LOW_BANDS = gradientBands(ARENA_PALETTE.hpLow);
/** The super meter while it is charging. */
export const SUPER_METER_BANDS = gradientBands(ARENA_PALETTE.superMeter);
/** The Token Bank meter. */
export const BANK_BANDS = gradientBands(ARENA_PALETTE.bank);

/**
 * The armed gauge's three ramps: `superMeterFull` blended toward `gold` at 0,
 * a half and 1.
 *
 * Three *colours* rather than three alphas. The reference pulses with
 * `globalAlpha`, which the hero raster declares and does not honour -- so the
 * hero would show a gauge that never moved while the browser showed one that
 * did, and the artefact drift test could not tell. Precomputing the ramps also
 * bounds the colour set, which is what makes `ARCADE_HUD_COLOURS` finite.
 *
 * At level 2 both stops are `gold`, so all four bands collapse to it and the
 * gauge reads as flat arcade gold at the top of the breath. That is the
 * reference's own choice -- it reserves flat `GOLD` for the loudest state -- and
 * the deduplication in `ARCADE_HUD_COLOURS` folds the repeats away.
 */
export const ARMED_PULSE_BANDS: readonly (readonly string[])[] = Object.freeze(
  Array.from({ length: ARMED_PULSE_LEVELS }, (_unused, level) =>
    gradientBands({
      from: lerpColour(
        ARENA_PALETTE.superMeterFull.from,
        ARENA_PALETTE.gold,
        level,
        ARMED_PULSE_LEVELS - 1,
      ),
      to: lerpColour(
        ARENA_PALETTE.superMeterFull.to,
        ARENA_PALETTE.gold,
        level,
        ARMED_PULSE_LEVELS - 1,
      ),
    }),
  ),
);

/**
 * Every colour `drawArcadeBar`, `drawArcadeSegments` and `arcadeText` can set,
 * deduplicated and frozen.
 *
 * `hero/hero.ts` feeds this straight into `heroPalette()`, and
 * `hero/raster.ts` throws on a `fillStyle` with no palette entry. So a band
 * table added below and forgotten here is a **loud** hero build failure rather
 * than a silent quantisation to whatever colour happened to be nearest.
 *
 * Two things are deliberately *not* in it, and both are the caller's to
 * declare: the `bands` a caller hands `drawArcadeBar` (the tables above are all
 * this module ships, but the parameter is open so `renderer.ts` can pass the
 * Token Bank's warn inversion), and the `colour` a caller hands `arcadeText`.
 * Both come from `THEME` or from `ARENA_PALETTE` at every call site in this
 * repository, and `hud.test.ts` sweeps the drawing functions to prove the set
 * below is complete for the tables that *are* shipped here.
 */
export const ARCADE_HUD_COLOURS: readonly string[] = Object.freeze([
  ...new Set([
    ARENA_PALETTE.hudPlate,
    ARENA_PALETTE.hudGhost,
    ARENA_PALETTE.hudBevel,
    ARENA_PALETTE.hudFrame,
    // Story 12.6. The armed callout's type and a won round's pip, both flat
    // arcade gold -- which the armed gauge's top pulse step already resolves to,
    // so this is a name for a value the set held rather than a new colour. It is
    // listed explicitly all the same: a later story that retunes the pulse ramps
    // must not silently take the callout's colour out of the hero's palette.
    ARENA_PALETTE.gold,
    // Story 12.6. The portrait plate's ground, which is the fighter's own aura
    // for whichever fighter is on that side -- and on a surface with no decoded
    // portrait it is the *whole* plate, so all four have to be reachable.
    ...Object.values(ARENA_PALETTE.aura),
    ...HP_HIGH_BANDS,
    ...HP_MID_BANDS,
    ...HP_LOW_BANDS,
    ...SUPER_METER_BANDS,
    ...BANK_BANDS,
    ...ARMED_PULSE_BANDS.flat(),
  ]),
]);

/**
 * The band table for a health level, in basis points of the fighter's starting
 * health.
 *
 * The reference's boundaries exactly (`screens.js:2454`): green above a half,
 * gold above a quarter, red at or below it. Written as basis-point comparisons
 * rather than as floats so the tier boundary is an integer comparison and a bar
 * at exactly 50% lands in the tier the reference puts it in -- `hpMid`, because
 * the test is strictly greater than.
 */
export function healthBands(healthBasisPoints: number): readonly string[] {
  if (healthBasisPoints > BASIS_POINTS_FULL / 2) {
    return HP_HIGH_BANDS;
  }
  if (healthBasisPoints > BASIS_POINTS_FULL / 4) {
    return HP_MID_BANDS;
  }
  return HP_LOW_BANDS;
}

/**
 * Which of the three armed ramps this frame draws.
 *
 * Pinned to level 0 under reduced motion, which is the whole of AC5 for this
 * element: the gauge keeps its layout, its information and its gold, and only
 * stops breathing. A negative frame index cannot arise from the film but is
 * clamped anyway, because `Math.floor(-1 / 6) % 4` is `-1` and an index of `-1`
 * into the triangle is `undefined` reaching a `fillStyle`.
 */
export function pulseLevel(frameIndex: number, reducedMotion: boolean): number {
  if (reducedMotion) {
    return 0;
  }
  const step =
    Math.floor(Math.max(0, frameIndex) / ARMED_PULSE_HOLD_FRAMES) % ARMED_PULSE_TRIANGLE.length;
  return ARMED_PULSE_TRIANGLE[step];
}

/**
 * One arcade bar.
 *
 * `mirror` is the reference's own flag: a mirrored bar leans the other way and
 * drains from the **outer** edge, so the two fighters' HUDs are reflections of
 * each other rather than two copies of the same bar. `ghostBasisPoints` below
 * `fillBasisPoints` draws nothing, which is how "no damage this step" produces
 * no second bar.
 */
export interface ArcadeBar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mirror: boolean;
  readonly fillBasisPoints: number;
  readonly ghostBasisPoints: number;
  readonly bands: readonly string[];
}

/** 0..`BASIS_POINTS_FULL`, and never `NaN`: a degenerate config must clamp, not paint nothing. */
function clampBasisPoints(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(BASIS_POINTS_FULL, value));
}

/**
 * The left edge of one row, mirrored and rounded to a whole pixel.
 *
 * Rounded because a `fillRect` on a half-pixel is antialiased into a blur, and
 * a blurred edge is the one thing `docs/DESIGN.md` will not have on either side
 * of the boundary. The lean is under seven pixels over a twenty-row bar, so
 * consecutive rows share a rounded offset in runs -- which is exactly what a
 * pixel-art skew looks like, and is what the reference's own antialiased path
 * approximates.
 */
function rowLeft(bar: ArcadeBar, row: number): number {
  const lean = Math.round(skewOffset(row, Math.max(1, bar.height)));
  return bar.mirror ? bar.x - lean : bar.x + lean;
}

/** Where a span of `spanWidth` starts on `row`: the outer edge, which is left unmirrored and right mirrored. */
function spanLeft(bar: ArcadeBar, row: number, spanWidth: number): number {
  return bar.mirror ? rowLeft(bar, row) + bar.width - spanWidth : rowLeft(bar, row);
}

/** A basis-point fraction of the bar's width, in whole pixels. */
function spanWidthOf(bar: ArcadeBar, basisPoints: number): number {
  return Math.round((bar.width * clampBasisPoints(basisPoints)) / BASIS_POINTS_FULL);
}

/**
 * Draws one bar: plate, then ghost, then the banded fill, then the bevel row,
 * then the skewed frame.
 *
 * The order is the reference's and it is not arbitrary -- the ghost has to be
 * under the live bar for a receding chip to read as *behind* it rather than as
 * a second bar beside it, and the frame has to be last so nothing overpaints
 * the outline.
 */
export function drawArcadeBar(ctx: Canvas2D, bar: ArcadeBar): void {
  const height = Math.max(0, Math.round(bar.height));
  if (height <= 0 || bar.width <= 0) {
    return;
  }

  const fill = spanWidthOf(bar, bar.fillBasisPoints);
  const ghost = Math.max(fill, spanWidthOf(bar, bar.ghostBasisPoints));

  ctx.fillStyle = ARENA_PALETTE.hudPlate;
  for (const row of upTo(height)) {
    ctx.fillRect(rowLeft(bar, row), bar.y + row, bar.width, 1);
  }

  // Only when it is actually behind something. A ghost equal to the live bar
  // is invisible by definition, and drawing it anyway would put a layer in the
  // call sequence that says "a hit landed" on every frame where none did.
  if (ghost > fill) {
    ctx.fillStyle = ARENA_PALETTE.hudGhost;
    for (const row of upTo(height)) {
      ctx.fillRect(spanLeft(bar, row, ghost), bar.y + row, ghost, 1);
    }
  }

  if (fill > 0) {
    for (const row of upTo(height)) {
      ctx.fillStyle = bar.bands[bandOf(row, height)];
      ctx.fillRect(spanLeft(bar, row, fill), bar.y + row, fill, 1);
    }

    // Inside the frame, not under it. The outline is drawn last and is
    // `FRAME_THICKNESS` deep, so a bevel on row 0 is painted over completely --
    // a defect that produces a *valid call sequence* and shows up only where
    // pixels are actually composited, which is `hero/raster.ts`. Row
    // `FRAME_THICKNESS` is the first row the outline does not claim.
    const bevelRow = Math.min(FRAME_THICKNESS, Math.max(0, height - BEVEL_ROWS));
    ctx.fillStyle = ARENA_PALETTE.hudBevel;
    ctx.fillRect(spanLeft(bar, bevelRow, fill), bar.y + bevelRow, fill, BEVEL_ROWS);
  }

  ctx.fillStyle = ARENA_PALETTE.hudFrame;
  for (const row of upTo(height)) {
    const left = rowLeft(bar, row);
    ctx.fillRect(left, bar.y + row, FRAME_THICKNESS, 1);
    ctx.fillRect(left + bar.width - FRAME_THICKNESS, bar.y + row, FRAME_THICKNESS, 1);
  }
  ctx.fillRect(rowLeft(bar, 0), bar.y, bar.width, FRAME_THICKNESS);
  ctx.fillRect(
    rowLeft(bar, height - 1),
    bar.y + height - FRAME_THICKNESS,
    bar.width,
    FRAME_THICKNESS,
  );
}

/**
 * `0, 1, ... count - 1`.
 *
 * An array rather than a counting `for` loop, for a reason that is this
 * repository's rather than a matter of taste: `source-discipline.test.ts` bans
 * a module-level mutable binding outright, and every loop in this file is a
 * row index or a segment index that has no business being one anywhere else.
 * `for (const row of upTo(h))` reads the same and cannot leak.
 */
function upTo(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}

/** A segmented meter -- the super gauge's four skewed chunks. */
export interface ArcadeSegments {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mirror: boolean;
  readonly count: number;
  readonly gap: number;
  readonly fillBasisPoints: number;
  readonly bands: readonly string[];
}

/**
 * Draws a meter as `count` skewed segments across `width`.
 *
 * Each segment fills independently (`screens.js:2466`: `frac = clamp01(pct *
 * SEGS - i)`), so a charging gauge reads as *how many chunks are lit* rather
 * than as a bar edge somewhere along a rail -- which is the difference between
 * a resource a viewer can count at five Decision Points a second and one they
 * have to measure. Segment 0 is at the outer edge on both sides, so the meters
 * mirror rather than both filling rightwards.
 */
export function drawArcadeSegments(ctx: Canvas2D, meter: ArcadeSegments): void {
  const count = Math.max(1, Math.floor(meter.count));
  const segmentWidth = Math.floor((meter.width - meter.gap * (count - 1)) / count);
  if (segmentWidth <= 0) {
    return;
  }

  for (const index of upTo(count)) {
    const offset = index * (segmentWidth + meter.gap);
    const x = meter.mirror
      ? meter.x + meter.width - segmentWidth - offset
      : meter.x + offset;
    const filled = clampBasisPoints(
      clampBasisPoints(meter.fillBasisPoints) * count - index * BASIS_POINTS_FULL,
    );

    drawArcadeBar(ctx, {
      x,
      y: meter.y,
      width: segmentWidth,
      height: meter.height,
      mirror: meter.mirror,
      fillBasisPoints: filled,
      ghostBasisPoints: 0,
      bands: meter.bands,
    });
  }
}

/**
 * A framed plate: the HUD's one surface that is not a bar (Story 12.6).
 *
 * The portrait sits in one and so does the round timer, because both are
 * *boxes* rather than levels -- and a box drawn as a degenerate `ArcadeBar`
 * would inherit the skew, which is the reference's language for a resource
 * draining and says the wrong thing about a face or a number.
 *
 * Four `fillRect` edges rather than a `strokeRect`: stroking a box draws its
 * outline centred on the path, so a 2px stroke lands one pixel outside the
 * declared rectangle and the plate ends up 2px wider than the layout says it
 * is. `renderer.ts` packs the portrait, the bars and the pips against measured
 * gaps, and an edge that overhangs its own box is how a HUD element starts
 * overlapping the one beside it -- the defect this story exists to remove.
 */
export interface ArcadePlate {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** What fills it behind whatever is drawn on top. */
  readonly fill: string;
}

export function drawArcadePlate(ctx: Canvas2D, plate: ArcadePlate): void {
  const width = Math.max(0, Math.round(plate.width));
  const height = Math.max(0, Math.round(plate.height));
  if (width <= 0 || height <= 0) {
    return;
  }

  ctx.fillStyle = plate.fill;
  ctx.fillRect(plate.x, plate.y, width, height);

  // Clamped, and then *offset* by the clamp. On a box one pixel tall the naive
  // `plate.y + height - FRAME_THICKNESS` lands a row **above** the box, which is
  // the exact overhang the four-`fillRect` construction exists to prevent -- and
  // an independent review of this story caught it sitting inside the docblock
  // that argues against it. Unreachable at today's sizes; a rule with one size
  // it does not hold for is not a rule.
  const edge = Math.min(FRAME_THICKNESS, width, height);
  ctx.fillStyle = ARENA_PALETTE.hudFrame;
  ctx.fillRect(plate.x, plate.y, width, edge);
  ctx.fillRect(plate.x, plate.y + height - edge, width, edge);
  ctx.fillRect(plate.x, plate.y, edge, height);
  ctx.fillRect(plate.x + width - edge, plate.y, edge, height);
}

/**
 * A portrait, as a sub-rectangle of an image the caller already decoded.
 *
 * Structural and narrow rather than `UltSheet`'s `UltFrame`, for `canvas2d.ts`'s
 * reason: naming the sheet's type here would bind the HUD to the Ultimate's
 * loader, and the HUD wants "somebody handed me a picture" and nothing else.
 * `UltFrame` satisfies it, which is what lets the portrait the cinematic already
 * fetches be the portrait the HUD draws -- the same file, fetched once.
 */
export interface HudPortrait {
  readonly image: unknown;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

/**
 * The portrait plate: an aura-filled, framed box with the fighter's face in it.
 *
 * **The face is optional and its absence is a designed state, not a blank.**
 * `hero/raster.ts` implements `Canvas2D` over a buffer of palette indices and
 * its `drawImage` *throws* -- it cannot decode a PNG without a Node built-in
 * `source-discipline.test.ts` forbids it -- so a HUD that drew the portrait
 * unconditionally would take the README image down with it. Filling the plate
 * with the fighter's own aura leaves a plate that still reads as *whose side
 * this is* on every surface, and the browser paints the face over it.
 *
 * This is the same fail-soft ladder `juice-draw.ts` already uses for the
 * cinematic's cut-in, and it is why `ARCADE_HUD_COLOURS` carries all four auras.
 */
export function drawPortraitPlate(
  ctx: Canvas2D,
  plate: ArcadePlate,
  portrait?: HudPortrait,
): void {
  drawArcadePlate(ctx, plate);

  const inner = FRAME_THICKNESS;
  const width = Math.max(0, Math.round(plate.width) - inner * 2);
  const height = Math.max(0, Math.round(plate.height) - inner * 2);
  if (portrait === undefined || width <= 0 || height <= 0) {
    return;
  }

  ctx.drawImage(
    portrait.image,
    portrait.sx,
    portrait.sy,
    portrait.sw,
    portrait.sh,
    plate.x + inner,
    plate.y + inner,
    width,
    height,
  );
}

/**
 * One round-win pip.
 *
 * Drawn whether or not it is earned (AC5): an empty pip is a plate on the
 * `hudPlate` ground, a won one is flat gold. A pip that appeared only once it
 * was won would be a HUD element that moves under the viewer mid-set, and the
 * viewer would have no way to know how many rounds the set is.
 */
export function drawArcadePip(
  ctx: Canvas2D,
  x: number,
  y: number,
  size: number,
  won: boolean,
): void {
  drawArcadePlate(ctx, {
    x,
    y,
    width: size,
    height: size,
    fill: won ? ARENA_PALETTE.gold : ARENA_PALETTE.hudPlate,
  });
}

/** The highest number the two-digit round timer can show. */
export const TIMER_MAX_READING = 99;

/**
 * The round timer's reading at a tick -- and it is not a clock (Story 12.6).
 *
 * The reference counts seconds. **We do not have seconds and must not acquire
 * them.** What exists is `tick` against `config.maxTicks`, which is a pure
 * function of the frame index: `maxTicks - tick` mapped onto 0..99 by integer
 * arithmetic, with no frame rate anywhere in it. A scrub to a frame shows the
 * same reading as playing to that frame, and a Match between two slow
 * Deployments reads identically to one between two fast ones (INV-1, INV-3).
 *
 * Degenerate inputs clamp rather than divide: a hand-built config with
 * `maxTicks <= 0` would otherwise put an `Infinity` through `String()` and print
 * a timer nobody can read.
 */
export function timerReading(tick: number, maxTicks: number): number {
  if (!Number.isFinite(tick) || !Number.isFinite(maxTicks) || maxTicks <= 0) {
    return 0;
  }
  // `ticksIn`, deliberately not the obvious word for it: `source-discipline.test.ts`
  // bans every timing-field name from shipped player source, and it is right to
  // -- the whole risk this function carries is that somebody later reads it as a
  // duration and reaches for a real one.
  const total = Math.floor(maxTicks);
  const ticksIn = Math.max(0, Math.min(total, Math.floor(Math.max(0, tick))));
  return Math.floor(((total - ticksIn) * TIMER_MAX_READING) / total);
}

/** The reading as the two digits the plate shows. */
export function timerLabel(tick: number, maxTicks: number): string {
  return String(timerReading(tick, maxTicks)).padStart(2, '0');
}

/**
 * A HUD callout in the arcade treatment: the display face at HUD size, drawn
 * twice -- once in `hudPlate` at a `+2,+2` offset, once in `colour`.
 *
 * The offset copy is the house style's hard shadow, arrived at through the one
 * mechanism a canvas has for it. `docs/DESIGN.md` bans a *blurred* shadow on
 * both sides of the boundary and says nothing against a hard one; two `fillText`
 * calls two pixels apart is what "6px 6px 0" looks like when the type is 16px
 * rather than a panel.
 *
 * The shadow is drawn in `hudPlate` rather than in the ground colour so a
 * callout sitting *on* a bar still separates from it -- the plate is the darkest
 * value in the arena palette, and a callout whose shadow matched the bar behind
 * it would have no shadow at all wherever it overlapped.
 */
export function arcadeText(
  ctx: Canvas2D,
  theme: Theme,
  text: string,
  x: number,
  y: number,
  align: string,
  colour: string,
): void {
  ctx.font = theme.arcadeFont;
  ctx.textAlign = align;
  ctx.fillStyle = ARENA_PALETTE.hudPlate;
  ctx.fillText(text, x + ARCADE_TEXT_SHADOW, y + ARCADE_TEXT_SHADOW);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}
