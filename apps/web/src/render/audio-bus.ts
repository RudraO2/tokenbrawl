import { BASIS_POINTS_FULL } from '../replay/film';
import type { AudioCue, AudioSink } from './audio';

/**
 * Story 9.6: the WebAudio sink. Three buses, one graph, and every failure a
 * silence rather than a throw.
 *
 * Everything above this file is pure and indexed (`audio.ts`); this is the one
 * place that touches a host object, and it is written to the same two rules the
 * rest of `apps/web` lives by.
 *
 * **No DOM or WebAudio ambient types.** `tsconfig.base.json` -- the one project
 * `tsc --noEmit` actually checks -- ships `lib: ["ES2022"]` with no DOM, and
 * adding DOM there would hand `packages/core` ambient `window` and
 * `AudioContext` types, weakening the type-level half of INV-3 across the whole
 * repo to spare a handful of interfaces here. So every host object is declared
 * structurally, exactly as `CanvasSurface`/`HostView` are in `main.ts`. The real
 * browser objects satisfy these shapes, so `startup.ts` passes them unwrapped.
 *
 * **No `AudioContext.currentTime`.** The idiomatic WebAudio mix ramps a gain
 * with `setTargetAtTime(target, ctx.currentTime, tau)` and schedules a source at
 * `ctx.currentTime + delay`. `currentTime` is a wall clock, and using it would
 * re-introduce precisely the timer the frame-counted design exists to avoid --
 * so gains are plain `node.gain.value` assignments and sources start with
 * `start(0)`. `source-discipline.test.ts`'s wall-clock sweep names `currentTime`
 * for this reason.
 *
 * ## Fail-soft, in five directions
 *
 * Absent `AudioContext`, absent `fetch`, a constructor that throws, a 404, a
 * decode rejection and a suspended context that refuses to resume each degrade
 * to silence with at most one `console.warn` -- the same warn-not-throw shape
 * `startup.ts`'s `loadArtist`/`loadBackdrop` already use for the sprite packs
 * and the backdrop. Nothing here is ever awaited by the paint path, and nothing
 * here rejects into it: `play` returns `void` and swallows its own promise.
 *
 * A name that failed is cached *as absent* and never fetched again. Without
 * that, one missing SFX file becomes one failed request per hit for the length
 * of a Match.
 */

/** A `GainNode`'s `gain`: one settable number, which is the whole of what the mix needs. */
export interface AudioParamLike {
  value: number;
}

export interface GainNodeLike {
  readonly gain: AudioParamLike;
  connect(destination: unknown): void;
}

export interface AudioBufferSourceLike {
  buffer: unknown;
  loop: boolean;
  connect(destination: unknown): void;
  /** `start(0)` only. The argument exists because the real API requires it, not because a time is computed. */
  start(when: number): void;
  /** `stop(0)` -- "now", same reasoning as `start`. Optional: a host that cannot stop a source simply keeps it. */
  stop?(when: number): void;
  disconnect?(): void;
}

export interface AudioContextLike {
  readonly destination: unknown;
  /** `'suspended'` until a user gesture, in every browser that autoplay-gates audio. */
  readonly state?: 'suspended' | 'running' | 'interrupted' | 'closed';
  createGain(): GainNodeLike;
  createBufferSource(): AudioBufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<unknown>;
  resume?(): Promise<void>;
}

/** What loading a cue needs of a response, and nothing more. */
export interface AudioFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AudioBusConfig {
  /** Absent on a browser with no WebAudio, and absent under test unless a fake is handed in. */
  readonly AudioContext?: new () => AudioContextLike;
  readonly fetch?: (url: string) => Promise<AudioFetchResponse>;
  /** Cue name → same-origin path. Overridable so a test can assert the graph without a naming convention. */
  readonly urlFor?: (name: string) => string;
}

