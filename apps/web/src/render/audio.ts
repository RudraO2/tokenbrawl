import { BASIS_POINTS_FULL } from '../replay/film';
import type { JuiceKind, JuiceTrack } from './juice';

/**
 * Story 9.6: the audio layer, as an indexed table rather than as a scheduler.
 *
 * The player is silent, and the obvious way to fix that is one flat channel
 * driven by `setTimeout` and `AudioContext.currentTime`. Both of those are wall
 * clocks, and a Match whose sound depended on either would leak exactly the
 * thing INV-1 and INV-3 exist to hide -- how long a Deployment took to think.
 *
 * So this module is the audio twin of `juice.ts`, and it keeps the same three
 * properties for the same three reasons:
 *
 * 1. **Every duration is an integer count of clock frames.** The duck window
 *    and the per-fighter voice rate limit are frame counts, not milliseconds.
 *    The player's `PlaybackClock` advances exactly one frame per animation-frame
 *    callback, so a 90-frame duck means 90 callbacks on a 60Hz laptop, on a
 *    144Hz monitor and in a backgrounded tab alike.
 *
 * 2. **The track is precomputed, not stepped.** A duck implemented as "drop the
 *    gain now, restore it in 90 frames' time" is a piece of mutable state that
 *    has no idea what it looked like at frame 40, which makes Story 4.5's scrub
 *    silently wrong. Here `musicGainBasisPoints` is simply *known* for every
 *    clock index, so restoring the level is an ordinary per-frame gain write and
 *    scrubbing into the middle of a duck window is correct for free.
 *
 * 3. **It is derived from the film, one way.** The cue source is the very same
 *    `JuiceTrack` Story 9.5 already built -- the epic note is explicit that 9.5
 *    and 9.6 must not each own a timer source, so there is no second diff of the
 *    film here. Nothing in this module writes to a `FighterState`, imports from
 *    `packages/*` simulation, or is read by anything that hashes (AD-15, INV-2).
 *
 * ## Basis points, and the one float
 *
 * Gains travel as integers -- basis points, `10000` being unity -- exactly as
 * `JuiceEvent.positionBasisPoints` does. The single division into a float
 * happens at the `GainNode` boundary in `audio-bus.ts`, mirroring how
 * `juice-draw.ts` owns the one viewport multiplication. An integer mix is a mix
 * two runs can be asserted byte-equal on.
 *
 * ## Where the numbers came from
 *
 * Behavioural facts read off the dev-reference project's audio director -- which
 * event maps to which category, that music sits below unity and ducks to about
 * a quarter of its base under a voice line, that voice lines are rate-limited
 * per fighter. Facts, not expression: none of its code is reproduced here, and
 * every value is a field in a frozen table rather than a literal at a call site.
 *
 * ## Assets land in Story 9.7
 *
 * Every cue name in `DEFAULT_AUDIO_TUNING` now has a file behind it, provenanced
 * in `docs/ASSETS.md` per that doc's licence-read rule. Story 9.6 shipped this
 * module building the whole track and running the whole graph against files
 * that did not yet exist -- the fail-soft path the story's AC2 asked for was
 * exercised on every load, not only in a test. Story 9.7 is what fills those
 * files in.
 *
 * ## The Ultimate's cue lands in Story 10.5
 *
 * `tuning.ultimate` is the sixth cue, and the one place this module reads
 * `juiceTrack.cinematics` rather than `juiceTrack.events`. Its trigger is
 * `CinematicEvent.filmIndex` -- the exact film frame Story 10.4's freeze opens
 * on -- so audio and picture are keyed off one index and cannot drift apart on
 * a seek. That is the story's AC2, and keying it this way makes the claim true
 * by construction rather than by two layers happening to agree.
 *
 * It is its own sample rather than `sfx.heavy` at a higher level. An Ultimate
 * that sounds like a heavy hit teaches a listener nothing, which is the whole
 * reason the cue exists: the Ultimate has to read for a visitor who is not
 * looking directly at the stage.
 */

