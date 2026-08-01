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
const SPRITES_ROOT = join(HERE, '..', '..', 'public', 'sprites');
/** Both shipped packs. p1 and p2 use different characters, and both must satisfy the same contract. */
const PACKS = ['martial-hero', 'martial-hero-2'] as const;
const LAYOUT_PATH = join(SPRITES_ROOT, PACKS[0], 'layout.json');
const SPRITES_DIR = join(SPRITES_ROOT, PACKS[0]);

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

describe.each(PACKS)('sprite pack %s', (pack) => {
  const dir = join(SPRITES_ROOT, pack);

  function layout(): ReturnType<typeof validateSpriteSheetLayout> {
    return validateSpriteSheetLayout(JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')));
  }

  function realImages(): ReadonlyMap<string, { width: number; height: number }> {
    const images = new Map<string, { width: number; height: number }>();
    for (const clip of Object.values(layout().clips)) {
      if (images.has(clip.image)) {
        continue;
      }
      const bytes = readFileSync(join(dir, clip.image.split('/').pop() ?? ''));
      images.set(clip.image, { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    }
    return images;
  }

  it('ships its own CC0 licence text', () => {
    expect(readFileSync(join(dir, 'LICENSE.txt'), 'utf8')).toContain('Creative Commons Zero');
  });

  it('satisfies every clip the animation can ask for', () => {
    const clips = layout().clips;
    for (const name of CLIP_NAMES) {
      expect(clips[name].frames).toBeGreaterThanOrEqual(CLIP_FRAME_COUNTS[name]);
    }
  });

  it('fits inside its real PNGs on disk', () => {
    // The two packs have genuinely different frame counts -- pack 2's idle is 4
    // where pack 1's is 8, its attacks are 4 where pack 1's are 6. A layout that
    // over-runs its image draws transparent nothing, which looks exactly like a
    // fighter that vanished.
    expect(() => createSpriteSheet(realImages(), layout())).not.toThrow();
  });

  it('starts each Commitment Window phase on a different frame', () => {
    // Pack 2 has only four attack frames, so its phases overlap. What must hold
    // for both packs is that startup, active and recovery each *begin*
    // somewhere different -- otherwise a viewer cannot tell a punishable
    // recovery from an active hitbox, which is the whole point of the sprite
    // work.
    const sheet = createSpriteSheet(realImages(), layout());
    const starts = (['attack-startup', 'attack-active', 'attack-recovery'] as const).map(
      (clip) => sheet.frameFor(clip, 0).sx,
    );
    expect(new Set(starts).size).toBe(3);
    expect(starts).toStrictEqual([...starts].sort((a, b) => a - b));
  });
});

describe('the strike is actually reachable (regression)', () => {
  it('plays startup and active during a real Match, not only recovery', async () => {
    // The defect this pins: the film samples state at Decision Point
    // boundaries 30 ticks apart, an attack window is 40 ticks and opens ON a
    // boundary, so the 8 ticks in which the strike winds up and connects fall
    // strictly between two samples. A census over the demo Match found
    // attack-startup and attack-active on ZERO of 360 playback frames -- the
    // art was there, the clips were wired, and the swing was unreachable.
    const { createFighterEnvironment } = await import(
      '../../../../packages/env-fighter/src/environment'
    );
    const { DEFAULT_FIGHTER_CONFIG } = await import('../../../../packages/env-fighter/src/config');
    const { buildReplayFilm } = await import('../replay/film');
    const { drawFrame } = await import('./renderer');

    const log = JSON.parse(
      readFileSync(join(HERE, '..', '..', 'public', 'replays', 'demo.command-log.json'), 'utf8'),
    );
    const film = buildReplayFilm(log, createFighterEnvironment());

    const seen = new Set<string>();
    const spy = {
      id: 'spy',
      draw: (_ctx: unknown, f: { animation: { clip: string } }) => seen.add(f.animation.clip),
    };
    const noop = new Proxy(
      { fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: '', imageSmoothingEnabled: true, globalAlpha: 1 },
      { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : () => undefined) },
    );

    for (const frame of film.frames) {
      drawFrame(noop as never, frame, {
        config: DEFAULT_FIGHTER_CONFIG,
        viewport: { width: 960, height: 400 },
        artists: [spy as never, spy as never],
      });
    }

    expect(seen).toContain('attack-startup');
    expect(seen).toContain('attack-active');
    expect(seen).toContain('attack-recovery');
  });
});

/**
 * Story 4.3 found this by opening the page: the hit marker.
 *
 * Story 4.1 drew it as `globalAlpha = 0.55` over the whole 600x600 sprite
 * frame. That is a translucent surface, which docs/DESIGN.md bans outright, and
 * at three-times scale over a character occupying roughly 80 of its 200 source
 * pixels it painted a red pane across a third of the arena rather than a flash
 * on the fighter who was hit. Neither the unit suite nor the CSS style sweep
 * could see it -- one is a canvas call, the other reads declarations.
 */
describe('the hit marker (4.3)', () => {
  interface Call {
    readonly op: string;
    readonly args: readonly number[];
    readonly strokeStyle: string;
    readonly alpha: number;
  }

  async function drawHit(clip: string): Promise<readonly Call[]> {
    const { createSpriteArtist } = await import('./artist');
    const { THEME } = await import('./theme');
    const calls: Call[] = [];
    const surface: Record<string, unknown> = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: '',
      imageSmoothingEnabled: true,
      globalAlpha: 1,
    };
    const record = (op: string, args: readonly number[]): void => {
      calls.push({
        op,
        args,
        strokeStyle: String(surface.strokeStyle),
        alpha: Number(surface.globalAlpha),
      });
    };
    const ctx = new Proxy(surface, {
      get: (target, key: string) =>
        key in target
          ? target[key]
          : (...args: unknown[]): void => record(key, args.filter((a) => typeof a === 'number')),
      set: (target, key: string, value) => {
        target[key] = value;
        return true;
      },
    });

    const sheet = {
      frameWidth: 200,
      frameHeight: 200,
      scale: 3,
      anchorY: 120,
      frameFor: () => ({ image: 'x.png', sx: 0, sy: 0, sw: 200, sh: 200 }),
      imageFor: () => ({ width: 200, height: 200 }),
    };

    createSpriteArtist(sheet as never).draw(
      ctx as never,
      {
        x: 480,
        groundY: 360,
        facing: 1,
        phase: 0,
        committedAction: 0,
        agentIndex: 0,
        animation: { clip, frame: 0 },
      } as never,
      THEME,
    );
    return calls;
  }

  it('marks a hit with an opaque hard-edged stroke, never a translucent wash', async () => {
    const { THEME } = await import('./theme');
    const calls = await drawHit('hit');

    const stroke = calls.find((call) => call.op === 'strokeRect');
    expect(stroke?.strokeStyle).toBe(THEME.warn);
    // Opaque. This is the assertion the old implementation fails.
    expect(stroke?.alpha).toBe(1);
    expect(calls.every((call) => call.alpha === 1)).toBe(true);
    expect(calls.some((call) => call.op === 'fillRect')).toBe(false);
  });

  it('sizes the marker to the fighter, not to the sprite frame', async () => {
    const calls = await drawHit('hit');
    const stroke = calls.find((call) => call.op === 'strokeRect');

    // The frame is 200x200 at 3x = 600x600. A marker that size covers a third
    // of a 960-wide arena, which is what made the old wash unusable.
    const [, , width, height] = stroke?.args ?? [];
    expect(width).toBeLessThan(600 / 2);
    expect(height).toBeLessThan(600 / 2);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it('draws no marker at all when the fighter was not hit', async () => {
    const calls = await drawHit('idle');
    expect(calls.some((call) => call.op === 'strokeRect')).toBe(false);
  });
});
