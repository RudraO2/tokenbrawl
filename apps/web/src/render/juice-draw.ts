import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import type { Canvas2D } from './canvas2d';
import type { JuiceCinematic, JuiceFrame, JuiceKind } from './juice';
import {
  FLOOR_INSET,
  HUD_BOTTOM,
  drawFrame,
  type DrawFrameOptions,
  type Viewport,
} from './renderer';
import { THEME, type Theme } from './theme';
import type { VfxPose, VfxSheet } from './vfx-sheet';

/**
 * Story 9.5: compositing the juice over a frame the renderer already knows how
 * to draw.
 *
 * This file exists because of one hard constraint and one soft one.
 *
 * The hard one: `renderer.test.ts` asserts `drawFrame`'s exact call sequence,
 * and that assertion is worth more than the convenience of reaching into it.
 * So `drawFrame` is not touched. The shake is applied *around* it -- a
 * `save`/`translate`/`restore` sandwich -- and the overlay is drawn inside the
 * same transform so the sparks travel with the stage rather than sliding
 * against it.
 *
 * The soft one: the `Canvas2D` port has no `rotate` and no path API by design
 * (see `canvas2d.ts`), and this story is not the story that widens it. A shake
 * is therefore a translation and nothing else, and a spark is a square. Both
 * are honest to the house style: `docs/DESIGN.md` asks for chunky flat blocks,
 * and a rectangular spark is what that looks like in motion.
 *
 * Neither was true of anything here until Story 11.2. The reflex when an
 * effect must "fade" is to ramp `globalAlpha`, and when this was written
 * `style-discipline.test.ts` banned exactly that outside `backdrop.ts` -- so a
 * spark died by shrinking to a pixel and then expiring on its tuned frame.
 * **Story 11.1 released `render/` from that ban** and **Story 11.2 spends the
 * release**: `paintImpacts` below draws a real sprite from
 * `public/fx/fx_sheet.png`, additively, on an integer alpha ramp. The squares
 * stay exactly as they were -- they are the debris *and* they are the fallback
 * for a sheet that never loaded, so nothing about them is removed.
 *
 * ## Why the clear happens here, at identity
 *
 * `drawFrame` opens with a full-viewport `clearRect` plus a background fill --
 * but *inside* a translated transform that would leave a band of stale pixels
 * along whichever edge the shake moved away from, which reads as the stage
 * tearing rather than shaking. So the surface is cleared and filled here,
 * before the translate, and `drawFrame`'s own clear then redundantly covers
 * the shifted rect. Redundant, cheap, and it is what keeps `drawFrame`
 * unchanged.
 */

/**
 * Colour and weight are read from the `Theme`; this file contains no colour of
 * its own.
 *
 * This is where the one viewport multiplication happens, in the same spirit as
 * `renderer.ts`'s `interpolatedX`: the juice track carries an impact point in
 * basis points and a scatter in pixels, and only here -- where the viewport is
 * actually in hand -- do the two become a screen coordinate. Both axes are
 * then clamped so no square is ever drawn outside the stage, and both are
 * rounded to whole pixels: a rect on a half-pixel is a blur, which is exactly
 * what the flat-block house style is not.
 */
function paintSparks(
  ctx: Canvas2D,
  juiceFrame: JuiceFrame,
  viewport: Viewport,
  theme: Theme,
): void {
  const groundY = viewport.height - FLOOR_INSET;
  for (const spark of juiceFrame.sparks) {
    const size = Math.max(1, Math.round(spark.sizePx));
    const centreX = (spark.positionBasisPoints * viewport.width) / BASIS_POINTS_FULL + spark.offsetPx;
    const x = clamp(Math.round(centreX - size / 2), 0, Math.max(0, viewport.width - size));
    const y = clamp(Math.round(groundY - spark.heightPx - size / 2), 0, Math.max(0, groundY - size));
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, y, size, size);
  }
}

