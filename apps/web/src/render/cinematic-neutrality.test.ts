import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { buildDemoLog } from '../testing/demo-log';
import type { Canvas2D } from './canvas2d';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack, type JuiceTuning } from './juice';
import { drawJuicedFrame } from './juice-draw';

/**
 * Story 10.4, AC2 and AD-15: the cinematic must not touch the hash.
 *
 * This is the story's central risk, and it is the reason the freeze is held by
 * the renderer at all. The reference stops both fighters for 90 ticks *inside
 * its simulation*; doing that here would move Tick counts, Match length, the
 * Decision Point budget and every Final-State Hash in the repository, turning
 * a presentation flourish into a balance change and invalidating every
 * committed Command Log. So the claim is asserted rather than argued.
 *
 * Being precise about what each case shows, in the same spirit as
 * `juice-neutrality.test.ts`. Comparing two already-computed
 * `film.finalStateHash` values compares two copies of one string, because
 * `buildReplayFilm` computes it before any drawing happens. The load-bearing
 * case is the first one below: it runs the whole juiced paint path over every
 * clock frame with the cinematic on, and only *then* rebuilds the film from
 * the same `CommandLog` with a fresh environment. A drawing path that had
 * reached back into a `FighterState` would show up there and nowhere else.
 *
 * ## Why this file replays `spectate-03` rather than the demo Match
 *
 * The demo Match contains no Ultimate at all -- both Baseline Bots are drawn
 * from `packages/env-fighter/src/bots.ts`, which never submits `special` --
 * so every case here would pass on it vacuously, with the cinematic code
 * never once reached. `spectate-03` is a committed Command Log in which the
 * random bot spends a full bar at tick 870 and connects. It is the only
 * Match in the repository that exercises this story, which is exactly why it
 * is the one the hash claim is made against.
 *
 * The demo Match still appears below, as the other half of the promise: a
 * Baseline Bot Match with no Ultimate must play back *completely unchanged*,
 * and "unchanged" is asserted as an identical canvas call sequence rather
 * than as an identical hash.
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

/**
 * The shipped tuning with the cinematic removed.
 *
 * `freezeFrames: 0` is the story's "disabled" configuration and it is a real
 * off switch rather than a zero-length hold: `buildJuiceTrack` skips the
 * derivation's output entirely at that value, so no clock frame carries a
 * cinematic record and no cinematic call reaches the canvas.
 */
const WITHOUT_CINEMATIC: JuiceTuning = Object.freeze({
  ...DEFAULT_JUICE_TUNING,
  cinematic: Object.freeze({ ...DEFAULT_JUICE_TUNING.cinematic, freezeFrames: 0 }),
});

const ARENA = arenaFor(DEFAULT_FIGHTER_CONFIG);
const OPTIONS = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

/** The one committed Command Log in this repository that contains an Ultimate. */
function ultimateLog(): unknown {
  return JSON.parse(
    readFileSync(`${process.cwd()}/public/replays/spectate-03.command-log.json`, 'utf8'),
  );
}

interface Run {
  readonly calls: readonly string[];
  readonly frameCount: number;
}

/** Replays a whole Match through the juiced paint path under one tuning. */
function replayDrawing(log: unknown, tuning: JuiceTuning): Run {
  const film = buildReplayFilm(log, createFighterEnvironment());
  const ctx = createRecordingCanvas();
  const track = buildJuiceTrack(film.frames, tuning, ARENA, false, DEFAULT_FIGHTER_CONFIG);
  for (let index = 0; index < track.frameCount; index += 1) {
    drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), OPTIONS);
  }
  return { calls: ctx.calls(), frameCount: track.frameCount };
}

