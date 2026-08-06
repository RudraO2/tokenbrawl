import type { DeploymentIdentity } from '@tokenbrawl/contracts';
import { sha256Hex } from '../../../../packages/env-fighter/src/sha256';
import type { Canvas2D } from './canvas2d';
import { BODY_HEIGHT, type DrawnFighter, type FighterArtist } from './artist';
import type { Theme } from './theme';

/**
 * Story 9.4: a Deployment's on-screen identity, derived rather than assigned.
 *
 * Every fighter is drawn by `agentIndex` alone today, so two Deployments that
 * happen to share a model name are indistinguishable, and a visitor watching
 * Spectate has no way to tell which Deployment is which across a whole stream
 * of Matches. The fix is a small emblem, derived once from the triple that
 * actually identifies a Deployment -- `provider`, `endpoint`, `model` -- and
 * drawn on top of whichever base artist (block or sprite) is already
 * rendering the fighter.
 */

/** A shape for the emblem's outline. Geometric only -- no provider logos, no likenesses. */
export type SilhouetteShape = 'circle' | 'hex' | 'chevron' | 'plate';

/** A shape for the glyph mark stroked on top of the silhouette. */
export type GlyphShape = 'square' | 'triangle' | 'diamond' | 'cross';

export interface VisualIdentity {
  /** A `#rrggbb` hex string, computed at runtime from the hash -- never a literal in source. */
  readonly colorway: string;
  readonly glyph: GlyphShape;
  readonly silhouette: SilhouetteShape;
}

const GLYPHS: readonly GlyphShape[] = ['square', 'triangle', 'diamond', 'cross'];
const SILHOUETTES: readonly SilhouetteShape[] = ['circle', 'hex', 'chevron', 'plate'];

/**
 * Derives an emblem from `(provider, endpoint, model)` by hashing the triple
 * once and reading three disjoint slices of the resulting hex digest.
 *
 * One hash call rather than three: the properties still vary independently
 * because they are read from non-overlapping character ranges of the same
 * digest, so a one-character change anywhere in the triple cannot move all
 * three properties in lockstep the way three calls seeded from the same
 * input might. Colours come from chars 0-6 (a full `#rrggbb`); the glyph
 * index from chars 6-8 mod 4; the silhouette index from chars 8-10 mod 4 --
 * disjoint ranges, so no property's value can influence another's.
 */
export function deriveVisualIdentity(deployment: DeploymentIdentity): VisualIdentity {
  if (
    typeof deployment.provider !== 'string' ||
    typeof deployment.endpoint !== 'string' ||
    typeof deployment.model !== 'string'
  ) {
    throw new TypeError(
      'deriveVisualIdentity: provider, endpoint and model must all be strings.',
    );
  }
  const digest = sha256Hex(`${deployment.provider}|${deployment.endpoint}|${deployment.model}`);

  const colorway = `#${digest.slice(0, 6)}`;
  const glyphIndex = Number.parseInt(digest.slice(6, 8), 16) % GLYPHS.length;
  const silhouetteIndex = Number.parseInt(digest.slice(8, 10), 16) % SILHOUETTES.length;

  return Object.freeze({
    colorway,
    glyph: GLYPHS[glyphIndex],
    silhouette: SILHOUETTES[silhouetteIndex],
  });
}

/** The emblem's footprint, in pixels. Small and near the head -- a badge, not a costume. */
const EMBLEM_SIZE = 24;
const EMBLEM_HALF = EMBLEM_SIZE / 2;
/** How far above the fighter's body box the emblem's centre sits. */
const EMBLEM_RISE = 18;

/**
 * `Canvas2D` -- the narrow port this player draws through -- exposes only
 * `fillRect`/`strokeRect` and no path, arc or rotate API (see `canvas2d.ts`).
 * Every shape below is therefore built out of axis-aligned rectangles rather
 * than a literal outline; each `SilhouetteShape`/`GlyphShape` still gets its
 * own distinct rectangle composition, so the four values remain visually
 * distinguishable within what the port can draw.
 */
