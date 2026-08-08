import type { EnvironmentAdapter } from '@tokenbrawl/contracts';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import { createPlaybackClock, type CancelFrame, type PlaybackClock, type RequestFrame } from '../player/clock';
import { buildReplayFilm, type ReplayFilm } from '../replay/film';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack, type JuiceTrack } from '../render/juice';
import type { LoopOffset, SpectateManifest, SpectateManifestEntry } from './manifest';

/**
 * Story 9.3: the manifest walk.
 *
 * Owns exactly one active `PlaybackClock`/`ReplayFilm` pair at a time and
 * advances to the next manifest entry when the current one's clock finishes.
 * `buildReplayFilm` and `createPlaybackClock` are imported and used **as
 * is** -- this module does not fork or reimplement either (a hard constraint
 * of this story): it is the sequencing layer that sits above them, the same
 * way `main.ts`'s `mountPlayer` is a sequencing layer above one film/clock
 * pair rather than a second implementation of either.
 *
 * Written to be shareable with Story 9.8's landing-page carousel, per the
 * epic's cross-story note -- nothing here is spectate-panel-specific. A
 * caller supplies `requestFrame`/`cancelFrame` and a handful of callbacks and
 * gets back a handle it can drive from any host (a panel, a carousel).
 *
 * **No wall-clock read anywhere in this file.** The one permitted
 * `Date.now()`-equivalent lives in `manifest.ts`'s `offsetForNow`, called
 * once by the caller before `startLoop` -- this module only ever receives an
 * already-computed `LoopOffset` and steps frames from there (INV-3).
 *
 * ## Fail-soft per entry
 *
 * A manifest entry that cannot be fetched, or whose Command Log fails schema
 * validation or hash verification, must never crash the walk (the I/O
 * matrix's "manifest entry fetch fails or fails hash verification" row).
 * `loadEntry` below is the one place that can fail, and every caller of it
 * catches, warns, and tries the next entry -- up to once around the whole
 * manifest, so a manifest whose every entry is broken reports a warning and
 * goes idle rather than spinning forever.
 *
 * ## Story 11.6: the clock's axis is the juice track's, not the film's
 *
 * Until this story the clock was created with `film.frames.length`, which is
 * why Spectate had no hitstop, no sparks and no cinematic: there was no juice
 * track for it to have. There is now one per mounted entry, built here rather
 * than in `panel.ts` for a structural reason -- the clock's `frameCount` *is*
 * the track's length, so the module that creates the clock has to be the module
 * that creates the track, or the two could disagree on the one failure path
 * neither caller can see.
 *
 * `buildJuiceTrack` is imported and called, never forked: same tuning, same
 * arena, same config as `main.ts`'s `mountPlayer` hands it, so one Match looks
 * the same on both surfaces by construction rather than by two call sites
 * happening to agree.
 *
 * Audio deliberately does *not* live here. It needs a sink -- a host object --
 * and this module is written to be host-free and shareable with Story 9.8's
 * carousel. The track crosses that boundary once, as `onEntryChange`'s third
 * argument, and `panel.ts` builds the audio track and director from it.
 */

export interface SpectateWalkDeps {
  readonly manifest: SpectateManifest;
  readonly fetchJson: (url: string) => Promise<unknown>;
  readonly env: EnvironmentAdapter<FighterState>;
  readonly requestFrame: RequestFrame;
  readonly cancelFrame?: CancelFrame;
  readonly reducedMotion?: boolean;
  /**
   * Fired whenever the active entry changes -- a fresh loop step, a manual pick, or a resume.
   *
   * Story 11.6 adds the entry's `JuiceTrack` as a third argument. It is what a
   * caller needs to build the audio for this entry (`buildAudioTrack` takes the
   * juice track, not the film), and handing it here rather than making the
   * caller re-read `currentTrack()` removes any question of which entry's track
   * it got.
   */
  readonly onEntryChange?: (entry: SpectateManifestEntry, film: ReplayFilm, track: JuiceTrack) => void;
  /**
   * Story 11.6: a **clock** index, not a film index. With hitstop the two
   * diverge; `currentTrack()!.filmIndexAt` is the mapping, exactly as
   * `main.ts`'s paint path uses `track.filmIndexAt`.
   */
  readonly onFrame?: (clockIndex: number) => void;
  /** Every fail-soft skip is reported here, never swallowed silently. */
  readonly onWarning?: (message: string) => void;
}