/** The three independent mix buses. One `GainNode` each, all three straight to `destination`. */
export type AudioBusName = 'music' | 'sfx' | 'voice';

export interface AudioCue {
  readonly bus: AudioBusName;
  /**
   * The cue's name, not its URL. `audio-bus.ts` owns the name → same-origin
   * path convention, so this pure layer carries nothing that could ever be an
   * off-origin fetch (`style-discipline.test.ts`'s offline sweep).
   */
  readonly name: string;
  /** True for the music bed and nothing else: a looping one-shot is a stuck sound. */
  readonly loop: boolean;
}

export interface AudioTuning {
  /** The music bed: one looping cue at clock frame 0, and the bus's base level. */
  readonly music: { readonly name: string; readonly gainBasisPoints: number };
  /** One SFX name per juice kind. Every kind has one -- a hit that made no sound is a bug, not a mix choice. */
  readonly sfx: Readonly<Record<JuiceKind, string>>;
  /**
   * Voice names, by kind, and deliberately partial.
   *
   * A voice line on every chip hit is how a fighting game becomes unlistenable
   * in thirty seconds, so the shipped table names one for the KO only. A later
   * story adds a kind by adding a key, with no call site to find.
   */
  readonly voice: Partial<Readonly<Record<JuiceKind, string>>>;
  /**
   * Story 10.5. The Ultimate's cue, on the SFX bus.
   *
   * Its own key rather than a fourth entry in `sfx`, because the Ultimate is
   * not a `JuiceKind`: kinds grade *damage taken*, and the cinematic fires on
   * the caster's active phase whether or not the Ultimate connects. Widening
   * `JuiceKind` to carry it would have put a non-damage event into the table
   * that drives hitstop, sparks and damage numbers.
   *
   * Required rather than optional, unlike `voice`: a tuning that forgot it
   * should fail to compile rather than ship a silent Ultimate, and the one
   * thing this story exists to prevent is the Ultimate being inaudible.
   */
  readonly ultimate: string;
  readonly sfxGainBasisPoints: number;
  readonly voiceGainBasisPoints: number;
  /** How many clock frames a voice line holds the music down for. */
  readonly duckFrames: number;
  /** The music bus's level while ducked. Absolute, not a proportion of the base: one number, one meaning. */
  readonly duckBasisPoints: number;
  /**
   * The fewest clock frames between two voice lines from *one* fighter.
   *
   * Per fighter rather than global: two fighters trading in one Decision Point
   * is a thing the simulation does, and silencing one of them because the other
   * spoke would drop the cue that says which one went down.
   */
  readonly voiceRateLimitFrames: number;
}

/**
 * The shipped tuning. Frozen, and frozen all the way down, in the same shape as
 * `juice.ts`'s `DEFAULT_JUICE_TUNING` and `animation.ts`'s `CLIP_FRAME_COUNTS`:
 * a table a later story retunes by editing a number.
 *
 * `8000` for music rather than unity because a bed at full level buries the
 * hits it exists to sit under; `2500` while ducked is the reference project's
 * "about a quarter" written as an absolute level rather than as a multiplier
 * nobody can read off the table.
 */
export const DEFAULT_AUDIO_TUNING: AudioTuning = Object.freeze({
  music: Object.freeze({ name: 'music_battle', gainBasisPoints: 8000 }),
  sfx: Object.freeze({ hit: 'sfx_hit_l', heavy: 'sfx_hit_h', ko: 'sfx_ko' }),
  voice: Object.freeze({ ko: 'vo_ko' }),
  ultimate: 'sfx_special',
  sfxGainBasisPoints: BASIS_POINTS_FULL,
  voiceGainBasisPoints: BASIS_POINTS_FULL,
  duckFrames: 90,
  duckBasisPoints: 2500,
  voiceRateLimitFrames: 11,
});