describe('the Ultimate cinematic is hash-neutral (AC2, INV-2, AD-15)', () => {
  it('re-derives the same hash after the cinematic has drawn, with it on and with it off', () => {
    // The case that can actually fail. Hash first, draw the whole Match, then
    // derive the hash *again* from the same log with a fresh environment.
    const log = ultimateLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const before = film.finalStateHash;
    expect(film.matchesRecordedHash).toBe(true);

    for (const tuning of [DEFAULT_JUICE_TUNING, WITHOUT_CINEMATIC]) {
      const ctx = createRecordingCanvas();
      const track = buildJuiceTrack(film.frames, tuning, ARENA, false, DEFAULT_FIGHTER_CONFIG);
      for (let index = 0; index < track.frameCount; index += 1) {
        drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), OPTIONS);
      }
      expect(ctx.calls().length).toBeGreaterThan(1_000);

      const rederived = buildReplayFilm(log, createFighterEnvironment());
      expect(rederived.finalStateHash).toBe(before);
      expect(rederived.finalStateHash).toBe((log as { finalStateHash: string }).finalStateHash);
      expect(rederived.matchesRecordedHash).toBe(true);
      // And the film the drawing read from is itself unchanged.
      expect(film.finalStateHash).toBe(before);
      expect(film.matchesRecordedHash).toBe(true);
    }
  });

  it('hashes byte-identically with the cinematic layer enabled and disabled', () => {
    const log = ultimateLog();
    const on = buildReplayFilm(log, createFighterEnvironment());
    const trackOn = buildJuiceTrack(
      on.frames,
      DEFAULT_JUICE_TUNING,
      ARENA,
      false,
      DEFAULT_FIGHTER_CONFIG,
    );
    expect(trackOn.cinematics).toHaveLength(1);

    const off = buildReplayFilm(log, createFighterEnvironment());
    buildJuiceTrack(off.frames, WITHOUT_CINEMATIC, ARENA, false, DEFAULT_FIGHTER_CONFIG);

    expect(on.finalStateHash).toBe(off.finalStateHash);
    expect(on.recordedStateHash).toBe(off.recordedStateHash);
    // Tick count, Match length and the Decision Point budget are all
    // properties of the film, and the film is the same film either way. The
    // freeze exists on the *clock*, which is a different axis entirely.
    expect(on.frames.length).toBe(off.frames.length);
    expect(on.states.length).toBe(off.states.length);
    expect(on.states[on.states.length - 1].tick).toBe(off.states[off.states.length - 1].tick);
  });

  it('really did draw two different things, so the case above is not vacuous', () => {
    const log = ultimateLog();
    const shipped = replayDrawing(log, DEFAULT_JUICE_TUNING);
    const stripped = replayDrawing(log, WITHOUT_CINEMATIC);

    // The freeze is exactly the tuned count of extra clock frames, and no
    // other number: an off-by-one here would mean the hold and the record
    // disagree about how long the cinematic is.
    expect(shipped.frameCount).toBe(stripped.frameCount + DEFAULT_JUICE_TUNING.cinematic.freezeFrames);
    expect(shipped.calls).not.toStrictEqual(stripped.calls);
    expect(shipped.calls.length).toBeGreaterThan(stripped.calls.length);
  });

  it('leaves a Baseline Bot Match with no Ultimate completely unchanged', async () => {
    // The demo Match is bot-vs-bot and neither bot ever submits `special`, so
    // enabling the cinematic must change nothing at all about it -- not the
    // clock's length, and not one canvas call. Asserted as an identical call
    // sequence rather than as an identical hash, because a hash would pass
    // even if the drawing had changed completely.
    const log = await buildDemoLog();
    const shipped = replayDrawing(log, DEFAULT_JUICE_TUNING);
    const stripped = replayDrawing(log, WITHOUT_CINEMATIC);

    expect(shipped.frameCount).toBe(stripped.frameCount);
    expect(shipped.calls).toStrictEqual(stripped.calls);
    expect(shipped.calls.length).toBeGreaterThan(1_000);

    const film = buildReplayFilm(log, createFighterEnvironment());
    expect(
      buildJuiceTrack(film.frames, DEFAULT_JUICE_TUNING, ARENA, false, DEFAULT_FIGHTER_CONFIG)
        .cinematics,
    ).toStrictEqual([]);
  });

  it('draws the same calls twice for the same tuning: nothing here is random', () => {
    // The reference's super VFX draw from an ungoverned RNG. A replay is a
    // claim that a Match reproduces, and a cinematic that scattered differently
    // on each viewing would contradict that in the one place a visitor is
    // actually looking.
    const log = ultimateLog();
    expect(replayDrawing(log, DEFAULT_JUICE_TUNING).calls).toStrictEqual(
      replayDrawing(log, DEFAULT_JUICE_TUNING).calls,
    );
  });

  it('presents every film frame exactly once as a live frame, cinematic or not', () => {
    // Hash-neutrality is about the numbers; this is the visual half of the same
    // promise. A 90-frame freeze that swallowed a film frame would make the
    // cinematic change what the replay *shows*, which is a different kind of
    // lie from changing what it hashes.
    const film = buildReplayFilm(ultimateLog(), createFighterEnvironment());

    for (const tuning of [DEFAULT_JUICE_TUNING, WITHOUT_CINEMATIC]) {
      const track = buildJuiceTrack(film.frames, tuning, ARENA, false, DEFAULT_FIGHTER_CONFIG);
      const live = Array.from({ length: track.frameCount }, (_unused, index) => index)
        .filter((index) => !track.at(index).frozen)
        .map((index) => track.filmIndexAt(index));
      expect(live).toStrictEqual(film.frames.map((frame) => frame.index));
    }
  });
});
