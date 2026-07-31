import type { FighterConfig } from '../../../../packages/env-fighter/src/config';
import { phaseOf } from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import { animationFor, isFree } from './animation';
import type { Backdrop } from './backdrop';
import type { Canvas2D } from './canvas2d';
import { createBlockArtist, type DrawnFighter, type FighterArtist } from './artist';
import { THEME, type Theme } from './theme';

/**
 * Story 4.1: drawing one film frame.
 *
 * Pure, and that is the point: `drawFrame` takes a state pair and a surface
 * and issues a fixed sequence of calls. It holds no state between frames, so
 * the same frame drawn twice produces the same calls, and a test can assert
 * the whole sequence against a recording fake with no DOM in sight.
 *
 * **No clock is read here or anywhere below it.** Which frame to draw is the
 * caller's decision, and the caller (`player/clock.ts`) decides it by counting
 * callbacks rather than by measuring time (INV-3, AC3).
 */

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface DrawFrameOptions {
  readonly config: FighterConfig;
  readonly viewport: Viewport;
  readonly theme?: Theme;
  /**
   * One artist per agent index. Each fighter gets its own sprite pack so a
   * viewer can tell them apart by silhouette rather than by reading a health
   * bar. A single entry is applied to both; none falls back to the block
   * artist, which is what keeps the player working with no art at all.
   */
  readonly artists?: readonly FighterArtist[];
  /** Scenery behind the fighters. Absent leaves the flat ground colour. */
  readonly backdrop?: Backdrop;
}

/**
 * Arena floor sits this far above the bottom edge.
 *
 * Small on purpose. The first draft left 72px of empty ground below the
 * fighters and a 540-tall arena above them, so two thirds of the stage was
 * black -- which reads as an unfinished layout rather than as space. A
 * fighting-game viewport is wide and short.
 */
const FLOOR_INSET = 40;
/** Health and meter bars live in this band at the top. */
const HUD_TOP = 24;
const HUD_BAR_HEIGHT = 20;
const HUD_BAR_WIDTH = 320;
const HUD_SIDE_INSET = 32;
const METER_HEIGHT = 10;
const METER_GAP = 8;

/**
 * Interpolates one fighter's arena position between two simulated states.
 *
 * This is the only float in the player, and it goes no further than the pixel
 * handed to the canvas. `progressBasisPoints` is an integer 0..9999 and the
 * simulated positions are integers; the product is divided out here and
 * nothing reads the result back.
 *
 * Position is the only field interpolated. Health, meter and phase step, which
 * is both correct -- damage is applied at a Decision Point, not spread across
 * it -- and consistent with the house style's stepped motion.
 */
function interpolatedX(
  from: FighterState,
  to: FighterState,
  agentIndex: 0 | 1,
  progressBasisPoints: number,
  config: FighterConfig,
  viewport: Viewport,
): number {
  const fromUnits = from.position[agentIndex];
  const toUnits = to.position[agentIndex];
  const units = fromUnits + ((toUnits - fromUnits) * progressBasisPoints) / BASIS_POINTS_FULL;

  const span = config.arenaMax - config.arenaMin;
  // A degenerate arena (min === max) would divide by zero and put both
  // fighters at NaN, which paints nothing and looks like a blank canvas bug.
  // Centre them instead; `assertIntegerConfig` already rejects such a config
  // upstream, so this is belt-and-braces for a hand-built one.
  if (span <= 0) {
    return viewport.width / 2;
  }
  return ((units - config.arenaMin) / span) * viewport.width;
}

/** Draws one bar: hard shadow, flat fill, ink border. No radius, no gradient. */
function drawBar(
  ctx: Canvas2D,
  theme: Theme,
  x: number,
  y: number,
  width: number,
  height: number,
  filledFraction: number,
  fill: string,
): void {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(x, y, width, height);

  const clamped = Math.max(0, Math.min(1, filledFraction));
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width * clamped, height);

  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = theme.borderWidth;
  ctx.strokeRect(x, y, width, height);
}

/**
 * Draws one frame of the film.
 *
 * Order is fixed and asserted: clear, floor, both fighters, both HUD blocks.
 * Fighters are drawn before the HUD so a fighter can never occlude a health
 * bar, and the two fighters are drawn in agent-index order so overlapping
 * bodies stack predictably rather than by whoever happens to be in front.
 */
