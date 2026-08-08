import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_NONE,
  PHASE_IDLE,
  ZONE_NONE,
} from '../../../../packages/env-fighter/src/frames';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { BASIS_POINTS_FULL, FRAMES_PER_DECISION, type RenderFrame } from '../replay/film';
import { buildReplayFilm } from '../replay/film';
import { buildDemoLog } from '../testing/demo-log';
import { createPlaybackClock } from '../player/clock';
import {
  DEFAULT_JUICE_TUNING,
  buildJuiceTrack,
  type CinematicEvent,
  type JuiceEvent,
  type JuiceTrack,
} from './juice';
import {
  DEFAULT_AUDIO_TUNING,
  buildAudioTrack,
  createAudioDirector,
  type AudioCue,
  type AudioSink,
  type AudioTuning,
} from './audio';

/**
 * Story 9.6, the pure half.
 *
 * Hand-built films rather than the demo Match, for the same reason
 * `juice.test.ts` uses them: the properties worth pinning are about *edges* --
 * a flurry inside the rate limit, a duck window that is restarted a frame
 * before it expires, an empty film -- and a real Match contains whichever of
 * those it happens to contain. The demo film appears in the one case that has
 * to be about a real film: seek-equals-play.
 *
 * There is no fake timer anywhere in this file, and there is nothing to fake.
 * The only driver is `createPlaybackClock` with a `requestFrame` that is a plain
 * function call: counting callbacks is the whole mechanism, in the audio layer
 * exactly as in the visual one.
 */

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

/** Mirrors `film.ts`'s frame layout: one state pair per Decision Point, only the first frame at progress zero. */
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

/** A film in which agent 1's health walks down the given path, one step per Decision Point. */
function healthFilm(path: readonly number[]): readonly RenderFrame[] {
  const steps: (readonly [FighterState, FighterState])[] = [];
  for (let step = 0; step + 1 < path.length; step += 1) {
    steps.push([
      stateWith({ health: [100, path[step]] }),
      stateWith({ health: [100, path[step + 1]] }),
    ]);
  }
  return filmOf(steps);
}

function trackFor(frames: readonly RenderFrame[]): JuiceTrack {
  return buildJuiceTrack(frames);
}

/** Every clock frame's cues, flattened with the frame they fire on. */
function cuesByFrame(
  frames: readonly RenderFrame[],
  tuning: AudioTuning = DEFAULT_AUDIO_TUNING,
): readonly { readonly clockIndex: number; readonly cue: AudioCue }[] {
  const juice = trackFor(frames);
  const audio = buildAudioTrack(juice, tuning);
  const found: { readonly clockIndex: number; readonly cue: AudioCue }[] = [];
  for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
    for (const cue of audio.at(clockIndex).cues) {
      found.push({ clockIndex, cue });
    }
  }
  return found;
}

/** Records what a sink was told, in order. Nothing else -- the graph is `audio-bus.test.ts`'s business. */
function createRecordingSink(): AudioSink & {
  readonly played: () => readonly string[];
  readonly gains: () => readonly string[];
  readonly unlocks: () => number;
  readonly stops: () => number;
} {
  const played: string[] = [];
  const gains: string[] = [];
  const counted = { unlocks: 0, stops: 0 };
  return Object.freeze({
    play: (cue: AudioCue): void => {
      played.push(`${cue.bus}:${cue.name}${cue.loop ? ':loop' : ''}`);
    },
    stopAll: (): void => {
      counted.stops += 1;
      played.push('stopAll');
    },
    setGains: (music: number, sfx: number, voice: number): void => {
      gains.push(`${String(music)}/${String(sfx)}/${String(voice)}`);
    },
    unlock: (): void => {
      counted.unlocks += 1;
    },
    played: () => played,
    gains: () => gains,
    unlocks: () => counted.unlocks,
    stops: () => counted.stops,
  });
}

describe('cue derivation, one bus per category (AC1)', () => {
  it('starts the music bed at clock frame 0, looping, and nowhere else', () => {
    const cues = cuesByFrame(healthFilm([100, 100]));
    const music = cues.filter(({ cue }) => cue.bus === 'music');

    expect(music).toHaveLength(1);
    expect(music[0].clockIndex).toBe(0);
    expect(music[0].cue).toStrictEqual({
      bus: 'music',
      name: DEFAULT_AUDIO_TUNING.music.name,
      loop: true,
    });
  });

  it('emits a kind-keyed SFX cue for a hit, a heavy and a KO', () => {
    // Three separate films, because a KO ends the fight and a heavy hit that
    // followed one would be filtered out by `deriveJuiceEvents` as damage to a
    // fighter already down.
    const light = cuesByFrame(healthFilm([100, 95])).filter(({ cue }) => cue.bus === 'sfx');
    const heavy = cuesByFrame(healthFilm([100, 80])).filter(({ cue }) => cue.bus === 'sfx');
    const ko = cuesByFrame(healthFilm([100, 0])).filter(({ cue }) => cue.bus === 'sfx');

    expect(light.map(({ cue }) => cue.name)).toStrictEqual([DEFAULT_AUDIO_TUNING.sfx.hit]);
    expect(heavy.map(({ cue }) => cue.name)).toStrictEqual([DEFAULT_AUDIO_TUNING.sfx.heavy]);
    expect(ko.map(({ cue }) => cue.name)).toStrictEqual([DEFAULT_AUDIO_TUNING.sfx.ko]);
    // And none of them loops. A looping one-shot is a stuck sound.
    for (const { cue } of [...light, ...heavy, ...ko]) {
      expect(cue.loop).toBe(false);
    }
  });

  it('adds a voice cue on a KO, on the same frame as its SFX cue', () => {
    const cues = cuesByFrame(healthFilm([100, 0]));
    const sfx = cues.find(({ cue }) => cue.bus === 'sfx');
    const voice = cues.find(({ cue }) => cue.bus === 'voice');

    expect(voice?.cue.name).toBe(DEFAULT_AUDIO_TUNING.voice.ko);
    expect(voice?.clockIndex).toBe(sfx?.clockIndex);
  });

  it('says nothing on an ordinary hit: the voice table names the KO only', () => {
    expect(cuesByFrame(healthFilm([100, 95])).filter(({ cue }) => cue.bus === 'voice')).toStrictEqual(
      [],
    );
  });

  it('puts a cue on the clock frame that presents its film frame, not on a hitstop hold (AC2)', () => {
    // The whole reason the track is indexed on the clock. The first Decision
    // Point is quiet, the second lands a hit; the hit's cue belongs on the clock
    // frame where the freeze *starts*, and on no frame of the freeze.
    const frames = healthFilm([100, 100, 88]);
    const juice = trackFor(frames);
    const audio = buildAudioTrack(juice);
    const sfxFrames: number[] = [];
    for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
      if (audio.at(clockIndex).cues.some((cue) => cue.bus === 'sfx')) {
        sfxFrames.push(clockIndex);
      }
    }

    expect(sfxFrames).toHaveLength(1);
    // The hit lands on film frame `FRAMES_PER_DECISION`, and no hitstop has been
    // inserted before it, so clock and film agree at exactly that index.
    expect(sfxFrames[0]).toBe(FRAMES_PER_DECISION);
    expect(juice.filmIndexAt(sfxFrames[0])).toBe(FRAMES_PER_DECISION);
    // The frames that follow are holds of the same film frame, and they are silent.
    expect(audio.at(sfxFrames[0] + 1).cues).toStrictEqual([]);
    expect(juice.filmIndexAt(sfxFrames[0] + 1)).toBe(FRAMES_PER_DECISION);
  });
});

