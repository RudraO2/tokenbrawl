import type { SpriteImage } from './sprite-sheet';

/**
 * Story 11.2: the impact FX sheet, and the contract one must meet.
 *
 * The art is a 5x5 grid of 208x208 cells from the author's own prior fighting
 * game -- the same source, the same owner and the same basis as every sprite
 * pack and every audio cue already in `apps/web/public/`. `docs/ASSETS.md`
 * records its provenance; the bytes were copied and nothing else travelled
 * with them.
 *
 * ## Why this is a strip layout and not an atlas loader
 *
 * The source describes itself with a grid atlas -- `{ cell, grid, poses: {
 * cells: [...] } }` -- and porting that would mean a second sheet format in
 * this repo for no gain, because **every pose's cells are contiguous and stay
 * inside one row of the grid**. Cell *i* sits at
 * `(i % cols * cellW, floor(i / cols) * cellH)`, so a run of contiguous cells
 * inside one row *is* `{ x, y, frames }` with a fixed `frameWidth` -- exactly
 * the shape `sprite-sheet.ts` already reads. The layout beside the image is
 * therefore **authored in this repo**, not copied, and the grid arithmetic
 * happened once, at authoring time, rather than every page load.
 *
 * ## Why `holdFrames` is here and `impactFrames` is in the tuning
 *
 * The source atlas gives each pose an `fps`. That number describes the *art*:
 * how long a drawn cell is meant to hold. It is **not** a playback clock and
 * nothing here reads one (INV-1, INV-3) -- it is converted to an integer count
 * of clock frames when the layout is authored (20fps -> 3, 16fps -> 4) and
 * lives in the file as `holdFrames`, the only timing number in it.
 *
 * How long the whole impact is *on screen* is a different question, and it
 * belongs to `juice.ts`'s tuning table with every other effect duration. The
 * two must agree -- `impactFrames[kind] === frames * holdFrames` -- or the
 * sprite either freezes on its last cell or is cut off mid-pose, so
 * `juice.test.ts` reads this file from disk and asserts it.
 */

/** The poses this player asks the sheet for, one per `JuiceKind`. */
export const VFX_POSES = ['spark_l', 'spark_h', 'ko_burst'] as const;

export type VfxPose = (typeof VFX_POSES)[number];

export interface VfxPoseLayout {
  /** Which image file this pose lives in. */
  readonly image: string;
  /** Pixel offset of the pose's first cell within that image. */
  readonly x: number;
  readonly y: number;
  readonly frames: number;
  /**
   * Clock frames one atlas frame is held for.
   *
   * The source's `fps`, converted at authoring time. A description of the art,
   * never a duration read off a clock.
   */
  readonly holdFrames: number;
}

export interface VfxSheetLayout {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly poses: Readonly<Record<VfxPose, VfxPoseLayout>>;
}

