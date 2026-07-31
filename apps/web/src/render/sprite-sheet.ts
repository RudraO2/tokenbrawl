import { CLIP_FRAME_COUNTS, CLIP_NAMES, type ClipName } from './animation';

/**
 * Story 4.1: loading a sprite sheet, and the contract a sheet must meet.
 *
 * The art that ships is the **Martial Hero** pack by LuizMelo, Creative
 * Commons Zero -- the pack this project's brief and PRD named from the start.
 * Its licence text travels with it in
 * `public/sprites/martial-hero/LICENSE.txt`, and `docs/ASSETS.md` records
 * where it came from and when the licence was read.
 *
 * ## Why the layout is this shape
 *
 * A real pack is not one tidy sheet. Martial Hero ships nine PNGs with
 * different frame counts (Idle 8, Run 8, Attack1 6, Attack2 6, Death 6, Take
 * Hit 4), and this game's eleven clips do not map one-to-one onto them: an
 * attack's startup, active and recovery are three *sub-ranges of one file*,
 * because that is exactly what the Commitment Window is -- one animation
 * sliced by the frame data.
 *
 * So a clip names its own image and its own starting offset. That is what lets
 * `attack-startup`, `attack-active` and `attack-recovery` all read from
 * `attack1.png` at frames 0-1, 2-3 and 4-5, which is the entire reason a
 * viewer can see a punish land.
 *
 * Any other pack drops in by describing itself the same way. No rendering code
 * changes.
 */

/** The narrow image surface `drawImage` needs. Declared structurally, like `Canvas2D`. */
export interface SpriteImage {
  readonly width: number;
  readonly height: number;
}

export interface ClipLayout {
  /** Which image file this clip lives in. */
  readonly image: string;
  /** Pixel offset of the clip's first frame within that image. */
  readonly x: number;
  readonly y: number;
  readonly frames: number;
}

export interface SpriteSheetLayout {
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** Drawn size multiplier. A 200px frame whose character is 80px tall needs one. */
  readonly scale: number;
  /**
   * Where the character's feet sit inside a frame, in source pixels from the
   * top. Packs pad their frames generously and never agree on how much, so
   * this is data rather than a constant -- get it wrong and the fighter floats
   * or sinks through the floor.
   */
  readonly anchorY: number;
  readonly clips: Readonly<Record<string, ClipLayout>>;
}

export interface SpriteFrame {
  readonly image: string;
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
}

export interface SpriteSheet {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly scale: number;
  readonly anchorY: number;
  /** Every distinct image the layout references, so a caller knows what to load. */
  readonly imageUrls: readonly string[];
  imageFor(url: string): SpriteImage | undefined;
  /** Source rectangle for one frame of one clip. Clamped, never out of bounds. */
  frameFor(clip: ClipName, frame: number): SpriteFrame;
}

function fail(detail: string): never {
  throw new Error(`Sprite sheet layout is unusable: ${detail}`);
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
 * Every clip in `CLIP_NAMES` must be present, and none may promise fewer
 * frames than `CLIP_FRAME_COUNTS` needs -- a short clip means `frameFor`
 * clamps and the pose stops advancing halfway through a Commitment Window,
 * which looks like a fighter that froze rather than like a bug.
 */
export function validateSpriteSheetLayout(candidate: unknown): SpriteSheetLayout {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    fail('the document is not an object');
  }

  const layout = candidate as Record<string, unknown>;
  const frameWidth = positiveInteger(layout.frameWidth, 'frameWidth');
  const frameHeight = positiveInteger(layout.frameHeight, 'frameHeight');
  const scale = positiveInteger(layout.scale, 'scale');
  const anchorY = nonNegativeInteger(layout.anchorY, 'anchorY');
  if (anchorY > frameHeight) {
    fail(`anchorY (${String(anchorY)}) is below the bottom of a frame (${String(frameHeight)})`);
  }

  if (typeof layout.clips !== 'object' || layout.clips === null) {
    fail('`clips` must be an object');
  }
  const clips = layout.clips as Record<string, unknown>;

  const validated: Record<string, ClipLayout> = {};
  for (const name of CLIP_NAMES) {
    const entry = clips[name];
    if (typeof entry !== 'object' || entry === null) {
      fail(`no layout for clip "${name}"`);
    }
    const record = entry as Record<string, unknown>;

    const image = record.image;
    if (typeof image !== 'string' || image.trim().length === 0) {
      fail(`clips.${name}.image must be a non-empty string`);
    }
    if (image.startsWith('http://') || image.startsWith('https://')) {
      // Same reason the fonts are self-hosted: the site must render identically
      // offline and in CI, and a third-party host is a dependency someone else
      // can withdraw.
      fail(`clips.${name}.image must be same-origin, got ${image}`);
    }

    const frames = positiveInteger(record.frames, `clips.${name}.frames`);
    if (frames < CLIP_FRAME_COUNTS[name]) {
      fail(
        `clip "${name}" supplies ${String(frames)} frame(s) but the animation needs ${String(CLIP_FRAME_COUNTS[name])}`,
      );
    }

    validated[name] = Object.freeze({
      image,
      x: nonNegativeInteger(record.x, `clips.${name}.x`),
      y: nonNegativeInteger(record.y, `clips.${name}.y`),
      frames,
    });
  }

  return Object.freeze({
    frameWidth,
    frameHeight,
    scale,
    anchorY,
    clips: Object.freeze(validated),
  });
}

/**
 * Binds a validated layout to its loaded images.
 *
 * `frameFor` clamps rather than throwing. A clamp draws the clip's last frame,
 * which degrades visibly but sanely; throwing would abort the animation-frame
 * callback and freeze playback on whatever was last painted.
 */
export function createSpriteSheet(
  images: ReadonlyMap<string, SpriteImage>,
  layout: SpriteSheetLayout,
): SpriteSheet {
  const imageUrls = [...new Set(Object.values(layout.clips).map((clip) => clip.image))];

  for (const url of imageUrls) {
    const image = images.get(url);
    if (image === undefined) {
      fail(`no image was loaded for "${url}"`);
    }
    // Checked per clip rather than per image: two clips can share a file and
    // sit at different offsets, and only the rightmost one bounds its width.
    for (const [name, clip] of Object.entries(layout.clips)) {
      if (clip.image !== url) {
        continue;
      }
      const needed = clip.x + layout.frameWidth * clip.frames;
      if (needed > image.width || clip.y + layout.frameHeight > image.height) {
        fail(
          `clip "${name}" needs ${String(needed)}x${String(clip.y + layout.frameHeight)} of "${url}", ` +
            `which is ${String(image.width)}x${String(image.height)}`,
        );
      }
    }
  }

  return Object.freeze({
    frameWidth: layout.frameWidth,
    frameHeight: layout.frameHeight,
    scale: layout.scale,
    anchorY: layout.anchorY,
    imageUrls: Object.freeze(imageUrls),
    imageFor: (url: string) => images.get(url),

    frameFor(clip: ClipName, frame: number): SpriteFrame {
      const entry = layout.clips[clip];
      const column = Math.max(0, Math.min(entry.frames - 1, Math.floor(frame)));
      return {
        image: entry.image,
        sx: entry.x + column * layout.frameWidth,
        sy: entry.y,
        sw: layout.frameWidth,
        sh: layout.frameHeight,
      };
    },
  });
}