describe('the duck window, as a value in the table rather than a scheduled restore', () => {
  it('holds the music down for exactly duckFrames and restores on the frame after', () => {
    // A shorter duck than the shipped 90 frames, so both edges of the window
    // land inside a two-Decision-Point film rather than past its end -- where
    // `at()`'s clamp would answer for the last frame and prove nothing.
    const brisk: AudioTuning = Object.freeze({ ...DEFAULT_AUDIO_TUNING, duckFrames: 10 });
    const audio = buildAudioTrack(trackFor(healthFilm([100, 0])), brisk);
    const start = 0;

    // The KO is the first Decision Point, so the voice cue lands on clock 0.
    expect(audio.at(start).cues.some((cue) => cue.bus === 'voice')).toBe(true);
    expect(audio.at(start).musicGainBasisPoints).toBe(brisk.duckBasisPoints);
    expect(audio.at(start + brisk.duckFrames - 1).musicGainBasisPoints).toBe(
      brisk.duckBasisPoints,
    );
    expect(start + brisk.duckFrames).toBeLessThan(audio.frameCount);
    expect(audio.at(start + brisk.duckFrames).musicGainBasisPoints).toBe(
      brisk.music.gainBasisPoints,
    );
  });

  it('restarts the window when a second voice line lands inside it', () => {
    // Two fighters, so the per-fighter rate limiter cannot be what suppresses
    // the second line: agent 0 goes down on the first Decision Point and agent 1
    // on the second, far enough apart that both speak.
    const first = stateWith({ health: [100, 100] });
    const second = stateWith({ health: [0, 100] });
    const third = stateWith({ health: [0, 0] });
    const frames = filmOf([
      [first, second],
      [second, third],
      [third, third],
    ]);
    // A shorter duck than the shipped one, purely so both edges of the restarted
    // window land inside a three-Decision-Point film instead of past its end.
    const brisk: AudioTuning = Object.freeze({ ...DEFAULT_AUDIO_TUNING, duckFrames: 30 });
    const juice = trackFor(frames);
    const audio = buildAudioTrack(juice, brisk);

    const voiceFrames: number[] = [];
    for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
      if (audio.at(clockIndex).cues.some((cue) => cue.bus === 'voice')) {
        voiceFrames.push(clockIndex);
      }
    }
    expect(voiceFrames).toHaveLength(2);
    const [firstVoice, secondVoice] = voiceFrames;
    // The second lands inside the first's window, which is the case worth pinning.
    expect(secondVoice - firstVoice).toBeLessThan(brisk.duckFrames);

    // Still ducked where the *first* window would have expired ...
    const wouldHaveExpired = firstVoice + brisk.duckFrames;
    expect(wouldHaveExpired).toBeLessThan(audio.frameCount);
    expect(audio.at(wouldHaveExpired).musicGainBasisPoints).toBe(brisk.duckBasisPoints);

    // ... and back at base only after the second's, which is what "restarts"
    // means when the window is a range of array entries.
    const restored = secondVoice + brisk.duckFrames;
    expect(restored).toBeLessThan(audio.frameCount);
    expect(audio.at(restored).musicGainBasisPoints).toBe(brisk.music.gainBasisPoints);
  });

  it('rests at the base level on the last clock frame, however late the KO landed', () => {
    // The shipped duck is 90 frames and every voice line in the shipped tuning
    // comes from a KO, which by definition lands near the end -- so the window
    // reaches the end of the track and playback stops inside it. Without the
    // final frame being restored, a finished Match would sit at a quarter
    // volume forever, which reads as a broken mix rather than as an ending.
    const audio = buildAudioTrack(trackFor(healthFilm([100, 0])));
    expect(audio.at(0).musicGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.duckBasisPoints);
    expect(audio.frameCount).toBeLessThan(DEFAULT_AUDIO_TUNING.duckFrames);
    expect(audio.at(audio.frameCount - 1).musicGainBasisPoints).toBe(
      DEFAULT_AUDIO_TUNING.music.gainBasisPoints,
    );
  });

  it('leaves the SFX and voice buses alone while the music bus is ducked', () => {
    // Independence stated on the pure side; `audio-bus.test.ts` states the same
    // thing about the graph. A duck that pulled the whole mix down would be a
    // volume control, not a mix.
    const audio = buildAudioTrack(trackFor(healthFilm([100, 0])));
    for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
      expect(audio.at(clockIndex).sfxGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.sfxGainBasisPoints);
      expect(audio.at(clockIndex).voiceGainBasisPoints).toBe(
        DEFAULT_AUDIO_TUNING.voiceGainBasisPoints,
      );
    }
    expect(audio.at(0).musicGainBasisPoints).not.toBe(DEFAULT_AUDIO_TUNING.music.gainBasisPoints);
  });
});