/**
 * Where a cue's file lives. Same-origin and rooted, so the offline sweep in
 * `style-discipline.test.ts` has nothing to find and the site keeps rendering
 * identically with no network.
 *
 * Story 9.7 landed the roster's audio behind these paths, provenanced in
 * `docs/ASSETS.md` per that doc's licence rule. A path that 404s (e.g. a name
 * not yet in `DEFAULT_AUDIO_TUNING`'s shipped set) is still cached as absent
 * after exactly one attempt.
 */
function defaultUrlFor(name: string): string {
  // Encoded rather than interpolated raw. Every name in `DEFAULT_AUDIO_TUNING`
  // is a plain identifier today, but the tuning table is advertised as
  // hand-editable by a later story, and a name containing `/`, `..` or `//`
  // would escape this directory -- `//host/x.mp3` is protocol-relative and would
  // fetch from another origin, which is exactly what `style-discipline.test.ts`
  // and the offline guarantee forbid. `resolveSidecarUrl` in `startup.ts`
  // refuses the same two shapes for the same reason.
  return `/audio/${encodeURIComponent(name)}.mp3`;
}

/** Reported, never swallowed silently: audio that failed looks identical to audio nobody wired up. */
function warn(what: string, error: unknown): void {
  console.warn(`${what}: ${String(error instanceof Error ? error.message : error)}`);
}

/**
 * Builds the three-bus graph, or returns `null` when this environment has no
 * WebAudio at all.
 *
 * `null` rather than a silent stub, because the two are different facts and
 * `main.ts` should be able to mount with no sink at all -- which is also the
 * configuration every existing test runs in, and the configuration the
 * hash-neutrality case compares against.
 */
