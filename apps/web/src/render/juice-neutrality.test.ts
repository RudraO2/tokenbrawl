import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { buildDemoLog } from '../testing/demo-log';
import { ARENA_PALETTE } from './arena-palette';
import type { Canvas2D } from './canvas2d';
import { DEFAULT_JUICE_TUNING, buildJuiceTrack, type JuiceTuning } from './juice';
import { drawJuicedFrame } from './juice-draw';
import { drawFrame } from './renderer';
import { createVfxSheet, validateVfxSheetLayout, type VfxSheet } from './vfx-sheet';

/**
 * Story 9.5, INV-2 and AD-15: the juice must not touch the hash.
 *
 * Being precise about what these cases show, because the obvious version of
 * this test cannot fail. `film.finalStateHash` is computed by
 * `buildReplayFilm` *before* any drawing happens, so comparing three
 * already-computed hashes to each other compares three copies of one string.
 * That assertion is kept below -- it is cheap and it would catch a
 * `buildJuiceTrack` that somehow mutated the film -- but the load-bearing case
 * is `re-derives the same hash after the juice has drawn`: it runs the full
 * juiced paint path over every clock frame, twice, under two different
 * tunings, and only *then* rebuilds the film from the same `CommandLog` with a
 * fresh environment. If any of the drawing had reached back into a
 * `FighterState` -- directly, or by mutating something the film holds -- the
 * freshly derived hash would move.
 *
 * What that demonstrates is a property of these inputs and this code as it
 * stands, not a theorem: nothing in the type system forbids a future edit from
 * writing through a `RenderFrame`. The test is the check.
 */

const VIEWPORT = { width: 960, height: 400 };

/** Records enough of each call to tell two drawings apart, and nothing more. */
function createRecordingCanvas(): Canvas2D & { readonly calls: () => readonly string[] } {
  const calls: string[] = [];
  const surface = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    calls: () => calls,
  } as unknown as Canvas2D & { readonly calls: () => readonly string[] };

  const record = (op: string, args: readonly (number | string)[]): void => {
    calls.push(`${op}(${args.map((arg) => String(arg)).join(',')})@${surface.fillStyle}`);
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  // Story 11.2 records the rects: with an impact sheet loaded, `drawImage` is
  // the *only* op that differs from the sheetless run, so an argument-less
  // recorder would make "the two runs drew different things" unprovable.
  surface.drawImage = (_image, sx, sy, sw, sh, dx, dy, dw, dh) =>
    record('drawImage', [sx, sy, sw, sh, dx, dy, dw, dh]);
  surface.save = () => record('save', []);
  surface.restore = () => record('restore', []);
  surface.translate = (x, y) => record('translate', [x, y]);
  surface.scale = (x, y) => record('scale', [x, y]);

  return surface;
}

interface Run {
  readonly finalStateHash: string;
  readonly recordedStateHash: string;
  readonly matchesRecordedHash: boolean;
  readonly calls: readonly string[];
  readonly frameCount: number;
}

/** Replays the demo Match end to end with the given tuning, or with none at all. */
async function replayDrawing(tuning: JuiceTuning | null): Promise<Run> {
  const log = await buildDemoLog();
  const film = buildReplayFilm(log, createFighterEnvironment());
  const ctx = createRecordingCanvas();
  const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

  if (tuning === null) {
    // The juice module stripped: the Story 4.1 paint path, unchanged.
    for (const frame of film.frames) {
      drawFrame(ctx, frame, options);
    }
    return {
      finalStateHash: film.finalStateHash,
      recordedStateHash: film.recordedStateHash,
      matchesRecordedHash: film.matchesRecordedHash,
      calls: ctx.calls(),
      frameCount: film.frames.length,
    };
  }

  const track = buildJuiceTrack(film.frames, tuning);
  for (let index = 0; index < track.frameCount; index += 1) {
    drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), options);
  }
  return {
    finalStateHash: film.finalStateHash,
    recordedStateHash: film.recordedStateHash,
    matchesRecordedHash: film.matchesRecordedHash,
    calls: ctx.calls(),
    frameCount: track.frameCount,
  };
}

/**
 * Story 11.2. A sheet in the shape of the shipped one, bound to a fake image.
 *
 * Built through the real `validateVfxSheetLayout`/`createVfxSheet` rather than
 * stubbed, so this exercises the same code the page runs. The numbers are a
 * hand copy of `public/fx/layout.json` and are not meant to track it: this
 * case is about the hash being indifferent to *any* sheet, so the particular
 * sheet is scenery. `juice.test.ts` owns the drift guard. The image is a bare
 * `{ width, height }` because that is all `createVfxSheet` needs of one, and
 * `drawImage`'s first argument is `unknown` by design in the port -- there is
 * no decoder and no DOM anywhere in this suite.
 */
const FX_IMAGE = '/fx/fx_sheet.png';

