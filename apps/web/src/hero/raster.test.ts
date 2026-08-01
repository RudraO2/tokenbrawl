import { describe, expect, it } from 'vitest';
import { GLYPH_HEIGHT } from './font';
import { createRasterSurface } from './raster';

const PALETTE = ['#0a0a0a', '#f5f5f0', '#c8ff00', '#ff3b30', '#6e6e68'];

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): number {
  return pixels[y * width + x];
}

describe('the raster Canvas2D', () => {
  it('starts as ground and fills a rectangle in palette indices', () => {
    const surface = createRasterSurface(10, 6, PALETTE);
    expect([...surface.snapshot()].every((value) => value === 0)).toBe(true);

    surface.fillStyle = PALETTE[2];
    surface.fillRect(2, 1, 3, 2);

    const pixels = surface.snapshot();
    expect(pixelAt(pixels, 10, 2, 1)).toBe(2);
    expect(pixelAt(pixels, 10, 4, 2)).toBe(2);
    // Exclusive on the far edge, exactly as `fillRect` is on a real canvas.
    expect(pixelAt(pixels, 10, 5, 1)).toBe(0);
    expect(pixelAt(pixels, 10, 2, 3)).toBe(0);
  });

  it('refuses a colour that is not in the palette', () => {
    // The design system as a gate: a sixth colour on the canvas breaks the
    // hero build loudly instead of being quantised to whatever was nearest.
    const surface = createRasterSurface(4, 4, PALETTE);
    surface.fillStyle = '#123456';
    expect(() => surface.fillRect(0, 0, 1, 1)).toThrow(/not in the hero palette/);
  });

  it('clips to its own bounds rather than writing past them', () => {
    const surface = createRasterSurface(4, 4, PALETTE);
    surface.fillStyle = PALETTE[1];
    surface.fillRect(-10, -10, 100, 100);
    expect(surface.snapshot()).toHaveLength(16);
    expect([...surface.snapshot()].every((value) => value === 1)).toBe(true);
  });

  it('strokes centred on the path, half in and half out', () => {
    const surface = createRasterSurface(12, 12, PALETTE);
    surface.strokeStyle = PALETTE[1];
    surface.lineWidth = 2;
    surface.strokeRect(4, 4, 4, 4);

    const pixels = surface.snapshot();
    // A 2px stroke on the top edge covers y=3 and y=4, not y=4 and y=5.
    expect(pixelAt(pixels, 12, 5, 3)).toBe(1);
    expect(pixelAt(pixels, 12, 5, 4)).toBe(1);
    expect(pixelAt(pixels, 12, 5, 5)).toBe(0);
    // And the interior is untouched.
    expect(pixelAt(pixels, 12, 6, 6)).toBe(0);
  });

  it('clears to the ground colour', () => {
    const surface = createRasterSurface(4, 4, PALETTE);
    surface.fillStyle = PALETTE[3];
    surface.fillRect(0, 0, 4, 4);
    surface.clearRect(1, 1, 2, 2);
    expect(pixelAt(surface.snapshot(), 4, 1, 1)).toBe(0);
    expect(pixelAt(surface.snapshot(), 4, 0, 0)).toBe(3);
  });

  it('draws text above the baseline, as a canvas does', () => {
    const surface = createRasterSurface(40, 20, PALETTE);
    surface.fillStyle = PALETTE[1];
    surface.font = `${String(GLYPH_HEIGHT)}px mono`;
    surface.textAlign = 'left';
    surface.fillText('L', 2, 12);

    const pixels = surface.snapshot();
    // Scale 1: the glyph box is rows 5..11 with the baseline at 12.
    expect(pixelAt(pixels, 40, 2, 5)).toBe(1);
    expect(pixelAt(pixels, 40, 6, 11)).toBe(1);
    // Nothing below the baseline, which is where a top-anchored version would
    // have put the whole glyph.
    expect(pixelAt(pixels, 40, 2, 12)).toBe(0);
  });

  it('scales glyphs to the pixel size in the font string', () => {
    const surface = createRasterSurface(60, 40, PALETTE);
    surface.fillStyle = PALETTE[1];
    surface.font = '14px mono';
    surface.fillText('L', 0, 20);
    // 14px over a 7-row glyph is scale 2, so the left column is two pixels wide.
    const pixels = surface.snapshot();
    expect(pixelAt(pixels, 60, 0, 6)).toBe(1);
    expect(pixelAt(pixels, 60, 1, 6)).toBe(1);
    expect(pixelAt(pixels, 60, 2, 6)).toBe(0);
  });

  it('honours textAlign', () => {
    const left = createRasterSurface(60, 20, PALETTE);
    const centred = createRasterSurface(60, 20, PALETTE);
    for (const surface of [left, centred]) {
      surface.fillStyle = PALETTE[1];
      surface.font = `${String(GLYPH_HEIGHT)}px mono`;
    }
    left.textAlign = 'left';
    left.fillText('AB', 30, 10);
    centred.textAlign = 'center';
    centred.fillText('AB', 30, 10);

    const inked = (surface: ReturnType<typeof createRasterSurface>): number =>
      [...surface.snapshot()].filter((value) => value === 1).length;
    expect(inked(left)).toBe(inked(centred));
    // Centred text starts left of where left-aligned text starts.
    const firstInked = (surface: ReturnType<typeof createRasterSurface>): number =>
      [...surface.snapshot()].findIndex((value) => value === 1) % 60;
    expect(firstInked(centred)).toBeLessThan(firstInked(left));
  });

  it('translates and flips, and a flipped rectangle still paints', () => {
    // `scale(-1, 1)` is how the sprite artist faces a fighter left. Multiplying
    // the origin by a negative scale and keeping the width positive produces a
    // rectangle whose left edge is to the right of its right edge, and a naive
    // loop paints nothing at all.
    const surface = createRasterSurface(20, 10, PALETTE);
    surface.fillStyle = PALETTE[2];
    surface.save();
    surface.translate(10, 0);
    surface.scale(-1, 1);
    surface.fillRect(0, 0, 4, 4);
    surface.restore();

    const pixels = surface.snapshot();
    expect(pixelAt(pixels, 20, 7, 1)).toBe(2);
    expect(pixelAt(pixels, 20, 9, 1)).toBe(2);
    expect(pixelAt(pixels, 20, 10, 1)).toBe(0);

    // And the transform really was restored.
    surface.fillRect(0, 0, 2, 2);
    expect(pixelAt(surface.snapshot(), 20, 0, 0)).toBe(2);
  });

  it('refuses an unbalanced restore and an unsupported drawImage', () => {
    const surface = createRasterSurface(4, 4, PALETTE);
    expect(() => surface.restore()).toThrow(/no matching save/);
    expect(() => surface.drawImage(null, 0, 0, 1, 1, 0, 0, 1, 1)).toThrow(/not supported/);
  });

  it('refuses a degenerate size', () => {
    expect(() => createRasterSurface(0, 10, PALETTE)).toThrow(/positive integers/);
    expect(() => createRasterSurface(10, 1.5, PALETTE)).toThrow(/positive integers/);
  });

  it('hands back a copy, so a caller cannot scribble on the surface', () => {
    const surface = createRasterSurface(4, 4, PALETTE);
    const snapshot = surface.snapshot();
    snapshot[0] = 4;
    expect(surface.snapshot()[0]).toBe(0);
  });
});
