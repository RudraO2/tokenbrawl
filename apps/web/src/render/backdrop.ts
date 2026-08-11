import type { Canvas2D } from './canvas2d';
import type { SpriteImage } from './sprite-sheet';
import type { Theme } from './theme';

/**
 * Story 4.1: the arena backdrop. Story 12.10: with depth in it.
 *
 * A stack of layers drawn behind the fighters, each told how much of the
 * camera's movement to take. A layer at depth 0 is a horizon at infinity that
 * the fighters travel across; a layer at a larger depth slides with the camera,
 * faster the nearer it is, which is what makes a backdrop read as scenery with
 * distance in it rather than as a single flat painting.
 *
 * ## Why this stack moves now, when for eleven stories it did not
 *
 * This docblock used to say *"Static, not parallaxed: the arena is a single
 * fixed horizontal axis with no camera, so there is nothing for parallax to be
 * relative to, and inventing a scroll would be motion that does not correspond
 * to anything in the simulation."* That was exactly right when it was written
 * and Story 12.3 removed its premise: it gave the arena a camera
 * (`render/camera.ts`), so there is now something for parallax to be relative
 * to -- the fighters' own positions, by way of the camera centred between them.
 *
 * So the parallax here is **not** invented motion, which is the specific thing
 * the old docblock refused. It is a pure function of the camera:
 *
 *   offset = cameraX * depth
 *
 * computed fresh each frame from the value `cameraForFrame` already returns. No
 * accumulator, no scroll state, no `deltaTime` -- the reference project's own
 * scroller is a stepped mutable, one of the four mechanisms
 * `docs/DEV-REFERENCE.md` forbids copying, and a stepped scroll could not be
 * scrubbed backwards. A scrub to frame 90 draws the backdrop at exactly the
 * offset a play-through to frame 90 draws (INV-1, INV-3).
 *
 * `docs/DESIGN.md` bans parallax -- **for the page**. Its Motion rule ("no
 * easing curve, no spring, no parallax, no scroll-jacking") governs page chrome,
 * and the 2026-08-07 ruling scoped the flat-surface rules to the UI (see the
 * "Two regimes" section). A backdrop layer moving with the camera inside the
 * arena is not scroll-jacking; it is the arena drawing depth.
 *
 * ## Anchoring and tiling
 *
 * Layers are anchored to the **bottom**. Scaled to span the arena's width they
 * are taller than it is, and the half worth showing is the lower half -- the
 * horizon and the treeline the fighters stand against. Cropping the sky is the
 * right crop. Each layer tiles horizontally from its parallax offset, so a pan
 * never opens a gap at either edge whatever the camera does.
 *
 * ## The dim
 *
 * `dim` fades the whole stack toward the ground colour. `docs/DESIGN.md` commits
 * the app to near-black with one accent, and a full-strength painting would both
 * fight the fighters for attention and drop the bone-white sprites' contrast
 * below the point where the action reads. Six stages means six chances to get
 * this wrong, so the dim is per-stage and each value is recorded in
 * `docs/stories/12.10`'s Visual check finding alongside the contrast it buys.
 */

/**
 * One layer of a backdrop: a same-origin image, how much of the camera it takes,
 * and the integer-free scale it is drawn at.
 *
 * `depth` is `0..1`: 0 is fixed, 1 tracks the camera one-for-one. `scale`
 * multiplies the image's native size; unlike `packages/` geometry it is a plain
 * number rather than a safe integer, because a stage is a full illustration
 * fitted to the arena (0.6 maps a 1600-wide scene onto the 960 arena) rather
 * than a pixel-art tile drawn at an integer multiple. `render/**` is released
 * from the flat-surface rules but not from type discipline; the value is still
 * validated as fetched, untrusted JSON.
 */
export interface BackdropLayer {
  readonly image: string;
  readonly depth: number;
  readonly scale: number;
}

export interface BackdropLayout {
  /** 0 is the untouched painting, 1 is solid ground colour. */
  readonly dim: number;
  readonly layers: readonly BackdropLayer[];
}

export interface Backdrop {
  readonly layerUrls: readonly string[];
  /**
   * Draws the stack for one frame. `cameraX` is the world x the frame is centred
   * on (`camera.ts`'s `Camera.x`); each layer offsets by `cameraX * depth`, so
   * the whole backdrop is a pure function of the camera and nothing else.
   */
  draw(ctx: Canvas2D, width: number, height: number, cameraX: number, theme: Theme): void;
}

function fail(detail: string): never {
  throw new Error(`Backdrop layout is unusable: ${detail}`);
}

function validateLayer(candidate: unknown, index: number): BackdropLayer {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    fail(`layer ${index} is not an object`);
  }
  const layer = candidate as Record<string, unknown>;
  if (typeof layer.image !== 'string' || layer.image.trim().length === 0) {
    fail(`layer ${index}: image must be a non-empty string, got ${String(layer.image)}`);
  }
  if (layer.image.startsWith('http://') || layer.image.startsWith('https://')) {
    // Same offline guarantee the fonts and sheets are held to.
    fail(`layer ${index}: image "${layer.image}" must be same-origin`);
  }
  if (typeof layer.depth !== 'number' || !Number.isFinite(layer.depth) || layer.depth < 0 || layer.depth > 1) {
    fail(`layer ${index}: depth must be between 0 and 1, got ${String(layer.depth)}`);
  }
  if (typeof layer.scale !== 'number' || !Number.isFinite(layer.scale) || layer.scale <= 0) {
    fail(`layer ${index}: scale must be a positive number, got ${String(layer.scale)}`);
  }
  return Object.freeze({ image: layer.image, depth: layer.depth, scale: layer.scale });
}

export function validateBackdropLayout(candidate: unknown): BackdropLayout {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    fail('the document is not an object');
  }
  const layout = candidate as Record<string, unknown>;

  if (typeof layout.dim !== 'number' || layout.dim < 0 || layout.dim > 1) {
    fail(`dim must be between 0 and 1, got ${String(layout.dim)}`);
  }
  if (!Array.isArray(layout.layers) || layout.layers.length === 0) {
    fail('layers must be a non-empty array');
  }

  const layers = (layout.layers as unknown[]).map((layer, index) => validateLayer(layer, index));

  return Object.freeze({
    dim: layout.dim,
    layers: Object.freeze(layers),
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
    layerUrls: layout.layers.map((layer) => layer.image),

    draw(ctx: Canvas2D, width: number, height: number, cameraX: number, theme: Theme): void {
      ctx.save();
      ctx.imageSmoothingEnabled = false;

      for (const layer of layout.layers) {
        const image = images.get(layer.image);
        if (image === undefined) {
          continue;
        }
        const drawWidth = image.width * layer.scale;
        const drawHeight = image.height * layer.scale;
        // Parallax: the layer slides left as the camera's centre moves right,
        // `depth` of the way. Pure in `cameraX`, so a scrubbed frame and a
        // played frame land the layer identically.
        const offset = cameraX * layer.depth;
        // Tiled across from the offset so a pan never opens a gap, and anchored
        // to the bottom edge. `startX` is the leftmost tile boundary at or left
        // of the offset; the modulo keeps it bounded as the camera travels.
        let startX = -(offset % drawWidth);
        if (startX > 0) {
          startX -= drawWidth;
        }
        for (let x = startX; x < width; x += drawWidth) {
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
