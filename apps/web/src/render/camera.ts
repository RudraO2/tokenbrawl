import type { FighterConfig } from '../../../../packages/env-fighter/src/config';
import type { Canvas2D } from './canvas2d';
import type { Viewport } from './renderer';

/**
 * Story 12.3: the arena gets a camera.
 *
 * Until this story the simulation's single horizontal axis was mapped **1:1**
 * onto device pixels: `arenaMin..arenaMax` is `0..960` and the canvas is 960
 * wide, so a fighter standing on the right wall was drawn centred on the
 * canvas's right edge and half of them rendered outside the frame. Both walls
 * cut a fighter in half, and a Match opened with the pair occupying the middle
 * third with the outer thirds empty. `render/backdrop.ts` stated the cause in
 * its own docblock -- *"no camera"* -- and that sentence was accurate.
 *
 * ## Pure, like everything else under `render/`
 *
 * `cameraFor` is a function of the two positions and the viewport and nothing
 * else. **No accumulator, no easing across calls, no clock.** The reference
 * project smooths its camera through a mutable module-level `state`, which is
 * one of the four mechanisms `docs/DEV-REFERENCE.md` forbids copying and which
 * `source-discipline.test.ts` bans outright: a stepped accumulator cannot be
 * scrubbed backwards, so Story 4.5's timeline would show a camera that depended
 * on how the viewer arrived at the frame rather than on the frame.
 *
 * Smoothing still happens, and it is free: the positions handed in are already
 * interpolated across `progressBasisPoints`, so the camera eases exactly as the
 * fighters do and a scrub to frame 90 draws the same camera as a play-through
 * that reaches frame 90 (INV-1, INV-3).
 *
 * ## World space
 *
 * "World" here is the pixel space the arena has always been drawn in:
 * `arenaMin..arenaMax` mapped onto `0..viewport.width`. Nothing about that
 * mapping changed, which is what keeps every existing coordinate assertion in
 * `renderer.test.ts` and `juice-draw.test.ts` describing the same drawing. The
 * camera is a transform applied *over* it, and `arenaMin`/`arenaMax` are not
 * touched -- changing those would change every Final-State Hash in the repo.
 */

export interface Camera {
  /** World x the frame is centred on. */
  readonly x: number;
  /** Uniform zoom. Below 1 shows more of the stage than the arena is wide. */
  readonly scale: number;
}

/**
 * How far past each wall the camera may look, as a fraction of the arena's
 * world width.
 *
 * The stage is not the arena. A fighter standing *on* `arenaMax` has to be
 * drawn whole, and half a sprite is 104 world pixels, so the camera must be
 * able to show at least that much beyond the wall or the clamp merely moves the
 * clipping bug rather than fixing it. Half the arena is far more than that
 * minimum, deliberately: it is what gives the camera somewhere to travel to
 * when the fight pins itself against one wall, which is the case where a
 * stage-centred frame puts the pair off in one third of the picture. Nothing
 * draws a wall, so the extra stage reads as more floor -- exactly as it does in
 * the reference frame, where the arena runs past both fighters to the edge.
 */
const STAGE_MARGIN_RATIO = 0.5;

/**
 * Air the camera wants beyond each fighter, as a fraction of the arena's world
 * width. This is the zoom's whole tuning.
 *
 * Measured against `<REF>/shots/04_local_match.png` rather than picked: the
 * reference frames its pair at roughly a third of frame height with the pair's
 * separation about a fifth of frame width. This build's sprites read at ~44% of
 * a 400-tall arena at 1:1, and the opening separation is 320 world pixels. At
 * `0.5` the opening frame wants `320 + 960` world pixels of view, which is a
 * scale of `0.75` -- fighters at 33% of frame height and separated by a quarter
 * of the frame. That is the reference's framing, arrived at by arithmetic.
 */
const HEADROOM_RATIO = 0.5;

/**
 * The tightest the camera ever zooms.
 *
 * Reached in a corner exchange: `minSeparation` is 40 units, which wants a view
 * of 1000 world pixels and therefore a scale of 0.96, and going that tight
 * makes a clinch fill the frame with two sprites and no stage. 0.9 keeps the
 * exchange bigger than the neutral game -- which is what a fighting-game camera
 * is *for* -- without losing the ground either fighter is standing on.
 *
 * The loose end is not a constant: it is the scale at which the whole stage
 * exactly fills the frame (`minScaleFor` below). Writing it down as a second
 * number would let the two drift, and a camera zoomed looser than its own stage
 * shows dead space beyond the margin it just promised to stay inside.
 */
