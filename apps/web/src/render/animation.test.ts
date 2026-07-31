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
const LAYOUT_PATH = join(HERE, '..', '..', 'public', 'sprites', 'fighter.layout.json');

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

describe('the committed sprite sheet', () => {
  it('supplies every clip the animation can ask for', () => {
    const layout = validateSpriteSheetLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')));
    for (const name of CLIP_NAMES) {
      expect(layout.clips[name].frames).toBeGreaterThanOrEqual(CLIP_FRAME_COUNTS[name]);
    }
  });

  it('gives every clip its own row, so no two poses collide', () => {
    const layout = validateSpriteSheetLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')));
    const rows = CLIP_NAMES.map((name) => layout.clips[name].row);
    expect(new Set(rows).size).toBe(CLIP_NAMES.length);
  });

  it('maps each clip and frame to a distinct source rectangle', () => {
    const layout = validateSpriteSheetLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')));
    const sheet = createSpriteSheet({ width: 4_096, height: 4_096 }, layout);

    const seen = new Set<string>();
    for (const name of CLIP_NAMES) {
      for (let frame = 0; frame < CLIP_FRAME_COUNTS[name]; frame += 1) {
        const rect = sheet.frameFor(name, frame);
        seen.add(`${String(rect.sx)}:${String(rect.sy)}`);
      }
    }
    const total = CLIP_NAMES.reduce((sum, name) => sum + CLIP_FRAME_COUNTS[name], 0);
    expect(seen.size).toBe(total);
  });

  it('clamps an out-of-range frame rather than reading outside the image', () => {
    // A clamp draws the clip's last frame, which degrades visibly but sanely.
    // Throwing would abort the animation-frame callback and freeze playback.
    const layout = validateSpriteSheetLayout(JSON.parse(readFileSync(LAYOUT_PATH, 'utf8')));
    const sheet = createSpriteSheet({ width: 4_096, height: 4_096 }, layout);

    const last = sheet.frameFor('walk', CLIP_FRAME_COUNTS.walk - 1);
    expect(sheet.frameFor('walk', 999)).toStrictEqual(last);
    expect(sheet.frameFor('walk', -5)).toStrictEqual(sheet.frameFor('walk', 0));
  });
});

describe('rejecting an unusable sheet layout', () => {
  function layoutWith(overrides: Record<string, unknown>): unknown {
    const clips = Object.fromEntries(
      CLIP_NAMES.map((name, row) => [name, { row, frames: CLIP_FRAME_COUNTS[name] }]),
    );
    return { image: '/sprites/fighter.png', frameWidth: 64, frameHeight: 96, clips, ...overrides };
  }

  it('rejects a missing clip, naming it', () => {
    const clips = Object.fromEntries(
      CLIP_NAMES.filter((name) => name !== 'ko').map((name, row) => [
        name,
        { row, frames: CLIP_FRAME_COUNTS[name] },
      ]),
    );
    expect(() => validateSpriteSheetLayout(layoutWith({ clips }))).toThrow(/no layout for clip "ko"/);
  });

  it('rejects a clip with fewer frames than the animation needs', () => {
    const clips = Object.fromEntries(
      CLIP_NAMES.map((name, row) => [name, { row, frames: name === 'walk' ? 1 : CLIP_FRAME_COUNTS[name] }]),
    );
    expect(() => validateSpriteSheetLayout(layoutWith({ clips }))).toThrow(
      /clip "walk" supplies 1 frame\(s\) but the animation needs 4/,
    );
  });

  it('rejects an off-origin image, which would break the offline guarantee', () => {
    expect(() =>
      validateSpriteSheetLayout(layoutWith({ image: 'https://cdn.example.com/sheet.png' })),
    ).toThrow(/must be same-origin/);
  });

  it('rejects a nonsensical frame size', () => {
    expect(() => validateSpriteSheetLayout(layoutWith({ frameWidth: 0 }))).toThrow(
      /frameWidth must be a positive safe integer/,
    );
  });

  it('rejects an image too small for the layout it claims', () => {
    const layout = validateSpriteSheetLayout(layoutWith({}));
    expect(() => createSpriteSheet({ width: 64, height: 96 }, layout)).toThrow(
      /image is 64x96 but the layout needs at least/,
    );
  });
});
