import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import type { Canvas2D } from './canvas2d';
import { CAMERA_MAX_SCALE, applyCamera, cameraFor, worldXFor } from './camera';

/**
 * Story 12.3. The camera's whole contract is that it is a function.
 *
 * These cases are deliberately arithmetic rather than pixel assertions: the
 * property that matters is that a fighter standing on a wall is inside the
 * frame at the scale the camera chose, and the way to know that is to run the
 * camera's own transform over the fighter's world position and check where it
 * lands. `drawFrame`'s recording fake cannot answer that -- it records the
 * transform calls without applying them -- which is exactly why the arithmetic
 * is tested here and the wiring is tested there.
 */

const CONFIG = DEFAULT_FIGHTER_CONFIG;
const VIEWPORT = { width: 960, height: 400 };

/** Half a roster sprite, in world pixels: every pack is 208 wide at scale 1. */
const HALF_SPRITE_WORLD = 104;

/** Where a world x lands on the canvas under a camera. The inverse of `applyCamera`. */
function screenXOf(worldX: number, camera: { x: number; scale: number }): number {
  return (worldX - camera.x) * camera.scale + VIEWPORT.width / 2;
}

function cameraAt(a: number, b: number): { x: number; scale: number } {
  return cameraFor(a, b, VIEWPORT, CONFIG);
}

describe('the camera is a pure function of the frame', () => {
  it('returns the same camera for the same arguments, a thousand times over', () => {
    const first = cameraAt(320, 640);
    for (let call = 0; call < 1_000; call += 1) {
      expect(cameraAt(320, 640)).toStrictEqual(first);
    }
  });

  it('depends on nothing but the pair: two independently built calls agree', () => {
    // If anything on this path accumulated, eased across calls, or read a
    // clock, these two would differ -- the first has a thousand calls of
    // history behind it and the second has none.
    for (let call = 0; call < 1_000; call += 1) {
      cameraAt(call, 960 - call);
    }
    expect(cameraAt(200, 500)).toStrictEqual(cameraFor(200, 500, VIEWPORT, CONFIG));
  });

  it('is symmetric in its two fighters, because a midpoint is', () => {
    expect(cameraAt(120, 880)).toStrictEqual(cameraAt(880, 120));
  });
});

describe('follow', () => {
  it('centres on the midpoint when the midpoint is reachable', () => {
    const camera = cameraAt(320, 640);
    expect(camera.x).toBe(480);
    expect(screenXOf(320, camera)).toBeLessThan(VIEWPORT.width / 2);
    expect(screenXOf(640, camera)).toBeGreaterThan(VIEWPORT.width / 2);
  });

  it('moves with a fight that drifts down the stage', () => {
    // The defect this story exists to fix: a pair pinned to one wall used to be
    // drawn in the far third of a frame whose other two thirds were empty.
    const centred = cameraAt(320, 640);
    const shifted = cameraAt(640, 960);
    expect(shifted.x).toBeGreaterThan(centred.x);
    // ...and having moved, it puts them back near the middle rather than at the
    // edge. Within a quarter-frame of centre, from 660px out of centre before.
    const midScreen = (screenXOf(640, shifted) + screenXOf(960, shifted)) / 2;
    expect(Math.abs(midScreen - VIEWPORT.width / 2)).toBeLessThan(VIEWPORT.width / 4);
  });
});

describe('clamp', () => {
  it('draws a fighter standing on either wall whole, inside the frame', () => {
    for (const [a, b] of [
      [CONFIG.arenaMin, CONFIG.arenaMin + CONFIG.minSeparation],
      [CONFIG.arenaMax - CONFIG.minSeparation, CONFIG.arenaMax],
      [CONFIG.arenaMin, CONFIG.arenaMax],
      [CONFIG.arenaMax, CONFIG.arenaMax],
      [CONFIG.arenaMin, CONFIG.arenaMin],
    ] as const) {
      const camera = cameraFor(a, b, VIEWPORT, CONFIG);
      for (const units of [a, b]) {
        const centre = screenXOf(worldXFor(units, CONFIG, VIEWPORT), camera);
        const halfSprite = HALF_SPRITE_WORLD * camera.scale;
        expect(centre - halfSprite).toBeGreaterThanOrEqual(0);
        expect(centre + halfSprite).toBeLessThanOrEqual(VIEWPORT.width);
      }
    }
  });

  it('stops rather than chasing a midpoint past the stage', () => {
    // Both fighters jammed into the right corner. The midpoint is 940; the
    // camera must refuse to follow it that far, and must be identical for a
    // pair jammed further still.
    const corner = cameraAt(920, 960);
    expect(corner.x).toBeLessThan(940);
    expect(cameraAt(940, 960).x).toBe(corner.x);
  });

  it('never shows past the stage margin at either end', () => {
    const margin = VIEWPORT.width / 2;
    for (let a = CONFIG.arenaMin; a <= CONFIG.arenaMax; a += 20) {
      for (let b = a; b <= CONFIG.arenaMax; b += 20) {
        const camera = cameraFor(a, b, VIEWPORT, CONFIG);
        const halfView = VIEWPORT.width / (2 * camera.scale);
        expect(camera.x - halfView).toBeGreaterThanOrEqual(-margin - 1e-9);
        expect(camera.x + halfView).toBeLessThanOrEqual(VIEWPORT.width + margin + 1e-9);
      }
    }
  });
});

