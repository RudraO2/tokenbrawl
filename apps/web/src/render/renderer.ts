import type { FighterConfig } from '../../../../packages/env-fighter/src/config';
import { COMMITTED_NONE, phaseOf } from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import type { BankReading } from '../replay/token-bank';
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
  /**
   * Story 4.4. One Token Bank reading per agent index, or `null` for an Agent
   * that has no bank -- a Baseline Bot consumes nothing and must show no meter.
   *
   * Optional so that every Story 4.1 renderer assertion still describes what
   * this function draws: omit it and the output is unchanged.
   */
  readonly banks?: readonly (BankReading | null)[];
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
/** Baseline of the `HP … MTR …` readout under the two simulation bars. */
const HUD_LABEL_BASELINE = HUD_TOP + HUD_BAR_HEIGHT + METER_GAP + METER_HEIGHT + 20;
/**
 * Story 4.4. The Token Bank sits at the bottom of the same stack, under health,
 * meter and their readout -- the two resources a fighter spends, then the one
 * it thinks with, in one column beside each fighter.
 */
const BANK_HEIGHT = 16;
const BANK_TOP = HUD_LABEL_BASELINE + METER_GAP;

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

/** The Commitment Window a fighter is inside partway through a Decision Point. */
interface LiveWindow {
  readonly committedAction: number;
  readonly remaining: number;
}

/**
 * Recovers the Commitment Window's *sub-Decision-Point* state, which is the
 * only way the strike is ever visible.
 *
 * The film samples the simulation at Decision Point boundaries, 30 ticks apart.
 * An `attack` window is 4 startup + 4 active + 32 recovery = 40 ticks and it
 * opens *at* a boundary, so by the next sample 10 ticks remain -- already deep
 * in recovery. The eight ticks in which the attack winds up and connects fall
 * strictly between two samples, and reading `from.commitmentRemaining`
 * directly means nothing ever observes them: a census over the demo Match
 * found `attack-startup` and `attack-active` played on zero of 360 playback
 * frames. The art was there, the clips were wired, and the swing was
 * unreachable. A viewer saw only the follow-through.
 *
 * So the window is reconstructed from whichever endpoint actually holds it and
 * wound forward by the ticks elapsed within this Decision Point. A window that
 * is open at `to` opened during this step, so at the step's start it held
 * `to.commitmentRemaining + ticksPerDecision`; one open only at `from` was
 * already running and expires during the step.
 *
 * This is presentation arithmetic over state the simulation already produced.
 * It reads no clock, feeds nothing back, and changes no hash -- the same
 * standing as position interpolation.
 */
function liveWindow(
  frame: RenderFrame,
  agentIndex: 0 | 1,
  config: FighterConfig,
  ticksElapsed: number,
): LiveWindow {
  const openedThisStep = frame.to.committedAction[agentIndex] !== COMMITTED_NONE;
  const committedAction = openedThisStep
    ? frame.to.committedAction[agentIndex]
    : frame.from.committedAction[agentIndex];

  if (committedAction === COMMITTED_NONE) {
    return { committedAction: COMMITTED_NONE, remaining: 0 };
  }

  const remainingAtStart = openedThisStep
    ? frame.to.commitmentRemaining[agentIndex] + config.ticksPerDecision
    : frame.from.commitmentRemaining[agentIndex];
  const remaining = remainingAtStart - ticksElapsed;

  // Expired partway through the step: the fighter is free for the rest of it.
  return remaining > 0 ? { committedAction, remaining } : { committedAction: COMMITTED_NONE, remaining: 0 };
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
 * Draws the Token Bank meter for one fighter (Story 4.4).
 *
 * The exhausted state is deliberately the loudest thing the palette allows,
 * because it is the moment the whole benchmark turns on: the bank empties,
 * Reflex Mode caps the next call at eight tokens, and the fighter starts making
 * instant, bad decisions. A bar that merely reached its left edge would pass
 * unnoticed at five Decision Points per second, so the meter inverts to a solid
 * `--tb-warn` block carrying the word REFLEX in ground ink -- the same
 * warn-as-fill pattern `docs/DESIGN.md` sanctions for warning text, and the one
 * pair in the palette that reads as an alarm.
 *
 * Nothing here is a duration. The bar is redrawn from a level the log recorded,
 * so two Matches with identical `bankRemaining` sequences produce identical
 * HUDs however long either Deployment took to think (INV-3).
 */
function drawTokenBank(
  ctx: Canvas2D,
  theme: Theme,
  x: number,
  reading: BankReading,
): void {
  if (reading.exhausted) {
    ctx.fillStyle = theme.warn;
    ctx.fillRect(x, BANK_TOP, HUD_BAR_WIDTH, BANK_HEIGHT);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = theme.borderWidth;
    ctx.strokeRect(x, BANK_TOP, HUD_BAR_WIDTH, BANK_HEIGHT);

    ctx.fillStyle = theme.bg;
    ctx.font = theme.monoFont;
    ctx.textAlign = 'left';
    ctx.fillText('REFLEX  BANK 0', x + METER_GAP, BANK_TOP + BANK_HEIGHT - theme.borderWidth);
    return;
  }

  drawBar(
    ctx,
    theme,
    x,
    BANK_TOP,
    HUD_BAR_WIDTH,
    BANK_HEIGHT,
    reading.filledBasisPoints / BASIS_POINTS_FULL,
    theme.muted,
  );

  ctx.fillStyle = theme.ink;
  ctx.font = theme.monoFont;
  ctx.textAlign = 'left';
  ctx.fillText(`BANK ${String(reading.remaining)}`, x + METER_GAP, BANK_TOP + BANK_HEIGHT - theme.borderWidth);
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

  const ticksElapsed = Math.floor(
    (frame.progressBasisPoints * config.ticksPerDecision) / BASIS_POINTS_FULL,
  );

  for (const agentIndex of [0, 1] as const) {
    const window = liveWindow(frame, agentIndex, config, ticksElapsed);
    const phase = phaseOf(config, window.committedAction, window.remaining);

    const fighter: DrawnFighter = {
      x: positions[agentIndex],
      groundY,
      // Fighters always face each other; nothing in the simulation stores a
      // facing, because nothing in the simulation depends on one.
      facing: positions[agentIndex] <= positions[agentIndex === 0 ? 1 : 0] ? 1 : -1,
      phase,
      committedAction: window.committedAction,
      agentIndex,
      // Every input is state the simulation already carries. `to` is the state
      // this Decision Point resolves into, so comparing it with `from` is how
      // "took damage" and "moved" are known without inventing either.
      animation: animationFor({
        committedAction: window.committedAction,
        phase,
        health: frame.to.health[agentIndex],
        previousHealth: frame.from.health[agentIndex],
        movedUnits: frame.to.position[agentIndex] - frame.from.position[agentIndex],
        blocking:
          isFree(window.committedAction) &&
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
      HUD_LABEL_BASELINE,
    );

    // Only for an Agent that has one. A Baseline Bot spends no tokens, records
    // no `bankRemaining`, and must show no meter at all -- a bot with a
    // full-looking Token Bank would misrepresent what is being measured (AC3).
    const bank = options.banks?.[agentIndex];
    if (bank != null) {
      drawTokenBank(ctx, theme, x, bank);
    }
  }

  ctx.fillStyle = theme.muted;
  ctx.font = theme.monoFont;
  ctx.textAlign = 'center';
  ctx.fillText(`TICK ${String(frame.from.tick)}`, viewport.width / 2, HUD_TOP + HUD_BAR_HEIGHT);
}