describe('the per-fighter voice rate limit', () => {
  /** A tuning whose voice table names every kind, so a flurry is expressible at all. */
  const CHATTY: AudioTuning = Object.freeze({
    ...DEFAULT_AUDIO_TUNING,
    voice: Object.freeze({ hit: 'vo_hit', heavy: 'vo_heavy', ko: 'vo_ko' }),
  });

  it('drops the second line when one fighter is hit twice inside the window', () => {
    // Two consecutive Decision Points, so the two hits are `FRAMES_PER_DECISION`
    // plus one hitstop apart -- comfortably inside a limit of 90.
    const patient: AudioTuning = Object.freeze({ ...CHATTY, voiceRateLimitFrames: 90 });
    const cues = cuesByFrame(healthFilm([100, 95, 90]), patient);

    expect(cues.filter(({ cue }) => cue.bus === 'voice')).toHaveLength(1);
    // And the SFX cue is untouched: the limiter is on the voice bus only.
    expect(cues.filter(({ cue }) => cue.bus === 'sfx')).toHaveLength(2);
  });

  it('lets the second line through once the window has passed', () => {
    const impatient: AudioTuning = Object.freeze({ ...CHATTY, voiceRateLimitFrames: 1 });
    const cues = cuesByFrame(healthFilm([100, 95, 90]), impatient);

    expect(cues.filter(({ cue }) => cue.bus === 'voice')).toHaveLength(2);
  });

  it('limits each fighter separately, so a trade does not silence one of them', () => {
    // Both fighters take damage in one Decision Point: two events on one film
    // frame, and both must speak. A global limiter would drop whichever came
    // second and lose the cue that says who went down.
    const before = stateWith({ health: [100, 100] });
    const after = stateWith({ health: [88, 91] });
    const patient: AudioTuning = Object.freeze({ ...CHATTY, voiceRateLimitFrames: 90 });
    const cues = cuesByFrame(filmOf([[before, after]]), patient);

    expect(cues.filter(({ cue }) => cue.bus === 'voice')).toHaveLength(2);
  });
});

describe('degenerate inputs answer rather than throw', () => {
  it('builds a zero-frame track from an empty film and answers with the neutral frame', () => {
    const audio = buildAudioTrack(buildJuiceTrack([]));

    expect(audio.frameCount).toBe(0);
    const frame = audio.at(0);
    expect(frame.cues).toStrictEqual([]);
    expect(frame.musicGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.music.gainBasisPoints);
    expect(frame.sfxGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.sfxGainBasisPoints);
    expect(frame.voiceGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.voiceGainBasisPoints);
  });

  it('clamps an out-of-range index at both ends', () => {
    const audio = buildAudioTrack(trackFor(healthFilm([100, 88])));

    expect(audio.at(-1)).toBe(audio.at(0));
    expect(audio.at(-10_000)).toBe(audio.at(0));
    expect(audio.at(audio.frameCount + 5)).toBe(audio.at(audio.frameCount - 1));
    expect(audio.at(Number.NaN)).toBe(audio.at(0));
  });

  it('keeps its frame count equal to the juice track it was built from', () => {
    // One index means one thing across both layers. A track that disagreed by
    // even one frame would put the duck on a different axis from the transport.
    const juice = trackFor(healthFilm([100, 88, 70, 0]));
    expect(buildAudioTrack(juice).frameCount).toBe(juice.frameCount);
  });
});