export interface SpectateWalkHandle {
  /** Begins the ambient loop, joining at the manifest position `offset` computed for "now". */
  readonly startLoop: (offset: LoopOffset) => Promise<void>;
  /** Suspends the loop and plays exactly one entry, by id. Fails soft (a warning, no throw) if the id is unknown or the entry cannot be loaded. */
  readonly playSpecific: (entryId: string) => Promise<void>;
  /** Resumes the ambient loop from the manifest position after the entry that was showing before the last `playSpecific` (or the current loop position, if no pick has happened). */
  readonly resumeLoop: () => Promise<void>;
  readonly currentEntryId: () => string | null;
  readonly currentFilm: () => ReplayFilm | null;
  /**
   * Story 11.6. The active entry's juice track -- the axis its clock runs on.
   * Null exactly when `currentFilm()` is: the two are set and cleared together.
   */
  readonly currentTrack: () => JuiceTrack | null;
  readonly currentClock: () => PlaybackClock | null;
  readonly stop: () => void;
}

/** What `loadEntry` can throw for -- a fetch rejection, a thrown schema/hash failure, or a false `matchesRecordedHash`. */
async function loadEntry(
  entry: SpectateManifestEntry,
  deps: SpectateWalkDeps,
): Promise<ReplayFilm> {
  const document = await deps.fetchJson(entry.commandLogUrl);
  const film = buildReplayFilm(document, deps.env);
  if (!film.matchesRecordedHash) {
    throw new Error(
      `entry "${entry.id}" failed hash verification (recomputed ${film.finalStateHash} vs recorded ${film.recordedStateHash})`,
    );
  }
  return film;
}

/**
 * Builds a walk over `deps.manifest`.
 *
 * Closure state only (house convention, `source-discipline.test.ts`'s
 * sibling sweep for `spectate/` forbids a module-level mutable binding the
 * same way it forbids one everywhere else in this app): every mutable field
 * below lives inside this factory, so two walks never interfere.
 */