export const CAMERA_MAX_SCALE = 0.9;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * One arena position in world pixels.
 *
 * Lifted out of `renderer.ts`'s `interpolatedX` unchanged, including the
 * degenerate-arena guard: a config with `arenaMin === arenaMax` would divide by
 * zero and put every fighter at `NaN`, which paints nothing and reads as a blank
 * canvas rather than as a bad config. `assertIntegerConfig` rejects such a
 * config upstream; this is belt and braces for a hand-built one.
 */
export function worldXFor(
  units: number,
  config: Pick<FighterConfig, 'arenaMin' | 'arenaMax'>,
  viewport: Viewport,
): number {
  const span = config.arenaMax - config.arenaMin;
  if (span <= 0) {
    return viewport.width / 2;
  }
  return ((units - config.arenaMin) / span) * viewport.width;
}

/** The scale at which the stage -- arena plus both margins -- exactly fills the frame. */
function minScaleFor(): number {
  return 1 / (1 + STAGE_MARGIN_RATIO * 2);
}

/**
 * The camera for one drawn frame.
 *
 * Three behaviours, in the priority order the story sets:
 *
 * 1. **Follow.** The centre is the midpoint between the two fighters.
 * 2. **Clamp.** The centre is pulled back so the view never leaves the stage,
 *    which is the arena plus `STAGE_MARGIN_RATIO` of it at each end. A fighter
 *    on either wall is therefore drawn whole, and the camera *stops* at the
 *    stage edge rather than continuing to chase a midpoint past it.
 * 3. **Zoom.** The view widens with the pair's separation and tightens as they
 *    close, bounded at both ends.
 *
 * The two ratios are equal on purpose, and that is what makes the clamp total:
 * the view wanted is `separation + 2 * margin` and the stage is
 * `arenaWidth + 2 * margin`, so as long as the two fighters are inside the
 * arena the view is never wider than the stage and the clamp always has an
 * interval to work in. The degenerate branch below is reachable only through a
 * hand-built config, and centring the stage is the honest answer there.
 *
 * Positions arrive in **arena units** rather than world pixels so that the
 * arena-to-pixel mapping lives in exactly one place. Both are interpolated by
 * the caller, which is where the smoothing comes from.
 */
export function cameraFor(
  fighterAUnits: number,
  fighterBUnits: number,
  viewport: Viewport,
  config: Pick<FighterConfig, 'arenaMin' | 'arenaMax'>,
): Camera {
  const worldA = worldXFor(fighterAUnits, config, viewport);
  const worldB = worldXFor(fighterBUnits, config, viewport);

  // A non-finite position is a bad frame, not a camera decision. Falling
  // through would put `NaN` into `ctx.scale`, which silently blanks the whole
  // arena; a neutral 1:1 camera at least draws whatever the artists produce.
  if (!Number.isFinite(worldA) || !Number.isFinite(worldB) || viewport.width <= 0) {
    return Object.freeze({ x: viewport.width / 2, scale: 1 });
  }

  const margin = viewport.width * STAGE_MARGIN_RATIO;
  const headroom = viewport.width * HEADROOM_RATIO;
  const stageLeft = -margin;
  const stageRight = viewport.width + margin;

  const separation = Math.abs(worldA - worldB);
  const scale = clamp(
    viewport.width / (separation + headroom * 2),
    minScaleFor(),
    CAMERA_MAX_SCALE,
  );

  const halfView = viewport.width / (2 * scale);
  const low = stageLeft + halfView;
  const high = stageRight - halfView;
  const midpoint = (worldA + worldB) / 2;

  return Object.freeze({
    x: low > high ? (stageLeft + stageRight) / 2 : clamp(midpoint, low, high),
    scale,
  });
}

/**
 * Puts the surface into world space for the caller's next draws.
 *
 * The caller owns the `save`/`restore` pair, because the arena is drawn in the
 * middle of a sequence that is screen-space on both sides of it -- the backdrop
 * and floor under it, the HUD over it -- and a helper that saved and restored
 * around a callback would either hide that split or invert it.
 *
 * Anchored on the **floor line**, not on the centre of the frame: a zoom about
 * the centre would slide the ground up and down the canvas as the fighters
 * closed, and the one thing in a fighting game that must never move is the
 * floor. `groundY` therefore maps to itself at every scale, and the HUD's
 * screen-space coordinates are untouched because the HUD is drawn outside this
 * transform entirely.
 *
 * Only `translate` and `scale` are used. Both are already on the `Canvas2D`
 * port and both are honoured by `hero/raster.ts`, which is the second real
 * implementation of that port -- a camera that only worked in the browser would
 * silently fork the README hero from the player.
 */
export function applyCamera(
  ctx: Canvas2D,
  camera: Camera,
  viewport: Viewport,
  groundY: number,
): void {
  ctx.translate(viewport.width / 2, groundY);
  ctx.scale(camera.scale, camera.scale);
  ctx.translate(-camera.x, -groundY);
}