/** Everything the sink needs for one *clock* frame. */
export interface AudioFrame {
  /** The one-shots (and, at frame 0, the loop) that begin on this frame. Empty on most frames. */
  readonly cues: readonly AudioCue[];
  readonly musicGainBasisPoints: number;
  readonly sfxGainBasisPoints: number;
  readonly voiceGainBasisPoints: number;
}

export interface AudioTrack {
  /** Clock frames. Always equal to the juice track's, so one index means one thing. */
  readonly frameCount: number;
  /** The audio at a clock frame. Clamped at both ends; never throws. */
  readonly at: (clockIndex: number) => AudioFrame;
}

/**
 * What the pure layer asks of a sink, and the whole of it.
 *
 * Declared here rather than in `audio-bus.ts` so this module depends on nothing
 * host-shaped: a test drives the director with a plain recording object, and
 * `audio-bus.ts` is one implementation of this shape rather than its definition.
 *
 * Gains arrive as basis points. The sink owns the single division into a float.
 */
export interface AudioSink {
  readonly play: (cue: AudioCue) => void;
  /**
   * Stops everything this sink has started, the looping music bed included.
   *
   * The sink outlives any one Match -- `startup.ts` holds one graph per *page*,
   * so a BYOK or Arcade re-mount, and a press of Replay, both arrive at a sink
   * whose bed is already looping. Without a way to stop it, every re-mount would
   * start a second bed over the first and nothing would ever stop either: the
   * stacking this design moved off the gain nodes would simply reappear on the
   * sources.
   */
  readonly stopAll: () => void;
  readonly setGains: (
    musicBasisPoints: number,
    sfxBasisPoints: number,
    voiceBasisPoints: number,
  ) => void;
  /** Resumes a context the browser suspended until a user gesture. Never throws. */
  readonly unlock: () => void;
}

/** The frame a film with no frames at all resolves to: base gains, nothing playing. */
function neutralFrame(tuning: AudioTuning): AudioFrame {
  return Object.freeze({
    cues: Object.freeze([]),
    musicGainBasisPoints: tuning.music.gainBasisPoints,
    sfxGainBasisPoints: tuning.sfxGainBasisPoints,
    voiceGainBasisPoints: tuning.voiceGainBasisPoints,
  });
}

/**
 * Builds the whole audio track: one entry per *clock* frame, hitstop holds
 * included.
 *
 * Indexing on the clock rather than on the film is the load-bearing choice. A
 * hit re-presents its film frame for several clock frames, so a track indexed on
 * the film would fire the same SFX for every frame of the freeze -- and, worse,
 * would put the duck window on a different axis from the transport that has to
 * walk it. `juiceTrack.filmIndexAt` is the one mapping, and it is asked rather
 * than reproduced.
 */