describe('the director tells playing apart from jumping (AC2)', () => {
  /** Plays the whole track through a real clock: one frame per callback, no timer anywhere. */
  function playThrough(frames: readonly RenderFrame[]): ReturnType<typeof createRecordingSink> {
    const juice = trackFor(frames);
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: buildAudioTrack(juice), sink });
    const clock = createPlaybackClock({
      frameCount: juice.frameCount,
      requestFrame: (callback) => {
        callback();
        return 1;
      },
      onFrame: (index) => {
        director.atFrame(index);
      },
    });
    clock.start();
    return sink;
  }

  it('fires each cue exactly once across a full playback', () => {
    const sink = playThrough(healthFilm([100, 88, 0]));

    // One music bed, one SFX per hit, one voice line on the KO.
    expect(sink.played().filter((entry) => entry.startsWith('music:'))).toHaveLength(1);
    expect(sink.played().filter((entry) => entry.startsWith('sfx:'))).toHaveLength(2);
    expect(sink.played().filter((entry) => entry.startsWith('voice:'))).toHaveLength(1);
  });

  it('writes the bus gains on every frame, including the silent ones', () => {
    const frames = healthFilm([100, 88]);
    const sink = playThrough(frames);
    expect(sink.gains()).toHaveLength(trackFor(frames).frameCount);
  });

  it('fires nothing on a seek, and re-applies the gains it seeked into', () => {
    const frames = healthFilm([100, 0]);
    const juice = trackFor(frames);
    const audio = buildAudioTrack(juice);
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: audio, sink });

    // Frame 0 is the first frame presented, so it fires -- that is the mount
    // paint. Then jump into the middle of the duck window.
    director.atFrame(0);
    const afterMount = sink.played().length;
    director.atFrame(40);
    director.atFrame(5);
    director.atFrame(40);

    expect(sink.played()).toHaveLength(afterMount);
    expect(sink.gains()).toHaveLength(4);
    expect(sink.gains()[1]).toBe(
      `${String(audio.at(40).musicGainBasisPoints)}/${String(audio.at(40).sfxGainBasisPoints)}/${String(audio.at(40).voiceGainBasisPoints)}`,
    );
  });

  it('does not re-fire a cue when the same frame is repainted', () => {
    // Reachable on every load: `mountPlayer` paints frame zero, then a sprite
    // pack decodes and repaints it, then the backdrop lands and repaints it
    // again. Three paints of one frame must be one music bed, not three.
    const sink = createRecordingSink();
    const director = createAudioDirector({
      track: buildAudioTrack(trackFor(healthFilm([100, 88]))),
      sink,
    });

    director.atFrame(0);
    director.atFrame(0);
    director.atFrame(0);

    // The heavy hit lands on film frame 0, so frame 0 carries the bed *and* its
    // SFX cue -- and three paints of it are still one of each.
    expect(sink.played()).toStrictEqual(['music:music_battle:loop', 'sfx:sfx_hit_h']);
  });

  it('resumes firing on the first ordinary advance after a seek', () => {
    // Scrubbing to just before a hit and letting go must still play the hit.
    const frames = healthFilm([100, 100, 88]);
    const juice = trackFor(frames);
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: buildAudioTrack(juice), sink });

    director.atFrame(0);
    director.atFrame(FRAMES_PER_DECISION - 1);
    expect(sink.played().filter((entry) => entry.startsWith('sfx:'))).toHaveLength(0);
    director.atFrame(FRAMES_PER_DECISION);
    expect(sink.played().filter((entry) => entry.startsWith('sfx:'))).toHaveLength(1);
  });

  it('stops everything and restarts the bed when Replay rewinds to frame 0', () => {
    // `clock.start()` rewinds and emits 0 next, and the sink outlives the
    // playback that started the loop -- so a Replay that merely "did not fire"
    // would leave the old bed running, and one that fired without stopping
    // would layer a second bed on top of it. Neither is a mix.
    const frames = healthFilm([100, 88]);
    const juice = trackFor(frames);
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: buildAudioTrack(juice), sink });

    for (let index = 0; index < juice.frameCount; index += 1) {
      director.atFrame(index);
    }
    const firstPass = sink.played().length;
    expect(sink.stops()).toBe(0);

    director.atFrame(0);

    expect(sink.stops()).toBe(1);
    // Stopped *before* the restart, or the stop would kill the bed it just
    // started.
    expect(sink.played().slice(firstPass)).toStrictEqual([
      'stopAll',
      'music:music_battle:loop',
      'sfx:sfx_hit_h',
    ]);
  });

  it('is a no-op with no sink, and still tracks position', () => {
    const director = createAudioDirector({
      track: buildAudioTrack(trackFor(healthFilm([100, 88]))),
      sink: null,
    });
    expect(() => {
      director.atFrame(0);
      director.atFrame(1);
      director.atFrame(-4);
      director.atFrame(Number.NaN);
    }).not.toThrow();
  });
});

/**
 * Story 10.5: the Ultimate's cue.
 *
 * `spectate-03` rather than a hand-built film, and for exactly the reason
 * `cinematic-neutrality.test.ts` gives: no Baseline Bot in
 * `packages/env-fighter/src/bots.ts` ever submits `special`, so a case built on
 * a synthesised film would either pass with the code under test unreached, or
 * need `liveWindow`'s phase reconstruction transcribed into this file. It is the
 * one committed Command Log in this repository that contains an Ultimate -- the
 * random bot spends a full bar at Tick 870 and connects.
 */
function ultimateFilm(): readonly RenderFrame[] {
  const log: unknown = JSON.parse(
    readFileSync(`${process.cwd()}/public/replays/spectate-03.command-log.json`, 'utf8'),
  );
  return buildReplayFilm(log, createFighterEnvironment()).frames;
}

/** The clock frames on which a cue of the given name begins. */
function framesNaming(track: ReturnType<typeof buildAudioTrack>, name: string): readonly number[] {
  const found: number[] = [];
  for (let clockIndex = 0; clockIndex < track.frameCount; clockIndex += 1) {
    if (track.at(clockIndex).cues.some((cue) => cue.name === name)) {
      found.push(clockIndex);
    }
  }
  return found;
}

