import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildReplayFilm } from '../replay/film';
import { buildDemoLog } from '../testing/demo-log';
import type { Canvas2D } from './canvas2d';
import { buildJuiceTrack } from './juice';
import { drawJuicedFrame } from './juice-draw';
import {
  DEFAULT_AUDIO_TUNING,
  buildAudioTrack,
  createAudioDirector,
  type AudioCue,
  type AudioSink,
  type AudioTuning,
} from './audio';

/**
 * Story 9.6, INV-2, INV-3 and AD-15: the audio must not touch the hash, and
 * must not be able to tell two Deployments' thinking times apart.
 *
 * Being precise about what these cases show, the same way
 * `juice-neutrality.test.ts` is. `film.finalStateHash` is computed by
 * `buildReplayFilm` before anything is drawn or played, so comparing two
 * already-computed hashes compares two copies of one string. The load-bearing
 * case is the one that drives the *whole* painted playback -- every clock frame,
 * with a recording sink attached and with none -- and only then rebuilds the
 * film from the same `CommandLog` with a fresh environment. If the audio layer
 * had reached back into a `FighterState`, directly or by mutating something the
 * film holds, the freshly derived hash would move.
 *
 * The INV-3 half is a different kind of claim and gets a different kind of
 * check: the cue stream is asserted to be a function of frame index and damage
 * *only*, by inspecting what a cue can carry at all.
 */

const VIEWPORT = { width: 960, height: 400 };

/** Records nothing about the canvas beyond that it was drawn on: this file is about the audio. */
function createSilentCanvas(): Canvas2D & { readonly calls: () => number } {
  const counted = { calls: 0 };
  const bump = (): void => {
    counted.calls += 1;
  };
  const surface = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    calls: () => counted.calls,
  } as unknown as Canvas2D & { readonly calls: () => number };

  surface.fillRect = bump;
  surface.strokeRect = bump;
  surface.fillText = bump;
  surface.clearRect = bump;
  surface.drawImage = bump;
  surface.save = bump;
  surface.restore = bump;
  surface.translate = bump;
  surface.scale = bump;
  return surface;
}

/** Records the cue stream and the gain stream, in order, and nothing else. */
function createRecordingSink(): AudioSink & {
  readonly cues: () => readonly AudioCue[];
  readonly gains: () => readonly string[];
} {
  const cues: AudioCue[] = [];
  const gains: string[] = [];
  return Object.freeze({
    play: (cue: AudioCue): void => {
      cues.push(cue);
    },
    setGains: (music: number, sfx: number, voice: number): void => {
      gains.push(`${String(music)}/${String(sfx)}/${String(voice)}`);
    },
    unlock: (): void => undefined,
    stopAll: (): void => undefined,
    cues: () => cues,
    gains: () => gains,
  });
}

interface Run {
  readonly finalStateHash: string;
  readonly recordedStateHash: string;
  readonly matchesRecordedHash: boolean;
  readonly cues: readonly AudioCue[];
  readonly gains: readonly string[];
  readonly frameCount: number;
}

/**
 * Plays the demo Match end to end through the real paint path -- draw, then
 * present the audio frame -- with the given tuning, or with no sink at all.
 */
async function replayPlaying(tuning: AudioTuning | null): Promise<Run> {
  const log = await buildDemoLog();
  const film = buildReplayFilm(log, createFighterEnvironment());
  const ctx = createSilentCanvas();
  const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

  const juice = buildJuiceTrack(film.frames);
  const sink = tuning === null ? null : createRecordingSink();
  const director = createAudioDirector({
    track: buildAudioTrack(juice, tuning ?? DEFAULT_AUDIO_TUNING),
    sink,
  });

  for (let index = 0; index < juice.frameCount; index += 1) {
    drawJuicedFrame(ctx, film.frames[juice.filmIndexAt(index)], juice.at(index), options);
    director.atFrame(index);
  }
  expect(ctx.calls()).toBeGreaterThan(1_000);

  return {
    finalStateHash: film.finalStateHash,
    recordedStateHash: film.recordedStateHash,
    matchesRecordedHash: film.matchesRecordedHash,
    cues: sink?.cues() ?? [],
    gains: sink?.gains() ?? [],
    frameCount: juice.frameCount,
  };
}

/** A tuning nothing about the shipped one survives: different names, different duck, a chattier voice table. */
const RETUNED: AudioTuning = Object.freeze({
  music: Object.freeze({ name: 'music_alt', gainBasisPoints: 4_000 }),
  sfx: Object.freeze({ hit: 'sfx_alt_l', heavy: 'sfx_alt_h', ko: 'sfx_alt_ko' }),
  voice: Object.freeze({ hit: 'vo_alt_hit', heavy: 'vo_alt_heavy', ko: 'vo_alt_ko' }),
  ultimate: 'sfx_alt_ult',
  ultimateVoice: 'vo_alt_ult',
  sfxGainBasisPoints: 6_000,
  voiceGainBasisPoints: 9_000,
  duckFrames: 5,
  duckBasisPoints: 100,
  voiceRateLimitFrames: 3,
});