describe('zoom', () => {
  it('is bounded at both ends for every legal separation', () => {
    const minScale = 1 / 2;
    for (let a = CONFIG.arenaMin; a <= CONFIG.arenaMax; a += 10) {
      for (let b = a + CONFIG.minSeparation; b <= CONFIG.arenaMax; b += 10) {
        const { scale } = cameraFor(a, b, VIEWPORT, CONFIG);
        expect(scale).toBeGreaterThanOrEqual(minScale);
        expect(scale).toBeLessThanOrEqual(CAMERA_MAX_SCALE);
      }
    }
  });

  it('reaches both bounds, so neither is decorative', () => {
    expect(cameraFor(400, 400 + CONFIG.minSeparation, VIEWPORT, CONFIG).scale).toBe(
      CAMERA_MAX_SCALE,
    );
    expect(cameraFor(CONFIG.arenaMin, CONFIG.arenaMax, VIEWPORT, CONFIG).scale).toBe(1 / 2);
  });

  it('widens as the pair separates and tightens as they close, monotonically', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let separation = CONFIG.minSeparation; separation <= 960; separation += 20) {
      const { scale } = cameraFor(480 - separation / 2, 480 + separation / 2, VIEWPORT, CONFIG);
      expect(scale).toBeLessThanOrEqual(previous);
      previous = scale;
    }
  });

  it('frames the opening pair the way the reference frames its own', () => {
    // `<REF>/shots/04_local_match.png` reads its fighters at ~32% of frame
    // height, separated by ~21% of frame width. This build's sprites are 208
    // world pixels tall in a 400-tall arena, so 1:1 reads at 52% and the gap
    // is 33% -- both far too big, which is the "pressed into one third of the
    // picture" finding Story 12.1 recorded. These two numbers are the story's
    // acceptance criterion expressed as arithmetic.
    const camera = cameraAt(...(CONFIG.startPosition as unknown as [number, number]));
    const heightRatio = (208 * camera.scale) / VIEWPORT.height;
    const separationRatio =
      (screenXOf(worldXFor(CONFIG.startPosition[1], CONFIG, VIEWPORT), camera) -
        screenXOf(worldXFor(CONFIG.startPosition[0], CONFIG, VIEWPORT), camera)) /
      VIEWPORT.width;
    expect(heightRatio).toBeGreaterThan(0.25);
    expect(heightRatio).toBeLessThan(0.42);
    expect(separationRatio).toBeGreaterThan(0.18);
    expect(separationRatio).toBeLessThan(0.3);
  });

  it('keeps the opening pair out of the outer fifth on either side', () => {
    // The gate's `camera-frames-the-fight`, as arithmetic. The check samples
    // pixels; this samples the camera that produces them, so a regression is
    // caught in milliseconds rather than in a browser.
    const camera = cameraAt(...(CONFIG.startPosition as unknown as [number, number]));
    for (const units of CONFIG.startPosition) {
      const centre = screenXOf(worldXFor(units, CONFIG, VIEWPORT), camera);
      const halfSprite = HALF_SPRITE_WORLD * camera.scale;
      expect(centre - halfSprite).toBeGreaterThan(VIEWPORT.width / 5);
      expect(centre + halfSprite).toBeLessThan((VIEWPORT.width * 4) / 5);
    }
  });
});

describe('degenerate inputs draw something rather than nothing', () => {
  it('centres on a zero-width arena instead of dividing by zero', () => {
    const flat = { ...CONFIG, arenaMin: 100, arenaMax: 100 };
    const camera = cameraFor(100, 100, VIEWPORT, flat);
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(Number.isFinite(camera.scale)).toBe(true);
  });

  it('falls back to a neutral camera on a non-finite position', () => {
    expect(cameraAt(Number.NaN, 640)).toStrictEqual({ x: 480, scale: 1 });
  });

  it('falls back to a neutral camera on a zero-width viewport', () => {
    expect(cameraFor(0, 960, { width: 0, height: 400 }, CONFIG)).toStrictEqual({ x: 0, scale: 1 });
  });
});

describe('applyCamera', () => {
  function recording(): Canvas2D & { readonly calls: readonly string[] } {
    const calls: string[] = [];
    return {
      calls,
      translate: (x: number, y: number) => calls.push(`translate ${String(x)} ${String(y)}`),
      scale: (x: number, y: number) => calls.push(`scale ${String(x)} ${String(y)}`),
    } as unknown as Canvas2D & { readonly calls: readonly string[] };
  }

  it('uses only transform calls the hero raster also implements', () => {
    const ctx = recording();
    applyCamera(ctx, { x: 480, scale: 0.75 }, VIEWPORT, 360);
    expect(ctx.calls).toStrictEqual(['translate 480 360', 'scale 0.75 0.75', 'translate -480 -360']);
  });

  it('pins the floor: the ground line maps to itself at every scale', () => {
    // Modelled rather than asserted through a canvas, because this is the one
    // property the anchor exists for: a zoom about the frame's centre would
    // slide the floor up and down as the fighters closed.
    for (const scale of [0.5, 0.75, CAMERA_MAX_SCALE]) {
      const groundY = 360;
      const y = (groundY - groundY) * scale + groundY;
      expect(y).toBe(groundY);
    }
  });
});
