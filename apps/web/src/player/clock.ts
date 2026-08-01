/**
 * Story 4.1: the playback clock, and the narrowest place INV-3 can be broken.
 *
 * It advances **exactly one film frame per animation-frame callback**. It does
 * not read a timestamp, does not subtract two clock values, and has no
 * delta-time path -- `requestAnimationFrame` hands its callback a
 * high-resolution time and this module's `RequestFrame` type deliberately
 * declares a callback that takes no arguments, so the value is unreachable
 * rather than merely unused. That is not stylistic: a type that cannot express
 * the timestamp is a guarantee a later story cannot quietly relax.
 *
 * The consequences, which are three of the story's five ACs at once:
 *
 * - **AC4**: at the browser's 60Hz refresh, one frame per callback is 60
 *   frames per playback second, constant, by construction.
 * - **AC2**: a Match between two slow Deployments and one between two fast
 *   ones produce films of the same length for the same Decision-Point count,
 *   and this clock treats both identically because it never learns which is
 *   which.
 * - **AC3**: there is no wall-clock or latency field read anywhere on this
 *   path, and `source-discipline.test.ts` sweeps the whole of `apps/web/src`
 *   to keep it that way.
 *
 * A delta-time loop -- the ordinary way to write a player -- would make
 * playback depend on the viewer's refresh rate and on how long the tab was
 * backgrounded. That is INV-1's latency confound wearing a different hat, and
 * it is why this file counts instead of measuring.
 */

/** Takes a zero-argument callback: the timestamp `requestAnimationFrame` supplies is deliberately unreachable. */
export type RequestFrame = (callback: () => void) => number;
export type CancelFrame = (handle: number) => void;

export interface PlaybackClock {
  /** Rewinds to the start, then plays. This is what the Replay button does. */
  readonly start: () => void;
  readonly stop: () => void;
  /**
   * Continues from the frame on screen.
   *
   * Story 4.3 needs this because reading is impossible at five Decision Points
   * per second: hovering a fighter stops the clock and leaving continues it,
   * and `start()` deliberately rewinds (Story 4.1 fixed the Replay button that
   * way) so resuming cannot be expressed with it. Story 4.5's scrub wants the
   * same verb.
   *
   * A no-op when the clock is already running, when the film has been played
   * to its end, and under reduced motion -- in that last case there is no
   * motion to resume, only a still that is already correct.
   */
  readonly resume: () => void;
  /** The frame most recently emitted, or `-1` before the first. */
  readonly frameIndex: () => number;
  readonly isRunning: () => boolean;
}

export interface PlaybackClockConfig {
  readonly frameCount: number;
  readonly onFrame: (index: number) => void;
  readonly requestFrame: RequestFrame;
  readonly cancelFrame?: CancelFrame;
  /**
   * When true, playback does not animate: the final frame is emitted once and
   * the clock stops. `prefers-reduced-motion: reduce` is honoured, and the
   * still it lands on is the end of the Match rather than the start, because a
   * viewer who asked for no motion still wants to see the result.
   */
  readonly reducedMotion?: boolean;
}

/**
 * Builds a clock over a film of `frameCount` frames.
 *
 * `start()` on an already-running clock is a no-op rather than a second loop:
 * two concurrent schedulers would advance the film at double rate, which is
 * the one bug in this file that would look like a rendering choice rather than
 * a defect.
 */
export function createPlaybackClock(config: PlaybackClockConfig): PlaybackClock {
  const { frameCount, onFrame, requestFrame } = config;

  if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
    throw new Error(
      `createPlaybackClock: frameCount must be a non-negative safe integer, got ${String(frameCount)}.`,
    );
  }

  // Module-level mutable state is banned in this repo's shipped packages;
  // closure state inside a factory is the house pattern, and it is per-clock
  // rather than per-module, so two players on one page cannot interfere.
  const state = { index: -1, running: false, handle: 0 };

  function stop(): void {
    state.running = false;
    if (state.handle !== 0) {
      config.cancelFrame?.(state.handle);
      state.handle = 0;
    }
  }

  function tick(): void {
    if (!state.running) {
      return;
    }

    state.index += 1;
    onFrame(state.index);

    if (state.index >= frameCount - 1) {
      stop();
      return;
    }

    state.handle = requestFrame(tick);
  }

  function start(): void {
    if (state.running || frameCount === 0) {
      return;
    }

    // Rewind. Without this the clock cannot be started twice: after a full
    // playback `index` sits at the last frame, so the next `start()` advances
    // straight past the end and emits an out-of-range index instead of
    // replaying. Found by clicking the Replay button rather than by any test --
    // every case here started from a fresh clock, which is exactly the state a
    // second press is not in.
    state.index = -1;

    if (config.reducedMotion === true) {
      // No scheduling at all. Emitting the last frame directly is what makes
      // this branch honest -- a "reduced" animation that still ran, only
      // faster, would still be motion.
      state.index = frameCount - 1;
      onFrame(state.index);
      return;
    }

    state.running = true;
    state.handle = requestFrame(tick);
  }

  function resume(): void {
    // Every guard here is a state a hover-to-read interaction actually reaches.
    // Running: the pointer re-entered a target without ever leaving the stage.
    // Finished: the Match ended while the panel was open, and resuming would
    // emit an out-of-range index -- the same defect `start()`'s rewind fixed
    // from the other direction. Reduced motion: there is no motion to resume,
    // and scheduling one would be the preference ignored.
    if (state.running || frameCount === 0 || config.reducedMotion === true) {
      return;
    }
    if (state.index >= frameCount - 1) {
      return;
    }

    state.running = true;
    state.handle = requestFrame(tick);
  }

  return Object.freeze({
    start,
    stop,
    resume,
    frameIndex: () => state.index,
    isRunning: () => state.running,
  });
}