function drawSilhouette(
  ctx: Canvas2D,
  shape: SilhouetteShape,
  cx: number,
  cy: number,
  fillStyle: string,
): void {
  ctx.fillStyle = fillStyle;
  const s = EMBLEM_SIZE;
  const h = EMBLEM_HALF;
  switch (shape) {
    case 'circle':
      // A stepped block approximation of a roundel: a full square with its
      // corners shaved by four small corner cuts (drawn as background-less
      // gaps is not possible, so the shave is faked with a smaller inset
      // square plus wide cross bars).
      ctx.fillRect(cx - h, cy - h * 0.7, s * 0.7, h * 1.4);
      ctx.fillRect(cx - h * 0.7, cy - h, h * 1.4, s * 0.7);
      break;
    case 'hex':
      // Two overlapping bars, wide-short then narrow-tall, reading as a
      // hexagon's flat top/bottom plus its side facets.
      ctx.fillRect(cx - h, cy - h * 0.5, s, h);
      ctx.fillRect(cx - h * 0.6, cy - h, h * 1.2, s);
      break;
    case 'chevron':
      // Two diagonal-reading bars offset from centre, standing in for an
      // arrow/chevron notch.
      ctx.fillRect(cx - h, cy - h, h, s);
      ctx.fillRect(cx, cy - h * 0.4, h, h * 0.8);
      break;
    case 'plate':
    default:
      // A flat wide rectangle -- a plate is simply wider than it is tall.
      ctx.fillRect(cx - h, cy - h * 0.55, s, h * 1.1);
      break;
  }
}

function drawGlyph(ctx: Canvas2D, shape: GlyphShape, cx: number, cy: number, strokeStyle: string): void {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 2;
  const half = EMBLEM_HALF * 0.5;
  switch (shape) {
    case 'square':
      ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
      break;
    case 'triangle':
      // A stepped triangle outline: a wide short bar over a narrow tall one,
      // reading as a shape that tapers upward.
      ctx.strokeRect(cx - half * 0.3, cy - half, half * 0.6, half);
      ctx.strokeRect(cx - half, cy, half * 2, half);
      break;
    case 'diamond':
      // Two small squares offset diagonally, reading as a diamond's top and
      // bottom points.
      ctx.strokeRect(cx - half * 0.4, cy - half, half * 0.8, half * 0.8);
      ctx.strokeRect(cx - half * 0.4, cy + half * 0.2, half * 0.8, half * 0.8);
      break;
    case 'cross':
    default:
      // A plus sign: one horizontal bar and one vertical bar.
      ctx.strokeRect(cx - half, cy - half * 0.25, half * 2, half * 0.5);
      ctx.strokeRect(cx - half * 0.25, cy - half, half * 0.5, half * 2);
      break;
  }
}

/**
 * Wraps a base artist so it draws the given emblem after its own drawing.
 *
 * A decorator, not a replacement: `base.draw` runs first and unmodified, so
 * body geometry, hitbox-adjacent drawing, and the strike bar are exactly what
 * `createBlockArtist`/`createSpriteArtist` would have drawn on their own. The
 * emblem is a small badge added afterwards, near the fighter's head, and it
 * never alters `fighter` or the phase fill the base artist already computed.
 */
export function createIdentityArtist(base: FighterArtist, identity: VisualIdentity): FighterArtist {
  return Object.freeze({
    id: `${base.id}+identity`,

    draw(ctx: Canvas2D, fighter: DrawnFighter, theme: Theme): void {
      base.draw(ctx, fighter, theme);

      const cx = fighter.x;
      const cy = fighter.groundY - BODY_HEIGHT - EMBLEM_RISE;

      drawSilhouette(ctx, identity.silhouette, cx, cy, identity.colorway);
      drawGlyph(ctx, identity.glyph, cx, cy, theme.ink);
    },
  });
}