function fakeVfxSheet(): VfxSheet {
  return createVfxSheet(
    new Map([[FX_IMAGE, { width: 1_040, height: 1_040 }]]),
    validateVfxSheetLayout({
      frameWidth: 208,
      frameHeight: 208,
      poses: {
        spark_l: { image: FX_IMAGE, x: 0, y: 0, frames: 4, holdFrames: 3 },
        spark_h: { image: FX_IMAGE, x: 0, y: 208, frames: 4, holdFrames: 3 },
        ko_burst: { image: FX_IMAGE, x: 0, y: 832, frames: 5, holdFrames: 4 },
      },
    }),
  );
}

/** A tuning nothing about the shipped one survives: different holds, different shake. */
const RETUNED: JuiceTuning = Object.freeze({
  ...DEFAULT_JUICE_TUNING,
  hitstopFrames: Object.freeze({ hit: 1, heavy: 2, ko: 3 }),
  shakeCurve: Object.freeze([
    Object.freeze({ minDamage: 0, magnitude: 24, frames: 30 }),
    Object.freeze({ minDamage: 12, magnitude: 30, frames: 40 }),
  ]),
  sparks: Object.freeze({
    hit: Object.freeze({ count: 2, lifeFrames: 3 }),
    heavy: Object.freeze({ count: 3, lifeFrames: 4 }),
    ko: Object.freeze({ count: 4, lifeFrames: 5 }),
  }),
  damageNumberFrames: 4,
  damageNumberRisePx: 4,
});

