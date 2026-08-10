import type { FighterConfig } from '../../../../packages/env-fighter/src/config';
import { COMMITTED_NONE, phaseOf } from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { BASIS_POINTS_FULL, type RenderFrame } from '../replay/film';
import type { BankReading } from '../replay/token-bank';
import { animationFor, isFree } from './animation';
import type { Backdrop } from './backdrop';
import { applyCamera, cameraFor, worldXFor, type Camera } from './camera';
import type { Canvas2D } from './canvas2d';
import { createBlockArtist, type DrawnFighter, type FighterArtist } from './artist';
import { ARENA_PALETTE } from './arena-palette';
import {
  ARMED_PULSE_BANDS,
  BANK_BANDS,
  SUPER_METER_BANDS,
  arcadeText,
  drawArcadeBar,
  drawArcadePip,
  drawArcadePlate,
  drawArcadeSegments,
  drawPortraitPlate,
  gradientBands,
  healthBands,
  pulseLevel,
  timerLabel,
} from './hud';
import { ROSTER_NAMES, auraFor, type RosterPair } from './roster';
import type { UltSheet } from './ult-sheet';
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
  /**
   * Story 11.3. Whether the viewer asked for less motion.
   *
   * A HUD *input*, threaded from the same `prefersReducedMotion(view)` read the
   * clock and the juice track already make, rather than a second read taken
   * here: a renderer that consulted `matchMedia` itself would be a renderer
   * that could not be drawn in a test, and would give the hero raster -- which
   * has no `window` at all -- a different answer from the page.
   *
   * Absent means "not reduced", which is what keeps every Story 4.1 assertion
   * describing what this function draws: omit it and the output is the
   * unreduced frame.
   */
  readonly reducedMotion?: boolean;
  /**
   * Story 12.6. Which fighter each agent index *is*, for the HUD's portrait and
   * name plate.
   *
   * Declared here as well as on `juice-draw.ts`'s `DrawJuicedFrameOptions`
   * because the two want it for different things -- the cinematic wants the
   * caster's aura and name, the HUD wants the name over both bars on every
   * frame -- and the compositor already hands `drawFrame` the very same options
   * object. Every live surface therefore gets a named HUD with no call-site
   * change at all; the two declarations are the same type and the drift is
   * `renderer.test.ts`'s to catch.
   *
   * Absent means "nobody has said", and the HUD then draws the plates with no
   * name rather than guessing a fighter -- the same degrade ladder the cinematic
   * uses. `hero/hero.ts` passes `DEFAULT_ROSTER`, which is what that constant is
   * for.
   */
  readonly roster?: RosterPair;
  /**
   * Story 12.6. Where the HUD's portraits come from.
   *
   * The Ultimate's sheet, reused rather than re-fetched. `/portraits/<id>.png`
   * is *already* loaded by `startup.ts` for the cinematic's cut-in, for exactly
   * the pair in play, and it is already threaded to all three surfaces --
   * fetching the same 200 KB file a second time under a second loader would be
   * the one cost this HUD is not worth.
   *
   * Absent until it decodes and absent forever if it never does, on the same
   * terms as `vfx`: the plate keeps its frame and its aura ground and the HUD
   * loses nothing but the face.
   */
  readonly ult?: UltSheet;
  /**
   * Story 12.6. Rounds won by each agent, for the pips.
   *
   * Optional, and absent is `[0, 0]` -- which is every surface today, because no
   * round system exists until Story 12.7. The pips are drawn empty rather than
   * not drawn (AC5), so the element that 12.7 fills is already in the layout and
   * does not relay the HUD when it arrives.
   */
  readonly roundsWon?: readonly [number, number];
}

/**
 * Arena floor sits this far above the bottom edge.
 *
 * Small on purpose. The first draft left 72px of empty ground below the
 * fighters and a 540-tall arena above them, so two thirds of the stage was
 * black -- which reads as an unfinished layout rather than as space. A
 * fighting-game viewport is wide and short.
 */
export const FLOOR_INSET = 40;

/**
 * ## The HUD band, laid out once (Story 12.6)
 *
 * Every row below is written down here rather than derived at a call site,
 * because the two defects this story fixes were both *layout* defects that no
 * unit test could see: `ULTIMATE READY` drawn at the gauge's own coordinates
 * (unreadable on flat gold) and the `HP … MTR …` readout sharing rows with a
 * bar. `hud-no-overlap` in `scripts/visual-gate.mjs` reads the same numbers from
 * the other side, and `renderer.test.ts` pins that the two copies agree.
 *
 * The band is one column per side plus a centre column:
 *
 * ```
 *  12..56   portrait plate                    timer plate       portrait plate
 *  18..36   NAME                    pip pip  [ 63 ]  pip pip              NAME
 *  40..58   health bar (ghost under)                       health bar
 *  62..78   super gauge / armed bar                    super gauge
 *  82..100  ULTIMATE READY                          ULTIMATE READY
 * 106..121  HP nn  MTR nn                              HP nn  MTR nn
 * 126..142  Token Bank                                    Token Bank
 * ```
 *
 * The callout moved **off** the gauge and the readout moved **below** the
 * gauge, which is what makes those two row spans disjoint. It costs 24px of
 * band height, and that is the trade the story asks for: a HUD that is one row
 * taller is worth a HUD whose two loudest elements are legible.
 */
