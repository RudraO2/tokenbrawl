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

interface DrawImageCall {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly dx: number;
}

/** A canvas that records the source rect and destination x of every `drawImage`. */
function recordingCanvas(): { ctx: Canvas2D; xs: () => number[]; calls: () => DrawImageCall[] } {
  const calls: DrawImageCall[] = [];
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
    drawImage(_image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number) {
      calls.push({ sx, sy, sw, sh, dx });
    },
  } as unknown as Canvas2D;
  return { ctx, xs: () => calls.map((c) => c.dx), calls: () => calls };
}

const image = (): SpriteImage => ({ width: 1600, height: 900 }) as unknown as SpriteImage;

describe('backdrop parallax is pure in the camera (Story 12.10)', () => {
  // The depths the stages actually ship (`public/stages/*/layout.json`), so the
  // purity and ordering tests exercise the tuning the gate measures.
  const built = () => {
    const validated = validateBackdropLayout({
      dim: 0,
      layers: [
        { image: '/back.png', depth: 0.03, scale: 0.6 },
        { image: '/crowd.png', depth: 0.28, scale: 0.6, crop: { x: 0, y: 96, width: 254, height: 158 } },
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
    // first-tile start with nothing else in the way. The shipped depths: at
    // cameraX 100 the far layer (0.03) starts at -3 and the near layer (0.28) at
    // -28 -- the near layer slides ~9x as far, which is the depth ordering the
    // gate's `stage-parallax-has-depth` measures on the real page.
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
    const farShift = Math.abs(startX(0.03, 100) - startX(0.03, 0));
    const nearShift = Math.abs(startX(0.28, 100) - startX(0.28, 0));
    expect(nearShift).toBeGreaterThan(farShift);
    expect(farShift).toBeGreaterThan(0);
  });

  it('draws only the cropped cell of a layer that declares a crop', () => {
    const cropped = createBackdrop(
      new Map([['/crowd.png', image()]]),
      validateBackdropLayout({
        dim: 0,
        layers: [{ image: '/crowd.png', depth: 0, scale: 1, crop: { x: 0, y: 96, width: 254, height: 158 } }],
      }),
    );
    const rec = recordingCanvas();
    cropped.draw(rec.ctx, 960, 400, 0, THEME);
    // Every tile is drawn from the crop's source rectangle, never the whole
    // 1600x900 (the atlas's empty bands and second row stay off the canvas).
    expect(rec.calls().length).toBeGreaterThan(0);
    for (const call of rec.calls()) {
      expect([call.sx, call.sy, call.sw, call.sh]).toStrictEqual([0, 96, 254, 158]);
    }
  });

  it('rejects a malformed crop the way it rejects a malformed scale', () => {
    const withCrop = (crop: unknown): unknown => ({
      dim: 0,
      layers: [{ image: '/a.png', depth: 0.1, scale: 1, crop }],
    });
    expect(() => validateBackdropLayout(withCrop({ x: -1, y: 0, width: 10, height: 10 }))).toThrow(/crop\.x/);
    expect(() => validateBackdropLayout(withCrop({ x: 0, y: 0, width: 0, height: 10 }))).toThrow(/crop\.width/);
    expect(() => validateBackdropLayout(withCrop({ x: 0, y: 0, width: 1.5, height: 10 }))).toThrow(/crop\.width/);
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