export function drawFrame(ctx: Canvas2D, frame: RenderFrame, options: DrawFrameOptions): void {
  const theme = options.theme ?? THEME;
  const fallbackArtist = createBlockArtist();
  const artistFor = (agentIndex: 0 | 1): FighterArtist =>
    options.artists?.[agentIndex] ?? options.artists?.[0] ?? fallbackArtist;
  const { config, viewport } = options;
  const groundY = viewport.height - FLOOR_INSET;

  ctx.clearRect(0, 0, viewport.width, viewport.height);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  options.backdrop?.draw(ctx, viewport.width, viewport.height, theme);

  // The floor is a solid rule, not a gradient horizon. `fillRect` rather than
  // `strokeRect`: stroking a 4px-tall box draws its two long edges and leaves a
  // hairline gap between them, which renders as a double line.
  ctx.fillStyle = theme.ink;
  ctx.fillRect(0, groundY, viewport.width, theme.borderWidth);

  const positions: readonly number[] = [0, 1].map((index) =>
    interpolatedX(
      frame.from,
      frame.to,
      index as 0 | 1,
      frame.progressBasisPoints,
      config,
      viewport,
    ),
  );

  for (const agentIndex of [0, 1] as const) {
    const phase = phaseOf(
      config,
      frame.from.committedAction[agentIndex],
      frame.from.commitmentRemaining[agentIndex],
    );

    const fighter: DrawnFighter = {
      x: positions[agentIndex],
      groundY,
      // Fighters always face each other; nothing in the simulation stores a
      // facing, because nothing in the simulation depends on one.
      facing: positions[agentIndex] <= positions[agentIndex === 0 ? 1 : 0] ? 1 : -1,
      phase,
      committedAction: frame.from.committedAction[agentIndex],
      agentIndex,
      // Every input is state the simulation already carries. `to` is the state
      // this Decision Point resolves into, so comparing it with `from` is how
      // "took damage" and "moved" are known without inventing either.
      animation: animationFor({
        committedAction: frame.from.committedAction[agentIndex],
        phase,
        health: frame.to.health[agentIndex],
        previousHealth: frame.from.health[agentIndex],
        movedUnits: frame.to.position[agentIndex] - frame.from.position[agentIndex],
        blocking:
          isFree(frame.from.committedAction[agentIndex]) &&
          frame.to.health[agentIndex] === frame.from.health[agentIndex] &&
          frame.to.position[agentIndex] === frame.from.position[agentIndex],
        frameIndex: frame.index,
      }),
    };
    artistFor(agentIndex).draw(ctx, fighter, theme);
  }

  for (const agentIndex of [0, 1] as const) {
    const x =
      agentIndex === 0 ? HUD_SIDE_INSET : viewport.width - HUD_SIDE_INSET - HUD_BAR_WIDTH;

    drawBar(
      ctx,
      theme,
      x,
      HUD_TOP,
      HUD_BAR_WIDTH,
      HUD_BAR_HEIGHT,
      frame.from.health[agentIndex] / config.initialHealth,
      agentIndex === 0 ? theme.accent : theme.warn,
    );

    drawBar(
      ctx,
      theme,
      x,
      HUD_TOP + HUD_BAR_HEIGHT + METER_GAP,
      HUD_BAR_WIDTH,
      METER_HEIGHT,
      frame.from.meter[agentIndex] / config.maxMeter,
      theme.ink,
    );

    ctx.fillStyle = theme.ink;
    ctx.font = theme.monoFont;
    ctx.textAlign = 'left';
    ctx.fillText(
      `HP ${String(frame.from.health[agentIndex])}  MTR ${String(frame.from.meter[agentIndex])}`,
      x,
      HUD_TOP + HUD_BAR_HEIGHT + METER_GAP + METER_HEIGHT + 20,
    );
  }

  ctx.fillStyle = theme.muted;
  ctx.font = theme.monoFont;
  ctx.textAlign = 'center';
  ctx.fillText(`TICK ${String(frame.from.tick)}`, viewport.width / 2, HUD_TOP + HUD_BAR_HEIGHT);
}