describe("the Ultimate's cue (Story 10.5)", () => {
  it('is its own sample on the SFX bus, not a reuse of the heavy hit (AC1)', () => {
    // The acceptance criterion is about *teaching a listener*, so the assertion
    // is that the name differs from every other cue in the table -- a distinct
    // name is what buys a distinct file, and `docs/ASSETS.md` records that the
    // two files are different samples from the same source project.
    const juice = buildJuiceTrack(ultimateFilm());
    expect(juice.cinematics).toHaveLength(1);
    const audio = buildAudioTrack(juice);

    const fired = framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimate);
    expect(fired).toHaveLength(1);
    const cue = audio
      .at(fired[0])
      .cues.find((entry) => entry.name === DEFAULT_AUDIO_TUNING.ultimate);
    expect(cue?.bus).toBe('sfx');
    // A looping one-shot is a stuck sound, and this one would be stuck under a
    // 90-frame freeze with nothing to end it.
    expect(cue?.loop).toBe(false);

    expect(DEFAULT_AUDIO_TUNING.ultimate).not.toBe(DEFAULT_AUDIO_TUNING.sfx.heavy);
    const others = [
      DEFAULT_AUDIO_TUNING.music.name,
      ...Object.values(DEFAULT_AUDIO_TUNING.sfx),
      ...Object.values(DEFAULT_AUDIO_TUNING.voice),
    ];
    expect(others).not.toContain(DEFAULT_AUDIO_TUNING.ultimate);
  });

  it('fires on the frame the cinematic freeze opens on, and on none of its holds (AC2)', () => {
    // The story's second criterion, stated as the one index both layers key
    // off. If this ever drifts, the sound and the picture have stopped agreeing
    // about where the Ultimate is.
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice);
    const cinematic = juice.cinematics[0];
    const [fired] = framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimate);

    expect(juice.filmIndexAt(fired)).toBe(cinematic.filmIndex);
    // The live frame of the freeze, not one of the re-presents: age zero and
    // not flagged frozen.
    expect(juice.at(fired).frozen).toBe(false);
    expect(juice.at(fired).cinematic?.age).toBe(0);

    // And every hold that follows is silent. The whole freeze is 90 frames of
    // one film frame re-presented; a cue keyed on the film would fire on all of
    // them, which is the machine-gun failure the clock indexing exists to
    // prevent.
    const freeze = DEFAULT_JUICE_TUNING.cinematic.freezeFrames;
    for (let held = 1; held <= freeze; held += 1) {
      expect(juice.at(fired + held).filmIndex).toBe(cinematic.filmIndex);
      expect(audio.at(fired + held).cues).toStrictEqual([]);
    }
  });

  it('announces two Ultimates opening on one film frame exactly once', () => {
    // `buildJuiceTrack` already collapses this case to one freeze carrying one
    // caster. Two copies of one sample started on one frame is a flam, not a
    // bigger sound, so the audio layer collapses it the same way. Built by
    // handing the builder a track whose `cinematics` stream is doubled, because
    // no committed Command Log contains simultaneous Ultimates.
    const juice = buildJuiceTrack(ultimateFilm());
    const first = juice.cinematics[0];
    const doubled: JuiceTrack = Object.freeze({
      ...juice,
      cinematics: Object.freeze([
        first,
        Object.freeze({
          ...first,
          agentIndex: first.agentIndex === 0 ? 1 : 0,
        }) as CinematicEvent,
      ]),
    });

    expect(framesNaming(buildAudioTrack(doubled), DEFAULT_AUDIO_TUNING.ultimate)).toHaveLength(1);
  });

  it('names the cue nowhere at all in a Match with no Ultimate', async () => {
    // The other half of the promise, and the guard against the cue leaking onto
    // ordinary hits. The demo Match is Baseline Bot vs Baseline Bot.
    const film = buildReplayFilm(await buildDemoLog(), createFighterEnvironment());
    const juice = buildJuiceTrack(film.frames);
    expect(juice.cinematics).toStrictEqual([]);
    expect(framesNaming(buildAudioTrack(juice), DEFAULT_AUDIO_TUNING.ultimate)).toStrictEqual([]);
  });

  it('does not stack or retrigger under repeated seeks across it (AC4)', () => {
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice);
    const [fired] = framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimate);
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: audio, sink });

    director.atFrame(0);
    const afterMount = sink.played().length;

    // Scrubbing back and forth over the Ultimate. None of these indexes is the
    // previous one plus one, so every one of them is a jump -- and a jump
    // re-applies the gains and fires nothing.
    for (let pass = 0; pass < 5; pass += 1) {
      director.atFrame(fired + 20);
      director.atFrame(fired - 20);
      director.atFrame(fired);
      director.atFrame(fired + 60);
    }

    expect(sink.played()).toHaveLength(afterMount);
    // Non-vacuous: the gains were written every one of those frames, so the
    // director really did present them.
    expect(sink.gains()).toHaveLength(1 + 20);
  });

  it('still fires it on the first ordinary advance into the frame', () => {
    // The other side of the case above: a scrub that stops just short of the
    // Ultimate and is released must still play it, or "no stacking" would have
    // been bought by never playing the cue at all.
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice);
    const [fired] = framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimate);
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: audio, sink });

    director.atFrame(0);
    director.atFrame(fired - 1);
    const before = sink
      .played()
      .filter((entry) => entry.endsWith(DEFAULT_AUDIO_TUNING.ultimate)).length;
    expect(before).toBe(0);

    director.atFrame(fired);
    expect(
      sink.played().filter((entry) => entry.endsWith(DEFAULT_AUDIO_TUNING.ultimate)),
    ).toStrictEqual([`sfx:${DEFAULT_AUDIO_TUNING.ultimate}`]);
  });

  it('plays the Ultimate silently and throws nothing with no sink at all (AC3)', () => {
    // `createAudioBus` returns `null` on a browser with no WebAudio, a blocked
    // context or a constructor that throws, and `main.ts` mounts with it. The
    // whole cinematic must be walkable in that configuration.
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice);
    const director = createAudioDirector({ track: audio, sink: null });

    expect(() => {
      for (let index = 0; index < audio.frameCount; index += 1) {
        director.atFrame(index);
      }
    }).not.toThrow();
  });
});

/**
 * Story 11.5: the announcement and the duck.
 *
 * Every case here is driven off `spectate-03` for the reason the Story 10.5
 * block gives -- it is the one committed Command Log containing an Ultimate --
 * and the two cases that need a fighter line next to the Ultimate synthesise
 * *that* half rather than the Ultimate, because no committed log contains both.
 *
 * The numbers this file writes out as literals were read off the shipped log:
 * the Ultimate's active phase opens on film frame 353, which is first presented
 * on clock frame 401, and the track is 630 clock frames long.
 */
const ULTIMATE_CLOCK = 401;
const ULTIMATE_FILM = 353;

/** A KO on a chosen film frame, so a fighter's line can be placed next to the Ultimate. */
function koEvent(filmIndex: number, agentIndex: 0 | 1): JuiceEvent {
  return Object.freeze({
    filmIndex,
    kind: 'ko' as const,
    agentIndex,
    damage: 100,
    positionBasisPoints: BASIS_POINTS_FULL / 2,
  });
}

/** The same real track with its event stream replaced. `cinematics` and the clock are untouched. */
function withEvents(juice: JuiceTrack, events: readonly JuiceEvent[]): JuiceTrack {
  return Object.freeze({ ...juice, events: Object.freeze(events) });
}

