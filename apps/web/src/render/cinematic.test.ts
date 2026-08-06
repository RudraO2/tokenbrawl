import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_IDLE,
  ZONE_NONE,
  phaseOf,
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { createPlaybackClock } from '../player/clock';
import { BASIS_POINTS_FULL, FRAMES_PER_DECISION, buildReplayFilm, type RenderFrame } from '../replay/film';
import { animationFor } from './animation';
import type { Canvas2D } from './canvas2d';
import {
  DEFAULT_JUICE_TUNING,
  arenaFor,
  buildJuiceTrack,
  deriveCinematicEvents,
  type JuiceTuning,
} from './juice';
import { drawJuicedFrame } from './juice-draw';
import { liveWindow, ticksIntoDecision } from './renderer';

/**
 * Story 10.4, the derivation and seek-safety half.
 *
 * `cinematic-neutrality.test.ts` owns the hash claim. This file owns the two
 * things that would still be wrong with a perfectly hash-neutral cinematic:
 * that it fires on the right film frame at all, and that it is a pure function
 * of the frame index rather than a stepped effect.
 *
 * Hand-built films for the edges -- a whiff, an active run several frames
 * wide, an Ultimate on the last frame -- and the real `spectate-03` Match for
 * the cases that have to be about a real film. The demo Match cannot serve
 * here: neither Baseline Bot ever submits `special`, so every case would pass
 * with the cinematic code unreached.
 *
 * No fake timer anywhere, and nothing to fake: the only driver is
 * `createPlaybackClock` with a `requestFrame` that is a plain function call.
 */

const ARENA = arenaFor(DEFAULT_FIGHTER_CONFIG);
const CONFIG = DEFAULT_FIGHTER_CONFIG;
const VIEWPORT = { width: 960, height: 400 };
const OPTIONS = { config: CONFIG, viewport: VIEWPORT };
const SPECIAL_TOTAL_TICKS =
  CONFIG.specialWindow.startup + CONFIG.specialWindow.active + CONFIG.specialWindow.recovery;

function stateWith(overrides: Partial<FighterState> = {}): FighterState {
  return {
    tick: 0,
    rngState: 1,
    health: [100, 100],
    position: [320, 640],
    meter: [0, 0],
    commitmentRemaining: [0, 0],
    committedAction: [COMMITTED_NONE, COMMITTED_NONE],
    windowHitLanded: [0, 0],
    verticalPosition: [0, 0],
    airState: [PHASE_IDLE, PHASE_IDLE],
    committedZone: [ZONE_NONE, ZONE_NONE],
    juggleCount: [0, 0],
    ...overrides,
  };
}

/** Mirrors `film.ts`'s `toFrames` exactly: one state pair per Decision Point, 12 frames each. */
function filmOf(steps: readonly (readonly [FighterState, FighterState])[]): readonly RenderFrame[] {
  const frames: RenderFrame[] = [];
  for (const [step, pair] of steps.entries()) {
    for (let offset = 0; offset < FRAMES_PER_DECISION; offset += 1) {
      frames.push({
        index: step * FRAMES_PER_DECISION + offset,
        decisionPoint: step,
        progressBasisPoints: Math.floor((offset * BASIS_POINTS_FULL) / FRAMES_PER_DECISION),
        from: pair[0],
        to: pair[1],
      });
    }
  }
  return frames;
}

/**
 * A Decision Point in which agent 0 commits an Ultimate, then one quiet one.
 *
 * The `to` state is what a committed window looks like at the *end* of the
 * step it opened in -- `commitmentRemaining` down by one Decision Point's
 * worth of Ticks -- which is the shape `liveWindow` reconstructs the
 * sub-Decision-Point phase from.
 */
function ultimateFilm(damageToOpponent: number): readonly RenderFrame[] {
  const before = stateWith({ health: [100, 100] });
  const after = stateWith({
    tick: CONFIG.ticksPerDecision,
    health: [100, 100 - damageToOpponent],
    committedAction: [COMMITTED_SPECIAL, COMMITTED_NONE],
    commitmentRemaining: [SPECIAL_TOTAL_TICKS - CONFIG.ticksPerDecision, 0],
  });
  const settled = stateWith({ tick: CONFIG.ticksPerDecision * 2, health: after.health });
  return filmOf([
    [before, after],
    [after, settled],
  ]);
}

/** The one committed Command Log in this repository that contains an Ultimate. */
function ultimateFilmFromLog(): ReturnType<typeof buildReplayFilm> {
  const log: unknown = JSON.parse(
    readFileSync(`${process.cwd()}/public/replays/spectate-03.command-log.json`, 'utf8'),
  );
  return buildReplayFilm(log, createFighterEnvironment());
}

