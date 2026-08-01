import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { resolveDecision } from '../replay/decision-point';
import { buildReplayFilm, type RenderFrame } from '../replay/film';
import { createBankReadout } from '../replay/token-bank';
import { drawFrame } from '../render/renderer';
import { THEME } from '../render/theme';
import { encodeAnimatedGif, type GifFrame } from './gif';
import { GLYPH_SPACING, GLYPH_WIDTH } from './font';
import { createRasterSurface, type RasterSurface } from './raster';

/**
 * Story 7.4: the README hero.
 *
 * The arena is drawn by `drawFrame` -- the shipped renderer, the shipped theme,
 * the shipped film -- into a raster surface instead of a browser canvas. Under
 * it sits the one thing the player shows on hover and a still image cannot: the
 * reasoning for the Decision Point currently on screen.
 *
 * AC2 asks for a Token Bank draining and at least one reasoning excerpt. Both
 * come from the Match itself: the meter is `drawFrame`'s own (Story 4.4), and
 * the caption is the `reasoning` field of the Decision Point that governs the
 * fighter at this playback position, resolved by the same `resolveDecision`
 * the hover panel uses. Nothing here invents content the log does not carry.
 *
 * **No clock, anywhere.** The frame count is
 * `decisionPoints * FRAMES_PER_DECISION / HERO_FRAME_STRIDE` and the delay is a
 * constant, so a Match between two slow Deployments produces exactly the same
 * animation length as one between two fast ones (INV-3).
 */

export const HERO_WIDTH = 960;
/**
 * The arena viewport. `drawFrame` paints this region and nothing below it.
 *
 * Short on purpose, for the same reason `FLOOR_INSET` is: a fighting-game stage
 * is wide and shallow, and the first draft's 460 left a band of empty black
 * between the HUD and the fighters' heads that read as an unfinished layout.
 */
export const HERO_ARENA_HEIGHT = 400;
export const HERO_HEIGHT = 560;

/** Every Nth film frame is kept. The film is 60fps, so a stride of 5 is 12fps. */
export const HERO_FRAME_STRIDE = 5;
/** Hundredths of a second per GIF frame. Constant, and equal to the stride's cadence. */
export const HERO_DELAY_CENTISECONDS = 8;

/** The reasoning panel, in surface coordinates. */
const PANEL_LEFT = 24;
const PANEL_TOP = HERO_ARENA_HEIGHT + 16;
const PANEL_WIDTH = HERO_WIDTH - PANEL_LEFT * 2;
const PANEL_HEIGHT = 120;
const PANEL_PADDING = 12;
const LABEL_HEIGHT = 30;
/** Body text is `THEME.monoFont`, which the raster surface renders at scale 2. */
const BODY_SCALE = 2;
const BODY_LINE_HEIGHT = 22;
const CAPTION_LINES = 3;

/** Characters that fit across the panel at body scale. */
const CAPTION_COLUMNS = Math.floor(
  (PANEL_WIDTH - PANEL_PADDING * 2 + GLYPH_SPACING * BODY_SCALE) /
    ((GLYPH_WIDTH + GLYPH_SPACING) * BODY_SCALE),
);

/**
 * Said on every single frame, not in a footnote.
 *
 * The Match is real -- real engine, real frame data, real Token Bank debits,
 * real Command Log -- and the text a model would have produced is scripted,
 * because no provider credential exists in this repository. A hero that let a
 * reader assume otherwise would fail this story's own acceptance criterion
 * before the README was even read.
 */
export const STAND_IN_NOTICE = 'SCRIPTED - NOT A LIVE MODEL';

interface HeroDecision {
  readonly tick: number;
  readonly agentIndex: 0 | 1;
  readonly reasoning?: string | null;
  readonly rawResponse?: string | null;
  readonly bankRemaining?: number;
  readonly reflexMode?: boolean;
}

interface HeroLogView {
  readonly agents: readonly { readonly id: string; readonly kind: string }[];
  readonly decisions: readonly HeroDecision[];
  readonly tokenBankStart?: number;
}

/** The five design colours, in the order the GIF's colour table carries them. */
export function heroPalette(): readonly string[] {
  return [THEME.bg, THEME.ink, THEME.accent, THEME.warn, THEME.muted];
}