describe('the audio layer is hash-neutral on the demo Match (AC3, INV-2, AD-15)', () => {
  it('re-derives the same hash after a full playback, attached and retuned', async () => {
    // The case that can actually fail. Hash first, play everything, then derive
    // the hash *again* from the same log with a fresh environment.
    const log = await buildDemoLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const before = film.finalStateHash;
    const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

    for (const tuning of [DEFAULT_AUDIO_TUNING, RETUNED]) {
      const ctx = createSilentCanvas();
      const sink = createRecordingSink();
      const juice = buildJuiceTrack(film.frames);
      const director = createAudioDirector({ track: buildAudioTrack(juice, tuning), sink });
      for (let index = 0; index < juice.frameCount; index += 1) {
        drawJuicedFrame(ctx, film.frames[juice.filmIndexAt(index)], juice.at(index), options);
        director.atFrame(index);
      }
      expect(sink.cues().length).toBeGreaterThan(0);

      const rederived = buildReplayFilm(log, createFighterEnvironment());
      expect(rederived.finalStateHash).toBe(before);
      expect(rederived.finalStateHash).toBe(log.finalStateHash);
      expect(rederived.recordedStateHash).toBe(film.recordedStateHash);
      expect(rederived.matchesRecordedHash).toBe(true);
      // And the film the playback read from is itself unchanged.
      expect(film.finalStateHash).toBe(before);
      expect(film.matchesRecordedHash).toBe(true);
    }
  });

  it('produces one hash whether the audio is absent, attached or retuned', async () => {
    const log = await buildDemoLog();
    const [silent, attached, retuned] = await Promise.all([
      replayPlaying(null),
      replayPlaying(DEFAULT_AUDIO_TUNING),
      replayPlaying(RETUNED),
    ]);

    for (const run of [silent, attached, retuned]) {
      expect(run.finalStateHash).toBe(silent.finalStateHash);
      expect(run.recordedStateHash).toBe(silent.recordedStateHash);
      expect(run.finalStateHash).toBe(log.finalStateHash);
      expect(run.matchesRecordedHash).toBe(true);
    }
    // The clock is untouched too: attaching audio must not change how many
    // frames the playback takes, only what it sounds like.
    expect(attached.frameCount).toBe(silent.frameCount);
    expect(retuned.frameCount).toBe(silent.frameCount);
  });

  it('really did play three different things, so the case above is not vacuous', async () => {
    const [silent, attached, retuned] = await Promise.all([
      replayPlaying(null),
      replayPlaying(DEFAULT_AUDIO_TUNING),
      replayPlaying(RETUNED),
    ]);

    expect(silent.cues).toStrictEqual([]);
    expect(silent.gains).toStrictEqual([]);
    expect(attached.cues.length).toBeGreaterThan(1);
    // The retune moves the cue stream and the mix, which is what a tuning table
    // is for -- and, per the case above, moves neither hash.
    expect(retuned.cues.map((cue) => cue.name)).not.toStrictEqual(
      attached.cues.map((cue) => cue.name),
    );
    expect(retuned.gains).not.toStrictEqual(attached.gains);
    // Every frame got a gain write under both tunings: the mix is a state, not
    // an event.
    expect(attached.gains).toHaveLength(attached.frameCount);
    expect(retuned.gains).toHaveLength(retuned.frameCount);
  });

  it('plays the identical cue stream twice: nothing here is random', async () => {
    const [first, second] = await Promise.all([
      replayPlaying(DEFAULT_AUDIO_TUNING),
      replayPlaying(DEFAULT_AUDIO_TUNING),
    ]);

    expect(first.cues).toStrictEqual(second.cues);
    expect(first.gains).toStrictEqual(second.gains);
  });
});

/**
 * Story 10.5, AC6. The demo Match above cannot make this claim about the
 * Ultimate's cue, because neither Baseline Bot ever submits `special` -- every
 * case there would pass with `tuning.ultimate` never once emitted.
 * `spectate-03` is the one committed Command Log in this repository containing
 * an Ultimate, which is why `cinematic-neutrality.test.ts` uses it and why the
 * audio half of the same claim is made against it here.
 */
function ultimateLog(): unknown {
  return JSON.parse(
    readFileSync(`${process.cwd()}/public/replays/spectate-03.command-log.json`, 'utf8'),
  );
}

