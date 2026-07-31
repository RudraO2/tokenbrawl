import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_IDLE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
} from '../../../../packages/env-fighter/src/frames';
import {
  CLIP_FRAME_COUNTS,
  CLIP_NAMES,
  animationFor,
  type AnimationInput,
  type ClipName,
} from './animation';
import { createSpriteSheet, validateSpriteSheetLayout } from './sprite-sheet';

/**
 * Story 4.1: the layer that makes the frame data visible.
 *
 * Story 2.2 built Commitment Windows as a real state machine and the first
 * draft of this player expressed all of it as a rectangle changing colour. The
 * cases below are the claim that a viewer can now tell startup from active
 * from recovery -- which is the difference the whole game turns on, since the
 * punish window *is* the recovery tail.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT_PATH = join(HERE, '..', '..', 'public', 'sprites', 'martial-hero', 'layout.json');
const SPRITES_DIR = join(HERE, '..', '..', 'public', 'sprites', 'martial-hero');

function input(overrides: Partial<AnimationInput> = {}): AnimationInput {
  return {
    committedAction: COMMITTED_NONE,
    phase: PHASE_IDLE,
    health: 100,
    previousHealth: 100,
    movedUnits: 0,
    blocking: false,
    frameIndex: 0,
    ...overrides,
  };
}

describe('choosing an animation clip', () => {
  it('gives every Commitment Window phase its own clip', () => {
    const clips = new Set<ClipName>();
    for (const committedAction of [COMMITTED_ATTACK, COMMITTED_SPECIAL]) {
      for (const phase of [PHASE_STARTUP, PHASE_ACTIVE, PHASE_RECOVERY]) {
        clips.add(animationFor(input({ committedAction, phase })).clip);
      }
    }
    // Six distinct poses. A viewer that cannot tell recovery from startup
    // cannot see why a punish landed, which is the one thing the frame data
    // exists to make legible.
    expect(clips.size).toBe(6);
  });

  it('shows a Commitment Window even when the fighter is being hit', () => {
    // Deliberately ranked above `hit`. A fighter caught in recovery while
    // taking damage is the most instructive moment in the game, and a generic
    // flinch there would hide the mistake that lost the exchange.
    const state = animationFor(
      input({
        committedAction: COMMITTED_ATTACK,
        phase: PHASE_RECOVERY,
        health: 80,
        previousHealth: 100,
      }),
    );
    expect(state.clip).toBe('attack-recovery');
  });

  it('puts a KO above everything, including an open window', () => {
    expect(
      animationFor(input({ health: 0, committedAction: COMMITTED_SPECIAL, phase: PHASE_ACTIVE }))
        .clip,
    ).toBe('ko');
  });

  it('flinches on damage taken while free', () => {
    expect(animationFor(input({ health: 88, previousHealth: 100 })).clip).toBe('hit');
  });

  it('guards, walks and idles in that order of precedence', () => {
    expect(animationFor(input({ blocking: true, movedUnits: 40 })).clip).toBe('block');
    expect(animationFor(input({ movedUnits: -60 })).clip).toBe('walk');
    expect(animationFor(input({ movedUnits: 0 })).clip).toBe('idle');
  });

  it('walks on movement in either direction', () => {
    expect(animationFor(input({ movedUnits: 60 })).clip).toBe('walk');
    expect(animationFor(input({ movedUnits: -60 })).clip).toBe('walk');
  });

  it('reads no clock: the same state always yields the same clip and frame', () => {
    const state = input({ movedUnits: 60, frameIndex: 37 });
    expect(animationFor(state)).toStrictEqual(animationFor(state));
  });

  it('advances a looping clip with the playback frame, and never past its frame count', () => {
    const frames = new Set<number>();
    for (let frameIndex = 0; frameIndex < 120; frameIndex += 1) {
      const state = animationFor(input({ movedUnits: 60, frameIndex }));
      expect(state.frame).toBeGreaterThanOrEqual(0);
      expect(state.frame).toBeLessThan(CLIP_FRAME_COUNTS.walk);
      frames.add(state.frame);
    }
    // It must actually cycle, not sit on frame zero -- a "walk" that never
    // advances is the bug this case exists to catch.
    expect(frames.size).toBe(CLIP_FRAME_COUNTS.walk);
  });

  it('keeps a single-frame clip on its only frame', () => {
    for (let frameIndex = 0; frameIndex < 60; frameIndex += 1) {
      expect(animationFor(input({ health: 0, frameIndex })).frame).toBe(0);
    }
  });
});

describe('the committed Martial Hero sheet', () => {
  function layout(): ReturnType<typeof validateSpriteSheetLayout> {
    return validateSpriteSheetLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')));
  }

  /** Every PNG the layout names, with its real on-disk dimensions read from the IHDR chunk. */
  function realImages(): ReadonlyMap<string, { width: number; height: number }> {
    const images = new Map<string, { width: number; height: number }>();
    for (const clip of Object.values(layout().clips)) {
      if (images.has(clip.image)) {
        continue;
      }
      const bytes = readFileSync(join(SPRITES_DIR, clip.image.split('/').pop() ?? ''));
      images.set(clip.image, { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    }
    return images;
  }

  it('ships the CC0 licence text beside the art it licenses', () => {
    // The pack's own words. `docs/ASSETS.md` records where it came from; this
    // asserts the licence travels with the files rather than only with the doc.
    const licence = readFileSync(join(SPRITES_DIR, 'LICENSE.txt'), 'utf8');
    expect(licence).toContain('Creative Commons Zero');
  });

  it('supplies every clip the animation can ask for', () => {
    const clips = layout().clips;
    for (const name of CLIP_NAMES) {
      expect(clips[name].frames).toBeGreaterThanOrEqual(CLIP_FRAME_COUNTS[name]);
    }
  });

  it('fits inside the real PNGs on disk', () => {
    // The check that actually matters: a layout that over-runs its image draws
    // transparent nothing, which looks exactly like a fighter that vanished.
    expect(() => createSpriteSheet(realImages(), layout())).not.toThrow();
  });

  it('gives each Commitment Window phase a different slice of the same attack animation', () => {
    // This is the whole point of the sub-range layout. startup, active and
    // recovery come out of one file at three offsets, which is what a
    // Commitment Window is: one animation sliced by the frame data.
    const sheet = createSpriteSheet(realImages(), layout());
    const startup = sheet.frameFor('attack-startup', 0);
    const active = sheet.frameFor('attack-active', 0);
    const recovery = sheet.frameFor('attack-recovery', 0);

    expect(new Set([startup.image, active.image, recovery.image]).size).toBe(1);
    expect(startup.sx).toBeLessThan(active.sx);
    expect(active.sx).toBeLessThan(recovery.sx);
  });

  it('maps every clip and frame to a distinct source rectangle', () => {
    const sheet = createSpriteSheet(realImages(), layout());
    const seen = new Set<string>();
    for (const name of CLIP_NAMES) {
      for (let frame = 0; frame < CLIP_FRAME_COUNTS[name]; frame += 1) {
        const rect = sheet.frameFor(name, frame);
        seen.add(`${rect.image}:${String(rect.sx)}:${String(rect.sy)}`);
      }
    }
    // `special-active` and `special-recovery` overlap on one frame by design --
    // attack2.png has six frames and the phases need 3+2+2. Everything else is
    // distinct, and the overlap is exactly one.
    const total = CLIP_NAMES.reduce((sum, name) => sum + CLIP_FRAME_COUNTS[name], 0);
    expect(seen.size).toBe(total - 1);
  });

  it('clamps an out-of-range frame rather than reading outside the image', () => {
    const sheet = createSpriteSheet(realImages(), layout());
    // Clamped to what the *sheet* supplies, not to what the animation uses:
    // Martial Hero's run cycle is 8 frames and `animationFor` only reaches 4,
    // which is the "a richer sheet is a welcome upgrade" case working.
    const supplied = layout().clips.walk.frames;
    expect(supplied).toBeGreaterThan(CLIP_FRAME_COUNTS.walk);
    expect(sheet.frameFor('walk', 999)).toStrictEqual(sheet.frameFor('walk', supplied - 1));
    expect(sheet.frameFor('walk', -5)).toStrictEqual(sheet.frameFor('walk', 0));
  });

  it('anchors the feet inside the frame, so fighters stand on the floor', () => {
    const sheet = createSpriteSheet(realImages(), layout());
    expect(sheet.anchorY).toBeGreaterThan(0);
    expect(sheet.anchorY).toBeLessThanOrEqual(sheet.frameHeight);
  });
});

