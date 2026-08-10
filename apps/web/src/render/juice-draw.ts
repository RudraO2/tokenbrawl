import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import { ARENA_PALETTE } from './arena-palette';
import type { Canvas2D } from './canvas2d';
import type { JuiceCinematic, JuiceFrame, JuiceKind } from './juice';
import { applyCamera } from './camera';
import {
  FLOOR_INSET,
  HUD_BOTTOM,
  cameraForFrame,
  drawFrame,
  groundYFor,
  type DrawFrameOptions,
  type Viewport,
} from './renderer';
import { ROSTER_NAMES, auraFor, type RosterId, type RosterPair } from './roster';
import { THEME, type Theme } from './theme';
import type { UltSheet } from './ult-sheet';
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
 * One `#rrggbb` blended toward another, in integer channel steps (Story 11.4).
 *
 * The reference's `mixHex`, and the reason it is computed rather than declared:
 * the slam's colour is *white with 40% of the caster's aura in it*, and there
 * are four auras, so declaring the result would put four more values in the
 * palette that no one chose and that would silently be wrong the day a fifth
 * fighter lands. `render/identity.ts` has had exactly this standing since Story
 * 9.4 -- a colour a text sweep cannot see because it was never typed -- and
 * `arena-palette.ts`'s docblock says so in as many words.
 *
 * Anything that does not parse as `#rrggbb` is returned unchanged rather than
 * producing `#NaNNaNNaN`, which paints nothing and reports nothing.
 */