describe('the juice layer is hash-neutral on the demo Match (AC4, INV-2, AD-15)', () => {
  it('re-derives the same hash after the juice has drawn, under two tunings', async () => {
    // The case that can actually fail. Hash first, then draw everything, then
    // derive the hash *again* from the same log with a fresh environment: a
    // drawing path that wrote back into a `FighterState` would show up as a
    // different hash on the second derivation, and nowhere else.
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const before = film.finalStateHash;
    const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

    for (const tuning of [DEFAULT_JUICE_TUNING, RETUNED]) {
      const ctx = createRecordingCanvas();
      const track = buildJuiceTrack(film.frames, tuning);
      for (let index = 0; index < track.frameCount; index += 1) {
        drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), options);
      }
      expect(ctx.calls().length).toBeGreaterThan(1_000);

      const rederived = buildReplayFilm(log, createFighterEnvironment());
      expect(rederived.finalStateHash).toBe(before);
      expect(rederived.finalStateHash).toBe(log.finalStateHash);
      expect(rederived.recordedStateHash).toBe(film.recordedStateHash);
      expect(rederived.matchesRecordedHash).toBe(true);
      // And the film the drawing read from is itself unchanged.
      expect(film.finalStateHash).toBe(before);
      expect(film.matchesRecordedHash).toBe(true);
    }
  });

  it('re-derives the same hash with the impact sheet loaded and with it absent (Story 11.2)', async () => {
    // The 11.2 half of the same claim, and it has to be its own case: the
    // tunings above never load a sheet, so every `drawImage` the impact path
    // issues went entirely unexercised by them. Two full juiced playbacks of
    // the demo Match -- one with the FX sheet, one without -- and the hash is
    // re-derived from the same `CommandLog` with a fresh environment after
    // each. Reading a sheet is a pure read; painting from one must not reach
    // back into a `FighterState`, and this is the check rather than the
    // assumption.
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const before = film.finalStateHash;
    const track = buildJuiceTrack(film.frames, DEFAULT_JUICE_TUNING);

    const drawn = new Map<string, readonly string[]>();
    for (const [label, vfx] of [
      ['with the sheet', fakeVfxSheet()],
      ['without it', undefined],
    ] as const) {
      const ctx = createRecordingCanvas();
      const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT, vfx };
      for (let index = 0; index < track.frameCount; index += 1) {
        drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), options);
      }
      expect(ctx.calls().length).toBeGreaterThan(1_000);
      drawn.set(label, ctx.calls());

      const rederived = buildReplayFilm(log, createFighterEnvironment());
      expect(rederived.finalStateHash).toBe(before);
      expect(rederived.finalStateHash).toBe(log.finalStateHash);
      expect(rederived.recordedStateHash).toBe(film.recordedStateHash);
      expect(rederived.matchesRecordedHash).toBe(true);
    }

    // And the film the drawing read from is itself unchanged, both times.
    expect(film.finalStateHash).toBe(before);
    expect(film.matchesRecordedHash).toBe(true);

    // Not vacuous: the sheet really did change the picture, and only by adding
    // sprites. Every other call is byte-identical, which is the fail-soft
    // promise stated as an equality rather than as an intention.
    const withSheet = drawn.get('with the sheet') ?? [];
    const without = drawn.get('without it') ?? [];
    expect(withSheet).not.toStrictEqual(without);
    expect(withSheet.filter((call) => call.startsWith('drawImage(')).length).toBeGreaterThan(0);
    expect(without.filter((call) => call.startsWith('drawImage('))).toStrictEqual([]);
    expect(withSheet.filter((call) => !call.startsWith('drawImage('))).toStrictEqual([...without]);
  });

  it('re-derives the same hash with the arcade HUD painted, reduced and not (Story 11.3, AC7)', async () => {
    // The 11.3 half. The arcade HUD reads more state than the flat one did --
    // `to` as well as `from`, and `progressBasisPoints` for the damage-lag
    // ghost -- and reading more state is exactly the circumstance under which a
    // presentation layer accidentally starts writing some of it back. AD-15
    // says it may not, and this is the check rather than the assumption.
    //
    // Both motion settings, because `reducedMotion` selects a different branch
    // through the armed gauge and a branch nothing exercises is a branch
    // nothing has cleared.
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const before = film.finalStateHash;
    const track = buildJuiceTrack(film.frames, DEFAULT_JUICE_TUNING);

    const drawn = new Map<boolean, readonly string[]>();
    for (const reducedMotion of [false, true]) {
      const ctx = createRecordingCanvas();
      const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT, reducedMotion };
      for (let index = 0; index < track.frameCount; index += 1) {
        drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), options);
      }
      expect(ctx.calls().length).toBeGreaterThan(1_000);
      drawn.set(reducedMotion, ctx.calls());

      const rederived = buildReplayFilm(log, createFighterEnvironment());
      expect(rederived.finalStateHash).toBe(before);
      expect(rederived.finalStateHash).toBe(log.finalStateHash);
      expect(rederived.recordedStateHash).toBe(film.recordedStateHash);
      expect(rederived.matchesRecordedHash).toBe(true);
    }

    expect(film.finalStateHash).toBe(before);
    expect(film.matchesRecordedHash).toBe(true);

    // The HUD is drawn on every frame of both playbacks, so a run that somehow
    // skipped it would still have satisfied every hash assertion above.
    for (const calls of drawn.values()) {
      expect(calls.some((call) => call.includes(ARENA_PALETTE.hudFrame))).toBe(true);
    }
  });

  it('produces one hash whether it is stripped, shipped or retuned', async () => {
    const log = await buildDemoLog();
    const [stripped, shipped, retuned] = await Promise.all([
      replayDrawing(null),
      replayDrawing(DEFAULT_JUICE_TUNING),
      replayDrawing(RETUNED),
    ]);

    for (const run of [stripped, shipped, retuned]) {
      // Byte-identical to each other and to what the log itself recorded.
      // Weaker than the case above -- each hash was computed before its run
      // drew anything -- but it does pin that `buildJuiceTrack` leaves the
      // film it was handed alone, and that the log's own recorded hash is the
      // value all three agree on rather than a shared wrong answer.
      expect(run.finalStateHash).toBe(stripped.finalStateHash);
      expect(run.recordedStateHash).toBe(stripped.recordedStateHash);
      expect(run.finalStateHash).toBe(log.finalStateHash);
      expect(run.matchesRecordedHash).toBe(true);
    }
  });

  it('really did draw three different things, so the case above is not vacuous', async () => {
    const [stripped, shipped, retuned] = await Promise.all([
      replayDrawing(null),
      replayDrawing(DEFAULT_JUICE_TUNING),
      replayDrawing(RETUNED),
    ]);

    // Every run drew something substantial.
    for (const run of [stripped, shipped, retuned]) {
      expect(run.calls.length).toBeGreaterThan(1_000);
    }
    // And the three differ, in the two ways the tuning is supposed to move:
    // how many clock frames the playback takes, and what lands on the canvas.
    expect(shipped.frameCount).toBeGreaterThan(stripped.frameCount);
    expect(retuned.frameCount).not.toBe(shipped.frameCount);
    expect(shipped.calls).not.toStrictEqual(stripped.calls);
    expect(retuned.calls).not.toStrictEqual(shipped.calls);
    // The shake is real: at least one stage translation is a non-zero offset.
    expect(
      shipped.calls.some((call) => call.startsWith('translate(') && !call.startsWith('translate(0,0)')),
    ).toBe(true);
  });

  it('draws the same calls twice for the same tuning: nothing here is random', async () => {
    // `Math.random` is banned on this path. A replay is a claim that a Match
    // reproduces, and a stage that rattled differently on each viewing would
    // quietly contradict it in the one place a visitor is looking.
    const [first, second] = await Promise.all([
      replayDrawing(DEFAULT_JUICE_TUNING),
      replayDrawing(DEFAULT_JUICE_TUNING),
    ]);

    expect(first.calls).toStrictEqual(second.calls);
  });

  it('presents every film frame exactly once as a live frame, however it is tuned', async () => {
    // Hash-neutrality is about the numbers; this is the visual half of the
    // same promise. A hitstop that dropped a film frame would make the juice
    // layer change what the replay *shows*, which is a different kind of lie
    // from changing what it hashes.
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());

    for (const tuning of [DEFAULT_JUICE_TUNING, RETUNED]) {
      const track = buildJuiceTrack(film.frames, tuning);
      const live = Array.from({ length: track.frameCount }, (_unused, index) => index)
        .filter((index) => !track.at(index).frozen)
        .map((index) => track.filmIndexAt(index));
      expect(live).toStrictEqual(film.frames.map((frame) => frame.index));
    }
  });
});
