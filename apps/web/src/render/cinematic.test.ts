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
  easeOutBackBasisPoints,
  easeOutCubicBasisPoints,
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

/**
 * The same Ultimate, followed by enough quiet Decision Points for the release
 * act to play out inside the film.
 *
 * `ultimateFilm` is two Decision Points long, which is all the freeze needs and
 * two thirds of what the release act does: the record runs 130 clock frames and
 * a 24-frame film plus a 90-frame freeze is 114. Rather than lengthen
 * `ultimateFilm` -- three existing cases assert `film.length + freezeFrames`
 * and would silently become about a different film -- the tail is added here,
 * where the cases that need it can ask for it.
 */
function longUltimateFilm(damageToOpponent: number): readonly RenderFrame[] {
  const before = stateWith({ health: [100, 100] });
  const after = stateWith({
    tick: CONFIG.ticksPerDecision,
    health: [100, 100 - damageToOpponent],
    committedAction: [COMMITTED_SPECIAL, COMMITTED_NONE],
    commitmentRemaining: [SPECIAL_TOTAL_TICKS - CONFIG.ticksPerDecision, 0],
  });
  const steps: (readonly [FighterState, FighterState])[] = [[before, after]];
  let previous = after;
  for (let step = 1; step <= 8; step += 1) {
    const settled = stateWith({
      tick: CONFIG.ticksPerDecision * (step + 1),
      health: after.health,
    });
    steps.push([previous, settled]);
    previous = settled;
  }
  return filmOf(steps);
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

  it('freezes on a whiffed Ultimate and still fires the beam, but marks no impact', () => {
    // AC1 keys the freeze on the active phase, so a full-bar Action about to
    // miss is exactly as worth stopping for.
    //
    // Story 11.4 splits what 10.4 treated as one thing. The *beam* is the
    // Action and fires either way -- the fighter threw it, and a release act
    // that only happened on a hit would be the presentation hiding half the
    // Ultimates in the game. The *impact* is the damage, and belongs to the
    // connecting case alone: a whiff that drew one would be the juice layer
    // claiming something the simulation did not do.
    const film = ultimateFilm(0);
    const [whiff] = deriveCinematicEvents(film, CONFIG, ARENA);
    expect(whiff.connected).toBe(false);

    const track = trackFor(film);
    const start = indexOfFirstCinematic(track);
    const shape = DEFAULT_JUICE_TUNING.cinematic;

    // The build act draws no beam at all, on a whiff or otherwise.
    expect(track.at(start).cinematic?.reachBasisPoints).toBe(0);

    // The release act does, and it is the same sweep a connecting Ultimate
    // gets -- the only difference is downstream.
    const releasing = track.at(start + shape.releaseFromFrame + shape.beamSweepFrames).cinematic;
    expect(releasing?.reachBasisPoints).toBeGreaterThan(0);
    expect(releasing?.connected).toBe(false);

    // The freeze itself still happened.
    expect(track.frameCount).toBe(film.length + shape.freezeFrames);
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
    // The *record* outlives the freeze by design (Story 11.4): the release act
    // plays over resumed playback, exactly as the reference lets its beam
    // window run after it nulls the cutscene. So the frame after the freeze is
    // unfrozen and still carries a cinematic.
    expect(track.at(start + DEFAULT_JUICE_TUNING.cinematic.freezeFrames + 1).frozen).toBe(false);
    expect(
      track.at(start + DEFAULT_JUICE_TUNING.cinematic.freezeFrames + 1).cinematic,
    ).not.toBeNull();
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
    const shape = DEFAULT_JUICE_TUNING.cinematic;
    const start = indexOfFirstCinematic(calm);
    const calmStart = start;
    const fullStart = indexOfFirstCinematic(full);
    for (let age = 0; age <= shape.freezeFrames; age += 1) {
      const frame = calm.at(calmStart + age);
      expect(frame.shakeX).toBe(0);
      expect(frame.shakeY).toBe(0);
      expect(frame.cinematic?.flashBasisPoints).toBe(0);
      expect(frame.cinematic?.streaks).toStrictEqual([]);
    }

    // Every act still happens on the same frames: the preference removes
    // motion, never the beat.
    for (const age of [0, shape.slamFromFrame, shape.slamFromFrame + shape.slamFrames]) {
      expect(calm.at(calmStart + age).cinematic?.act).toBe(
        full.at(fullStart + age).cinematic?.act,
      );
    }

    // Everything that would have moved is pinned at the value it settles on,
    // from the frame it first appears.
    expect(calm.at(calmStart + 1).cinematic?.letterboxPx).toBe(shape.letterboxHeightPx);
    expect(calm.at(calmStart + shape.portraitFromFrame).cinematic?.portraitBasisPoints).toBe(
      BASIS_POINTS_FULL,
    );
    expect(calm.at(calmStart).cinematic?.orbRadiusPx).toBe(shape.orbMaxPx);
    expect(calm.at(calmStart).cinematic?.bloomBasisPoints).toBe(0);
    // The beam is at full reach on the first frame of the release rather than
    // sweeping out to it.
    expect(calm.at(calmStart + shape.releaseFromFrame).cinematic?.reachBasisPoints).toBe(
      calm.at(calmStart + shape.releaseFromFrame + shape.beamSweepFrames).cinematic
        ?.reachBasisPoints,
    );

    // And none of that was already true without the preference, so this is not
    // vacuous in any of its five arms.
    expect(full.at(fullStart + shape.slamFromFrame).cinematic?.flashBasisPoints).toBeGreaterThan(0);
    expect(full.at(fullStart + 1).cinematic?.letterboxPx).toBeLessThan(shape.letterboxHeightPx);
    expect(full.at(fullStart).cinematic?.orbRadiusPx).toBeLessThan(shape.orbMaxPx);
    expect(full.at(fullStart + shape.releaseFromFrame).cinematic?.reachBasisPoints).toBeLessThan(
      full.at(fullStart + shape.releaseFromFrame + shape.beamSweepFrames).cinematic
        ?.reachBasisPoints ?? 0,
    );
    expect(full.at(fullStart + shape.portraitFromFrame + 1).cinematic?.streaks.length).toBe(
      shape.streakCount,
    );
  });
});

