import type { Canvas2D } from '../render/canvas2d';
import { GLYPH_HEIGHT, GLYPH_SPACING, GLYPH_WIDTH, glyphRows, measureText } from './font';

/**
 * Story 7.4: `Canvas2D`, implemented over an array of palette indices.
 *
 * This is the whole reason the hero is the *player* rather than a picture of
 * it. `render/canvas2d.ts` declares the narrowest surface the renderer needs --
 * deliberately, so tests could run against a recording fake -- and that same
 * narrowness makes a second real implementation about two hundred lines. So
 * `drawFrame` draws the hero with the real theme, the real film and the real
 * artist, and anything that changes how the player looks changes the hero too
 * (the artefact drift test then fails until it is regenerated).
 *
 * ## Palette, not colour
 *
 * A pixel is one byte: an index into a palette handed in at construction. That
 * is what a GIF wants, and it turns the design system into a gate -- a
 * `fillStyle` with no palette entry **throws**. A later story that puts a sixth
 * colour on the canvas breaks the hero build loudly rather than having it
 * silently quantised to whatever was nearest. Colours arrive from `THEME`; no
 * literal appears here, because `style-discipline.test.ts` allows a hex in two
 * files and this is not one of them.
 *
 * ## What is not implemented
 *
 * `drawImage` throws. The hero uses the block artist, and a sprite sheet is a
 * PNG this file would have to decode -- `node:zlib` is a Node built-in, which
 * `source-discipline.test.ts` forbids a shipped file here. A silent no-op would
 * render an empty arena that looked like a broken sprite pack.
 */

export interface RasterSurface extends Canvas2D {
  readonly width: number;
  readonly height: number;
  /** One palette index per pixel, row-major, `width * height` long. */
  snapshot(): Uint8Array;
}

interface View {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

/** Pixel size out of a CSS font shorthand. The hero only ever sets `NNpx family`. */
function fontPixelSize(font: string): number {
  const match = /(\d+)px/.exec(font);
  return match === null ? GLYPH_HEIGHT : Number(match[1]);
}

/** Glyph scale for a requested pixel size. Never below 1: a zero-scale glyph is an invisible caption. */
function glyphScale(font: string): number {
  return Math.max(1, Math.round(fontPixelSize(font) / GLYPH_HEIGHT));
}

export function createRasterSurface(
  width: number,
  height: number,
  palette: readonly string[],
): RasterSurface {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(
      `createRasterSurface: width and height must be positive integers, got ${String(width)}x${String(height)}.`,
    );
  }

  const indexOfColour = new Map<string, number>();
  for (const [index, colour] of palette.entries()) {
    indexOfColour.set(colour.toLowerCase(), index);
  }

  const pixels = new Uint8Array(width * height);
  const view: View = { dx: 0, dy: 0, sx: 1, sy: 1 };
  const saved: View[] = [];

  const resolve = (colour: string): number => {
    const index = indexOfColour.get(colour.toLowerCase());
    if (index === undefined) {
      throw new Error(
        `createRasterSurface: "${colour}" is not in the hero palette. Every colour drawn must come from THEME.`,
      );
    }
    return index;
  };

  /**
   * Paints a rectangle given in user space.
   *
   * Both corners are transformed and then ordered, rather than transforming the
   * origin and multiplying the size: a `scale(-1, 1)` flip (which is how the
   * sprite artist faces a fighter left) produces a negative width, and a
   * loop from left to left+width would then paint nothing at all.
   */
  const paint = (colourIndex: number, x: number, y: number, w: number, h: number): void => {
    const xa = view.dx + view.sx * x;
    const xb = view.dx + view.sx * (x + w);
    const ya = view.dy + view.sy * y;
    const yb = view.dy + view.sy * (y + h);

    const left = Math.max(0, Math.round(Math.min(xa, xb)));
    const right = Math.min(width, Math.round(Math.max(xa, xb)));
    const top = Math.max(0, Math.round(Math.min(ya, yb)));
    const bottom = Math.min(height, Math.round(Math.max(ya, yb)));

    for (let row = top; row < bottom; row += 1) {
      pixels.fill(colourIndex, row * width + left, row * width + right);
    }
  };

  return {
    width,
    height,

    fillStyle: palette[0],
    strokeStyle: palette[0],
    lineWidth: 1,
    font: `${String(GLYPH_HEIGHT)}px monospace`,
    textAlign: 'left',
    imageSmoothingEnabled: false,
    globalAlpha: 1,

    snapshot(): Uint8Array {
      return Uint8Array.from(pixels);
    },

    fillRect(x: number, y: number, w: number, h: number): void {
      paint(resolve(this.fillStyle), x, y, w, h);
    },

    clearRect(x: number, y: number, w: number, h: number): void {
      // Index 0 is the ground colour, which is what `drawFrame` fills over the
      // whole viewport immediately afterwards anyway. Clearing to a
      // "transparent" index instead would leave holes wherever the renderer
      // relies on the clear alone.
      paint(0, x, y, w, h);
    },

    strokeRect(x: number, y: number, w: number, h: number): void {
      // Centred on the path, the way a real canvas strokes: half the width
      // falls inside the rectangle and half outside. Drawing it wholly inside
      // would shrink every bar by 4px against what the browser shows.
      const colour = resolve(this.strokeStyle);
      const half = this.lineWidth / 2;
      paint(colour, x - half, y - half, w + this.lineWidth, this.lineWidth);
      paint(colour, x - half, y + h - half, w + this.lineWidth, this.lineWidth);
      paint(colour, x - half, y - half, this.lineWidth, h + this.lineWidth);
      paint(colour, x + w - half, y - half, this.lineWidth, h + this.lineWidth);
    },

    fillText(text: string, x: number, y: number): void {
      const colour = resolve(this.fillStyle);
      const scale = glyphScale(this.font);
      const advance = (GLYPH_WIDTH + GLYPH_SPACING) * scale;
      // `y` is an alphabetic baseline, as on a real canvas: the glyph box sits
      // above it. Treating `y` as the top would drop every HUD readout a full
      // line, which on this layout puts the tick counter through a health bar.
      const top = y - GLYPH_HEIGHT * scale;

      const measured = measureText(text, scale);
      const left =
        this.textAlign === 'center'
          ? x - measured / 2
          : this.textAlign === 'right'
            ? x - measured
            : x;

      for (const [position, character] of [...text].entries()) {
        const rows = glyphRows(character);
        for (const [rowIndex, bits] of rows.entries()) {
          for (let column = 0; column < GLYPH_WIDTH; column += 1) {
            if ((bits & (1 << (GLYPH_WIDTH - 1 - column))) === 0) {
              continue;
            }
            paint(
              colour,
              left + position * advance + column * scale,
              top + rowIndex * scale,
              scale,
              scale,
            );
          }
        }
      }
    },

    drawImage(): void {
      throw new Error(
        'createRasterSurface: drawImage is not supported. The hero renders with the block artist; decoding a sprite sheet would need a Node built-in this file may not import (AD-4).',
      );
    },

    save(): void {
      saved.push({ ...view });
    },

    restore(): void {
      const previous = saved.pop();
      if (previous === undefined) {
        throw new Error('createRasterSurface: restore() with no matching save().');
      }
      view.dx = previous.dx;
      view.dy = previous.dy;
      view.sx = previous.sx;
      view.sy = previous.sy;
    },

    translate(x: number, y: number): void {
      view.dx += view.sx * x;
      view.dy += view.sy * y;
    },

    scale(x: number, y: number): void {
      view.sx *= x;
      view.sy *= y;
    },
  };
}