function trackFor(frames: readonly RenderFrame[], tuning: JuiceTuning = DEFAULT_JUICE_TUNING) {
  return buildJuiceTrack(frames, tuning, ARENA, false, CONFIG);
}

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

describe('finding the Ultimate in the film (AC1)', () => {
  it('fires on the frame the active phase opens, not on the Decision Point boundary', () => {
    const film = ultimateFilm(22);
    const events = deriveCinematicEvents(film, CONFIG, ARENA);

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.agentIndex).toBe(0);
    expect(event.connected).toBe(true);

    // The load-bearing property, and the reason this reconstructs the window
    // rather than reading `frame.from`. `specialWindow` is 10 startup and 5
    // active Ticks, so the active phase opens and closes strictly *between*
    // two samples of the simulation -- frame 0 of the Decision Point is deep
    // in startup, and by frame 6 the window is already in recovery.
    expect(event.filmIndex).toBeGreaterThan(0);
    expect(event.filmIndex).toBeLessThan(FRAMES_PER_DECISION);

    const frame = film[event.filmIndex];
    const open = liveWindow(frame, 0, CONFIG, ticksIntoDecision(frame, CONFIG));
    expect(open.committedAction).toBe(COMMITTED_SPECIAL);
    expect(
      SPECIAL_TOTAL_TICKS - open.remaining,
    ).toBeGreaterThanOrEqual(CONFIG.specialWindow.startup);
    expect(SPECIAL_TOTAL_TICKS - open.remaining).toBeLessThan(
      CONFIG.specialWindow.startup + CONFIG.specialWindow.active,
    );
  });

  it('fires once per active run, however many frames the run spans', () => {
    // Under the shipped frame data the run is one film frame wide. A retuned
    // `specialWindow` with a longer active phase widens it, and a cinematic
    // that re-fired on each frame of the run would stop the stage several
    // times over for one Ultimate.
    const wide = {
      ...CONFIG,
      specialWindow: { startup: 4, active: 20, recovery: 40 },
    };
    const before = stateWith();
    const total = wide.specialWindow.startup + wide.specialWindow.active + wide.specialWindow.recovery;
    const after = stateWith({
      tick: wide.ticksPerDecision,
      health: [100, 78],
      committedAction: [COMMITTED_SPECIAL, COMMITTED_NONE],
      commitmentRemaining: [total - wide.ticksPerDecision, 0],
    });
    const film = filmOf([
      [before, after],
      [after, stateWith({ tick: 60, health: after.health })],
    ]);

    // The run really is several frames wide under this config...
    const activeFrames = film.filter((frame) => {
      const open = liveWindow(frame, 0, wide, ticksIntoDecision(frame, wide));
      return (
        open.committedAction === COMMITTED_SPECIAL &&
        phaseOf(wide, open.committedAction, open.remaining) === PHASE_ACTIVE
      );
    });
    expect(activeFrames.length).toBeGreaterThan(1);
    // ...and still produces exactly one cinematic.
    expect(deriveCinematicEvents(film, wide, ARENA)).toHaveLength(1);
  });

  it('freezes on a whiffed Ultimate but draws no impact mark', () => {
    // AC1 keys the freeze on the active phase, so a full-bar Action about to
    // miss is exactly as worth stopping for. AC5's flash, shake and impact
    // mark belong to the *connecting* case -- a whiff that still drew a hit
    // mark would be the juice layer claiming something the simulation did not
    // do.
    const [whiff] = deriveCinematicEvents(ultimateFilm(0), CONFIG, ARENA);
    expect(whiff.connected).toBe(false);

    const track = trackFor(ultimateFilm(0));
    const started = track
      .at(indexOfFirstCinematic(track))
      .cinematic;
    expect(started).not.toBeNull();
    expect(started?.reachBasisPoints).toBe(0);
    // The freeze itself still happened.
    expect(track.frameCount).toBe(
      ultimateFilm(0).length + DEFAULT_JUICE_TUNING.cinematic.freezeFrames,
    );
  });

  it('ignores every committed Action that is not the Ultimate', () => {
    const before = stateWith();
    const after = stateWith({
      tick: 30,
      health: [100, 93],
      committedAction: [COMMITTED_ATTACK, COMMITTED_NONE],
      commitmentRemaining: [10, 0],
    });
    expect(
      deriveCinematicEvents(filmOf([[before, after]]), CONFIG, ARENA),
    ).toStrictEqual([]);
  });

  it('finds the one Ultimate in the one committed Match that contains one', () => {
    const film = ultimateFilmFromLog();
    const cinematics = deriveCinematicEvents(film.frames, CONFIG, ARENA);

    expect(cinematics).toHaveLength(1);
    expect(cinematics[0].agentIndex).toBe(0);
    expect(cinematics[0].connected).toBe(true);

    // And it lands on the frame the fighter is actually *drawn* mid-Ultimate
    // on, which is what makes AC6's "reuse the existing special clips" true by
    // construction rather than by hope: the held film frame is a
    // `special-active` frame, so the freeze holds the art the pack ships for
    // exactly this moment.
    const frame = film.frames[cinematics[0].filmIndex];
    const open = liveWindow(frame, 0, CONFIG, ticksIntoDecision(frame, CONFIG));
    const animation = animationFor({
      committedAction: open.committedAction,
      phase: PHASE_ACTIVE,
      health: frame.to.health[0],
      previousHealth: frame.from.health[0],
      movedUnits: 0,
      blocking: false,
      frameIndex: frame.index,
    });
    expect(animation.clip).toBe('special-active');
  });
});