/** Where the portrait plate and the timer plate sit, and how big they are. */
const HUD_PORTRAIT_TOP = 12;
const HUD_PORTRAIT_SIZE = 44;
/** The portrait's distance from the frame's outer edge. */
const HUD_PORTRAIT_INSET = 24;
/** Health and meter bars live in this band at the top. */
const HUD_TOP = 40;
const HUD_BAR_HEIGHT = 18;
const HUD_BAR_WIDTH = 328;
/**
 * Where a side's bar column starts, measured from the frame's outer edge.
 *
 * Wider than Story 4.1's 32 because the portrait now occupies the outer 24..68:
 * the bars begin where the portrait plate ends, with an 8px gutter.
 */
const HUD_SIDE_INSET = 76;
const METER_GAP = 8;
/** The fighter's name, on the arcade face, beside the portrait and above the bar. */
const HUD_NAME_BASELINE = 32;
/**
 * Story 10.3. The Super Gauge's height, raised from the 10px it shipped at.
 *
 * Ten pixels drew a hairline the width of the health bar, in `theme.ink` --
 * which is the colour every *border* and every *rule* on the canvas is drawn
 * in. It read as a divider between the health bar and the readout beneath it,
 * and a visitor had no reason to think it was a resource at all. Eighteen is
 * deliberately short of the health bar's twenty: the gauge is a second thing
 * being accumulated, not a second health bar, and it still leaves room for the
 * armed state's word at the mono face's real size.
 */
const METER_HEIGHT = 16;
const METER_TOP = HUD_TOP + HUD_BAR_HEIGHT + 4;
/**
 * The Super Gauge's four skewed segments, and the gap between them.
 *
 * Four is the reference's `SUP_SEGS` (`<REF>/game_source/js/screens.js:2460`).
 * The gap is eight rather than the reference's own value because the arithmetic
 * has to come out whole: `(320 - 3 * 8) / 4` is exactly 74, and a segment width
 * with a fraction in it puts every segment after the first on a half-pixel,
 * which a canvas antialiases into a blur.
 *
 * Story 10.3's `ARMED_PULSE_FRAMES` used to sit here, and its docblock named
 * this story as the place the pulse would be reconsidered. It was: the blink is
 * now `hud.ts`'s `pulseLevel` over `ARMED_PULSE_HOLD_FRAMES`, a three-colour
 * triangle rather than a border swap, and it moved to the module that owns the
 * colours it cycles through.
 */
const METER_SEGMENTS = 4;
const METER_SEGMENT_GAP = 8;
/**
 * Baseline of the armed callout, in its **own** rows under the gauge (Story 12.6).
 *
 * Story 11.3 drew `ULTIMATE READY` at `METER_TOP + METER_HEIGHT - borderWidth`,
 * which is *inside* the gauge, and Story 12.1's gate photographed the result:
 * `arcadeText` separates type from a dark ground by drawing a `hudPlate` shadow
 * under it, and the armed gauge at pulse level 2 is flat arcade gold -- the one
 * background that treatment cannot survive. The word was unreadable.
 *
 * Moving it below the gauge is the whole fix, and it also changes the callout's
 * colour: on the arena ground, ground-coloured ink would be invisible, so the
 * callout is now `ARENA_PALETTE.gold` on `--tb-bg` at a measured **13.74:1**
 * (see this story's Visual check finding). The gauge under it is gold too, which
 * is what keeps the callout reading as *that gauge's* word.
 */
const HUD_CALLOUT_BASELINE = METER_TOP + METER_HEIGHT + 18;
/** Baseline of the `HP … MTR …` readout, in its own rows under the callout. */
const HUD_LABEL_BASELINE = HUD_CALLOUT_BASELINE + 22;
/**
 * Story 4.4. The Token Bank sits at the bottom of the same stack, under health,
 * meter and their readout -- the two resources a fighter spends, then the one
 * it thinks with, in one column beside each fighter.
 *
 * Given the same height as the health bar deliberately: the story asks a
 * visitor with no context to *notice* this meter, and a resource drawn thinner
 * than the two beside it reads as a footnote to them rather than as a third
 * thing being spent.
 */
const BANK_HEIGHT = HUD_BAR_HEIGHT;
const BANK_TOP = HUD_LABEL_BASELINE + METER_GAP;
/**
 * The first row of pixels below every HUD block (Story 10.4).
 *
 * Derived rather than written down, so a later story that grows the gauge
 * again -- 10.3 has already done it once -- moves everything hung beneath the
 * HUD with it instead of leaving the cinematic's banner overlapping a Token
 * Bank that quietly got taller.
 */