/**
 * Story 11.2. Which pose each grade of hit is drawn with.
 *
 * The one place a `JuiceKind` becomes a name in the sheet, and it lives here
 * rather than in `juice.ts` because `juice.ts` has deliberately never known
 * that a sheet exists -- it says *what kind* of impact this is, and this file,
 * which owns both the sheet and the viewport, decides what that is drawn as.
 *
 * A KO taking `ko_burst` rather than a bigger `spark_h` is the Match's last
 * hit not looking like its first, which is the acceptance criterion in one
 * table row.
 *
 * Exported so nothing has to keep a second copy in step with this one.
 * `juice.test.ts`'s drift guard -- `impactFrames[kind] === frames * holdFrames`
 * for the mapped pose -- is only worth having if it reads the mapping the
 * paint path actually uses; against a hand-written mirror it would stay green
 * through exactly the remap it exists to catch.
 */
export const POSE_FOR_KIND: Readonly<Record<JuiceKind, VfxPose>> = Object.freeze({
  hit: 'spark_l',
  heavy: 'spark_h',
  ko: 'ko_burst',
});

/**
 * The impact sprites, drawn additively at the point of contact.
 *
 * Skipped entirely when no sheet has loaded, which is the fail-soft half of
 * this story: `paintSparks` above is untouched and is what a visitor sees when
 * the sheet 404s, fails to parse, or will not decode. A fight with no impact
 * art is worse-looking, never broken.
 *
 * Three things happen here and nowhere else:
 *
 * - **The atlas frame.** `frameFor(pose, ageFrames)` divides the age by the
 *   pose's `holdFrames` and clamps to its last cell. No clock is read; the age
 *   is an integer count of clock frames handed over by the track.
 * - **The one viewport multiplication**, for the same reason and in the same
 *   place `paintSparks` explains: the track carries basis points because it has
 *   no viewport, and this is the only file that does.
 * - **The single float.** `alphaBasisPoints / BASIS_POINTS_FULL` is the one
 *   division in the whole impact path, at the canvas boundary, exactly as
 *   `audio-bus.ts` divides basis points only at its `GainNode`.
 *
 * All three canvas modes are put back to what they were on the way in, rather
 * than to the defaults they are *expected* to have been. `drawJuicedFrame`
 * wraps this in `save`/`restore` so the difference is invisible there, but
 * `drawJuiceOverlay` is exported and a caller that had set its own alpha would
 * silently get 1 back. `'lighter'` left set would additively blend the *next*
 * frame's backdrop and fighters, which reads as the whole stage catching fire
 * on the frame after a hit.
 *
 * **`imageSmoothingEnabled` is forced off, and it has to be forced here.**
 * `artist.ts` and `backdrop.ts` each set it inside their *own* `save`/`restore`
 * pair, so by the time this runs the flag is back at the canvas default, which
 * is `true`. These cells are 208px pixel art drawn down to 128 for a `hit` and
 * up to 260 for a `ko` -- both directions resample -- so inheriting the default
 * would make the impact sheet the one thing in the arena drawn bilinear, which
 * `canvas2d.ts` calls the setting that decides whether this looks like a sprite
 * or like a blurred shape. No recording fake in the suite reads the flag, so
 * this is asserted explicitly rather than left to a call-sequence check.
 *
 * Deliberately **not** clamped to the stage the way a spark is, on either axis.
 * A spark is debris and pinning one to the edge merely relocates it; an impact
 * is struck at a fighter's own position, and sliding a 208px sprite inward so
 * it fits would draw the flash somewhere the hit did not happen. The canvas
 * clips it instead, which is the truthful picture for a fighter pinned to a
 * wall.
 *
 * Be explicit about what that costs vertically, because it is not zero and it
 * is not visible from the numbers here. On the shipped 960x400 stage
 * `groundY` is 360 and `HUD_BOTTOM` is 118; a `ko` at `impactHeightPx` 116 and
 * `impactSizePx` 260 spans y 114..374, so it already reaches four pixels into
 * the Token Bank row and fourteen below the floor line -- additively, over a
 * HUD that has already been painted. That is accepted at the shipped tuning
 * (the top rows of `ko_burst` are near-transparent) and it is the number to
 * check first if `impactSizePx.ko` or `impactHeightPx.ko` is ever raised: the
 * health bars have nothing protecting their legibility but these two values.
 */
