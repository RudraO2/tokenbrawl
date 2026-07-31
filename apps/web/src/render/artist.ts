import type { Canvas2D } from './canvas2d';
import { phaseFill, type Theme } from './theme';

/**
 * How a fighter is drawn, as a port.
 *
 * Story 4.1's scope names CC0 sprite integration, and this is the seam it goes
 * through: a sheet-backed artist implements the same interface and the renderer
 * does not change. Keeping it a port rather than inlining the drawing is what
 * makes the sprite question a swap rather than a rewrite.
 *
 * The artist that ships is procedural and authored in this repo, which makes it
 * unambiguously licence-clean. That is a deliberate choice over committing a
 * downloaded sheet whose LICENCE file nobody in this session could read:
 * `docs/ASSETS.md` records provenance for every asset as it lands, and an entry
 * that said "believed CC0" would be precisely the reconstruct-it-later failure
 * the story warns against. See deferred-work.md.
 */

export interface DrawnFighter {
  /** Pixel x of the fighter's centre, already interpolated by the renderer. */
  readonly x: number;
  /** Pixel y of the fighter's feet. */
  readonly groundY: number;
  /** `1` faces right, `-1` faces left. Fighters always face each other. */
  readonly facing: -1 | 1;
  /** `PHASE_*` from env-fighter. Drives the fill. */
  readonly phase: number;
  /** `COMMITTED_*` from env-fighter. Drives the reach of the drawn strike. */
  readonly committedAction: number;
  readonly agentIndex: 0 | 1;
}

export interface FighterArtist {
  readonly id: string;
  draw(ctx: Canvas2D, fighter: DrawnFighter, theme: Theme): void;
}

/**
 * Body box, in pixels. Chunky on purpose -- this is a brutalist player, and
 * the first draft's 44x96 fighters read as specks in a 960-wide arena. Sized
 * against the arena rather than against a sprite sheet: the fighters are the
 * subject, so they get the vertical space.
 */
const BODY_WIDTH = 64;
const BODY_HEIGHT = 160;
/** How far a committed strike reaches out of the body box, drawn as a bar. */
const STRIKE_LENGTH = 72;
const STRIKE_HEIGHT = 20;
/** Vertical offset of the strike bar from the top of the body. */
const STRIKE_RISE = 56;

/**
 * The in-repo artist: a fighter is a hard-edged block with a border, a hard
 * offset shadow, and a strike bar that extends while a Commitment Window is
 * open.
 *
 * Every rule from `docs/DESIGN.md` applies on the canvas exactly as it does in
 * CSS -- flat fills, square corners, a shadow that is an offset rectangle
 * rather than a blur. `fillRect` cannot produce a rounded corner or a gradient,
 * so the canvas gets the house style by construction; that is a happy accident
 * of the medium, not a reason to stop checking.
 */
export function createBlockArtist(): FighterArtist {
  return Object.freeze({
    id: 'block-artist',

    draw(ctx: Canvas2D, fighter: DrawnFighter, theme: Theme): void {
      const left = fighter.x - BODY_WIDTH / 2;
      const top = fighter.groundY - BODY_HEIGHT;

      // Hard offset shadow first, so the body lands on top of it. Offset away
      // from the centre line, so the two fighters' shadows fall outward and the
      // arena reads as lit from between them.
      ctx.fillStyle = fighter.agentIndex === 0 ? theme.accent : theme.warn;
      ctx.fillRect(
        left + theme.shadowOffset * fighter.facing * -1,
        top + theme.shadowOffset,
        BODY_WIDTH,
        BODY_HEIGHT,
      );

      ctx.fillStyle = phaseFill(theme, fighter.phase);
      ctx.fillRect(left, top, BODY_WIDTH, BODY_HEIGHT);

      ctx.strokeStyle = theme.ink;
      ctx.lineWidth = theme.borderWidth;
      ctx.strokeRect(left, top, BODY_WIDTH, BODY_HEIGHT);

      // The strike bar is drawn only while a window is open, and it points the
      // way the fighter faces. A viewer can read reach and commitment off the
      // silhouette alone, which is the whole reason phases are coloured.
      if (fighter.committedAction !== 0) {
        const strikeX =
          fighter.facing === 1 ? left + BODY_WIDTH : left - STRIKE_LENGTH;
        ctx.fillStyle = phaseFill(theme, fighter.phase);
        ctx.fillRect(strikeX, top + STRIKE_RISE, STRIKE_LENGTH, STRIKE_HEIGHT);
        ctx.strokeRect(strikeX, top + STRIKE_RISE, STRIKE_LENGTH, STRIKE_HEIGHT);
      }
    },
  });
}