/** The first clock frame carrying a cinematic record. */
function indexOfFirstCinematic(track: ReturnType<typeof trackFor>): number {
  for (let index = 0; index < track.frameCount; index += 1) {
    if (track.at(index).cinematic !== null) {
      return index;
    }
  }
  throw new Error('indexOfFirstCinematic: this track has no cinematic');
}

describe('the freeze is counted in playback frames (AC1, AC3, INV-1, INV-3)', () => {
  it('holds the Ultimate\'s film frame for exactly the tuned count of extra clock frames', () => {
    const film = ultimateFilm(22);
    const track = trackFor(film);
    const start = indexOfFirstCinematic(track);
    const held = track.filmIndexAt(start);

    for (let age = 0; age <= DEFAULT_JUICE_TUNING.cinematic.freezeFrames; age += 1) {
      expect(track.filmIndexAt(start + age)).toBe(held);
      expect(track.at(start + age).cinematic?.age).toBe(age);
      // Every frame after the first is a re-present, not a fresh film frame.
      expect(track.at(start + age).frozen).toBe(age > 0);
    }
    // And the film resumes on the very next frame it would have reached.
    expect(track.filmIndexAt(start + DEFAULT_JUICE_TUNING.cinematic.freezeFrames + 1)).toBe(held + 1);
    expect(track.at(start + DEFAULT_JUICE_TUNING.cinematic.freezeFrames + 1).cinematic).toBeNull();
  });

  it('retunes by a number, with no call site to go hunting for', () => {
    // This Ultimate connects for 22, so the film also owes one `heavy`
    // hitstop -- on a different film frame, and therefore a separate hold.
    // The baseline is measured rather than written down, so the case stays
    // about the cinematic's own count when the hitstop table is retuned.
    const film = ultimateFilm(22);
    const baseline = trackFor(film, {
      ...DEFAULT_JUICE_TUNING,
      cinematic: { ...DEFAULT_JUICE_TUNING.cinematic, freezeFrames: 0 },
    }).frameCount;

    for (const freezeFrames of [0, 1, 30, 90, 200]) {
      const tuning: JuiceTuning = {
        ...DEFAULT_JUICE_TUNING,
        cinematic: { ...DEFAULT_JUICE_TUNING.cinematic, freezeFrames },
      };
      expect(trackFor(film, tuning).frameCount).toBe(baseline + freezeFrames);
    }
  });

  it('takes the longer of a hitstop and a cinematic on one film frame, never their sum', () => {
    // Two holds on one film frame is a freeze nobody tuned. The same rule two
    // simultaneous hits already resolve by.
    const film = ultimateFilm(22);
    const shortFreeze: JuiceTuning = {
      ...DEFAULT_JUICE_TUNING,
      cinematic: { ...DEFAULT_JUICE_TUNING.cinematic, freezeFrames: 2 },
      hitstopFrames: { hit: 40, heavy: 40, ko: 40 },
    };
    // The hit fires on frame 0 of the Decision Point and the cinematic a few
    // frames later, so both holds exist and neither is the other's sum.
    const track = trackFor(film, shortFreeze);
    expect(track.frameCount).toBe(film.length + 40 + 2);
  });

  it('drops the cinematic on the final clock frame, where playback rests forever', () => {
    // Same class of reason `buildJuiceTrack` neutralises the shake there: a
    // title banner left on screen indefinitely reads as a broken layout rather
    // than as a finished Match.
    const film = ultimateFilm(22);
    const track = trackFor(film);
    expect(track.at(track.frameCount - 1).cinematic).toBeNull();
  });

  it('stills the cinematic under reduced motion without changing the track\'s shape', () => {
    const film = ultimateFilm(22);
    const full = buildJuiceTrack(film, DEFAULT_JUICE_TUNING, ARENA, false, CONFIG);
    const calm = buildJuiceTrack(film, DEFAULT_JUICE_TUNING, ARENA, true, CONFIG);

    // Same frame count and the same clock->film mapping, so the transport, the
    // scrub and every index-based assertion behave identically.
    expect(calm.frameCount).toBe(full.frameCount);
    for (let index = 0; index < full.frameCount; index += 1) {
      expect(calm.filmIndexAt(index)).toBe(full.filmIndexAt(index));
    }

    // What goes is the three motions the preference exists to switch off: a
    // full-stage luminance change, a moving particle field, and camera shake.
    const start = indexOfFirstCinematic(calm);
    for (let age = 0; age <= DEFAULT_JUICE_TUNING.cinematic.freezeFrames; age += 1) {
      const frame = calm.at(start + age);
      expect(frame.shakeX).toBe(0);
      expect(frame.shakeY).toBe(0);
      expect(frame.cinematic?.flash).toBe(false);
      expect(frame.cinematic?.streaks).toStrictEqual([]);
    }
    // The mark is still there, already at full reach rather than expanding.
    expect(calm.at(start).cinematic?.reachBasisPoints).toBe(
      full.at(indexOfFirstCinematic(full) + DEFAULT_JUICE_TUNING.cinematic.impactFrames).cinematic
        ?.reachBasisPoints,
    );
    // And the flash really was on without the preference, so this is not vacuous.
    expect(full.at(indexOfFirstCinematic(full)).cinematic?.flash).toBe(true);
  });
});