function paintImpacts(
  ctx: Canvas2D,
  juiceFrame: JuiceFrame,
  viewport: Viewport,
  vfx: VfxSheet,
): void {
  if (juiceFrame.impacts.length === 0) {
    return;
  }

  const groundY = viewport.height - FLOOR_INSET;
  const priorAlpha = ctx.globalAlpha;
  const priorComposite = ctx.globalCompositeOperation;
  const priorSmoothing = ctx.imageSmoothingEnabled;
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = false;

  // `finally` rather than a trailing set of assignments: a throw anywhere in
  // the loop would otherwise leave the surface additive, and the next frame's
  // backdrop and fighters would blend into whatever survived on it.
  try {
    for (const impact of juiceFrame.impacts) {
      const pose = POSE_FOR_KIND[impact.kind];
      const cell = vfx.frameFor(pose, impact.ageFrames);
      const image = vfx.imageFor(cell.image);
      if (image === undefined) {
        continue;
      }

      const size = Math.max(1, Math.round(impact.sizePx));
      const centreX = (impact.positionBasisPoints * viewport.width) / BASIS_POINTS_FULL;
      const x = Math.round(centreX - size / 2);
      const y = Math.round(groundY - impact.heightPx - size / 2);

      ctx.globalAlpha = impact.alphaBasisPoints / BASIS_POINTS_FULL;
      ctx.drawImage(image, cell.sx, cell.sy, cell.sw, cell.sh, x, y, size, size);
    }
  } finally {
    ctx.globalAlpha = priorAlpha;
    ctx.globalCompositeOperation = priorComposite;
    ctx.imageSmoothingEnabled = priorSmoothing;
  }
}

/** Half the width of the widest damage label, so a centred number stays on the stage. */
const NUMBER_MARGIN_PX = 24;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The floating number, in the display face rather than the mono one.
 *
 * Damage is the one number on screen that is meant to be read at a glance
 * while everything else is moving, so it takes the loudest pairing the palette
 * allows -- warn on the heavy display face -- rather than sitting in the same
 * mono readout as the HUD it is trying to be noticed against.
 */
function paintNumbers(
  ctx: Canvas2D,
  juiceFrame: JuiceFrame,
  viewport: Viewport,
  theme: Theme,
): void {
  const groundY = viewport.height - FLOOR_INSET;
  for (const number of juiceFrame.damageNumbers) {
    // Same rule as `paintSparks`, for the same two reasons. A centred label at
    // a wall-pinned fighter (`positionBasisPoints` at either end) would be
    // drawn half off-canvas, and the one number the feature exists to make
    // readable is the one that must never be clipped; the rounding keeps it
    // off a half-pixel. `NUMBER_MARGIN_PX` leaves room for the half-width of
    // the glyphs the centre alignment spreads either side.
    const centreX = (number.positionBasisPoints * viewport.width) / BASIS_POINTS_FULL;
    const x = clamp(
      Math.round(centreX),
      Math.min(NUMBER_MARGIN_PX, viewport.width),
      Math.max(0, viewport.width - NUMBER_MARGIN_PX),
    );
    const y = clamp(Math.round(groundY - number.heightPx), 0, Math.max(0, groundY));
    ctx.fillStyle = theme.warn;
    ctx.font = theme.displayFont;
    ctx.textAlign = 'center';
    ctx.fillText(String(number.damage), x, y);
  }
}

/**
 * Story 10.4. The Ultimate cinematic, in two halves.
 *
 * The split is not cosmetic. The impact mark and the streak field belong to
 * the *stage*: they are struck at a fighter's position and must travel with
 * the shake, or a 16px camera kick would slide the beam off the fighter that
 * threw it. The plate and the banner belong to the *screen*: a letterboxed
 * title that rattled with the camera reads as a broken overlay rather than as
 * framing, and the plate is a full-viewport fill that must not leave a stale
 * band along whichever edge the translate moved away from -- the same reason
 * the clear happens at identity above.
 *
 * So `drawCinematicStage` runs inside the transform, next to the sparks, and
 * `drawCinematicPlate` runs after the `restore`, at identity.
 *
 * Everything below is a `fillRect` or a `fillText` in a palette colour. The
 * reference's super does this with additive blending, a radial gradient and an
 * alpha ramp; when this was written `docs/DESIGN.md` banned all three inside
 * the arena too. **Story 11.1 lifted that**, and Story 11.4 is where the
 * Ultimate's cinematic is meant to use it. Until then a solid plate for three
 * frames, a hard accent band and a field of shrinking squares say the same
 * thing flat.
 */