export interface VfxFrame {
  readonly image: string;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

export interface VfxSheet {
  readonly frameWidth: number;
  readonly frameHeight: number;
  /**
   * Every distinct image the sheet was bound to, deduplicated.
   *
   * Deliberately **not** "so a caller knows what to load" -- by the time a
   * `VfxSheet` exists the images are already decoded and in hand, so nothing
   * can read this to decide what to fetch. `startup.ts` derives the same list
   * from the *layout* one step earlier, which is the only point at which the
   * question is still open. What this is for is introspection after the fact:
   * `imageFor` returns `undefined` for anything outside it, and the tests use
   * it to say which files a given layout ended up depending on.
   */
  readonly imageUrls: readonly string[];
  imageFor(url: string): SpriteImage | undefined;
  /** Source rectangle for one pose at one age. Clamped, never out of bounds. */
  frameFor(pose: VfxPose, ageFrames: number): VfxFrame;
  /** Clock frames the pose's whole animation occupies: `frames * holdFrames`. */
  lifeFramesFor(pose: VfxPose): number;
}

function fail(detail: string): never {
  throw new Error(`Impact FX layout is unusable: ${detail}`);
}

/**
 * Any absolute reference: a scheme (`https:`, `data:`, `blob:`), a
 * protocol-relative `//host/…`, or the same thing spelled with backslashes.
 *
 * `sprite-sheet.ts` and `backdrop.ts` check the two `http` prefixes only,
 * which is the weaker half of this: `//cdn.example/fx.png` names another host
 * and passes that check untouched. This is `audio-bus.test.ts`'s pattern, the
 * one place in the repo that already got it right, and INV-8 is about the
 * *origin* rather than about the two spellings of one scheme.
 *
 * The backslash arm is the third spelling and it is not decoration: the URL
 * parser normalises `\` to `/` in the authority position of a special scheme,
 * so `\\cdn.example/fx.png` assigned to `img.src` resolves to
 * `https://cdn.example/fx.png` -- the off-origin fetch INV-8 forbids, from a
 * document this function has just called same-origin. A path under
 * `public/` has no legitimate use for a backslash, so any occurrence is
 * refused rather than only the leading pair.
 *
 * Every arm is anchored, and an anchored pattern is only as good as the string
 * it is anchored against -- which is why `parsedAs` below exists.
 */
const OFF_ORIGIN = /^[a-z][a-z0-9+.-]*:|^\/\/|\\/i;

/**
 * The string the URL parser will actually see, which is not the one in the file.
 *
 * WHATWG URL parsing **strips leading and trailing C0-and-space** and **removes
 * tab, LF and CR from anywhere** in the input before it resolves anything. So
 * `" //cdn.example/fx.png"` and `"ht\ntps://cdn.example/fx.png"` are both
 * `https://cdn.example/fx.png` by the time `img.src` fetches them, while
 * `OFF_ORIGIN`'s `^` arms -- tested against the raw text -- see a leading space
 * or an interrupted scheme and pass them as same-origin.
 *
 * That is the third instance of one bug: `//host` was closed, then the
 * backslash spelling, and both fixes widened the *pattern* while leaving the
 * *subject* untouched. The subject is normalised here instead, so the check
 * runs on what the browser will resolve rather than on what was typed.
 */
function parsedAs(image: string): string {
  return image.replace(/[\t\n\r]/g, '').trim();
}

function positiveInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${where} must be a positive safe integer, got ${String(value)}`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${where} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value as number;
}

/**
 * Validates a layout document and returns it typed.
 *
 * Every pose in `VFX_POSES` must be present. A missing one is rejected rather
 * than defaulted, because the fallback for "no impact art" is the whole sheet
 * being absent -- a half-present sheet that silently drew a KO with the light
 * spark would be worse than no sheet at all, and it would be invisible.
 */
export function validateVfxSheetLayout(candidate: unknown): VfxSheetLayout {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    fail('the document is not an object');
  }

  const layout = candidate as Record<string, unknown>;
  const frameWidth = positiveInteger(layout.frameWidth, 'frameWidth');
  const frameHeight = positiveInteger(layout.frameHeight, 'frameHeight');
  if (frameWidth !== frameHeight) {
    // Refused rather than supported, because the drawing path cannot honour it:
    // `juice-draw.ts` sizes an impact from a single `impactSizePx` and passes it
    // as both destination dimensions, so a 208x104 cell would be drawn stretched
    // to a square with nothing reporting it. A rectangular sheet is a real thing
    // to want -- it just needs `impactSizePx` to become a pair first, and that is
    // a tuning change, not a silent one.
    fail(
      `frameWidth (${String(frameWidth)}) and frameHeight (${String(frameHeight)}) must match: ` +
        'impacts are drawn from one size',
    );
  }

  if (typeof layout.poses !== 'object' || layout.poses === null) {
    fail('`poses` must be an object');
  }
  const poses = layout.poses as Record<string, unknown>;

  const validated: Record<string, VfxPoseLayout> = {};
  for (const name of VFX_POSES) {
    const entry = poses[name];
    if (typeof entry !== 'object' || entry === null) {
      fail(`no layout for pose "${name}"`);
    }
    const record = entry as Record<string, unknown>;

    const image = record.image;
    if (typeof image !== 'string' || image.trim().length === 0) {
      fail(`poses.${name}.image must be a non-empty string`);
    }
    const resolved = parsedAs(image);
    if (resolved !== image || OFF_ORIGIN.test(resolved)) {
      // INV-8, for the reason `sprite-sheet.ts` gives: the site must render
      // identically offline and in CI, and a third-party host is a dependency
      // someone else can withdraw.
      //
      // `resolved !== image` is refused on its own rather than only when the
      // normalised form looks remote. A path under `public/` has no use for a
      // leading space or an embedded newline, and admitting one would mean this
      // function validates a different string from the one `img.src` fetches --
      // which is the whole hole, independent of what the difference spells.
      fail(`poses.${name}.image must be same-origin, got ${JSON.stringify(image)}`);
    }

    validated[name] = Object.freeze({
      image,
      x: nonNegativeInteger(record.x, `poses.${name}.x`),
      y: nonNegativeInteger(record.y, `poses.${name}.y`),
      frames: positiveInteger(record.frames, `poses.${name}.frames`),
      holdFrames: positiveInteger(record.holdFrames, `poses.${name}.holdFrames`),
    });
  }

  return Object.freeze({
    frameWidth,
    frameHeight,
    poses: Object.freeze(validated) as Readonly<Record<VfxPose, VfxPoseLayout>>,
  });
}

/**
 * Binds a validated layout to its loaded images.
 *
 * `frameFor` clamps rather than throwing, for the reason `createSpriteSheet`
 * gives: a clamp draws the pose's last cell, which degrades visibly but
 * sanely, where a throw would abort the animation-frame callback and freeze
 * playback on whatever was last painted. Bounds are checked *here*, once, at
 * creation -- so a layout that overruns its image is refused before it can
 * reach the paint path at all.
 */
export function createVfxSheet(
  images: ReadonlyMap<string, SpriteImage>,
  layout: VfxSheetLayout,
): VfxSheet {
  // A snapshot, not the caller's map. `ReadonlyMap` is a compile-time view of
  // a runtime-mutable object, and the bounds below run exactly once: a caller
  // that still holds the original could swap in a smaller image afterwards and
  // `frameFor` would hand `drawImage` a source rect past the end of it, which
  // is the silently-draws-nothing failure the checks exist to prevent.
  const owned = new Map(images);
  const imageUrls = [...new Set(Object.values(layout.poses).map((pose) => pose.image))];

  for (const url of imageUrls) {
    const image = owned.get(url);
    if (image === undefined) {
      fail(`no image was loaded for "${url}"`);
    }
    // Per pose rather than per image: several poses share one file at different
    // offsets, and only the rightmost and lowest of them bound it.
    for (const [name, pose] of Object.entries(layout.poses)) {
      if (pose.image !== url) {
        continue;
      }
      const needed = pose.x + layout.frameWidth * pose.frames;
      const neededHeight = pose.y + layout.frameHeight;
      if (needed > image.width || neededHeight > image.height) {
        fail(
          `pose "${name}" needs ${String(needed)}x${String(neededHeight)} of "${url}", ` +
            `which is ${String(image.width)}x${String(image.height)}`,
        );
      }
    }
  }

  return Object.freeze({
    frameWidth: layout.frameWidth,
    frameHeight: layout.frameHeight,
    imageUrls: Object.freeze(imageUrls),
    imageFor: (url: string) => owned.get(url),

    frameFor(pose: VfxPose, ageFrames: number): VfxFrame {
      const entry = layout.poses[pose];
      // Integer division, and the clamp is the whole point: an impact that
      // outlives its pose holds on the last cell rather than reading a source
      // rect past the end of the strip.
      //
      // `NaN` is excluded first, because `Math.max`/`Math.min` propagate it
      // rather than clamping it: a `NaN` age walks straight through both and
      // out into `sx`, and `drawImage` with a `NaN` source rect draws *nothing*
      // and reports nothing. The docblock on `frameFor` promises a rect that is
      // never out of bounds, and a silent no-op is the one way to break that
      // promise without a single number ever leaving the strip.
      //
      // Only `NaN`. The infinities are ordinary out-of-range ages and the two
      // clamps already handle them correctly -- `+Infinity` is past the end and
      // holds on the last cell, `-Infinity` is before the start and reads the
      // first -- so routing them through a zero would be the *wrong* frame,
      // quietly, in the name of safety.
      const age = Number.isNaN(ageFrames) ? 0 : Math.max(0, ageFrames);
      const advanced = Math.floor(age / entry.holdFrames);
      const column = Math.max(0, Math.min(entry.frames - 1, advanced));
      return {
        image: entry.image,
        sx: entry.x + column * layout.frameWidth,
        sy: entry.y,
        sw: layout.frameWidth,
        sh: layout.frameHeight,
      };
    },

    lifeFramesFor(pose: VfxPose): number {
      const entry = layout.poses[pose];
      return entry.frames * entry.holdFrames;
    },
  });
}