describe('the cinematic is a pure function of the frame index (AC4, Story 4.5)', () => {
  it('draws the identical call sequence for the same clock index twice', () => {
    const film = ultimateFilmFromLog();
    const track = trackFor(film.frames);
    const start = indexOfFirstCinematic(track);

    for (const index of [start, start + 1, start + 45, start + 90]) {
      const first = createRecordingCanvas();
      const second = createRecordingCanvas();
      drawJuicedFrame(first, film.frames[track.filmIndexAt(index)], track.at(index), OPTIONS);
      drawJuicedFrame(second, film.frames[track.filmIndexAt(index)], track.at(index), OPTIONS);
      expect(first.calls()).toStrictEqual(second.calls());
    }
  });

  it('reproduces identical frames when scrubbed backwards and forwards across the Ultimate', () => {
    // Story 4.5's seek-equals-play, aimed at the one span where a stepped
    // implementation would visibly break: a mutable effect list has no memory
    // of what it looked like 60 frames ago, so dragging back into a freeze
    // would leave the cinematic stuck, doubled, or gone.
    const film = ultimateFilmFromLog();
    const track = trackFor(film.frames);
    const start = indexOfFirstCinematic(track);
    const span = Array.from(
      { length: DEFAULT_JUICE_TUNING.cinematic.freezeFrames + 20 },
      (_unused, offset) => start - 10 + offset,
    );

    const paint = (index: number): readonly string[] => {
      const ctx = createRecordingCanvas();
      drawJuicedFrame(ctx, film.frames[track.filmIndexAt(index)], track.at(index), OPTIONS);
      return ctx.calls();
    };

    // Played forwards through the whole cinematic...
    const played = new Map(span.map((index) => [index, paint(index)]));
    // ...then dragged backwards over it, then forwards again.
    for (const index of [...span].reverse()) {
      expect(paint(index)).toStrictEqual(played.get(index));
    }
    for (const index of span) {
      expect(paint(index)).toStrictEqual(played.get(index));
    }
  });

  it('agrees with a clock that actually walked there, one callback at a time', () => {
    // The transport half of the same claim. `createPlaybackClock` advances
    // exactly one frame per callback and reads no time at all, so walking to a
    // frame and seeking to it must produce the same juice.
    const film = ultimateFilmFromLog();
    const track = trackFor(film.frames);
    const target = indexOfFirstCinematic(track) + 40;

    const walked: number[] = [];
    const clock = createPlaybackClock({
      frameCount: track.frameCount,
      onFrame: (index) => {
        walked.push(index);
        if (index >= target) {
          clock.stop();
        }
      },
      requestFrame: (callback) => {
        callback();
        return 1;
      },
    });
    clock.start();

    expect(walked[walked.length - 1]).toBe(target);
    expect(track.at(target).cinematic).not.toBeNull();

    const seeked = trackFor(film.frames);
    expect(seeked.at(target)).toStrictEqual(track.at(target));
    expect(seeked.filmIndexAt(target)).toBe(track.filmIndexAt(target));
  });
});