export function drawCinematicStage(
  ctx: Canvas2D,
  cinematic: JuiceCinematic,
  viewport: Viewport,
  theme: Theme = THEME,
): void {
  const groundY = viewport.height - FLOOR_INSET;
  const casterX = (cinematic.casterBasisPoints * viewport.width) / BASIS_POINTS_FULL;

  // The impact mark: a hard accent band struck from the caster toward whoever
  // it landed on, with a heavier cap at the leading edge so it reads as
  // something thrown rather than as a stray rule. Absent on a whiff, because
  // `reachBasisPoints` is zero there.
  if (cinematic.reachBasisPoints > 0) {
    const toward = cinematic.targetBasisPoints >= cinematic.casterBasisPoints ? 1 : -1;
    const band = Math.max(1, Math.round(cinematic.bandPx));
    // The one viewport multiplication for the mark, in the same place and for
    // the same reason as `paintSparks`': the track carries basis points, and
    // only here is there a viewport to turn them into pixels with.
    const reach = Math.round(
      (cinematic.reachBasisPoints * viewport.width) / BASIS_POINTS_FULL,
    );
    const y = clamp(Math.round(groundY - cinematic.heightPx - band / 2), 0, Math.max(0, groundY - band));
    const near = Math.round(casterX);
    const far = near + toward * reach;
    const left = clamp(Math.min(near, far), 0, viewport.width);
    const right = clamp(Math.max(near, far), 0, viewport.width);

    ctx.fillStyle = theme.accent;
    ctx.fillRect(left, y, Math.max(0, right - left), band);

    const capX = clamp(
      Math.round(far - band),
      0,
      Math.max(0, viewport.width - band * 2),
    );
    ctx.fillRect(capX, clamp(y - band, 0, Math.max(0, groundY - band * 3)), band * 2, band * 3);
  }

  for (const streak of cinematic.streaks) {
    const size = Math.max(1, Math.round(streak.sizePx));
    const x = clamp(Math.round(casterX + streak.offsetPx - size / 2), 0, Math.max(0, viewport.width - size));
    const y = clamp(Math.round(groundY - streak.heightPx - size / 2), 0, Math.max(0, groundY - size));
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, y, size, size);
  }
}

/** Gap between the lowest HUD block and the title banner. */
const BANNER_GAP_PX = 12;
/** The banner's height. Tall enough for the display face plus its own inset. */
const BANNER_HEIGHT_PX = 44;
/**
 * The word the banner carries.
 *
 * `ULTIMATE`, deliberately the same word Story 10.3 put on the armed gauge.
 * The gauge says ULTIMATE READY for as long as the bar is full; this is the
 * payoff to that arming rather than a separate idea, and a viewer who has been
 * watching a red bar say READY should see the same word when it is spent.
 */
const BANNER_WORD = 'ULTIMATE';

