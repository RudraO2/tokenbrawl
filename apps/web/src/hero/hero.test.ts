import { beforeAll, describe, expect, it } from 'vitest';
import { THEME } from '../render/theme';
import { buildHeroLog } from '../testing/hero-match';
import {
  HERO_ARENA_HEIGHT,
  HERO_DELAY_CENTISECONDS,
  HERO_FRAME_STRIDE,
  HERO_HEIGHT,
  HERO_WIDTH,
  STAND_IN_NOTICE,
  buildHeroScene,
  heroFrameIndices,
  heroGifFrames,
  heroPalette,
  renderHeroFrame,
  wrapCaption,
  type HeroScene,
} from './hero';

const ACCENT = 2;
const WARN = 3;

/** Palette indices present in a frame, as a set, so a colour assertion reads as one. */
function coloursIn(pixels: Uint8Array): ReadonlySet<number> {
  return new Set(pixels);
}

/** Whether a frame's caption label bar is the warn colour, which is the Reflex Mode state. */
function labelBarColour(pixels: Uint8Array): number {
  // A pixel inside the label bar: just past the panel's left border, a few rows
  // into the bar itself.
  const x = 24 + THEME.borderWidth + 2;
  const y = HERO_ARENA_HEIGHT + 16 + THEME.borderWidth + 2;
  return pixels[y * HERO_WIDTH + x];
}

describe('wrapCaption', () => {
  it('breaks on spaces and keeps every line within the column count', () => {
    const lines = wrapCaption('the quick brown fox jumps over the lazy dog', 12, 5);
    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('ellipsises rather than dropping the tail silently', () => {
    const lines = wrapCaption('one two three four five six seven eight nine ten', 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('...')).toBe(true);
  });

  it('cuts a word longer than the whole line rather than overflowing the panel', () => {
    const lines = wrapCaption('supercalifragilistic', 8, 4);
    expect(lines.every((line) => line.length <= 8)).toBe(true);
    expect(lines.join('')).toBe('supercalifragilistic');
  });

  it('keeps the ellipsis inside the column count too', () => {
    // Three dots are three characters. Appending them to a line already at the
    // limit is the overflow the truncation exists to prevent, wearing a
    // different name.
    for (const columns of [1, 2, 3, 4, 5]) {
      const lines = wrapCaption('alpha beta gamma delta epsilon zeta', columns, 2);
      expect(lines.every((line) => line.length <= columns)).toBe(true);
    }
  });

  it('returns nothing for a degenerate box instead of looping forever', () => {
    expect(wrapCaption('anything', 0, 3)).toStrictEqual([]);
    expect(wrapCaption('anything', 10, 0)).toStrictEqual([]);
    expect(wrapCaption('   ', 10, 3)).toStrictEqual([]);
  });
});

describe('the hero palette', () => {
  it('is exactly the five design colours, in table order', () => {
    expect(heroPalette()).toStrictEqual([THEME.bg, THEME.ink, THEME.accent, THEME.warn, THEME.muted]);
  });

  it('holds no duplicate, which would make two design colours indistinguishable in the GIF', () => {
    expect(new Set(heroPalette()).size).toBe(heroPalette().length);
  });
});

describe('the hero scene', () => {
  const state: { scene: HeroScene } = { scene: undefined as unknown as HeroScene };

  beforeAll(async () => {
    state.scene = buildHeroScene(await buildHeroLog());
  });

  it('samples every HERO_FRAME_STRIDEth film frame and keeps at least a second of them', () => {
    const indices = heroFrameIndices(state.scene);
    expect(indices[0]).toBe(0);
    expect(indices[1]).toBe(HERO_FRAME_STRIDE);
    expect(indices.length).toBe(Math.ceil(state.scene.frames.length / HERO_FRAME_STRIDE));
    expect(indices.length).toBeGreaterThan(60);
  });

  it('draws a frame at the declared size', () => {
    expect(renderHeroFrame(state.scene, 0)).toHaveLength(HERO_WIDTH * HERO_HEIGHT);
  });

  it('draws the same frame identically twice, which is what makes the artefact drift-gateable', () => {
    expect(renderHeroFrame(state.scene, 30)).toStrictEqual(renderHeroFrame(state.scene, 30));
  });

  it('refuses a frame index the film does not have', () => {
    expect(() => renderHeroFrame(state.scene, state.scene.frames.length)).toThrow(/no film frame/);
  });

  it('puts every design colour on the opening frame', () => {
    // Ground, ink, the accent health bar, the warn health bar, and the muted
    // Token Bank fill. A frame missing one of these means a HUD block silently
    // stopped being drawn.
    const colours = coloursIn(renderHeroFrame(state.scene, 0));
    expect([...colours].sort((a, b) => a - b)).toStrictEqual([0, 1, 2, 3, 4]);
  });

  it('shows the Token Bank draining and then exhausted (AC2)', () => {
    // Before exhaustion the caption bar is the accent colour; once the bank is
    // empty the whole label inverts to warn. Both states must actually occur in
    // the committed hero, or the animation shows only half the mechanic.
    const bars = heroFrameIndices(state.scene).map((index) =>
      labelBarColour(renderHeroFrame(state.scene, index)),
    );
    expect(bars).toContain(ACCENT);
    expect(bars).toContain(WARN);
    // And it drains in one direction: the first frame is never the empty state.
    expect(bars[0]).toBe(ACCENT);
  });

  it('carries a reasoning excerpt on the frame, not merely in the log (AC2)', () => {
    // The caption panel occupies the band below the arena. If it were not being
    // drawn, that band would be entirely ground.
    const pixels = renderHeroFrame(state.scene, 0);
    const panelBand = pixels.slice(HERO_ARENA_HEIGHT * HERO_WIDTH);
    expect(new Set(panelBand).size).toBeGreaterThan(1);
    expect(coloursIn(panelBand)).toContain(1);
  });

  it('states that the stand-in is not a live model', () => {
    expect(STAND_IN_NOTICE).toMatch(/NOT A LIVE MODEL/);
  });

  it('holds every frame for the same delay, which is INV-3 on the artefact', () => {
    // Nothing about how long a Deployment took to think may reach the screen,
    // and a per-Decision-Point frame delay is exactly how that would leak --
    // invisible in the image, and readable off the file by anyone who looked.
    const delays = new Set(heroGifFrames(state.scene).map((frame) => frame.delayCentiseconds));
    expect([...delays]).toStrictEqual([HERO_DELAY_CENTISECONDS]);
    expect(Number.isSafeInteger(HERO_DELAY_CENTISECONDS)).toBe(true);
    expect(HERO_DELAY_CENTISECONDS).toBeGreaterThan(0);
  });
});