describe("the Ultimate's cue is hash-neutral too (Story 10.5, AC6, AD-15)", () => {
  it('re-derives the same hash after a Match containing an Ultimate has played', () => {
    const log = ultimateLog();
    const film = buildReplayFilm(log, createFighterEnvironment());
    const before = film.finalStateHash;
    expect(film.matchesRecordedHash).toBe(true);
    const options = { config: DEFAULT_FIGHTER_CONFIG, viewport: VIEWPORT };

    for (const tuning of [DEFAULT_AUDIO_TUNING, RETUNED]) {
      const ctx = createSilentCanvas();
      const sink = createRecordingSink();
      const juice = buildJuiceTrack(film.frames);
      const director = createAudioDirector({ track: buildAudioTrack(juice, tuning), sink });
      for (let index = 0; index < juice.frameCount; index += 1) {
        drawJuicedFrame(ctx, film.frames[juice.filmIndexAt(index)], juice.at(index), options);
        director.atFrame(index);
      }
      // Non-vacuous: both of the Ultimate's cues really were among what played,
      // and the bed really did drop under them (Story 11.5). A hash claim about
      // a layer that never ran is not a claim.
      expect(sink.cues().filter((cue) => cue.name === tuning.ultimate)).toHaveLength(1);
      expect(sink.cues().filter((cue) => cue.name === tuning.ultimateVoice)).toStrictEqual([
        { bus: 'voice', name: tuning.ultimateVoice, loop: false },
      ]);
      // At least the announcement's own window. `RETUNED`'s voice table names
      // every kind, so under it the bed is also down under a good many hits --
      // the exact geometry is `audio.test.ts`'s claim, not this file's.
      const ducked = `${String(tuning.duckBasisPoints)}/${String(tuning.sfxGainBasisPoints)}/${String(tuning.voiceGainBasisPoints)}`;
      expect(sink.gains().filter((entry) => entry === ducked).length).toBeGreaterThanOrEqual(
        tuning.duckFrames,
      );

      const rederived = buildReplayFilm(log, createFighterEnvironment());
      expect(rederived.finalStateHash).toBe(before);
      expect(rederived.finalStateHash).toBe((log as { finalStateHash: string }).finalStateHash);
      expect(rederived.matchesRecordedHash).toBe(true);
      expect(film.finalStateHash).toBe(before);
      expect(film.matchesRecordedHash).toBe(true);
    }
  });

  it('leaves the clock exactly as long with the cue attached as without it', () => {
    // Audio is not allowed to lengthen the transport. The 90-frame freeze is
    // Story 10.4's and is already on the clock before this layer is built; the
    // cue rides an existing frame rather than adding one.
    const film = buildReplayFilm(ultimateLog(), createFighterEnvironment());
    const juice = buildJuiceTrack(film.frames);
    expect(buildAudioTrack(juice, DEFAULT_AUDIO_TUNING).frameCount).toBe(juice.frameCount);
    expect(buildAudioTrack(juice, RETUNED).frameCount).toBe(juice.frameCount);
  });
});

describe('nothing in the mix can reveal how long an Agent took (AC5, INV-3)', () => {
  it('carries no latency-derived field on any cue', async () => {
    const run = await replayPlaying(DEFAULT_AUDIO_TUNING);
    expect(run.cues.length).toBeGreaterThan(0);

    // A cue is three fields, and none of them is a time. The Command Log schema
    // exposes no duration at all, so a field named for one here would be either
    // dead or the first half of a change that needs the frozen contract widened.
    for (const cue of run.cues) {
      expect(Object.keys(cue).sort()).toStrictEqual(['bus', 'loop', 'name']);
      expect(typeof cue.name).toBe('string');
      expect(typeof cue.loop).toBe('boolean');
    }
  });

  it('carries only integers through the mix, so two runs are comparable byte for byte', async () => {
    // Gains travel as basis points and the single division into a float happens
    // at the `GainNode` boundary. An integer mix is a mix two runs can be
    // asserted equal on -- which is the assertion above, and it is only
    // available because nothing here accumulates a float.
    const run = await replayPlaying(DEFAULT_AUDIO_TUNING);
    for (const entry of run.gains) {
      for (const part of entry.split('/')) {
        expect(Number.isInteger(Number(part))).toBe(true);
      }
    }
  });

  it('produces the same cue stream for two Matches that differ only in how long they took', async () => {
    // The two logs are the same Match. `provenance` is where a real Command Log
    // records what happened around a call, and the audio layer reads none of it:
    // the film it derives from is a re-simulation from `seed`, so two documents
    // that agree on the decisions produce the same film and therefore the same
    // cue stream, whatever else differs between them.
    const log = await buildDemoLog();
    // A field the audio path could only reach by reading something it must not.
    // Attached through a plain-object clone rather than by assigning to the
    // typed log: the point is that the document carries *more* than the schema
    // names, and the audio layer still cannot see any of it.
    const slower = {
      ...(JSON.parse(JSON.stringify(log)) as Record<string, unknown>),
      note: 'this Match was played by two very slow Deployments',
    } as unknown as typeof log;

    const runs = [log, slower].map((document) => {
      const film = buildReplayFilm(document, createFighterEnvironment());
      const juice = buildJuiceTrack(film.frames);
      const sink = createRecordingSink();
      const director = createAudioDirector({
        track: buildAudioTrack(juice, DEFAULT_AUDIO_TUNING),
        sink,
      });
      for (let index = 0; index < juice.frameCount; index += 1) {
        director.atFrame(index);
      }
      return sink;
    });

    expect(runs[0].cues()).toStrictEqual(runs[1].cues());
    expect(runs[0].gains()).toStrictEqual(runs[1].gains());
    expect(runs[0].cues().length).toBeGreaterThan(0);
  });
});