export function drawCinematicPlate(
  ctx: Canvas2D,
  cinematic: JuiceCinematic,
  viewport: Viewport,
  theme: Theme = THEME,
): void {
  // One solid plate, three frames, no repeat -- see `CinematicTuning.flashFrames`
  // for why this is not a strobe.
  if (cinematic.flash) {
    ctx.fillStyle = theme.ink;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  }

  if (!cinematic.title) {
    return;
  }

  // Warn-as-fill with the word in ground ink: the same pairing `drawSuperGauge`
  // and `drawTokenBank` already use for a crossed threshold, and the one
  // direction of that pair `docs/DESIGN.md` measured as legible (warn *on* bg
  // is 4.26:1 and misses the 4.5:1 floor; bg on warn does not).
  const top = clamp(HUD_BOTTOM + BANNER_GAP_PX, 0, Math.max(0, viewport.height - BANNER_HEIGHT_PX));
  ctx.fillStyle = theme.warn;
  ctx.fillRect(0, top, viewport.width, BANNER_HEIGHT_PX);

  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = theme.borderWidth;
  ctx.strokeRect(0, top, viewport.width, BANNER_HEIGHT_PX);

  ctx.fillStyle = theme.bg;
  ctx.font = theme.displayFont;
  ctx.textAlign = 'center';
  ctx.fillText(
    BANNER_WORD,
    Math.round(viewport.width / 2),
    Math.round(top + BANNER_HEIGHT_PX - theme.borderWidth * 3),
  );
}

/**
 * Draws the sparks, the impact art and the floating numbers for one clock
 * frame.
 *
 * The order is the point. Debris first, the impact flash over it, and the
 * damage number last so the one thing on screen that has to be *read* is never
 * under an additive sprite. `vfx` is optional and absent means the Story 9.5
 * path, unchanged and call-for-call identical -- which is what makes the
 * fail-soft claim checkable rather than asserted.
 */
export function drawJuiceOverlay(
  ctx: Canvas2D,
  juiceFrame: JuiceFrame,
  viewport: Viewport,
  theme: Theme = THEME,
  vfx?: VfxSheet,
): void {
  if (
    juiceFrame.sparks.length === 0 &&
    juiceFrame.damageNumbers.length === 0 &&
    juiceFrame.impacts.length === 0
  ) {
    return;
  }
  paintSparks(ctx, juiceFrame, viewport, theme);
  if (vfx !== undefined) {
    paintImpacts(ctx, juiceFrame, viewport, vfx);
  }
  paintNumbers(ctx, juiceFrame, viewport, theme);
}

/**
 * Story 11.2. `DrawFrameOptions` plus the impact sheet.
 *
 * Declared **here** rather than added to `DrawFrameOptions` deliberately.
 * `renderer.test.ts` asserts `drawFrame`'s exact call sequence and this file's
 * whole reason for existing is that that assertion is worth more than the
 * convenience of reaching into it -- so the sheet reaches the compositor
 * without `renderer.ts` being touched at all. `drawFrame` receives the same
 * object and ignores the extra field, which is what a structural type is for.
 */
export interface DrawJuicedFrameOptions extends DrawFrameOptions {
  /** Absent until the sheet decodes, and absent forever if it never does. */
  readonly vfx?: VfxSheet;
}

/**
 * One film frame, shaken, with its juice on top.
 *
 * Purely presentational: `frame` is read and never written, and nothing this
 * function touches is an input to `env.hash`. The intent is that swapping the
 * tuning changes every call recorded here and no byte of
 * `film.finalStateHash` (AD-15, INV-2). `juice-neutrality.test.ts` checks that
 * on the demo Match -- by re-deriving the hash from the same log after the
 * juiced paint has run -- rather than asserting it as a general theorem.
 */
export function drawJuicedFrame(
  ctx: Canvas2D,
  frame: RenderFrame,
  juiceFrame: JuiceFrame,
  options: DrawJuicedFrameOptions,
): void {
  const theme = options.theme ?? THEME;
  const { viewport } = options;

  ctx.clearRect(0, 0, viewport.width, viewport.height);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  ctx.save();
  ctx.translate(juiceFrame.shakeX, juiceFrame.shakeY);
  drawFrame(ctx, frame, options);
  if (juiceFrame.cinematic !== null) {
    drawCinematicStage(ctx, juiceFrame.cinematic, viewport, theme);
  }
  drawJuiceOverlay(ctx, juiceFrame, viewport, theme, options.vfx);
  ctx.restore();

  // At identity, and after the restore. The plate must cover the whole
  // viewport rather than the shaken one, and the banner is framing rather
  // than scenery -- see `drawCinematicStage`'s docblock for the split.
  if (juiceFrame.cinematic !== null) {
    drawCinematicPlate(ctx, juiceFrame.cinematic, viewport, theme);
  }
}