describe('rejecting an unusable sheet layout', () => {
  function clipsWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return Object.fromEntries(
      CLIP_NAMES.map((name) => [
        name,
        { image: '/sprites/x.png', x: 0, y: 0, frames: CLIP_FRAME_COUNTS[name], ...overrides },
      ]),
    );
  }

  function layoutWith(overrides: Record<string, unknown>): unknown {
    return { frameWidth: 200, frameHeight: 200, scale: 2, anchorY: 137, clips: clipsWith(), ...overrides };
  }

  it('rejects a missing clip, naming it', () => {
    const clips = clipsWith();
    delete clips.ko;
    expect(() => validateSpriteSheetLayout(layoutWith({ clips }))).toThrow(/no layout for clip "ko"/);
  });

  it('rejects a clip with fewer frames than the animation needs', () => {
    const clips = clipsWith();
    clips.walk = { image: '/sprites/x.png', x: 0, y: 0, frames: 1 };
    expect(() => validateSpriteSheetLayout(layoutWith({ clips }))).toThrow(
      /clip "walk" supplies 1 frame\(s\) but the animation needs 4/,
    );
  });

  it('rejects an off-origin image, which would break the offline guarantee', () => {
    const clips = clipsWith({ image: 'https://cdn.example.com/sheet.png' });
    expect(() => validateSpriteSheetLayout(layoutWith({ clips }))).toThrow(/must be same-origin/);
  });

  it('rejects a nonsensical frame size or scale', () => {
    expect(() => validateSpriteSheetLayout(layoutWith({ frameWidth: 0 }))).toThrow(
      /frameWidth must be a positive safe integer/,
    );
    expect(() => validateSpriteSheetLayout(layoutWith({ scale: -1 }))).toThrow(
      /scale must be a positive safe integer/,
    );
  });

  it('rejects an anchor below the bottom of a frame', () => {
    expect(() => validateSpriteSheetLayout(layoutWith({ anchorY: 999 }))).toThrow(
      /anchorY \(999\) is below the bottom of a frame/,
    );
  });

  it('rejects an image too small for the layout it claims', () => {
    const parsed = validateSpriteSheetLayout(layoutWith({}));
    const images = new Map([['/sprites/x.png', { width: 200, height: 200 }]]);
    expect(() => createSpriteSheet(images, parsed)).toThrow(/needs .* of "\/sprites\/x\.png"/);
  });

  it('rejects a layout whose image was never loaded', () => {
    const parsed = validateSpriteSheetLayout(layoutWith({}));
    expect(() => createSpriteSheet(new Map(), parsed)).toThrow(/no image was loaded/);
  });
});
