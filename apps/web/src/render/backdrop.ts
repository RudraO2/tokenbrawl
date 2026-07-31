import type { Canvas2D } from './canvas2d';
import type { SpriteImage } from './sprite-sheet';
import type { Theme } from './theme';

/**
 * Story 4.1: the arena backdrop.
 *
 * A stack of pixel-art layers drawn behind the fighters. Static, not
 * parallaxed: the arena is a single fixed horizontal axis with no camera, so
 * there is nothing for parallax to be relative to, and inventing a scroll would
 * be motion that does not correspond to anything in the simulation.
 *
 * Layers are anchored to the **bottom**. Scaled to span the arena's width they
 * are taller than it is, and the half worth showing is the lower half -- the
 * horizon and the treeline the fighters stand against. Cropping the sky is the
 * right crop.
 *
 * `dim` fades the whole stack toward the ground colour. `docs/DESIGN.md` commits
 * the app to near-black with one accent, and a full-strength dusk painting
 * would both fight the fighters for attention and drop the bone-white sprites'
 * contrast below the point where the action reads. The backdrop is scenery, and
 * scenery that competes with the subject is a defect rather than a flourish.
 */

export interface BackdropLayout {
  readonly scale: number;
  /** 0 is the untouched painting, 1 is solid ground colour. */
  readonly dim: number;
  readonly layers: readonly string[];
}

export interface Backdrop {
  readonly layerUrls: readonly string[];
  draw(ctx: Canvas2D, width: number, height: number, theme: Theme): void;
}

function fail(detail: string): never {
  throw new Error(`Backdrop layout is unusable: ${detail}`);
}

export function validateBackdropLayout(candidate: unknown): BackdropLayout {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    fail('the document is not an object');
  }
  const layout = candidate as Record<string, unknown>;

  if (!Number.isSafeInteger(layout.scale) || (layout.scale as number) <= 0) {
    fail(`scale must be a positive safe integer, got ${String(layout.scale)}`);
  }
  if (typeof layout.dim !== 'number' || layout.dim < 0 || layout.dim > 1) {
    fail(`dim must be between 0 and 1, got ${String(layout.dim)}`);
  }
  if (!Array.isArray(layout.layers) || layout.layers.length === 0) {
    fail('layers must be a non-empty array');
  }
  for (const layer of layout.layers) {
    if (typeof layer !== 'string' || layer.trim().length === 0) {
      fail(`every layer must be a non-empty string, got ${String(layer)}`);
    }
    if (layer.startsWith('http://') || layer.startsWith('https://')) {
      // Same offline guarantee the fonts and sheets are held to.
      fail(`layer "${layer}" must be same-origin`);
    }
  }

  return Object.freeze({
    scale: layout.scale as number,
    dim: layout.dim,
    layers: Object.freeze([...(layout.layers as string[])]),
  });
}

/**
 * Binds a validated layout to its decoded images.
 *
 * A layer whose image never loaded is skipped rather than throwing: losing the
 * far clouds should cost the far clouds, not the whole replay.
 */
export function createBackdrop(
  images: ReadonlyMap<string, SpriteImage>,
  layout: BackdropLayout,
): Backdrop {
  return Object.freeze({
    layerUrls: layout.layers,

    draw(ctx: Canvas2D, width: number, height: number, theme: Theme): void {
      ctx.save();
      ctx.imageSmoothingEnabled = false;

      for (const url of layout.layers) {
        const image = images.get(url);
        if (image === undefined) {
          continue;
        }
        const drawWidth = image.width * layout.scale;
        const drawHeight = image.height * layout.scale;
        // Tiled across, in case a layer is narrower than the arena, and
        // anchored to the bottom edge.
        for (let x = 0; x < width; x += drawWidth) {
          ctx.drawImage(
            image,
            0,
            0,
            image.width,
            image.height,
            x,
            height - drawHeight,
            drawWidth,
            drawHeight,
          );
        }
      }

      if (layout.dim > 0) {
        ctx.globalAlpha = layout.dim;
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, width, height);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    },
  });
}
