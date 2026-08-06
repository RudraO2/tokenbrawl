import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { buildDemoLog } from '../testing/demo-log';
import type { Canvas2D } from './canvas2d';
import { DEFAULT_JUICE_TUNING, buildJuiceTrack, type JuiceTuning } from './juice';
import { drawJuicedFrame } from './juice-draw';
import { drawFrame } from './renderer';

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
    calls: () => calls,
  } as unknown as Canvas2D & { readonly calls: () => readonly string[] };

  const record = (op: string, args: readonly (number | string)[]): void => {
    calls.push(`${op}(${args.map((arg) => String(arg)).join(',')})@${surface.fillStyle}`);
  };

  surface.fillRect = (x, y, w, h) => record('fillRect', [x, y, w, h]);
  surface.strokeRect = (x, y, w, h) => record('strokeRect', [x, y, w, h]);
  surface.fillText = (text, x, y) => record('fillText', [text, x, y]);
  surface.clearRect = (x, y, w, h) => record('clearRect', [x, y, w, h]);
  surface.drawImage = () => record('drawImage', []);
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