/** Every clock frame whose music gain is not the base level. */
function duckedFrames(track: ReturnType<typeof buildAudioTrack>, tuning: AudioTuning): number[] {
  const found: number[] = [];
  for (let clockIndex = 0; clockIndex < track.frameCount; clockIndex += 1) {
    if (track.at(clockIndex).musicGainBasisPoints !== tuning.music.gainBasisPoints) {
      found.push(clockIndex);
    }
  }
  return found;
}

describe("the Ultimate's announcement (Story 11.5)", () => {
  it('puts a voice cue on the voice bus on the same clock frame as the Ultimate SFX (AC1)', () => {
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice);

    // The frame is the cinematic's own, not a number this file chose.
    expect(juice.cinematics[0].filmIndex).toBe(ULTIMATE_FILM);
    const [announced] = framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimateVoice);
    const [impact] = framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimate);
    expect(announced).toBe(ULTIMATE_CLOCK);
    expect(impact).toBe(announced);
    expect(juice.filmIndexAt(announced)).toBe(juice.cinematics[0].filmIndex);

    const voice = audio.at(announced).cues.find((cue) => cue.bus === 'voice');
    expect(voice).toStrictEqual({
      bus: 'voice',
      name: DEFAULT_AUDIO_TUNING.ultimateVoice,
      loop: false,
    });
    // Its own name, shared with no other cue in the table: a distinct name is
    // what buys a distinct file.
    const others = [
      DEFAULT_AUDIO_TUNING.music.name,
      DEFAULT_AUDIO_TUNING.ultimate,
      ...Object.values(DEFAULT_AUDIO_TUNING.sfx),
      ...Object.values(DEFAULT_AUDIO_TUNING.voice),
    ];
    expect(others).not.toContain(DEFAULT_AUDIO_TUNING.ultimateVoice);
  });

  it('announces before it impacts, the order the two cues fire in', () => {
    // `vo()` then `sfx()` in the reference. Both land on one frame, so the claim
    // is about the order within that frame's cue list and nothing else.
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const names = audio.at(ULTIMATE_CLOCK).cues.map((cue) => cue.name);

    expect(names).toStrictEqual([
      DEFAULT_AUDIO_TUNING.ultimateVoice,
      DEFAULT_AUDIO_TUNING.ultimate,
    ]);
  });

  it('fires it on the opening frame and on none of the freeze it holds through', () => {
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice);

    expect(framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimateVoice)).toStrictEqual([
      ULTIMATE_CLOCK,
    ]);
    const freeze = DEFAULT_JUICE_TUNING.cinematic.freezeFrames;
    for (let held = 1; held <= freeze; held += 1) {
      expect(audio.at(ULTIMATE_CLOCK + held).cues).toStrictEqual([]);
    }
  });

  it('announces two Ultimates opening on one film frame exactly once', () => {
    // The voice half collapses with the SFX half, because it is derived in the
    // same de-duplicated walk.
    const juice = buildJuiceTrack(ultimateFilm());
    const first = juice.cinematics[0];
    const doubled: JuiceTrack = Object.freeze({
      ...juice,
      cinematics: Object.freeze([
        first,
        Object.freeze({ ...first, agentIndex: first.agentIndex === 0 ? 1 : 0 }) as CinematicEvent,
      ]),
    });
    const audio = buildAudioTrack(doubled);

    expect(framesNaming(audio, DEFAULT_AUDIO_TUNING.ultimateVoice)).toStrictEqual([
      ULTIMATE_CLOCK,
    ]);
    expect(audio.at(ULTIMATE_CLOCK).cues.filter((cue) => cue.bus === 'voice')).toHaveLength(1);
  });

  it('names it nowhere at all in a Match with no Ultimate', async () => {
    const film = buildReplayFilm(await buildDemoLog(), createFighterEnvironment());
    const juice = buildJuiceTrack(film.frames);
    expect(juice.cinematics).toStrictEqual([]);

    expect(
      framesNaming(buildAudioTrack(juice), DEFAULT_AUDIO_TUNING.ultimateVoice),
    ).toStrictEqual([]);
  });
});