export function createSpectateWalk(deps: SpectateWalkDeps): SpectateWalkHandle {
  const { manifest } = deps;

  const state: {
    mode: 'loop' | 'picked';
    /** The loop position to resume from once a `picked` entry finishes -- the index *after* the one that was showing (AC: "resumes from the manifest position after the entry that was playing"). */
    resumeIndex: number;
    entryIndex: number;
    entryId: string | null;
    film: ReplayFilm | null;
    /** Story 11.6. Set and cleared with `film`, never independently. */
    track: JuiceTrack | null;
    clock: PlaybackClock | null;
    /** Bumped on every load, so a stale async response from a superseded call is dropped rather than clobbering a newer one (re-entrancy guard). */
    generation: number;
    stopped: boolean;
  } = {
    mode: 'loop',
    resumeIndex: 0,
    entryIndex: 0,
    entryId: null,
    film: null,
    track: null,
    clock: null,
    generation: 0,
    stopped: false,
  };

  function stopClock(): void {
    state.clock?.stop();
    state.clock = null;
  }

  function warn(message: string): void {
    deps.onWarning?.(message);
  }

  /**
   * Advances the loop's own cursor, wrapping to the first entry at the end
   * (the "end of manifest" row of the I/O matrix). Only ever called for
   * `mode === 'loop'`.
   */
  function nextLoopIndex(fromIndex: number): number {
    return (fromIndex + 1) % manifest.entries.length;
  }

  /**
   * Loads and mounts one entry, retrying forward through the manifest on
   * failure (fail-soft skip) up to the whole manifest's length once, so a
   * manifest with every entry broken warns and stops rather than looping
   * forever.
   *
   * `advance` decides what index comes after a failure or after this entry
   * finishes -- the loop wraps, a manual pick does not retry at all (an
   * unplayable pick just warns and leaves the previous entry on screen).
   */
  async function mount(
    startIndex: number,
    advance: (index: number) => number,
    onFinished: () => void,
    maxAttempts: number = manifest.entries.length,
  ): Promise<void> {
    const myGeneration = (state.generation += 1);
    let index = startIndex;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const entry = manifest.entries[index];
      let film: ReplayFilm;
      try {
        film = await loadEntry(entry, deps);
      } catch (error) {
        warn(
          `Spectate: skipping "${entry.id}" -- ${error instanceof Error ? error.message : String(error)}`,
        );
        if (myGeneration !== state.generation) {
          // Superseded while this attempt's fetch was in flight -- a newer
          // call (a pick, or the walk having been stopped) owns the state now.
          return;
        }
        index = advance(index);
        continue;
      }

      if (myGeneration !== state.generation || state.stopped) {
        return;
      }

      // Mounting the film (creating the clock, notifying the caller, starting
      // playback) is wrapped the same way loading it is: a caller-supplied
      // `requestFrame`/`onEntryChange` that throws synchronously must not
      // surface as an unhandled rejection out of this async function -- the
      // same P1 category Story 9.2's review pass found in `startup.ts`'s
      // `mount()`. Treated exactly like a load failure: warned, and the walk
      // moves on to the next entry rather than getting stuck.
      try {
        stopClock();
        state.entryIndex = index;
        state.entryId = entry.id;
        state.film = film;
        // Story 11.6. Inside the same `try` the clock and the callbacks are in:
        // a throw from here is a mount failure like any other -- warned, and the
        // walk moves to the next entry -- rather than an unhandled rejection out
        // of an async function.
        const track = buildJuiceTrack(
          film.frames,
          DEFAULT_JUICE_TUNING,
          arenaFor(DEFAULT_FIGHTER_CONFIG),
          deps.reducedMotion === true,
          DEFAULT_FIGHTER_CONFIG,
        );
        state.track = track;
        const clock = createPlaybackClock({
          // The track's length, not the film's: with hitstop and the Ultimate's
          // freeze the two differ by up to a third of a Match, and a clock run
          // on the film's length would cut every hold short.
          frameCount: track.frameCount,
          requestFrame: deps.requestFrame,
          ...(deps.cancelFrame === undefined ? {} : { cancelFrame: deps.cancelFrame }),
          ...(deps.reducedMotion === undefined ? {} : { reducedMotion: deps.reducedMotion }),
          onFrame: (clockIndex) => {
            deps.onFrame?.(clockIndex);
            if (deps.reducedMotion === true) {
              // Story 11.6. A reduced-motion clock never schedules: `start()`
              // emits the last frame once, directly, and returns. That arrives
              // here looking exactly like an entry that finished playing, and
              // advancing on it would mount the next entry, which would emit
              // *its* last frame, which would advance again -- the whole
              // manifest fetched in a tight microtask chain, forever, on the
              // browsers of precisely the visitors who asked for less.
              //
              // So the ambient loop does not advance under the preference. The
              // stream is one still frame, which is what "honours it exactly as
              // the player does" means for a surface whose player shows a
              // still: no motion, and no traffic either.
              return;
            }
            if (clockIndex >= track.frameCount - 1) {
              // The clock has already stopped itself (Story 4.1's own
              // contract); this call is what decides what plays next.
              if (myGeneration === state.generation && !state.stopped) {
                onFinished();
              }
            }
          },
        });
        state.clock = clock;
        deps.onEntryChange?.(entry, film, track);
        clock.start();
        return;
      } catch (error) {
        state.entryId = null;
        state.film = null;
        state.track = null;
        state.clock = null;
        warn(
          `Spectate: could not mount "${entry.id}" -- ${error instanceof Error ? error.message : String(error)}`,
        );
        if (myGeneration !== state.generation) {
          return;
        }
        index = advance(index);
        continue;
      }
    }

    warn('Spectate: every manifest entry failed to load; nothing to play.');
  }

  /**
   * Every fire-and-forget entry point into `mount` (advancing the loop, or
   * resuming it after a pick) goes through here rather than a bare `void
   * mount(...)`, so a rejection that somehow escapes `mount`'s own try/catch
   * -- a caller callback throwing synchronously before that block, for
   * instance -- is still caught and reported instead of becoming an
   * unhandled promise rejection.
   */
  function fireAndForget(promise: Promise<void>): void {
    promise.catch((error: unknown) => {
      warn(`Spectate: internal error -- ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function playLoopFrom(index: number): void {
    fireAndForget(
      mount(
        index,
        (i) => nextLoopIndex(i),
        () => {
          playLoopFrom(nextLoopIndex(state.entryIndex));
        },
      ),
    );
  }

  async function startLoop(offset: LoopOffset): Promise<void> {
    state.mode = 'loop';
    state.stopped = false;
    const clampedIndex = Math.max(0, Math.min(offset.entryIndex, manifest.entries.length - 1));
    await mount(
      clampedIndex,
      (i) => nextLoopIndex(i),
      () => {
        playLoopFrom(nextLoopIndex(state.entryIndex));
      },
    );
    // Joining mid-entry: seek to the computed frame offset once the film is
    // mounted and running, rather than always starting the first entry of a
    // fresh join at its own frame zero (AD-17's "a visitor arriving mid-loop
    // sees a Match already in progress"). `seek` never re-enters INV-3's
    // frame-counted path -- it is the same verb the existing timeline scrub
    // uses.
    if (state.entryId === manifest.entries[clampedIndex].id && state.track !== null) {
      // Clamped against the *track*, not the film (Story 11.6). The offset comes
      // from `offsetForNow` over a manifest whose `frameCount` is now the
      // track's length, so clamping to the film's would drag every mid-loop join
      // backwards by exactly the juice this story added.
      const clamped = Math.max(0, Math.min(offset.frameOffset, state.track.frameCount - 1));
      state.clock?.seek(clamped);
    }
  }

  async function playSpecific(entryId: string): Promise<void> {
    const index = manifest.entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) {
      warn(`Spectate: no manifest entry "${entryId}" to play.`);
      return;
    }
    state.mode = 'picked';
    state.resumeIndex = nextLoopIndex(index);
    state.stopped = false;
    // A pick never retries onto a different entry on failure -- an unplayable
    // pick warns and leaves whatever was already on screen alone, rather than
    // silently substituting a different Match for the one a visitor chose.
    // `maxAttempts: 1` is what enforces "never retries": without it `mount`'s
    // own retry loop would hammer the same broken URL up to
    // `manifest.entries.length` times before giving up.
    await mount(
      index,
      (i) => i,
      () => {
        fireAndForget(resumeLoop());
      },
      1,
    );
  }

  async function resumeLoop(): Promise<void> {
    state.mode = 'loop';
    state.stopped = false;
    playLoopFrom(state.resumeIndex);
  }

  function stop(): void {
    state.stopped = true;
    state.generation += 1;
    stopClock();
    // Clear the "current" accessors along with the clock -- a caller polling
    // `currentEntryId`/`currentFilm` after `stop()` must see "nothing is
    // playing", not the last-playing entry's stale identity.
    state.mode = 'loop';
    state.entryId = null;
    state.film = null;
    state.track = null;
  }

  return Object.freeze({
    startLoop,
    playSpecific,
    resumeLoop,
    currentEntryId: (): string | null => state.entryId,
    currentFilm: (): ReplayFilm | null => state.film,
    currentTrack: (): JuiceTrack | null => state.track,
    currentClock: (): PlaybackClock | null => state.clock,
    stop,
  });
}
