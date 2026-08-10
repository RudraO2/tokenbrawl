import { beforeAll, describe, expect, it } from 'vitest';
import { ARENA_PALETTE } from '../render/arena-palette';
import {
  ARCADE_HUD_COLOURS,
  HP_HIGH_BANDS,
  HP_LOW_BANDS,
  HP_MID_BANDS,
} from '../render/hud';
import { THEME } from '../render/theme';
import { TRANSPARENT_INDEX } from './gif';
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
  it('leads with the five design colours, in table order', () => {
    // Still first and still in this order: the tests below and `gif.test.ts`
    // both index these slots by number, and the caption panel is page chrome
    // that uses nothing else. Story 11.3 appends rather than reorders for
    // exactly that reason.
    expect(heroPalette().slice(0, 5)).toStrictEqual([
      THEME.bg,
      THEME.ink,
      THEME.accent,
      THEME.warn,
      THEME.muted,
    ]);
  });

  it('carries every colour the arcade HUD can set, because the hero is the player', () => {
    // `hero/raster.ts` resolves `fillStyle` through a Map that throws on a
    // miss, so this is what turns a band table added to `hud.ts` and forgotten
    // here into a loud failure in the change that caused it rather than a
    // silent recolouring three stories later.
    for (const colour of ARCADE_HUD_COLOURS) {
      expect(heroPalette()).toContain(colour);
    }
  });

  it('fits the colour table it is encoded into, with the transparency slot spare', () => {
    // The GIF's global colour table is a fixed power of two and the last slot
    // is reserved. A palette that outgrew it would encode indices the decoder
    // reads as transparent -- a hero that silently developed holes.
    expect(heroPalette().length).toBeLessThanOrEqual(TRANSPARENT_INDEX);
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

  // 30s rather than vitest's default 5s. This renders a full hero frame twice
  // and compares every pixel, and it runs alongside every other file in the
  // workspace: alone it takes ~4.3s, under the parallel load of the whole suite
  // it has measured 5.9s and 6.3s and timed out. Story 12.1 recorded it as a
  // latent flake, Epic 12's new test files pushed it over the line, and a gate
  // that is green most of the time is worse than one that is red -- the honour
  // system this epic runs on depends on a red suite meaning something.
  it('draws the same frame identically twice, which is what makes the artefact drift-gateable', () => {
    expect(renderHeroFrame(state.scene, 30)).toStrictEqual(renderHeroFrame(state.scene, 30));
  }, 30_000);

  it('refuses a frame index the film does not have', () => {
    expect(() => renderHeroFrame(state.scene, state.scene.frames.length)).toThrow(/no film frame/);
  });

  it('puts every HUD block on the opening frame', () => {
    // A frame missing one of these means a HUD block silently stopped being
    // drawn, which is the defect this test has always existed to catch.
    //
    // Story 11.3 changes *which* colours say that. The health bars were the
    // accent and the warn; they are now banded from the arena's health ramps,
    // and the bar is built from a plate, a bevel and a frame that did not exist
    // before. So the assertion is restated in terms of what each colour means
    // rather than relaxed -- and it is written as an index lookup through
    // `heroPalette()` so that a palette reorder moves it rather than breaks it.
    const slot = (colour: string): number => heroPalette().indexOf(colour);
    const colours = coloursIn(renderHeroFrame(state.scene, 0));

    for (const colour of [
      THEME.bg, // the ground
      THEME.ink, // the caption text and the panel borders
      THEME.accent, // the caption bar, which is page chrome and still flat
      ARENA_PALETTE.hudPlate, // every bar sits on one
      ARENA_PALETTE.hudBevel, // ... and every filled bar is lit along its top
      ARENA_PALETTE.hudFrame, // ... and closed with a skewed outline
      HP_HIGH_BANDS[0], // both fighters open at full health
    ]) {
      expect(slot(colour)).toBeGreaterThanOrEqual(0);
      expect(colours.has(slot(colour)), colour).toBe(true);
    }
  });

  it('draws a damaged fighter and an armed gauge without the palette throwing (AC6)', () => {
    // The assertion that `heroPalette()` and `ARCADE_HUD_COLOURS` have not
    // drifted, made against the states that reach the *widest* set of colours:
    // a fighter low enough to be on the red ramp, and a gauge armed and
    // pulsing. `createRasterSurface` throws on an unpalettised `fillStyle`, so
    // a miss here is an exception rather than a wrong pixel.
    //
    // Every sampled frame rather than one: the hero runs a real Match, and the
    // frame that first reaches a tier boundary is not one this test should have
    // to know the index of.
    for (const index of heroFrameIndices(state.scene)) {
      expect(() => renderHeroFrame(state.scene, index)).not.toThrow();
    }
  });

  it('actually reaches more than one health tier, so the case above is not vacuous', () => {
    // A hero Match that never dropped a fighter below half would exercise the
    // green ramp and nothing else, and the sweep above would prove very little.
    const tiers = [HP_HIGH_BANDS[0], HP_MID_BANDS[0], HP_LOW_BANDS[0]].map((colour) =>
      heroPalette().indexOf(colour),
    );
    const seen = new Set<number>();
    for (const index of heroFrameIndices(state.scene)) {
      for (const value of coloursIn(renderHeroFrame(state.scene, index))) {
        if (tiers.includes(value)) {
          seen.add(value);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(1);
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