/**
 * The easings, pinned against values computed independently of the code under
 * test.
 *
 * Every expectation below is a **literal**, worked out from the standard
 * definitions in floating point and rounded, rather than from the
 * implementation's own staged-integer arithmetic. A test that re-derived the
 * curve the same way the curve derives it would be true of any curve and would
 * pin nothing -- the lesson Story 11.3 wrote into its triage log when every
 * pulse-cadence assertion turned out to be a statement about its own subject.
 */
describe('the easing curves are the reference own, in integer basis points', () => {
  it('sweeps the beam on easeOutCubic', () => {
    // 1 - (1 - t)^3 at t = 0, 1/4, 1/2, 3/4, 1.
    expect(easeOutCubicBasisPoints(0)).toBe(0);
    expect(easeOutCubicBasisPoints(2_500)).toBe(5_781);
    expect(easeOutCubicBasisPoints(1_000)).toBe(2_710);
    expect(easeOutCubicBasisPoints(5_000)).toBe(8_750);
    expect(easeOutCubicBasisPoints(7_500)).toBe(9_843);
    expect(easeOutCubicBasisPoints(BASIS_POINTS_FULL)).toBe(BASIS_POINTS_FULL);
  });

  it('never exceeds full, which is what distinguishes it from the back curve', () => {
    for (let t = 0; t <= BASIS_POINTS_FULL; t += 137) {
      expect(easeOutCubicBasisPoints(t)).toBeLessThanOrEqual(BASIS_POINTS_FULL);
      expect(easeOutCubicBasisPoints(t)).toBeGreaterThanOrEqual(0);
    }
  });

  it('slides the bars and the portrait on easeOutBack, overshoot included', () => {
    // 1 + 2.70158(t-1)^3 + 1.70158(t-1)^2. The endpoints are exact; the middle
    // values are the float curve to within a basis point of staging loss.
    expect(easeOutBackBasisPoints(0)).toBe(0);
    expect(easeOutBackBasisPoints(BASIS_POINTS_FULL)).toBe(BASIS_POINTS_FULL);
    expect(easeOutBackBasisPoints(1_000)).toBeCloseTo(4_088, -1);
    expect(easeOutBackBasisPoints(5_000)).toBeCloseTo(10_877, -1);

    // The overshoot is the whole reason this curve rather than a cubic: the
    // peak is ~1.0999 near t = 0.66, and it must be *above* full.
    const peak = Math.max(
      ...Array.from({ length: BASIS_POINTS_FULL + 1 }, (_unused, t) =>
        easeOutBackBasisPoints(t),
      ),
    );
    expect(peak).toBeGreaterThan(BASIS_POINTS_FULL);
    expect(peak).toBeCloseTo(10_999, -2);
  });

  it('clamps its input rather than extrapolating off either end', () => {
    expect(easeOutBackBasisPoints(-5_000)).toBe(0);
    expect(easeOutBackBasisPoints(BASIS_POINTS_FULL * 3)).toBe(BASIS_POINTS_FULL);
    expect(easeOutCubicBasisPoints(-1)).toBe(0);
    expect(easeOutCubicBasisPoints(BASIS_POINTS_FULL * 3)).toBe(BASIS_POINTS_FULL);
  });
});