export function buildAudioTrack(
  juiceTrack: JuiceTrack,
  tuning: AudioTuning = DEFAULT_AUDIO_TUNING,
): AudioTrack {
  const frameCount = juiceTrack.frameCount;
  if (frameCount <= 0) {
    const empty = neutralFrame(tuning);
    return Object.freeze({ frameCount: 0, at: (): AudioFrame => empty });
  }

  // The first clock frame that presents each film frame. Built by one forward
  // walk rather than by searching per event: a hit's cue belongs on the frame
  // the freeze *starts*, never on one of its holds.
  const firstClockOf = new Map<number, number>();
  for (let clockIndex = 0; clockIndex < frameCount; clockIndex += 1) {
    const filmIndex = juiceTrack.filmIndexAt(clockIndex);
    if (!firstClockOf.has(filmIndex)) {
      firstClockOf.set(filmIndex, clockIndex);
    }
  }

  const cuesByClock: AudioCue[][] = Array.from({ length: frameCount }, () => []);
  // Every frame's music level, base until a voice line pulls it down.
  const musicGains: number[] = Array.from({ length: frameCount }, () => tuning.music.gainBasisPoints);

  // The music bed. Frame 0 rather than "on mount": a cue that is a property of
  // the track is a cue a scrub back to the start re-states correctly, and one
  // the director can decline to re-fire on a repaint.
  cuesByClock[0].push(Object.freeze({ bus: 'music', name: tuning.music.name, loop: true }));

  // The last clock frame each fighter spoke on. Closure state in a builder, not
  // a module binding -- `source-discipline.test.ts` bans the latter, and this is
  // per-track state besides.
  const lastVoiceClock = new Map<number, number>();

  for (const event of juiceTrack.events) {
    const clockIndex = firstClockOf.get(event.filmIndex);
    if (clockIndex === undefined) {
      // A derived event whose film frame is not in the track at all. Not
      // reachable from `buildJuiceTrack`, which walks the same frames -- but a
      // caller may hand in a track built from a different film, and dropping the
      // cue is the only answer that cannot put a sound on the wrong frame.
      continue;
    }

    const sfxName = tuning.sfx[event.kind];
    if (sfxName !== undefined) {
      cuesByClock[clockIndex].push(Object.freeze({ bus: 'sfx', name: sfxName, loop: false }));
    }

    const voiceName = tuning.voice[event.kind];
    if (voiceName === undefined) {
      continue;
    }
    // The rate limit, per fighter. A flurry's second line is dropped rather than
    // queued: a queued line arrives after the moment it was about to describe,
    // which reads worse than not saying it.
    const spoke = lastVoiceClock.get(event.agentIndex);
    if (spoke !== undefined && clockIndex - spoke < tuning.voiceRateLimitFrames) {
      continue;
    }
    lastVoiceClock.set(event.agentIndex, clockIndex);
    cuesByClock[clockIndex].push(Object.freeze({ bus: 'voice', name: voiceName, loop: false }));

    // The duck, written into the table rather than scheduled. A second line
    // simply overwrites the tail of the first's window, which is what "restarts
    // the window" means when the window is a range of array entries.
    const end = Math.min(frameCount, clockIndex + Math.max(0, tuning.duckFrames));
    for (let ducked = clockIndex; ducked < end; ducked += 1) {
      musicGains[ducked] = tuning.duckBasisPoints;
    }
  }

  // Story 10.5. The Ultimate's cue, from the same track's `cinematics` stream
  // and through the same `firstClockOf` map every other cue goes through.
  //
  // `CinematicEvent.filmIndex` is the film frame the Ultimate's active phase
  // opens on, which is precisely the frame Story 10.4's freeze starts on. So
  // the cue lands on the clock frame the picture stops on, and on none of the
  // 90 holds that follow it -- the same "first clock frame, never a hold" rule
  // the hit SFX already obey, asked of the one index both layers key off. AC2
  // ("audio and picture cannot drift apart on a seek") is that shared index,
  // not a second reconstruction that happens to agree.
  //
  // Deliberately independent of `cinematic.freezeFrames`. That number is the
  // *visual* layer's, and a build that shortened or removed the freeze should
  // still announce the Ultimate: `tuning.ultimate` is the audio layer's own
  // switch, in the audio layer's own table.
  const announced = new Set<number>();
  for (const cinematic of juiceTrack.cinematics) {
    // One cue per film frame. Two fighters whose Ultimates go active on the
    // same frame is the case `buildJuiceTrack` already resolves to one freeze
    // carrying one caster; two copies of one sample started on one frame is a
    // flam, not a bigger sound, so the audio layer collapses it the same way.
    if (announced.has(cinematic.filmIndex)) {
      continue;
    }
    announced.add(cinematic.filmIndex);
    const clockIndex = firstClockOf.get(cinematic.filmIndex);
    if (clockIndex === undefined) {
      // Same reasoning as the dropped juice event above: a track built from a
      // different film cannot have its cue placed truthfully, so it gets none.
      continue;
    }
    cuesByClock[clockIndex].push(
      Object.freeze({ bus: 'sfx', name: tuning.ultimate, loop: false }),
    );
  }

  // Playback stops on the last clock frame and rests there indefinitely. A KO --
  // which is where every voice line in the shipped tuning comes from -- lands
  // near the end by definition, so its duck window is exactly the one that
  // reaches the end of the track: without this the fight would finish and leave
  // the bed at a quarter level forever, which reads as a broken mix rather than
  // as a finished Match. `buildJuiceTrack` neutralises its own final frame for
  // the same class of reason (a shake left permanently offset).
  musicGains[frameCount - 1] = tuning.music.gainBasisPoints;

  const track: readonly AudioFrame[] = Object.freeze(
    cuesByClock.map((cues, clockIndex) =>
      Object.freeze({
        cues: Object.freeze(cues),
        musicGainBasisPoints: musicGains[clockIndex],
        sfxGainBasisPoints: tuning.sfxGainBasisPoints,
        voiceGainBasisPoints: tuning.voiceGainBasisPoints,
      }),
    ),
  );

  const clamp = (clockIndex: number): number => {
    if (!Number.isFinite(clockIndex)) {
      return 0;
    }
    return Math.max(0, Math.min(track.length - 1, Math.floor(clockIndex)));
  };

  return Object.freeze({
    frameCount: track.length,
    at: (clockIndex: number): AudioFrame => track[clamp(clockIndex)],
  });
}

