import { describe, expect, it } from 'vitest';
import { createBackdrop, validateBackdropLayout } from './backdrop';
import type { Canvas2D } from './canvas2d';
import type { SpriteImage } from './sprite-sheet';
import { THEME } from './theme';

/**
 * Story 12.10: the backdrop gains depth.
 *
 * `validateBackdropLayout` rejects a malformed depth or scale exactly as it
 * rejects a malformed dim, because a layout is fetched, untrusted JSON. And the
 * parallax offset is pure in the camera value -- the same frame drawn twice
 * lands every layer identically, which is what lets Story 4.5's timeline scrub
 * the backdrop backwards.
 */

const layout = (over: Record<string, unknown> = {}): unknown => ({
  dim: 0.5,
  layers: [{ image: '/stages/stage-1/back.png', depth: 0.04, scale: 0.6 }],
  ...over,
});

describe('validateBackdropLayout (Story 12.10)', () => {
  it('accepts a well-formed two-layer stage', () => {
    const result = validateBackdropLayout({
      dim: 0.58,
      layers: [
        { image: '/stages/stage-1/back.png', depth: 0.04, scale: 0.6 },
        { image: '/stages/stage-1/crowd.png', depth: 0.16, scale: 0.6 },
      ],
    });
    expect(result.layers).toHaveLength(2);
    expect(result.layers[1].depth).toBe(0.16);
    expect(result.dim).toBe(0.58);
  });

  it('rejects a depth outside 0..1, the way it rejects a bad dim', () => {
    expect(() => validateBackdropLayout(layout({ layers: [{ image: '/a.png', depth: 1.4, scale: 1 }] }))).toThrow(
      /depth/,
    );
    expect(() => validateBackdropLayout(layout({ layers: [{ image: '/a.png', depth: -0.1, scale: 1 }] }))).toThrow(
      /depth/,
    );
    expect(() => validateBackdropLayout(layout({ layers: [{ image: '/a.png', depth: 'near', scale: 1 }] }))).toThrow(
      /depth/,
    );
  });

  it('rejects a non-positive or non-finite scale', () => {
    expect(() => validateBackdropLayout(layout({ layers: [{ image: '/a.png', depth: 0.1, scale: 0 }] }))).toThrow(
      /scale/,
    );
    expect(() =>
      validateBackdropLayout(layout({ layers: [{ image: '/a.png', depth: 0.1, scale: Number.POSITIVE_INFINITY }] })),
    ).toThrow(/scale/);
  });

  it('rejects a remote image, holding scenery to the same offline guarantee as the fonts', () => {
    expect(() =>
      validateBackdropLayout(layout({ layers: [{ image: 'https://cdn.example/x.png', depth: 0.1, scale: 1 }] })),
    ).toThrow(/same-origin/);
  });

  it('rejects an empty layer list and a bad dim, unchanged from before', () => {
    expect(() => validateBackdropLayout(layout({ layers: [] }))).toThrow(/non-empty/);
    expect(() => validateBackdropLayout(layout({ dim: 2 }))).toThrow(/dim/);
  });
});

/** A canvas that records only the `drawImage` destination x of every call. */
function recordingCanvas(): { ctx: Canvas2D; xs: () => number[] } {
  const xs: number[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {},
    translate() {},
    scale() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    drawImage(_image: unknown, _sx: number, _sy: number, _sw: number, _sh: number, dx: number) {
      xs.push(dx);
    },
  } as unknown as Canvas2D;
  return { ctx, xs: () => xs };
}

const image = (): SpriteImage => ({ width: 1600, height: 900 }) as unknown as SpriteImage;

describe('backdrop parallax is pure in the camera (Story 12.10)', () => {
  const built = () => {
    const validated = validateBackdropLayout({
      dim: 0,
      layers: [
        { image: '/back.png', depth: 0.04, scale: 0.6 },
        { image: '/crowd.png', depth: 0.16, scale: 0.6 },
      ],
    });
    const images = new Map<string, SpriteImage>([
      ['/back.png', image()],
      ['/crowd.png', image()],
    ]);
    return createBackdrop(images, validated);
  };

  it('draws every layer at the same offset for the same cameraX', () => {
    const backdrop = built();
    const a = recordingCanvas();
    const b = recordingCanvas();
    backdrop.draw(a.ctx, 960, 400, 512, THEME);
    backdrop.draw(b.ctx, 960, 400, 512, THEME);
    expect(a.xs()).toStrictEqual(b.xs());
  });

  it('shifts a near layer by more pixels than a far layer for the same pan', () => {
    // One layer per backdrop, so the recorded `drawImage` x is that layer's own
    // first-tile start with nothing else in the way. drawWidth is 1600*0.6=960,
    // so at cameraX 0 every layer starts at 0; at cameraX 100 the far layer
    // (depth 0.04) starts at -4 and the near layer (depth 0.16) at -16.
    const oneLayer = (depth: number) =>
      createBackdrop(
        new Map([['/layer.png', image()]]),
        validateBackdropLayout({ dim: 0, layers: [{ image: '/layer.png', depth, scale: 0.6 }] }),
      );
    const startX = (depth: number, cameraX: number): number => {
      const rec = recordingCanvas();
      oneLayer(depth).draw(rec.ctx, 960, 400, cameraX, THEME);
      return rec.xs()[0];
    };
    const farShift = Math.abs(startX(0.04, 100) - startX(0.04, 0));
    const nearShift = Math.abs(startX(0.16, 100) - startX(0.16, 0));
    expect(nearShift).toBeGreaterThan(farShift);
    expect(farShift).toBeGreaterThan(0);
  });

  it('skips a layer whose image never decoded rather than throwing', () => {
    const validated = validateBackdropLayout({
      dim: 0,
      layers: [{ image: '/missing.png', depth: 0.1, scale: 1 }],
    });
    const backdrop = createBackdrop(new Map(), validated);
    const rec = recordingCanvas();
    expect(() => backdrop.draw(rec.ctx, 960, 400, 100, THEME)).not.toThrow();
    expect(rec.xs()).toStrictEqual([]);
  });
});