export const HUD_BOTTOM = BANK_TOP + BANK_HEIGHT;

/**
 * The centre column: the round timer and the round pips (Story 12.6).
 *
 * Sized to fit the gutter the two bar columns leave. At the 960px arena the left
 * column ends at 404 and the right begins at 556, so the timer plate takes
 * 450..510 and each side's pips take 30px of the 46px that remain beside it --
 * the pips flank the timer the way the reference's diamonds do, and the fighter
 * whose pips they are is the fighter on that side.
 */
const TIMER_WIDTH = 60;
const TIMER_TOP = HUD_PORTRAIT_TOP;
const TIMER_HEIGHT = HUD_PORTRAIT_SIZE;
/** Baseline of the two digits inside the plate. */
const TIMER_BASELINE = TIMER_TOP + 30;
/**
 * How many rounds a side must win, and therefore how many pips it shows.
 *
 * Two, which is best-of-three -- the set Story 12.7 will actually run. Drawing
 * them here rather than there is deliberate: the HUD's layout is settled in one
 * story, and a story that adds an element to a finished HUD relays it out.
 */
export const ROUND_PIPS_PER_SIDE = 2;
const PIP_SIZE = 12;
const PIP_GAP = 6;
/** Gap between the timer plate and the nearest pip. */
const PIP_INSET = 8;
const PIP_GROUP_WIDTH = ROUND_PIPS_PER_SIDE * PIP_SIZE + (ROUND_PIPS_PER_SIDE - 1) * PIP_GAP;
const PIP_TOP = TIMER_TOP + Math.floor((TIMER_HEIGHT - PIP_SIZE) / 2);

/**
 * ## The band, published for the gate (Story 12.6)
 *
 * `scripts/visual-gate.mjs` samples ink in the boxes below and asserts the row
 * spans below are disjoint, and it cannot import a `.ts` module -- it is
 * dependency-free ESM run straight by Node, the same reason it duplicates
 * `SCREEN_ROUTES` and `ARENA_TOP_PX`. So the numbers are published here and
 * copied there, and `renderer.test.ts` reads the gate's copy off disk and pins
 * the two together. A layout edit that moved a bar and left the gate sampling
 * empty rows would otherwise report a HUD element as missing, or -- worse --
 * report a moved one as present.
 *
 * A text row span is the baseline's band, not the glyph's exact extent: a
 * `fillText` reports no metrics through this port and the whole point of these
 * numbers is that two elements cannot claim the same rows. Sixteen above the
 * baseline and four below is the arcade face's box at 16px; fourteen and four
 * is the mono face's at 14px. Both are generous in the direction that matters.
 */