/**
 * Story 11.4's first acceptance criterion is about *structure*: the Ultimate
 * reads as three acts. So the assertions here are about which act each frame
 * belongs to and what is on screen during it, against the reference's own tick
 * numbers written as literals -- 15, 78, 80, 8, 50 -- rather than against the
 * tuning fields those numbers live in. A test phrased in terms of
 * `shape.slamFromFrame` would hold for every value that field could take,
 * including the front-loaded one this story exists to replace.
 */
describe('the Ultimate plays as three acts (AC1, AC2)', () => {
  const shape = DEFAULT_JUICE_TUNING.cinematic;

  /** The cinematic record at one age, on the connecting Ultimate. */
  function at(age: number) {
    const track = trackFor(longUltimateFilm(22));
    const record = track.at(indexOfFirstCinematic(track) + age).cinematic;
    if (record === null || record === undefined) {
      throw new Error(`no cinematic at age ${String(age)}`);
    }
    return record;
  }

  it('is back-loaded: the flash is at frame 80, not at frame 0', () => {
    // The single sentence this story exists for. Story 10.4 flashed on frames
    // 0-2 and the reference flashes at tick 80; these assertions are the
    // difference, written as the literal frame numbers rather than as the
    // constant that holds them.
    expect(at(0).flashBasisPoints).toBe(0);
    expect(at(79).flashBasisPoints).toBe(0);
    expect(at(80).flashBasisPoints).toBeGreaterThan(0);
    // And it is one fall, not a strobe: strictly decreasing while it is up.
    expect(at(85).flashBasisPoints).toBeLessThan(at(80).flashBasisPoints);
    expect(at(89).flashBasisPoints).toBeGreaterThan(0);
    expect(at(90).flashBasisPoints).toBe(0);
  });

  it('labels each frame with the act it belongs to', () => {
    expect(at(0).act).toBe('build');
    expect(at(79).act).toBe('build');
    expect(at(80).act).toBe('slam');
    expect(at(89).act).toBe('slam');
    expect(at(90).act).toBe('release');
    // All three really occur in one cinematic, which is the criterion.
    const acts = new Set(Array.from({ length: 100 }, (_unused, age) => at(age).act));
    expect([...acts].sort()).toStrictEqual(['build', 'release', 'slam']);
  });

  it('builds an orb that accelerates to its maximum and then blooms', () => {
    // `age^2` rather than linear, pinned as the *value* a squared ramp produces
    // rather than as "less than the midpoint" -- which a straight ramp clears
    // by half a pixel and which therefore pinned nothing (mutation M2).
    //
    // At the halfway frame a squared ramp has covered a quarter of the span:
    // 3 + floor(27 / 4) = 9, worked out from the endpoints rather than read
    // back off the implementation. A linear ramp would be at 16.
    expect(at(39).orbRadiusPx).toBe(9);
    expect(at(0).orbRadiusPx).toBe(shape.orbMinPx);
    expect(at(78).orbRadiusPx).toBe(shape.orbMaxPx);
    // And the shape of the whole curve, not just one sample: the first half of
    // the build covers less than a third of the span, the second half more than
    // two thirds. True of any accelerating ramp, false of every straight one.
    const span = shape.orbMaxPx - shape.orbMinPx;
    expect(at(39).orbRadiusPx - shape.orbMinPx).toBeLessThan(span / 3);
    expect(shape.orbMaxPx - at(39).orbRadiusPx).toBeGreaterThan((span * 2) / 3);
    // Monotonic across the whole build, with no step backwards.
    for (let age = 1; age <= 78; age += 1) {
      expect(at(age).orbRadiusPx).toBeGreaterThanOrEqual(at(age - 1).orbRadiusPx);
    }
    // And the bloom is the last frames of the build, not the whole thing.
    expect(at(65).bloomBasisPoints).toBe(0);
    expect(at(66).bloomBasisPoints).toBe(0);
    expect(at(72).bloomBasisPoints).toBeGreaterThan(0);
    expect(at(79).bloomBasisPoints).toBeGreaterThan(at(72).bloomBasisPoints);
  });

  it('frames the shot: bars slide in over 15 frames with an overshoot, then retract', () => {
    expect(at(0).letterboxPx).toBe(0);
    // The overshoot is visible as a height *above* the settled one partway in,
    // which a non-overshooting ease could not produce.
    const heights = Array.from({ length: 16 }, (_unused, age) => at(age).letterboxPx);
    expect(Math.max(...heights)).toBeGreaterThan(shape.letterboxHeightPx);
    expect(at(15).letterboxPx).toBe(shape.letterboxHeightPx);
    expect(at(60).letterboxPx).toBe(shape.letterboxHeightPx);
    // Gone by the time the beam is sweeping, so the release plays over a stage
    // rather than inside a cutscene.
    expect(at(95).letterboxPx).toBe(0);
    expect(at(95).vignetteBasisPoints).toBe(0);
    expect(at(60).vignetteBasisPoints).toBeGreaterThan(0);
  });

  it('slides the caster in from frame 10 and not before', () => {
    expect(at(9).portraitBasisPoints).toBe(0);
    expect(at(10).portraitBasisPoints).toBe(0);
    expect(at(20).portraitBasisPoints).toBeGreaterThan(0);
    // Settled by frame 40 -- 10 plus the reference's 30-tick slide.
    expect(at(40).portraitBasisPoints).toBe(BASIS_POINTS_FULL);
    // Overshoots on the way, which is the same easeOutBack the bars use.
    const slide = Array.from({ length: 31 }, (_unused, offset) =>
      at(10 + offset).portraitBasisPoints,
    );
    expect(Math.max(...slide)).toBeGreaterThan(BASIS_POINTS_FULL);
  });

  it('releases a beam that sweeps out over 8 frames and then holds', () => {
    expect(at(79).reachBasisPoints).toBe(0);
    expect(at(80).reachBasisPoints).toBe(0);
    const swept = at(88).reachBasisPoints;
    expect(swept).toBeGreaterThan(0);
    // Sweeping, not snapping: an intermediate frame is strictly between.
    expect(at(83).reachBasisPoints).toBeGreaterThan(0);
    expect(at(83).reachBasisPoints).toBeLessThan(swept);
    // Then it holds rather than retracting, for the rest of the 50.
    expect(at(100).reachBasisPoints).toBe(swept);
    expect(at(129).reachBasisPoints).toBe(swept);
  });

  it('reaches the arena edge rather than stopping at the opponent', () => {
    // The reference's `Math.max(420, edgeLen)`. An Ultimate that stopped at the
    // fighter it hit would be a stick; the beam goes past them and the impact
    // art is what marks where it landed.
    const record = at(120);
    const separation = Math.abs(record.targetBasisPoints - record.casterBasisPoints);
    expect(record.reachBasisPoints).toBeGreaterThan(separation);
    expect(record.casterBasisPoints + record.reachBasisPoints).toBe(BASIS_POINTS_FULL);
  });

  it('marks the impact only once the beam has arrived, and only on a hit', () => {
    expect(at(80).impactCovers).toBe(false);
    expect(at(120).impactCovers).toBe(true);
    expect(at(120).impactBasisPoints).toBe(at(120).targetBasisPoints);
    // A whiff sweeps the same beam and never claims a connection.
    const whiff = trackFor(longUltimateFilm(0));
    const start = indexOfFirstCinematic(whiff);
    expect(whiff.at(start + 120).cinematic?.connected).toBe(false);
    expect(whiff.at(start + 120).cinematic?.reachBasisPoints).toBeGreaterThan(0);
  });

  it('covers nothing on the frame the beam fires, even at zero separation', () => {
    // A degenerate arena collapses both fighters onto one position, and a
    // separation of zero is satisfied by a reach of zero. Without the extra
    // term the impact would be marked as landed on the frame the beam fires,
    // before it has swept a single basis point.
    const collapsed = buildJuiceTrack(
      longUltimateFilm(22),
      DEFAULT_JUICE_TUNING,
      { min: 0, max: 0 },
      false,
      CONFIG,
    );
    const start = indexOfFirstCinematic(collapsed);
    const fired = collapsed.at(start + shape.releaseFromFrame).cinematic;
    expect(fired?.targetBasisPoints).toBe(fired?.casterBasisPoints);
    expect(fired?.reachBasisPoints).toBe(0);
    expect(fired?.impactCovers).toBe(false);
    // And it does cover once the sweep has started, so this is not vacuous.
    expect(
      collapsed.at(start + shape.releaseFromFrame + shape.beamSweepFrames).cinematic?.impactCovers,
    ).toBe(true);
  });

  it('runs 130 clock frames while freezing exactly 90 of them', () => {
    // The two numbers are deliberately different and that difference is the
    // story: the record outlives the freeze by the release act, which plays
    // over resumed playback. Written as literals so a retune of either field
    // cannot make this pass by moving both.
    expect(at(0).frames).toBe(130);
    expect(shape.freezeFrames).toBe(90);
    expect(shape.releaseFromFrame + shape.releaseFrames).toBe(130);
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