export interface AudioDirectorConfig {
  readonly track: AudioTrack;
  /** Absent on a page with no WebAudio, and absent in most tests. Then this is a no-op that still tracks position. */
  readonly sink?: AudioSink | null;
}

export interface AudioDirector {
  /**
   * Presents one clock frame: always re-applies the bus gains, fires one-shots
   * only on an ordinary forward advance.
   */
  readonly atFrame: (clockIndex: number) => void;
}

/**
 * Turns the indexed track into the two things a sink can be told.
 *
 * The distinction it exists to draw is advance-versus-everything-else.
 * `player/clock.ts` emits `index + 1` while running, and `seek` emits an
 * arbitrary index while leaving the running state alone; `main.ts` additionally
 * repaints the *current* index whenever a sprite pack decodes or a backdrop
 * lands. Firing a one-shot on any of those would make dragging the scrub across
 * a KO sound like a machine gun, and would re-fire the music bed every time an
 * asset arrived.
 *
 * So: `index === last + 1` (and the very first frame presented) fires; every
 * other index is a jump, and a jump re-applies gains silently. Gains are
 * re-applied unconditionally because they are a *state*, and the state after
 * seeking to frame `n` must equal the state after playing to it -- which is the
 * property the whole precomputed-track design exists to make true.
 */
export function createAudioDirector(config: AudioDirectorConfig): AudioDirector {
  const state = { last: -1 };

  return Object.freeze({
    atFrame: (clockIndex: number): void => {
      if (!Number.isFinite(clockIndex)) {
        return;
      }
      const index = Math.max(0, Math.floor(clockIndex));
      const frame = config.track.at(index);
      const sink = config.sink ?? null;

      // `last === -1` is the first frame ever presented, whatever index it is:
      // `mountPlayer` paints before the clock has emitted anything, and that
      // paint is the one that must start the music bed.
      //
      // A rewind to frame 0 from anywhere else is the Replay button
      // (`clock.start()` sets its index back to -1 and emits 0 next). It counts
      // as an advance -- the fight is starting again and frame 0's cues, the bed
      // included, belong at the start of it -- but only after everything the
      // previous playback started has been stopped, or Replay would stack a
      // second bed on top of the first.
      const rewound = state.last > 0 && index === 0;
      const advanced = state.last === -1 || index === state.last + 1 || rewound;
      state.last = index;
      if (sink === null) {
        return;
      }
      if (rewound) {
        sink.stopAll();
      }

      sink.setGains(
        frame.musicGainBasisPoints,
        frame.sfxGainBasisPoints,
        frame.voiceGainBasisPoints,
      );
      if (!advanced) {
        return;
      }
      for (const cue of frame.cues) {
        sink.play(cue);
      }
    },
  });
}