export interface HudRowSpan {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

/** Rows above the baseline an `arcadeFont` string can claim, and rows below it. */
const ARCADE_ASCENT = 16;
const ARCADE_DESCENT = 4;
/** The same, for `monoFont` readouts. */
const MONO_ASCENT = 14;
const MONO_DESCENT = 4;

export const HUD_ROW_SPANS: readonly HudRowSpan[] = Object.freeze([
  Object.freeze({
    id: 'name',
    top: HUD_NAME_BASELINE - ARCADE_ASCENT,
    bottom: HUD_NAME_BASELINE + ARCADE_DESCENT,
  }),
  Object.freeze({ id: 'health', top: HUD_TOP, bottom: HUD_TOP + HUD_BAR_HEIGHT }),
  Object.freeze({ id: 'gauge', top: METER_TOP, bottom: METER_TOP + METER_HEIGHT }),
  Object.freeze({
    id: 'callout',
    top: HUD_CALLOUT_BASELINE - ARCADE_ASCENT,
    bottom: HUD_CALLOUT_BASELINE + ARCADE_DESCENT,
  }),
  Object.freeze({
    id: 'readout',
    top: HUD_LABEL_BASELINE - MONO_ASCENT,
    bottom: HUD_LABEL_BASELINE + MONO_DESCENT,
  }),
  Object.freeze({ id: 'bank', top: BANK_TOP, bottom: BANK_TOP + BANK_HEIGHT }),
]);

/** One sampling box in the HUD band, in backbuffer pixels. */
export interface HudRegion {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The boxes `hud-has-all-five` samples: the four per-side elements and the two
 * at centre.
 *
 * Derived from the same constants the drawing uses, never written twice. A name
 * box is deliberately shorter than the bar it sits over -- the longest plate is
 * `ULTIMATE` at six characters and the box only has to contain *some* of it for
 * an ink sample to be non-empty, while a box the full width of the bar would
 * find the bar's own frame and report ink for a name that never drew.
 */
export function hudRegions(viewport: Viewport): readonly HudRegion[] {
  const centre = Math.round(viewport.width / 2);
  const timerLeft = centre - Math.floor(TIMER_WIDTH / 2);
  const nameWidth = 160;

  const perSide: readonly HudRegion[] = [0, 1].flatMap((agentIndex): readonly HudRegion[] => {
      const mirror = agentIndex === 1;
      const columnLeft = mirror ? viewport.width - HUD_SIDE_INSET - HUD_BAR_WIDTH : HUD_SIDE_INSET;
      const side = `p${String(agentIndex + 1)}`;
      return [
        Object.freeze({
          id: `${side}-portrait`,
          x: mirror ? viewport.width - HUD_PORTRAIT_INSET - HUD_PORTRAIT_SIZE : HUD_PORTRAIT_INSET,
          y: HUD_PORTRAIT_TOP,
          width: HUD_PORTRAIT_SIZE,
          height: HUD_PORTRAIT_SIZE,
        }),
        Object.freeze({
          id: `${side}-name`,
          x: mirror ? columnLeft + HUD_BAR_WIDTH - nameWidth : columnLeft,
          y: HUD_NAME_BASELINE - ARCADE_ASCENT,
          width: nameWidth,
          height: ARCADE_ASCENT + ARCADE_DESCENT,
        }),
        Object.freeze({
          id: `${side}-health`,
          x: columnLeft,
          y: HUD_TOP,
          width: HUD_BAR_WIDTH,
          height: HUD_BAR_HEIGHT,
        }),
        Object.freeze({
          id: `${side}-meter`,
          x: columnLeft,
          y: METER_TOP,
          width: HUD_BAR_WIDTH,
          height: METER_HEIGHT,
        }),
        // One box per side rather than one spanning the timer. A single box
        // across the middle would find the timer plate's frame and report ink
        // for pips that never drew, which is the shape of a check that cannot
        // fail -- and "an element is present" is precisely what this samples.
        Object.freeze({
          id: `${side}-pips`,
          x: mirror
            ? timerLeft + TIMER_WIDTH + PIP_INSET
            : timerLeft - PIP_INSET - PIP_GROUP_WIDTH,
          y: PIP_TOP,
          width: PIP_GROUP_WIDTH,
          height: PIP_SIZE,
        }),
      ];
  });

  return Object.freeze([
    ...perSide,
    Object.freeze({
      id: 'timer',
      x: timerLeft,
      y: TIMER_TOP,
      width: TIMER_WIDTH,
      height: TIMER_HEIGHT,
    }),
  ]);
}

/**
 * Interpolates one fighter's arena position between two simulated states, in
 * arena units.
 *
 * This is the only float in the player, and it goes no further than the pixel
 * handed to the canvas. `progressBasisPoints` is an integer 0..9999 and the
 * simulated positions are integers; the product is divided out here and
 * nothing reads the result back.
 *
 * Position is the only field interpolated. Health, meter and phase step, which
 * is both correct -- damage is applied at a Decision Point, not spread across
 * it -- and consistent with the house style's stepped motion.
 *
 * Story 12.3 split this in two. It used to return a pixel; the camera needs the
 * *unit*, because the arena-to-pixel mapping is now `camera.ts`'s and lives in
 * exactly one place. The composition below is the old function, unchanged.
 */
function interpolatedUnits(
  from: FighterState,
  to: FighterState,
  agentIndex: 0 | 1,
  progressBasisPoints: number,
): number {
  const fromUnits = from.position[agentIndex];
  const toUnits = to.position[agentIndex];
  return fromUnits + ((toUnits - fromUnits) * progressBasisPoints) / BASIS_POINTS_FULL;
}

function interpolatedX(
  from: FighterState,
  to: FighterState,
  agentIndex: 0 | 1,
  progressBasisPoints: number,
  config: FighterConfig,
  viewport: Viewport,
): number {
  return worldXFor(
    interpolatedUnits(from, to, agentIndex, progressBasisPoints),
    config,
    viewport,
  );
}

/**
 * The camera for one film frame (Story 12.3).
 *
 * Exported because two files draw into the arena and both must agree: this
 * module draws the fighters, and `juice-draw.ts` draws the sparks, the impact
 * art and the Ultimate's stage on top of them. A second, separately-derived
 * camera in the compositor is how an impact ends up landing where the fighter
 * *used to be* drawn, so both call this.
 *
 * Pure over the frame, exactly like `liveWindow` and `ticksIntoDecision` above
 * it: a scrub to frame 90 gets the camera a play-through reaching frame 90 gets.
 */
export function cameraForFrame(
  frame: RenderFrame,
  config: FighterConfig,
  viewport: Viewport,
): Camera {
  return cameraFor(
    interpolatedUnits(frame.from, frame.to, 0, frame.progressBasisPoints),
    interpolatedUnits(frame.from, frame.to, 1, frame.progressBasisPoints),
    viewport,
    config,
  );
}

/** Screen y of the arena floor. The camera's anchor, and the HUD's lower bound. */
export function groundYFor(viewport: Viewport): number {
  return viewport.height - FLOOR_INSET;
}

/** The Commitment Window a fighter is inside partway through a Decision Point. */
export interface LiveWindow {
  readonly committedAction: number;
  readonly remaining: number;
}

/**
 * Ticks elapsed within this Decision Point at this film frame.
 *
 * Extracted and exported for Story 10.4. The juice layer has to answer the
 * same question this file already answers -- *which phase is this fighter's
 * Commitment Window in, right now* -- in order to find the film frame an
 * Ultimate goes active on, and the reconstruction below is subtle enough
 * (see `liveWindow`'s docblock) that a second copy of it in `juice.ts` would
 * be a second thing to keep correct. Presentation arithmetic over state the
 * simulation already produced: no clock, no feedback, no hash (AD-15).
 */
export function ticksIntoDecision(frame: RenderFrame, config: FighterConfig): number {
  return Math.floor((frame.progressBasisPoints * config.ticksPerDecision) / BASIS_POINTS_FULL);
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
export function liveWindow(
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

/**
 * A level as basis points of a total, clamped, and never `NaN`.
 *
 * The degenerate cases are the point. `initialHealth <= 0` or `maxMeter <= 0`
 * is a hand-built config -- `assertIntegerConfig` rejects one upstream -- and
 * the honest failure for a bar is to clamp to empty. Dividing anyway would put
 * an `Infinity` or a `NaN` into a `fillRect` width, which paints nothing and
 * reads as a HUD block that silently stopped being drawn.
 */
function levelBasisPoints(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(BASIS_POINTS_FULL, Math.round((value * BASIS_POINTS_FULL) / total)));
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
 *
 * **Story 11.3 keeps the inversion and gives it the arcade geometry.** The
 * exhausted state is still a solid `--tb-warn` block carrying the word REFLEX
 * in ground ink -- that pairing is measured (`--tb-warn` on `--tb-bg` is
 * 4.26:1 and misses the text floor; the other way round it does not) and the
 * page has already taught a viewer what an inverted filled bar means. What
 * changes is that it is now the same skewed, bevelled, framed bar as the two
 * above it, filled edge to edge, rather than a square block sitting under two
 * parallelograms. The warn "ramp" is both stops of one colour, which is a flat
 * fill expressed in the same vocabulary rather than a special case in the bar.
 */
function drawTokenBank(
  ctx: Canvas2D,
  theme: Theme,
  x: number,
  mirror: boolean,
  reading: BankReading,
): void {
  const exhausted = reading.exhausted;
  drawArcadeBar(ctx, {
    x,
    y: BANK_TOP,
    width: HUD_BAR_WIDTH,
    height: BANK_HEIGHT,
    mirror,
    fillBasisPoints: exhausted ? BASIS_POINTS_FULL : reading.filledBasisPoints,
    ghostBasisPoints: 0,
    // Built here rather than exported from `hud.ts`, because the colour is the
    // *theme's* and `hud.ts` holds no theme: the arena palette is where arena
    // colour lives, and warn is a brand token doing a brand token's job.
    bands: exhausted ? gradientBands({ from: theme.warn, to: theme.warn }) : BANK_BANDS,
  });

  const baseline = BANK_TOP + BANK_HEIGHT - theme.borderWidth;
  if (exhausted) {
    // A callout, so it takes the arcade treatment. The number beside it is not,
    // and stays on the mono face in the same string it always shared.
    arcadeText(ctx, theme, 'REFLEX  BANK 0', x + METER_GAP, baseline, 'left', theme.bg);
    return;
  }

  ctx.fillStyle = theme.ink;
  ctx.font = theme.monoFont;
  ctx.textAlign = 'left';
  ctx.fillText(`BANK ${String(reading.remaining)}`, x + METER_GAP, baseline);
}

/**
 * Draws the Super Gauge for one fighter (Story 10.3, redrawn by 11.3).
 *
 * Two states, and the whole story is still that they are *two*. Charging is
 * four skewed segments on the reference's cyan ramp, each filling in turn, so
 * the gauge reads as *how many chunks are lit* at five Decision Points a second
 * rather than as an edge somewhere along a rail. Armed, every segment is gold
 * and the whole bar breathes through three enumerated ramps while ULTIMATE
 * READY sits on it in the arcade treatment.
 *
 * Story 10.3 armed the gauge by inverting it to a `--tb-warn` block with an
 * ink/accent border swap, and said so at length: warn-as-fill was the loudest
 * thing the flat palette allowed, and a border swap was the only pulse the
 * house style left available. Both of those were consequences of rules Story
 * 11.1 has since scoped to the page. Gold is what the reference arms with, it
 * is now legal here, and it says *afford* rather than *alarm* -- which is the
 * true statement about a meter that has finished charging.
 *
 * The threshold read is `specialMeterCost`, not `maxMeter`, because
 * ULTIMATE READY is a claim about the Action being legal and `specialMeterCost`
 * is the number `legalActionsFor` actually gates on -- reading the same field is
 * what stops the HUD asserting something the simulation would refuse. Story
 * 10.2 set the two equal, so under the shipped config the gauge arms at exactly
 * full and at no other value; a later story that lowers the cost gets a gauge
 * that still tells the truth rather than one that goes quietly out of date.
 *
 * Nothing here is a duration. The pulse counts `frame.index` and the level is
 * read off state the simulation already produced, so the gauge is a pure
 * function of the frame (INV-1, INV-3, AD-15). No `packages/` value is written,
 * and no Final-State Hash can move because of anything in this function.
 */
function drawSuperGauge(
  ctx: Canvas2D,
  theme: Theme,
  x: number,
  mirror: boolean,
  meter: number,
  config: FighterConfig,
  frameIndex: number,
  reducedMotion: boolean,
): void {
  const armed = meter >= config.specialMeterCost;

  if (armed) {
    // **One bar, not four.** The reference segments the meter while it charges
    // and turns *the whole bar* gold at full (`screens.js:2460-2472`), and
    // following it that far turns out to matter for more than fidelity: this
    // story's own visual gate found ULTIMATE READY drawn across four gapped
    // segments, with the gaps cutting through the letters. At the size the
    // canvas actually renders at -- scaled to its column, not 1:1 -- the word
    // degraded to mush.
    //
    // Filling solid fixes the callout's ground and sharpens AC2 at the same
    // time: charging and armed are now different *shapes*, not the same shape
    // in two colours, which is a distinction that survives being glanced at.
    drawArcadeBar(ctx, {
      x,
      y: METER_TOP,
      width: HUD_BAR_WIDTH,
      height: METER_HEIGHT,
      mirror,
      fillBasisPoints: BASIS_POINTS_FULL,
      ghostBasisPoints: 0,
      bands: ARMED_PULSE_BANDS[pulseLevel(frameIndex, reducedMotion)],
    });
  } else {
    drawArcadeSegments(ctx, {
      x,
      y: METER_TOP,
      width: HUD_BAR_WIDTH,
      height: METER_HEIGHT,
      mirror,
      count: METER_SEGMENTS,
      gap: METER_SEGMENT_GAP,
      fillBasisPoints: levelBasisPoints(meter, config.maxMeter),
      bands: SUPER_METER_BANDS,
    });
  }

  if (armed) {
    // **Under the gauge, not on it, and gold rather than ground ink** (Story
    // 12.6). Story 11.3 put ground ink on the gold fill, which is the direction
    // `docs/DESIGN.md` requires of a warn pairing -- and it was the wrong
    // reading here, because `arcadeText` also draws a `hudPlate` hard shadow
    // and flat gold is the one background that treatment cannot separate from.
    // Story 12.1's gate photographed the result and called it unreadable.
    //
    // Off the bar the ground is `--tb-bg`, where gold measures 13.74:1 -- well
    // clear of the 4.5:1 floor that `docs/DESIGN.md`'s "Two regimes" says canvas
    // *text* keeps even though the arena's fills are released from it. The
    // shadow now falls on the ground it was designed for.
    arcadeText(
      ctx,
      theme,
      'ULTIMATE READY',
      mirror ? x + HUD_BAR_WIDTH : x,
      HUD_CALLOUT_BASELINE,
      mirror ? 'right' : 'left',
      ARENA_PALETTE.gold,
    );
  }
}

/**
 * Draws one frame of the film.
 *
 * Order is fixed and asserted: clear, floor, both fighters, both HUD blocks.
 * Fighters are drawn before the HUD so a fighter can never occlude a health
 * bar, and the two fighters are drawn in agent-index order so overlapping
 * bodies stack predictably rather than by whoever happens to be in front.
 *
 * ## Two spaces, one function (Story 12.3)
 *
 * The fighters are drawn inside a camera transform and everything else is not.
 * The ground, the backdrop and the floor rule are screen space because they
 * span the frame whatever the camera is looking at; the HUD is screen space
 * because a health bar that slid with the fight would be unreadable. Only the
 * fighters' coordinates mean arena positions, so only they are transformed --
 * which is also why every coordinate assertion below still describes the same
 * numbers: the camera moves the *surface*, not the arithmetic.
 *
 * ## Why the live bars read `frame.to` (Story 11.3)
 *
 * The film samples the simulation at Decision Point boundaries, so `from` is
 * the state *before* this step's damage. Drawing it means the health bar falls
 * one whole Decision Point after the punch that caused it -- while
 * `animationFor` a few lines above already plays the hurt animation *during*
 * the step, because it derives "took damage" from `to.health !== from.health`.
 * The two were a Decision Point apart, and the one a viewer notices is the bar.
 *
 * Reading `to` puts the drop and the flinch on the same film frames, and it is
 * what gives the ghost something to recede *from*: the chip layer is the old
 * value easing to the new one across the same step. Health, meter and the
 * `HP … MTR …` readout all move together for that reason -- a readout a step
 * ahead of its own bar would be worse than either.
 *
 * This is presentation arithmetic over state the simulation already produced.
 * It reads no clock, feeds nothing back and changes no hash -- the same
 * standing as position interpolation (AD-15). `TICK` still reads `from.tick`,
 * because a tick counter is a statement about where playback *is*, not about
 * what this step resolves into.
 */
export function drawFrame(ctx: Canvas2D, frame: RenderFrame, options: DrawFrameOptions): void {
  const theme = options.theme ?? THEME;
  const reducedMotion = options.reducedMotion === true;
  const fallbackArtist = createBlockArtist();
  const artistFor = (agentIndex: 0 | 1): FighterArtist =>
    options.artists?.[agentIndex] ?? options.artists?.[0] ?? fallbackArtist;
  const { config, viewport } = options;
  const groundY = groundYFor(viewport);

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

  const ticksElapsed = ticksIntoDecision(frame, config);

  // Story 12.3. Everything above this line is screen space -- the ground fill,
  // the backdrop and the floor rule all span the frame however the camera is
  // pointed -- and everything below the matching `restore` is screen space
  // again, which is what keeps the HUD's coordinates untouched by any camera
  // value. Only the fighters live in world space, because they are the only
  // thing on this surface whose position means an arena position.
  ctx.save();
  applyCamera(ctx, cameraForFrame(frame, config, viewport), viewport, groundY);

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

  ctx.restore();

  for (const agentIndex of [0, 1] as const) {
    const x =
      agentIndex === 0 ? HUD_SIDE_INSET : viewport.width - HUD_SIDE_INSET - HUD_BAR_WIDTH;
    // p2's HUD is p1's reflected, which is what the reference's `mirror` flag
    // buys: the bars lean away from the centre and drain from the outer edge,
    // so the pair reads as two fighters facing each other rather than as one
    // panel drawn twice.
    const mirror = agentIndex === 1;

    // --- Story 12.6: who this side is ------------------------------------
    // Drawn before the bars, at the outer edge, so the reading order across the
    // band is face, name, health -- the reference's order and the order a
    // viewer glancing at the top of the screen needs it in.
    const fighter = options.roster?.[agentIndex];
    drawPortraitPlate(
      ctx,
      {
        x: mirror
          ? viewport.width - HUD_PORTRAIT_INSET - HUD_PORTRAIT_SIZE
          : HUD_PORTRAIT_INSET,
        y: HUD_PORTRAIT_TOP,
        width: HUD_PORTRAIT_SIZE,
        height: HUD_PORTRAIT_SIZE,
        // The fighter's own aura, which is what makes the plate say *whose side*
        // even on a surface whose portrait never decoded -- and on the hero
        // raster, where `drawImage` throws, it is the whole plate.
        fill: fighter === undefined ? ARENA_PALETTE.hudPlate : auraFor(fighter),
      },
      fighter === undefined ? undefined : options.ult?.portraitFor(fighter),
    );

    if (fighter !== undefined) {
      // Ink on the ground at 18.1:1, the ratio `docs/DESIGN.md` already records
      // for `--tb-ink` on `--tb-bg`. A name is type a visitor reads, so it
      // answers to the 4.5:1 floor whatever the arena's fills are released from.
      arcadeText(
        ctx,
        theme,
        ROSTER_NAMES[fighter],
        mirror ? x + HUD_BAR_WIDTH : x,
        HUD_NAME_BASELINE,
        mirror ? 'right' : 'left',
        theme.ink,
      );
    }

    const health = levelBasisPoints(frame.to.health[agentIndex], config.initialHealth);
    drawArcadeBar(ctx, {
      x,
      y: HUD_TOP,
      width: HUD_BAR_WIDTH,
      height: HUD_BAR_HEIGHT,
      mirror,
      fillBasisPoints: health,
      ghostBasisPoints: ghostBasisPoints(frame, agentIndex, config),
      bands: healthBands(health),
    });

    drawSuperGauge(
      ctx,
      theme,
      x,
      mirror,
      frame.to.meter[agentIndex],
      config,
      frame.index,
      reducedMotion,
    );

    // The numeric readout stays on the mono face. It is a *readout* -- the same
    // kind of thing as a tick count or a bank level -- and `docs/DESIGN.md`
    // reserves Departure Mono for every number a visitor reads as data. Only
    // the callouts (TICK, ULTIMATE READY, REFLEX) take the arcade treatment.
    //
    // Story 12.6 moved it below the gauge and mirrored its alignment. It used
    // to sit between the gauge and the Token Bank at a baseline 20px under the
    // gauge, close enough that the two shared rows once the mono face's real
    // ascent was accounted for -- which is the `HP 69 overlaps the bar below
    // it` defect Story 12.1's gate recorded. It now has rows of its own,
    // between the callout and the Bank, and `hud-no-overlap` measures that.
    ctx.fillStyle = theme.ink;
    ctx.font = theme.monoFont;
    ctx.textAlign = mirror ? 'right' : 'left';
    ctx.fillText(
      `HP ${String(frame.to.health[agentIndex])}  MTR ${String(frame.to.meter[agentIndex])}`,
      mirror ? x + HUD_BAR_WIDTH : x,
      HUD_LABEL_BASELINE,
    );

    // Only for an Agent that has one. A Baseline Bot spends no tokens, records
    // no `bankRemaining`, and must show no meter at all -- a bot with a
    // full-looking Token Bank would misrepresent what is being measured (AC3).
    const bank = options.banks?.[agentIndex];
    if (bank != null) {
      drawTokenBank(ctx, theme, x, mirror, bank);
    }
  }

  drawCentreColumn(ctx, theme, frame, options);
}

/**
 * The round timer and the round pips (Story 12.6).
 *
 * Screen space, at the centre of the frame, outside Story 12.3's camera
 * transform: the timer is a fact about the Match rather than about where the
 * camera is pointed, and a set score that slid with the fight would be
 * unreadable.
 *
 * **The timer is not a clock.** `timerLabel` maps `maxTicks - tick` onto two
 * digits by integer arithmetic and reads nothing else -- no `Date`, no
 * `performance.now()`, no frame rate. Scrubbing to a frame shows what playing to
 * it shows, and how long a Deployment thought cannot reach it (INV-1, INV-3).
 *
 * `TICK` survives underneath as the data readout it always was. It moved off the
 * bar row it shared with the health bars and onto the callout row, where it has
 * the centre gutter to itself.
 */
function drawCentreColumn(
  ctx: Canvas2D,
  theme: Theme,
  frame: RenderFrame,
  options: DrawFrameOptions,
): void {
  const centre = Math.round(options.viewport.width / 2);
  const timerLeft = centre - Math.floor(TIMER_WIDTH / 2);

  drawArcadePlate(ctx, {
    x: timerLeft,
    y: TIMER_TOP,
    width: TIMER_WIDTH,
    height: TIMER_HEIGHT,
    fill: ARENA_PALETTE.hudPlate,
  });
  // Gold on `hudPlate` at 13.73:1. The plate is the darkest value in the arena
  // palette and the digits are the one number a viewer reads at a glance rather
  // than measures, so they take the callout's colour rather than the readout's.
  arcadeText(
    ctx,
    theme,
    timerLabel(frame.from.tick, options.config.maxTicks),
    centre,
    TIMER_BASELINE,
    'center',
    ARENA_PALETTE.gold,
  );

  // A side's pips flank the timer on that side's own half, so "who is winning
  // the set" is answered in the same left/right language the bars use.
  const rounds = options.roundsWon ?? [0, 0];
  for (const agentIndex of [0, 1] as const) {
    const groupLeft =
      agentIndex === 0
        ? timerLeft - PIP_INSET - PIP_GROUP_WIDTH
        : timerLeft + TIMER_WIDTH + PIP_INSET;
    for (const pip of Array.from({ length: ROUND_PIPS_PER_SIDE }, (_unused, index) => index)) {
      drawArcadePip(
        ctx,
        groupLeft + pip * (PIP_SIZE + PIP_GAP),
        PIP_TOP,
        PIP_SIZE,
        pip < Math.max(0, Math.floor(rounds[agentIndex] ?? 0)),
      );
    }
  }

  arcadeText(
    ctx,
    theme,
    `TICK ${String(frame.from.tick)}`,
    centre,
    HUD_CALLOUT_BASELINE,
    'center',
    theme.muted,
  );
}

/**
 * The damage-lag ghost's level, in basis points of starting health.
 *
 * `from.health` eased linearly to `to.health` across `progressBasisPoints`. At
 * the start of a Decision Point the ghost stands at the health the fighter had
 * before the step's damage; by the end it has caught the live bar up. A big hit
 * is therefore visible as a receding second bar rather than only as a number
 * changing, which is AC1.
 *
 * This is the pure replacement for the reference's `state.hudGhost`
 * (`<REF>/game_source/js/screens.js:2450`), which decays by a fixed 0.015 a
 * rendered frame out of a mutable module-level accumulator. That is one of the
 * four mechanisms `docs/DEV-REFERENCE.md` says may never come across: a stepped
 * accumulator cannot be scrubbed backwards, so Story 4.5's timeline would show
 * a ghost that depended on how the viewer arrived at the frame. An ease across
 * `progressBasisPoints` depends on the frame and nothing else.
 */
function ghostBasisPoints(
  frame: RenderFrame,
  agentIndex: 0 | 1,
  config: FighterConfig,
): number {
  const before = frame.from.health[agentIndex];
  const after = frame.to.health[agentIndex];
  const eased = before + ((after - before) * frame.progressBasisPoints) / BASIS_POINTS_FULL;
  return levelBasisPoints(eased, config.initialHealth);
}