/**
 * Wraps text to `columns`, breaking on spaces, and ellipsises what will not fit
 * in `maxLines`.
 *
 * A word longer than a whole line is cut rather than allowed to overflow the
 * panel: a caption running off the edge of a hero image looks like a rendering
 * bug, which is a worse failure than a truncated word.
 */
export function wrapCaption(text: string, columns: number, maxLines: number): readonly string[] {
  if (columns <= 0 || maxLines <= 0) {
    return [];
  }

  const lines: string[] = [];
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  const current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      lines.push(current.join(' '));
      current.length = 0;
    }
  };

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current.join(' ')} ${word}`;
    if (candidate.length <= columns) {
      current.push(word);
      continue;
    }
    flush();
    if (word.length <= columns) {
      current.push(word);
      continue;
    }
    for (let offset = 0; offset < word.length; offset += columns) {
      lines.push(word.slice(offset, offset + columns));
    }
  }
  flush();

  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  // The ellipsis has to fit inside the column count too. At fewer than four
  // columns there is no room for it at all, and appending it anyway would put
  // three dots past the panel edge -- the exact overflow the truncation exists
  // to prevent.
  kept[maxLines - 1] = columns < 4 ? last.slice(0, columns) : `${last.slice(0, columns - 3)}...`;
  return kept;
}

/** Which Agent's reasoning the caption follows: the Deployment, or agent 0 if there is none. */
function captionedAgent(log: HeroLogView): 0 | 1 {
  return log.agents[1]?.kind === 'deployment' && log.agents[0]?.kind !== 'deployment' ? 1 : 0;
}

/** The reasoning governing `agentIndex` at a playback position, or a stated absence. */
function captionFor(
  log: HeroLogView,
  agentIndex: 0 | 1,
  decisionPoint: number,
  ticksPerDecision: number,
): { readonly text: string; readonly reflex: boolean } {
  const wasPolled = (tick: number, index: 0 | 1): boolean =>
    log.decisions.some((entry) => entry.tick === tick && entry.agentIndex === index);

  const resolved = resolveDecision(decisionPoint, agentIndex, wasPolled, ticksPerDecision);
  if (resolved === null) {
    return { text: 'NOT YET POLLED AT THIS DECISION POINT.', reflex: false };
  }

  const entry = log.decisions.find(
    (candidate) => candidate.tick === resolved.tick && candidate.agentIndex === agentIndex,
  );
  const reasoning = entry?.reasoning ?? entry?.rawResponse ?? null;
  const prefix = resolved.polled ? '' : 'STILL COMMITTED: ';

  return {
    text: reasoning === null ? 'NO REASONING RECORDED FOR THIS DECISION POINT.' : `${prefix}${reasoning}`,
    reflex: entry?.reflexMode === true,
  };
}

/** Hard offset shadow, flat fill, ink border, square corners. The house style, on a canvas. */
function drawPanel(surface: RasterSurface): void {
  surface.fillStyle = THEME.accent;
  surface.fillRect(
    PANEL_LEFT + THEME.shadowOffset,
    PANEL_TOP + THEME.shadowOffset,
    PANEL_WIDTH,
    PANEL_HEIGHT,
  );

  surface.fillStyle = THEME.bg;
  surface.fillRect(PANEL_LEFT, PANEL_TOP, PANEL_WIDTH, PANEL_HEIGHT);

  surface.strokeStyle = THEME.ink;
  surface.lineWidth = THEME.borderWidth;
  surface.strokeRect(PANEL_LEFT, PANEL_TOP, PANEL_WIDTH, PANEL_HEIGHT);
}

function drawCaption(
  surface: RasterSurface,
  label: string,
  lines: readonly string[],
  reflex: boolean,
): void {
  drawPanel(surface);

  // The label bar inverts: warn fill while the bank is empty, accent otherwise,
  // both carrying ground-coloured ink. Warning text on a warn fill rather than
  // warn text on the ground is the contrast rule docs/DESIGN.md sets out.
  surface.fillStyle = reflex ? THEME.warn : THEME.accent;
  surface.fillRect(
    PANEL_LEFT + THEME.borderWidth,
    PANEL_TOP + THEME.borderWidth,
    PANEL_WIDTH - THEME.borderWidth * 2,
    LABEL_HEIGHT,
  );

  const labelBaseline = PANEL_TOP + THEME.borderWidth + LABEL_HEIGHT - 6;
  surface.fillStyle = THEME.bg;
  surface.font = THEME.displayFont;
  surface.textAlign = 'left';
  surface.fillText(label, PANEL_LEFT + PANEL_PADDING, labelBaseline);

  // The stand-in notice sits on the same bar, right-aligned and at body size --
  // on every frame, not in a caption under the image that a reader can scroll
  // past. It is the honest half of AC1 and it is not allowed to be subtle.
  surface.font = THEME.monoFont;
  surface.textAlign = 'right';
  surface.fillText(STAND_IN_NOTICE, PANEL_LEFT + PANEL_WIDTH - PANEL_PADDING, labelBaseline);
  surface.textAlign = 'left';

  surface.fillStyle = THEME.ink;
  surface.font = THEME.monoFont;
  for (const [index, line] of lines.entries()) {
    surface.fillText(
      line,
      PANEL_LEFT + PANEL_PADDING,
      PANEL_TOP + THEME.borderWidth + LABEL_HEIGHT + BODY_LINE_HEIGHT * (index + 1),
    );
  }
}

export interface HeroScene {
  readonly log: HeroLogView;
  readonly frames: readonly RenderFrame[];
  readonly ticksPerDecision: number;
}

/** Builds the film once, so every frame is drawn from the same simulation. */
export function buildHeroScene(log: unknown): HeroScene {
  const env = createFighterEnvironment();
  const film = buildReplayFilm(log, env);
  return {
    log: log as HeroLogView,
    frames: film.frames,
    ticksPerDecision: env.ticksPerDecision,
  };
}

/** Draws one hero frame and returns its palette-index buffer. */
export function renderHeroFrame(scene: HeroScene, frameIndex: number): Uint8Array {
  const frame = scene.frames[frameIndex];
  if (frame === undefined) {
    throw new Error(`renderHeroFrame: no film frame at index ${String(frameIndex)}.`);
  }

  const surface = createRasterSurface(HERO_WIDTH, HERO_HEIGHT, heroPalette());
  const readout = createBankReadout(scene.log, scene.ticksPerDecision);

  drawFrame(surface, frame, {
    config: DEFAULT_FIGHTER_CONFIG,
    viewport: { width: HERO_WIDTH, height: HERO_ARENA_HEIGHT },
    banks: [0, 1].map((index) =>
      readout.tracked(index as 0 | 1) ? readout.at(frame.decisionPoint, index as 0 | 1) : null,
    ),
  });

  const agentIndex = captionedAgent(scene.log);
  const caption = captionFor(scene.log, agentIndex, frame.decisionPoint, scene.ticksPerDecision);
  const agentId = scene.log.agents[agentIndex]?.id ?? 'AGENT';
  const label = `P${String(agentIndex + 1)} ${agentId.toUpperCase()}`;

  drawCaption(
    surface,
    label,
    wrapCaption(caption.text, CAPTION_COLUMNS, CAPTION_LINES),
    caption.reflex,
  );

  return surface.snapshot();
}

/** Which film frames the GIF keeps. Every `HERO_FRAME_STRIDE`th, and never zero of them. */
export function heroFrameIndices(scene: HeroScene): readonly number[] {
  const indices: number[] = [];
  for (let index = 0; index < scene.frames.length; index += HERO_FRAME_STRIDE) {
    indices.push(index);
  }
  return indices;
}

/**
 * Every frame of the animation, in order.
 *
 * Separate from `renderHeroGif` so the delays can be asserted directly. INV-3
 * says nothing about how long a Deployment took to think may reach the screen,
 * and a per-Match or per-Decision-Point frame delay is exactly how that would
 * leak out of an animation -- invisible in the image, and readable off the file
 * by anyone who cared to.
 */
export function heroGifFrames(scene: HeroScene): readonly GifFrame[] {
  return heroFrameIndices(scene).map((index) => ({
    pixels: renderHeroFrame(scene, index),
    delayCentiseconds: HERO_DELAY_CENTISECONDS,
  }));
}

/** The whole hero: film, captions, diffed frames, encoded GIF. */
export function renderHeroGif(log: unknown): Uint8Array {
  const scene = buildHeroScene(log);
  const frames = heroGifFrames(scene);

  return encodeAnimatedGif({
    width: HERO_WIDTH,
    height: HERO_HEIGHT,
    palette: heroPalette(),
    frames,
  });
}
