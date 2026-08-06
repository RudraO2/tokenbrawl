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
import { buildJuiceTrack, type JuiceTrack } from './juice';
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