export function createAudioBus(config: AudioBusConfig): AudioSink | null {
  const Ctor = config.AudioContext;
  if (Ctor === undefined) {
    return null;
  }

  const started = ((): AudioContextLike | null => {
    try {
      return new Ctor();
    } catch (error) {
      warn('Audio unavailable, the Match will play silently', error);
      return null;
    }
  })();
  if (started === null) {
    return null;
  }
  const context = started;

  const buses = ((): Readonly<Record<AudioCue['bus'], GainNodeLike>> | null => {
    try {
      // Three independent nodes, each connected straight to `destination`.
      // Independent is the point: the KO duck moves the music bus and must leave
      // the SFX that fired on the same frame at full level.
      const made = {
        music: context.createGain(),
        sfx: context.createGain(),
        voice: context.createGain(),
      };
      made.music.connect(context.destination);
      made.sfx.connect(context.destination);
      made.voice.connect(context.destination);
      return Object.freeze(made);
    } catch (error) {
      warn('Audio graph could not be built, the Match will play silently', error);
      return null;
    }
  })();
  if (buses === null) {
    return null;
  }
  // Rebound after the guard, the same way `context` is above: TypeScript will
  // not carry a narrowing into the closures below, which may legally outlive
  // the check.
  const graph = buses;

  // Decoded buffer per cue name; `null` means "this name is absent, stop
  // asking". Both live in one map so a name is looked up once, and the map holds
  // the *promise* so two cues of the same name in flight at once share a single
  // fetch rather than racing two.
  const loading = new Map<string, Promise<unknown>>();

  async function bufferFor(name: string): Promise<unknown> {
    const already = loading.get(name);
    if (already !== undefined) {
      return already;
    }

    const pending = (async (): Promise<unknown> => {
      try {
        const fetchAudio = config.fetch;
        if (fetchAudio === undefined) {
          throw new Error('this environment has no fetch, so no audio can be loaded');
        }
        const url = (config.urlFor ?? defaultUrlFor)(name);
        const response = await fetchAudio(url);
        if (!response.ok) {
          throw new Error(`could not load ${url} (HTTP ${String(response.status)})`);
        }
        return await context.decodeAudioData(await response.arrayBuffer());
      } catch (error) {
        // Cached as absent by the resolved `null` this returns: the entry stays
        // in `loading`, so the next `play` of this name resolves instantly to
        // `null` and never touches the network again.
        warn(`Audio cue "${name}" unavailable, that sound will be silent`, error);
        return null;
      }
    })();

    loading.set(name, pending);
    return pending;
  }

  /**
   * Starts one cue, once its buffer is in hand.
   *
   * Deliberately `async` and deliberately un-awaited by the caller. The paint
   * path may not block, and it may not be handed a promise that can reject:
   * every failure inside here is already a resolved `null` or a caught throw, so
   * the promise this returns settles and does nothing.
   *
   * A cue whose buffer has already been decoded starts on the microtask after
   * the frame that asked for it, which is inaudible; a cue whose file is still
   * arriving starts when it arrives. Neither reads a clock.
   */
  /**
   * Every source this sink has started and not yet stopped.
   *
   * Held so `stopAll` can end them. A one-shot is added and never removed by
   * itself -- the port declares no `onended`, and adding one to reap a few
   * hundred entries per Match would widen the host surface for bookkeeping
   * nobody hears. `stopAll` clears the set wholesale, and it is called on every
   * re-mount and every Replay, which is the only place the set could grow
   * without bound.
   */
  const playing = new Set<AudioBufferSourceLike>();

  async function playCue(cue: AudioCue): Promise<void> {
    try {
      const buffer = await bufferFor(cue.name);
      if (buffer === null || buffer === undefined) {
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = cue.loop;
      source.connect(graph[cue.bus]);
      // `start(0)` -- "now", with no time computed from anything. See the
      // docblock: `ctx.currentTime` is a wall clock and this file does not read
      // one.
      source.start(0);
      playing.add(source);
    } catch (error) {
      warn(`Audio cue "${cue.name}" (bus "${cue.bus}") could not be played`, error);
    }
  }

  /** Basis points in, the one float out. The single division in the whole audio layer. */
  const level = (basisPoints: number): number => {
    if (!Number.isFinite(basisPoints)) {
      return 0;
    }
    return Math.max(0, Math.min(BASIS_POINTS_FULL, Math.floor(basisPoints))) / BASIS_POINTS_FULL;
  };

  return Object.freeze({
    play: (cue: AudioCue): void => {
      void playCue(cue);
    },
    stopAll: (): void => {
      // Each source independently: one that has already ended throws on `stop`
      // in some engines, and one bad source must not leave the rest of a stale
      // Match's audio playing under the new one.
      for (const source of playing) {
        try {
          source.stop?.(0);
        } catch {
          // Already ended, or a host that declines to stop it. Nothing to do:
          // it is being dropped either way.
        }
        try {
          source.disconnect?.();
        } catch {
          // Same.
        }
      }
      playing.clear();
    },
    setGains: (
      musicBasisPoints: number,
      sfxBasisPoints: number,
      voiceBasisPoints: number,
    ): void => {
      try {
        graph.music.gain.value = level(musicBasisPoints);
        graph.sfx.gain.value = level(sfxBasisPoints);
        graph.voice.gain.value = level(voiceBasisPoints);
      } catch (error) {
        warn('Audio gains could not be applied', error);
      }
    },
    unlock: (): void => {
      // Called from the transport and fighter-target handlers -- the only user
      // gestures on the page. A browser that never suspended the context needs
      // nothing done, and one whose `resume()` rejects (a tab that was closed
      // out from under it) must not turn a button press into an unhandled
      // rejection.
      try {
        // Anything that is not already running is worth trying to resume, not
        // `'suspended'` alone: iOS Safari parks a context in `'interrupted'`
        // after a phone call or an app switch, and a check for the one literal
        // left the page silent for the rest of the session with no way back.
        // `'closed'` cannot be resumed, and its rejection is caught below.
        if (context.state === undefined || context.state === 'running') {
          return;
        }
        void context.resume?.()?.catch((error: unknown) => {
          warn('Audio could not be unlocked, the Match will play silently', error);
        });
      } catch (error) {
        warn('Audio could not be unlocked, the Match will play silently', error);
      }
    },
  });
}