describe('the music gets out of the way (Story 11.5, AC1)', () => {
  it('ducks the bed from the announcement and restores it, at the frames it actually reaches', () => {
    // Written as the boundary it produces rather than as "ducks for
    // `duckFrames`", which is true of every value that constant can take and
    // therefore pins nothing. `spectate-03` carries no KO event, so the
    // announcement is the only voice line in the whole Match and this range is
    // the only ducked range in it.
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const base = DEFAULT_AUDIO_TUNING.music.gainBasisPoints;

    expect(audio.at(400).musicGainBasisPoints).toBe(base);
    expect(audio.at(401).musicGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.duckBasisPoints);
    expect(audio.at(490).musicGainBasisPoints).toBe(DEFAULT_AUDIO_TUNING.duckBasisPoints);
    expect(audio.at(491).musicGainBasisPoints).toBe(base);

    // And nothing else in the Match is ducked, so the range above is the whole
    // claim rather than the part of it this file happened to look at.
    const ducked = duckedFrames(audio, DEFAULT_AUDIO_TUNING);
    expect(ducked[0]).toBe(401);
    expect(ducked[ducked.length - 1]).toBe(490);
    expect(ducked).toHaveLength(490 - 401 + 1);
  });

  it('holds it down for exactly the freeze, an independently tuned number it happens to equal', () => {
    // The story's "lucky number": Story 9.6 chose a 90-frame duck window and
    // Story 10.4 chose a 90-frame freeze, separately. This asserts the two
    // really are the same length by measuring the duck against the *visual*
    // layer's constant, which the audio layer never reads.
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const ducked = duckedFrames(audio, DEFAULT_AUDIO_TUNING);

    expect(ducked).toHaveLength(DEFAULT_JUICE_TUNING.cinematic.freezeFrames);
    expect(ducked[0] + DEFAULT_JUICE_TUNING.cinematic.freezeFrames).toBe(
      ducked[ducked.length - 1] + 1,
    );
  });

  it('covers the freeze and not the release act, which plays over resumed gameplay', () => {
    // The deliberate reading of "the cinematic's length". Story 11.4's cinematic
    // runs `releaseFromFrame + releaseFrames` clock frames, of which only the
    // first `freezeFrames` are frozen; the rest is ordinary fighting with
    // ordinary SFX, and a bed still at a quarter through it is a mix that forgot
    // to come back.
    const shape = DEFAULT_JUICE_TUNING.cinematic;
    const span = shape.releaseFromFrame + shape.releaseFrames;
    // Non-vacuous: the two readings really are different lengths.
    expect(span).toBeGreaterThan(shape.freezeFrames);

    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const base = DEFAULT_AUDIO_TUNING.music.gainBasisPoints;
    for (let age = shape.freezeFrames; age < span; age += 1) {
      expect(audio.at(ULTIMATE_CLOCK + age).musicGainBasisPoints).toBe(base);
    }
  });

  it('leaves the SFX and voice buses at their base level while the bed is down', () => {
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    for (const clockIndex of [401, 445, 490]) {
      expect(audio.at(clockIndex).sfxGainBasisPoints).toBe(
        DEFAULT_AUDIO_TUNING.sfxGainBasisPoints,
      );
      expect(audio.at(clockIndex).voiceGainBasisPoints).toBe(
        DEFAULT_AUDIO_TUNING.voiceGainBasisPoints,
      );
    }
  });

  it('announces without ducking at all when the window is tuned to zero', () => {
    const flat: AudioTuning = Object.freeze({ ...DEFAULT_AUDIO_TUNING, duckFrames: 0 });
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()), flat);

    expect(framesNaming(audio, flat.ultimateVoice)).toStrictEqual([ULTIMATE_CLOCK]);
    expect(duckedFrames(audio, flat)).toStrictEqual([]);
  });

  it('reports the same music gain across the Ultimate seeking as playing (AC3)', () => {
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const played: number[] = [];
    for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
      played.push(audio.at(clockIndex).musicGainBasisPoints);
    }
    // Backwards, and stepping over the window's edges rather than landing on
    // them: the property is that the array is an array, whichever order it is
    // read in.
    for (let clockIndex = audio.frameCount - 1; clockIndex >= 0; clockIndex -= 3) {
      expect(audio.at(clockIndex).musicGainBasisPoints).toBe(played[clockIndex]);
    }
    // Non-vacuous: the stream really does move.
    expect(new Set(played).size).toBe(2);
  });
});

describe('the announcement and a fighter line share one voice bus (Story 11.5, AC4)', () => {
  /** A tuning whose voice table names every kind, so a fighter can speak next to the Ultimate. */
  const CHATTY_ULT: AudioTuning = Object.freeze({
    ...DEFAULT_AUDIO_TUNING,
    voice: Object.freeze({ hit: 'vo_hit', heavy: 'vo_heavy', ko: 'vo_ko' }),
  });

  it('speaks once when the Ultimate is the killing blow, and it is the announcement', () => {
    // The realistic collision, and the only one the 90-frame freeze allows: the
    // next film frame is not presented for 90 clock frames, so a fighter's line
    // can only land inside the limit by being on the Ultimate's own film frame.
    // The caster is agent 0 and the fighter who goes down is agent 1 -- two
    // different slots, which is why the announcement claims both.
    const juice = buildJuiceTrack(ultimateFilm());
    expect(juice.cinematics[0].agentIndex).toBe(0);
    const audio = buildAudioTrack(withEvents(juice, [koEvent(ULTIMATE_FILM, 1)]), CHATTY_ULT);

    const voices = audio.at(ULTIMATE_CLOCK).cues.filter((cue) => cue.bus === 'voice');
    expect(voices.map((cue) => cue.name)).toStrictEqual([CHATTY_ULT.ultimateVoice]);
    expect(framesNaming(audio, 'vo_ko')).toStrictEqual([]);

    // The limiter is on the voice bus only: both impacts still fire.
    expect(audio.at(ULTIMATE_CLOCK).cues.filter((cue) => cue.bus === 'sfx').map((cue) => cue.name))
      .toStrictEqual([CHATTY_ULT.sfx.ko, CHATTY_ULT.ultimate]);
  });

  it('lets the KO speak once the window has passed, so the limit is a window and not a mute', () => {
    // The same synthetic KO, one film frame later -- which is 90 clock frames
    // later, because the freeze sits between them.
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(withEvents(juice, [koEvent(ULTIMATE_FILM + 1, 1)]), CHATTY_ULT);

    const spoken = framesNaming(audio, CHATTY_ULT.ultimateVoice).concat(
      framesNaming(audio, 'vo_ko'),
    );
    expect(spoken).toStrictEqual([ULTIMATE_CLOCK, ULTIMATE_CLOCK + 91]);
    // Non-vacuous: they really are further apart than the limit.
    expect(91).toBeGreaterThanOrEqual(CHATTY_ULT.voiceRateLimitFrames);
  });

  it('drops the announcement when a fighter spoke inside the window before it', () => {
    // Symmetric, and on real data: `spectate-03` lands a heavy on agent 1 whose
    // clock frame is 13 before the Ultimate's. The shipped limit of 11 lets both
    // through; a limit of 20 does not, and the one that loses is the later of
    // the two.
    const juice = buildJuiceTrack(ultimateFilm());
    const patient: AudioTuning = Object.freeze({ ...CHATTY_ULT, voiceRateLimitFrames: 20 });

    // The precondition, stated rather than assumed: if the log's heavy ever
    // moves, this case fails loudly instead of passing vacuously.
    const lines = framesNaming(buildAudioTrack(juice, CHATTY_ULT), 'vo_heavy');
    expect(lines).toStrictEqual([ULTIMATE_CLOCK - 13]);
    expect(13).toBeGreaterThanOrEqual(CHATTY_ULT.voiceRateLimitFrames);
    expect(13).toBeLessThan(patient.voiceRateLimitFrames);

    expect(framesNaming(buildAudioTrack(juice, CHATTY_ULT), CHATTY_ULT.ultimateVoice)).toStrictEqual(
      [ULTIMATE_CLOCK],
    );
    const strict = buildAudioTrack(juice, patient);
    expect(framesNaming(strict, patient.ultimateVoice)).toStrictEqual([]);
    // The impact is not the limiter's business and still lands.
    expect(framesNaming(strict, patient.ultimate)).toStrictEqual([ULTIMATE_CLOCK]);
    // And a suppressed announcement opens no window of its own. The bed *is*
    // down at 401, but that is the heavy's window from 388, and it restores
    // where the heavy's window ends rather than 90 frames after the Ultimate.
    const base = patient.music.gainBasisPoints;
    expect(strict.at(ULTIMATE_CLOCK - 13 + patient.duckFrames).musicGainBasisPoints).toBe(base);
    expect(strict.at(ULTIMATE_CLOCK + patient.duckFrames - 1).musicGainBasisPoints).toBe(base);
  });

  it('still limits the two fighters separately when no Ultimate is involved', () => {
    // The Story 9.6 property, re-asserted because the limiter moved: two
    // fighters trading in one Decision Point claim different slots and both
    // speak. `spectate-03` trades on clock 100.
    const juice = buildJuiceTrack(ultimateFilm());
    const audio = buildAudioTrack(juice, CHATTY_ULT);

    expect(audio.at(100).cues.filter((cue) => cue.bus === 'voice')).toHaveLength(2);
  });
});