function mixHex(base: string, toward: string, basisPoints: number): string {
  const parse = (hex: string): readonly number[] | null =>
    /^#[0-9a-f]{6}$/i.test(hex)
      ? [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
      : null;
  const from = parse(base);
  const to = parse(toward);
  if (from === null || to === null) {
    return base;
  }
  const weight = Math.max(0, Math.min(BASIS_POINTS_FULL, Math.floor(basisPoints)));
  const channel = (index: number): string =>
    Math.round(from[index] + ((to[index] - from[index]) * weight) / BASIS_POINTS_FULL)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/**
 * Runs `paint` with the surface additive at a basis-point alpha, and puts both
 * modes back to whatever they were.
 *
 * Every layer of the cinematic that reads as *light* -- the aura glow, the orb,
 * the beam, the muzzle, the impact -- goes through here, for the reason
 * `canvas2d.ts` gives about `'lighter'`: a dark pixel contributes nothing and a
 * bright one stacks into what is behind it, which is what light looks like.
 *
 * Restored in a `finally` and to the values found rather than to the defaults
 * they are *expected* to have, exactly as `paintImpacts` does: `'lighter'` left
 * set would additively blend the next frame's backdrop and fighters, which
 * reads as the whole stage catching fire on the frame after an Ultimate.
 */
function additively(ctx: Canvas2D, alphaBasisPoints: number, paint: () => void): void {
  const alpha = Math.max(0, Math.min(BASIS_POINTS_FULL, alphaBasisPoints));
  if (alpha <= 0) {
    return;
  }
  const priorAlpha = ctx.globalAlpha;
  const priorComposite = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha / BASIS_POINTS_FULL;
  try {
    paint();
  } finally {
    ctx.globalAlpha = priorAlpha;
    ctx.globalCompositeOperation = priorComposite;
  }
}

/** Runs `paint` at a basis-point alpha, source-over. For the curtain, which subtracts light. */
function atAlpha(ctx: Canvas2D, alphaBasisPoints: number, paint: () => void): void {
  const alpha = Math.max(0, Math.min(BASIS_POINTS_FULL, alphaBasisPoints));
  if (alpha <= 0) {
    return;
  }
  const priorAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha / BASIS_POINTS_FULL;
  try {
    paint();
  } finally {
    ctx.globalAlpha = priorAlpha;
  }
}

/**
 * A filled square centred on a point, which is what this port has instead of an
 * arc.
 *
 * `Canvas2D` has no path API by design (see `canvas2d.ts`) and Story 11.4 is
 * not the story that widens it: the reference's orb is three stacked
 * `createRadialGradient` circles, and a stack of centred squares at falling
 * alpha reproduces the same falloff through calls both this port and the hero's
 * raster already have. It is also honest to the house style -- `docs/DESIGN.md`
 * asks for chunky flat blocks, and a blocky energy orb is what that looks like
 * in motion.
 */
function centredSquare(ctx: Canvas2D, cx: number, cy: number, radius: number): void {
  const size = Math.max(1, Math.round(radius * 2));
  ctx.fillRect(Math.round(cx - size / 2), Math.round(cy - size / 2), size, size);
}

/**
 * The layered glow and orb, outermost first, as `(alpha, radius)` fractions of
 * their full size -- both in basis points.
 *
 * The reference stacks three `createRadialGradient` circles and its alphas
 * *rise* inward: a wide dim aura wash at 0.6, a brighter mid layer at 0.85, a
 * white-hot core at 0.95. The order matters more than the numbers do. Drawn the
 * other way round -- the widest layer at full opacity -- a glow is not a glow
 * at all but a solid square with two smaller squares on top of it, which is
 * what the first pass of this story drew.
 */
const GLOW_LAYERS: readonly { readonly alpha: number; readonly radius: number }[] = Object.freeze(
  Array.from({ length: 8 }, (_unused, step) =>
    Object.freeze({
      // Rising inward, and *low*. Three layers at the reference's own alphas
      // was the first pass and the visual gate rejected it on sight: at this
      // stage size the outermost square is 480px across, and 60% of an aura
      // additively over the arena is a hard-edged orange block covering half
      // the fight, with two smaller blocks inside it. The reference gets its
      // falloff from a radial gradient, which this port does not have; eight
      // thin steps at a tenth to a third of full opacity accumulate into the
      // same shape through calls it does have. The centre saturates because
      // every layer stacks there; the outer edge adds nine percent and reads
      // as light rather than as paint.
      alpha: 900 + step * 300,
      radius: BASIS_POINTS_FULL - step * 1_250,
    }),
  ),
);

/**
 * Story 10.4, deepened by Story 11.4. The Ultimate cinematic, in two halves.
 *
 * The split is not cosmetic. The beam, the muzzle and the impact belong to the
 * *stage*: they are struck at a fighter's position and must travel with the
 * shake, or a 16px camera kick would slide the beam off the fighter that threw
 * it. The letterbox, the vignette, the portrait and the slam belong to the
 * *screen*: framing that rattled with the camera reads as a broken overlay, and
 * a full-viewport fill must not leave a stale band along whichever edge the
 * translate moved away from -- the same reason the clear happens at identity
 * above.
 *
 * So `drawCinematicStage` runs inside the transform, next to the sparks, and
 * `drawCinematicPlate` runs after the `restore`, at identity. The reference
 * makes the same split for the same reason: its `drawUltimateCinematic` is
 * screen-space and its `drawBeam` is world-space.
 *
 * ## The three levels of degrade, and how to reach each
 *
 * Story 11.4's acceptance criterion is that a fighter with no portrait or no
 * ult art still throws it without throwing. That is three states, not two, and
 * each is reachable on purpose:
 *
 * 1. **`ult` bound and `caster` in it** -- the fighter's own muzzle, beam and
 *    impact cells, and their own portrait.
 * 2. **`caster` known, art absent** -- a procedural beam and orb in that
 *    fighter's own aura, which is the reference's own `else` branch flattened
 *    to rectangles, and the banner in place of the portrait.
 * 3. **`caster` unknown** (no roster passed, e.g. a surface that has not been
 *    wired yet) -- Story 10.4 exactly: the accent band gated on `connected`,
 *    the streak field, the `ULTIMATE` banner.
 */
export function drawCinematicStage(
  ctx: Canvas2D,
  cinematic: JuiceCinematic,
  viewport: Viewport,
  theme: Theme = THEME,
  ult?: UltSheet,
  caster?: RosterId,
): void {
  const groundY = viewport.height - FLOOR_INSET;
  const casterX = (cinematic.casterBasisPoints * viewport.width) / BASIS_POINTS_FULL;
  const aura = caster === undefined ? undefined : auraFor(caster);
  const beamCell = caster === undefined ? undefined : ult?.partFor(caster, 'beam');

  // Deliberately **not** clamped to the stage, on the same terms and for the
  // same reason `paintImpacts` is not: a beam is fired from a fighter's own
  // position toward a point, and sliding it inward so it fits would draw it
  // somewhere it was not fired. The canvas clips it, which is the truthful
  // picture for a caster pinned against a wall. Story 10.4's accent band, the
  // last-resort fallback below, keeps its own clamp -- it is a *mark* rather
  // than a projectile, and a mark that left the stage would simply be missing.
  if (cinematic.reachBasisPoints > 0) {
    const toward = cinematic.targetBasisPoints >= cinematic.casterBasisPoints ? 1 : -1;
    // The one viewport multiplication for the beam, in the same place and for
    // the same reason as `paintSparks`': the track carries basis points, and
    // only here is there a viewport to turn them into pixels with.
    const reach = Math.round((cinematic.reachBasisPoints * viewport.width) / BASIS_POINTS_FULL);
    const near = Math.round(casterX);
    const far = near + toward * reach;
    const left = Math.min(near, far);
    const right = Math.max(near, far);
    const axisY = Math.round(groundY - cinematic.beamHeightPx);
    const thickness = Math.max(1, Math.round(cinematic.beamThicknessPx));
    const hitX = Math.round(
      (cinematic.impactBasisPoints * viewport.width) / BASIS_POINTS_FULL,
    );

    if (beamCell !== undefined) {
      // Level 1: the fighter's own beam art, tiled along the sweep the way the
      // reference tiles its own cell, and clamped to a bound so a degenerate
      // tuning cannot ask for thousands of `drawImage` calls on one frame.
      const segments = Math.min(
        MAX_BEAM_SEGMENTS,
        Math.max(1, Math.ceil((right - left) / thickness)),
      );
      additively(ctx, BASIS_POINTS_FULL, () => {
        const priorSmoothing = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        try {
          for (const index of Array.from({ length: segments }, (_unused, at) => at)) {
            const segmentX = left + index * thickness;
            ctx.drawImage(
              beamCell.image,
              beamCell.sx,
              beamCell.sy,
              beamCell.sw,
              beamCell.sh,
              segmentX,
              axisY - Math.round(thickness / 2),
              thickness,
              thickness,
            );
          }
          const muzzle = caster === undefined ? undefined : ult?.partFor(caster, 'muzzle');
          if (muzzle !== undefined) {
            const size = Math.round((thickness * MUZZLE_SCALE_BASIS_POINTS) / BASIS_POINTS_FULL);
            ctx.drawImage(
              muzzle.image,
              muzzle.sx,
              muzzle.sy,
              muzzle.sw,
              muzzle.sh,
              near - Math.round(size / 2),
              axisY - Math.round(size / 2),
              size,
              size,
            );
          }
          const impact = caster === undefined ? undefined : ult?.partFor(caster, 'impact');
          // Both conditions, and they are different questions: `connected` is
          // what the simulation did across the Decision Point, `impactCovers`
          // is whether the beam has arrived yet. A whiff must never draw an
          // impact, and a hit must not draw one before the beam reaches it.
          if (impact !== undefined && cinematic.connected && cinematic.impactCovers) {
            const size = Math.round(
              (thickness * CINEMATIC_IMPACT_SCALE_BASIS_POINTS) / BASIS_POINTS_FULL,
            );
            ctx.drawImage(
              impact.image,
              impact.sx,
              impact.sy,
              impact.sw,
              impact.sh,
              hitX - Math.round(size / 2),
              axisY - Math.round(size / 2),
              size,
              size,
            );
          }
        } finally {
          ctx.imageSmoothingEnabled = priorSmoothing;
        }
      });
    } else if (aura !== undefined) {
      // Level 2: the reference's procedural beam -- an outer aura wash, a
      // brighter aura core and a white-hot centre -- as three stacked bars
      // rather than three stroked lines, because the port has no `stroke` with
      // a `lineCap` and a bar is what a beam is anyway.
      const width = Math.max(0, right - left);
      for (const [index, layer] of GLOW_LAYERS.entries()) {
        const band = Math.max(1, Math.round((thickness * layer.radius) / BASIS_POINTS_FULL));
        const colour = index === GLOW_LAYERS.length - 1 ? ARENA_PALETTE.ultFlash : aura;
        additively(ctx, layer.alpha, () => {
          ctx.fillStyle = colour;
          ctx.fillRect(left, axisY - Math.round(band / 2), width, band);
        });
      }
      if (cinematic.connected && cinematic.impactCovers) {
        additively(ctx, BASIS_POINTS_FULL, () => {
          ctx.fillStyle = ARENA_PALETTE.ultFlash;
          centredSquare(ctx, hitX, axisY, thickness);
        });
      }
    } else {
      // Level 3: Story 10.4's own hard accent band, with a heavier cap at the
      // leading edge so it reads as something thrown rather than as a stray
      // rule -- and still gated on `connected`, because a mark says a hit
      // landed and the juice layer must never say something the simulation did
      // not do.
      if (cinematic.connected) {
        const band = Math.max(1, Math.round(cinematic.bandPx));
        const y = clamp(
          Math.round(groundY - cinematic.heightPx - band / 2),
          0,
          Math.max(0, groundY - band),
        );
        const boundedLeft = clamp(left, 0, viewport.width);
        const boundedRight = clamp(right, 0, viewport.width);
        ctx.fillStyle = theme.accent;
        ctx.fillRect(boundedLeft, y, Math.max(0, boundedRight - boundedLeft), band);

        const capX = clamp(Math.round(far - band), 0, Math.max(0, viewport.width - band * 2));
        ctx.fillRect(capX, clamp(y - band, 0, Math.max(0, groundY - band * 3)), band * 2, band * 3);
      }
    }
  }

  for (const streak of cinematic.streaks) {
    const size = Math.max(1, Math.round(streak.sizePx));
    const x = clamp(Math.round(casterX + streak.offsetPx - size / 2), 0, Math.max(0, viewport.width - size));
    const y = clamp(Math.round(groundY - streak.heightPx - size / 2), 0, Math.max(0, groundY - size));
    // The field takes the caster's aura when there is one: it is debris coming
    // off *that fighter*, and the accent is the site's colour rather than
    // theirs. Without a roster it stays exactly the accent Story 10.4 drew.
    ctx.fillStyle = aura ?? theme.accent;
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

/** Bands the vignette is built from, inward from each edge. */
const VIGNETTE_BANDS = 6;
/** How thick one vignette band is, as a fraction of the viewport's shorter axis, in basis points. */
const VIGNETTE_BAND_BASIS_POINTS = 600;
/** The muzzle sprite is drawn a little larger than the beam it comes out of. */
const MUZZLE_SCALE_BASIS_POINTS = 13_000;
/** The reference's 1.8x: an Ultimate's impact must clearly out-scale an ordinary blast's. */
const CINEMATIC_IMPACT_SCALE_BASIS_POINTS = 18_000;
/** A hard bound on the beam's tiling, so no tuning can ask for thousands of draws on one frame. */
const MAX_BEAM_SEGMENTS = 64;
/** Where the portrait settles, as basis points across the viewport, on the caster's own side. */
const PORTRAIT_NEAR_BASIS_POINTS = 3_200;
const PORTRAIT_FAR_BASIS_POINTS = 6_800;
/** How far along the portrait's own width its hand -- and therefore the orb -- sits. */
const HAND_OFFSET_BASIS_POINTS = 3_000;
/** Gap between the portrait's lower edge and the caster's name. */
const NAME_GAP_PX = 18;
/** The name's hard offset shadow, in pixels. The same treatment `hud.ts`'s `arcadeText` gives. */
const NAME_SHADOW_PX = 2;

/**
 * Where the caster's portrait settles, in pixels, and which way they face.
 *
 * Agent 0 is drawn on the left of the arena, so their portrait comes in from
 * the left and their orb sits to its right, and the reverse for agent 1. The
 * reference does exactly this off its `fromLeft` flag; here the flag is the
 * agent index, which is the same fact by a different name.
 */
function portraitAnchor(
  cinematic: JuiceCinematic,
  viewport: Viewport,
): { readonly x: number; readonly facing: 1 | -1 } {
  const fromLeft = cinematic.agentIndex === 0;
  const settled =
    ((fromLeft ? PORTRAIT_NEAR_BASIS_POINTS : PORTRAIT_FAR_BASIS_POINTS) * viewport.width) /
    BASIS_POINTS_FULL;
  return { x: settled, facing: fromLeft ? 1 : -1 };
}

export function drawCinematicPlate(
  ctx: Canvas2D,
  cinematic: JuiceCinematic,
  viewport: Viewport,
  theme: Theme = THEME,
  ult?: UltSheet,
  caster?: RosterId,
): void {
  const aura = caster === undefined ? undefined : auraFor(caster);
  const portrait = caster === undefined ? undefined : ult?.portraitFor(caster);

  // --- The framing. Bars first, then a vignette over them, so the darkening
  // is continuous from the bar's edge inward rather than stopping at it.
  if (cinematic.letterboxPx > 0) {
    const bar = Math.round(cinematic.letterboxPx);
    ctx.fillStyle = ARENA_PALETTE.curtain;
    ctx.fillRect(0, 0, viewport.width, bar);
    ctx.fillRect(0, Math.max(0, viewport.height - bar), viewport.width, bar);
  }

  if (cinematic.vignetteBasisPoints > 0) {
    // The reference's radial gradient, as bands. `createRadialGradient` is not
    // in this port and Story 11.4 is not the story that widens it: six nested
    // frames at a falling alpha darken the edges and leave the centre clear,
    // which is what a vignette *is*, through calls the port already has.
    const band = Math.max(
      1,
      Math.round(
        (Math.min(viewport.width, viewport.height) * VIGNETTE_BAND_BASIS_POINTS) /
          BASIS_POINTS_FULL,
      ),
    );
    ctx.fillStyle = ARENA_PALETTE.curtain;
    for (const step of Array.from({ length: VIGNETTE_BANDS }, (_unused, at) => at)) {
      const inset = step * band;
      const width = Math.max(0, viewport.width - inset * 2);
      const height = Math.max(0, viewport.height - inset * 2);
      if (width <= 0 || height <= 0) {
        break;
      }
      // Graded outward-in, not divided equally. These rings are disjoint --
      // each is a frame at its own inset -- so an equal share would darken the
      // centre exactly as much as the edge, which is a grey wash rather than a
      // vignette. The outermost ring gets the full strength and each one inward
      // gets a step less.
      const alpha = Math.floor(
        (cinematic.vignetteBasisPoints * (VIGNETTE_BANDS - step)) / VIGNETTE_BANDS,
      );
      atAlpha(ctx, alpha, () => {
        ctx.fillRect(inset, inset, width, band);
        ctx.fillRect(inset, inset + height - band, width, band);
        ctx.fillRect(inset, inset, band, height);
        ctx.fillRect(inset + width - band, inset, band, height);
      });
    }
  }

  // --- The subject. A pulsing aura wash behind it, then the portrait itself,
  // slid in from the caster's own side.
  const anchor = portraitAnchor(cinematic, viewport);
  const centreY = Math.round(viewport.height / 2);
  if (cinematic.portraitBasisPoints > 0 && aura !== undefined) {
    // A third of the stage's *height*, which is the reference's `360` of its
    // own 1080 -- not a fraction of the width. Taking a quarter of 960 made the
    // wash 480px across on a 400-tall stage, so it spanned more than the
    // picture was tall and could only read as a rectangle.
    const width = Math.max(1, Math.round(viewport.height / 3));
    for (const [index, layer] of GLOW_LAYERS.entries()) {
      additively(ctx, layer.alpha, () => {
        ctx.fillStyle = index === GLOW_LAYERS.length - 1 ? ARENA_PALETTE.ultFlash : aura;
        centredSquare(
          ctx,
          anchor.x,
          centreY,
          Math.max(1, Math.round((width * layer.radius) / BASIS_POINTS_FULL)),
        );
      });
    }
  }

  // The slide is a lerp from off-stage to the settled anchor, and the eased
  // progress deliberately **exceeds** full mid-curve: `easeOutBack` overshoots,
  // which is why the portrait arrives with weight instead of gliding to a stop.
  const portraitWidth = Math.max(1, Math.round(cinematic.portraitWidthPx));
  const startX = anchor.facing > 0 ? -portraitWidth : viewport.width + portraitWidth;
  const portraitX = Math.round(
    startX + ((anchor.x - startX) * cinematic.portraitBasisPoints) / BASIS_POINTS_FULL,
  );
  if (cinematic.portraitBasisPoints > 0 && portrait !== undefined) {
    const height = Math.max(1, Math.round(cinematic.portraitHeightPx));
    const priorSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    try {
      ctx.drawImage(
        portrait.image,
        portrait.sx,
        portrait.sy,
        portrait.sw,
        portrait.sh,
        portraitX - Math.round(portraitWidth / 2),
        centreY - Math.round(height / 2),
        portraitWidth,
        height,
      );
    } finally {
      ctx.imageSmoothingEnabled = priorSmoothing;
    }
    if (aura !== undefined) {
      ctx.strokeStyle = aura;
      ctx.lineWidth = theme.borderWidth;
      ctx.strokeRect(
        portraitX - Math.round(portraitWidth / 2),
        centreY - Math.round(height / 2),
        portraitWidth,
        height,
      );
    }
  }

  // --- The orb, at the caster's hand. Screen-space and anchored to the
  // portrait rather than to the fighter, because in the reference this is a
  // cutscene the fight is behind rather than an effect on the stage; the beam,
  // which *is* on the stage, is the other half and lives in `drawCinematicStage`.
  if (cinematic.orbRadiusPx > 0 && aura !== undefined) {
    const bloomed = Math.round(
      (cinematic.orbRadiusPx * (BASIS_POINTS_FULL + cinematic.bloomBasisPoints)) /
        BASIS_POINTS_FULL,
    );
    const handX =
      portraitX +
      anchor.facing * Math.round((portraitWidth * HAND_OFFSET_BASIS_POINTS) / BASIS_POINTS_FULL);
    for (const [index, layer] of GLOW_LAYERS.entries()) {
      additively(ctx, layer.alpha, () => {
        ctx.fillStyle = index === GLOW_LAYERS.length - 1 ? ARENA_PALETTE.ultFlash : aura;
        centredSquare(
          ctx,
          handX,
          centreY,
          Math.max(1, Math.round((bloomed * layer.radius) / BASIS_POINTS_FULL)),
        );
      });
    }
  }

  // --- The slam. One rise and one fall, no repeat -- see `CinematicTuning` for
  // why this is not a strobe -- tinted with the caster's own aura, which is the
  // reference's `mixHex(white, aura, 0.4)` at `screens.js:1500`.
  if (cinematic.flashBasisPoints > 0) {
    const tint =
      aura === undefined
        ? theme.ink
        : mixHex(ARENA_PALETTE.ultFlash, aura, cinematic.slamTintBasisPoints);
    atAlpha(ctx, cinematic.flashBasisPoints, () => {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, viewport.width, viewport.height);
    });
  }

  // --- The caster's name, in arcade type under their portrait. The reference
  // draws the same line in the same place; here it is the display face at HUD
  // size with a hard offset shadow, which is the treatment Story 11.3 settled
  // on rather than a third typeface.
  if (portrait !== undefined && cinematic.portraitBasisPoints > 0 && caster !== undefined) {
    const height = Math.max(1, Math.round(cinematic.portraitHeightPx));
    const nameY = clamp(
      centreY + Math.round(height / 2) + NAME_GAP_PX,
      0,
      Math.max(0, viewport.height),
    );
    ctx.font = theme.arcadeFont;
    ctx.textAlign = 'center';
    ctx.fillStyle = ARENA_PALETTE.curtain;
    ctx.fillText(ROSTER_NAMES[caster], portraitX + NAME_SHADOW_PX, nameY + NAME_SHADOW_PX);
    ctx.fillStyle = aura ?? theme.ink;
    ctx.fillText(ROSTER_NAMES[caster], portraitX, nameY);
    return;
  }

  // --- No portrait: Story 10.4's banner stands in, unchanged. This is the
  // second and third degrade levels sharing one stand-in, which is correct --
  // "there is no picture of this fighter" is one situation however it arose.
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
  /**
   * Story 11.4. The Ultimate's per-character art, on the same terms as `vfx`:
   * absent until it decodes, absent forever if it never does, and its absence
   * is a named degrade rather than a failure.
   */
  readonly ult?: UltSheet;
  /**
   * Story 11.4. Which fighter each agent index *is*.
   *
   * Optional, and its absence is the third degrade level: a surface that has
   * not been told who is fighting draws Story 10.4's cinematic exactly, rather
   * than guessing a fighter and glowing in somebody else's colour.
   */
  readonly roster?: RosterPair;
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

  // Story 11.4. Which fighter cast this Ultimate, or `undefined` when the
  // caller has not said -- which is the third degrade level and is drawn as
  // Story 10.4's cinematic rather than as a guess.
  const caster =
    juiceFrame.cinematic === null ? undefined : options.roster?.[juiceFrame.cinematic.agentIndex];

  ctx.save();
  ctx.translate(juiceFrame.shakeX, juiceFrame.shakeY);
  drawFrame(ctx, frame, options);

  // Story 12.3. Both of these place things by arena position -- a spark at the
  // point of impact, a beam reaching from the caster -- so both have to be in
  // the same space the camera just drew the fighters in. Drawn at identity they
  // would land where the fighters used to be before there was a camera, which
  // is a defect no unit test can see: the call sequence would be unchanged and
  // every coordinate would still be the "right" number.
  //
  // Derived from the same `cameraForFrame` `drawFrame` uses rather than passed
  // down from it, because the alternative -- returning the camera out of
  // `drawFrame` -- would make the compositor depend on a value the renderer
  // happened to compute rather than on the frame. Two calls, one pure function,
  // provably the same answer.
  ctx.save();
  applyCamera(ctx, cameraForFrame(frame, options.config, viewport), viewport, groundYFor(viewport));
  if (juiceFrame.cinematic !== null) {
    drawCinematicStage(ctx, juiceFrame.cinematic, viewport, theme, options.ult, caster);
  }
  drawJuiceOverlay(ctx, juiceFrame, viewport, theme, options.vfx);
  ctx.restore();

  ctx.restore();

  // At identity, and after the restore. The plate must cover the whole
  // viewport rather than the shaken one, and the framing is framing rather
  // than scenery -- see `drawCinematicStage`'s docblock for the split.
  if (juiceFrame.cinematic !== null) {
    drawCinematicPlate(ctx, juiceFrame.cinematic, viewport, theme, options.ult, caster);
  }
}