describe('the announcement survives the transport (Story 11.5, AC3, AC5)', () => {
  it('is not replayed by scrubbing back and forth across it', () => {
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: audio, sink });

    director.atFrame(0);
    const afterMount = sink.played().length;
    for (let pass = 0; pass < 5; pass += 1) {
      director.atFrame(ULTIMATE_CLOCK + 20);
      director.atFrame(ULTIMATE_CLOCK - 20);
      director.atFrame(ULTIMATE_CLOCK);
      director.atFrame(ULTIMATE_CLOCK + 60);
    }

    expect(sink.played()).toHaveLength(afterMount);
    expect(sink.played()).not.toContain(`voice:${DEFAULT_AUDIO_TUNING.ultimateVoice}`);
    // The gains are written on every one of those jumps, and the last of them
    // lands 60 frames into the window -- so a visitor who *seeks* into the
    // middle of the cutscene hears the bed already down, which is the half of
    // "seeking equals playing" the transport is responsible for.
    expect(sink.gains()).toHaveLength(1 + 20);
    expect(sink.gains()[sink.gains().length - 1]).toBe(
      `${String(DEFAULT_AUDIO_TUNING.duckBasisPoints)}/${String(DEFAULT_AUDIO_TUNING.sfxGainBasisPoints)}/${String(DEFAULT_AUDIO_TUNING.voiceGainBasisPoints)}`,
    );
    // And a jump to before it hears the bed at its base level.
    expect(sink.gains()[2]).toBe(
      `${String(DEFAULT_AUDIO_TUNING.music.gainBasisPoints)}/${String(DEFAULT_AUDIO_TUNING.sfxGainBasisPoints)}/${String(DEFAULT_AUDIO_TUNING.voiceGainBasisPoints)}`,
    );
  });

  it('plays it exactly once across a full playback, and ducks under it', () => {
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const sink = createRecordingSink();
    const director = createAudioDirector({ track: audio, sink });
    for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
      director.atFrame(clockIndex);
    }

    expect(
      sink.played().filter((entry) => entry === `voice:${DEFAULT_AUDIO_TUNING.ultimateVoice}`),
    ).toHaveLength(1);
    const ducked = `${String(DEFAULT_AUDIO_TUNING.duckBasisPoints)}/${String(DEFAULT_AUDIO_TUNING.sfxGainBasisPoints)}/${String(DEFAULT_AUDIO_TUNING.voiceGainBasisPoints)}`;
    expect(sink.gains().filter((entry) => entry === ducked)).toHaveLength(90);
  });

  it('is silent and throws nothing with no sink at all', () => {
    const audio = buildAudioTrack(buildJuiceTrack(ultimateFilm()));
    const director = createAudioDirector({ track: audio, sink: null });

    expect(() => {
      for (let clockIndex = 0; clockIndex < audio.frameCount; clockIndex += 1) {
        director.atFrame(clockIndex);
      }
    }).not.toThrow();
  });
});

describe('seeking to a frame equals playing to it', () => {
  it('reports identical bus gains either way, on the real demo film', async () => {
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const audio = buildAudioTrack(buildJuiceTrack(film.frames));

    // Play forward, recording the gains at every frame ...
    const played: string[] = [];
    for (let index = 0; index < audio.frameCount; index += 1) {
      const frame = audio.at(index);
      played.push(
        `${String(frame.musicGainBasisPoints)}/${String(frame.sfxGainBasisPoints)}/${String(frame.voiceGainBasisPoints)}`,
      );
    }
    // ... then seek to each one out of order, and compare. The two agree because
    // the track is an array, not a stepped effect list -- which is the property
    // a stepped implementation cannot have and this one gets for free.
    for (let index = audio.frameCount - 1; index >= 0; index -= 7) {
      const frame = audio.at(index);
      expect(
        `${String(frame.musicGainBasisPoints)}/${String(frame.sfxGainBasisPoints)}/${String(frame.voiceGainBasisPoints)}`,
      ).toBe(played[index]);
    }
    expect(audio.frameCount).toBeGreaterThan(100);
  });
});
