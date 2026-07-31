import { describe, expect, it } from 'vitest';
import { createPlaybackClock, type RequestFrame } from './clock';

/**
 * Story 4.1, AC3 and AC4.
 *
 * The clock is the narrowest place INV-3 can be broken, so the cases here are
 * about counting rather than timing: one frame per callback, in order, and a
 * stop at the end. A driver that ran the queue manually is the whole test
 * harness -- no fake timers, because there are no timers.
 */

interface Driver {
  readonly requestFrame: RequestFrame;
  readonly pump: (times: number) => void;
  readonly pending: () => number;
  readonly cancelled: () => readonly number[];
  readonly cancelFrame: (handle: number) => void;
}

function createDriver(): Driver {
  const queue: (() => void)[] = [];
  const cancelled: number[] = [];

  return {
    requestFrame: (callback: () => void) => {
      queue.push(callback);
      return queue.length;
    },
    cancelFrame: (handle: number) => {
      cancelled.push(handle);
    },
    cancelled: () => cancelled,
    pending: () => queue.length,
    pump: (times: number) => {
      for (let i = 0; i < times; i += 1) {
        const next = queue.shift();
        if (next === undefined) {
          return;
        }
        next();
      }
    },
  };
}

describe('the playback clock', () => {
  it('emits exactly one frame per animation-frame callback, in order (AC4)', () => {
    const driver = createDriver();
    const seen: number[] = [];
    const clock = createPlaybackClock({
      frameCount: 5,
      onFrame: (index) => seen.push(index),
      requestFrame: driver.requestFrame,
    });

    clock.start();
    driver.pump(10);

    expect(seen).toStrictEqual([0, 1, 2, 3, 4]);
  });

  it('never receives a timestamp it could pace against (AC3, INV-3)', () => {
    // `requestAnimationFrame` hands its callback a DOMHighResTimeStamp. The
    // `RequestFrame` type declares a zero-argument callback, so the value is
    // unreachable rather than merely unused -- and a driver that supplies one
    // anyway changes nothing about the frames emitted.
    const queue: ((maybeTimestamp?: number) => void)[] = [];
    const seen: number[] = [];
    const clock = createPlaybackClock({
      frameCount: 3,
      onFrame: (index) => seen.push(index),
      requestFrame: (callback) => queue.push(callback as () => void),
    });

    clock.start();
    for (const stamp of [0, 1_000_000, 5]) {
      const next = queue.shift();
      next?.(stamp);
    }

    expect(seen).toStrictEqual([0, 1, 2]);
  });

  it('paces identically no matter how the callbacks are delivered (AC2)', () => {
    const run = (pumpPattern: readonly number[]): readonly number[] => {
      const driver = createDriver();
      const seen: number[] = [];
      const clock = createPlaybackClock({
        frameCount: 6,
        onFrame: (index) => seen.push(index),
        requestFrame: driver.requestFrame,
      });
      clock.start();
      for (const chunk of pumpPattern) {
        driver.pump(chunk);
      }
      return seen;
    };

    expect(run([10])).toStrictEqual(run([1, 1, 1, 1, 1, 1, 1]));
    expect(run([10])).toStrictEqual(run([3, 3, 3]));
  });

  it('stops itself at the last frame and schedules nothing further', () => {
    const driver = createDriver();
    const clock = createPlaybackClock({
      frameCount: 2,
      onFrame: () => undefined,
      requestFrame: driver.requestFrame,
    });

    clock.start();
    driver.pump(5);

    expect(clock.isRunning()).toBe(false);
    expect(clock.frameIndex()).toBe(1);
    expect(driver.pending()).toBe(0);
  });

  it('ignores a second start rather than running two loops at double rate', () => {
    const driver = createDriver();
    const seen: number[] = [];
    const clock = createPlaybackClock({
      frameCount: 4,
      onFrame: (index) => seen.push(index),
      requestFrame: driver.requestFrame,
    });

    clock.start();
    clock.start();
    clock.start();
    driver.pump(10);

    expect(seen).toStrictEqual([0, 1, 2, 3]);
  });

  it('stops on request and cancels the frame it had scheduled', () => {
    const driver = createDriver();
    const seen: number[] = [];
    const clock = createPlaybackClock({
      frameCount: 10,
      onFrame: (index) => seen.push(index),
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    clock.start();
    driver.pump(2);
    clock.stop();
    driver.pump(5);

    expect(seen).toStrictEqual([0, 1]);
    expect(clock.isRunning()).toBe(false);
    expect(driver.cancelled().length).toBe(1);
  });

  it('honours reduced motion by landing on the final frame with no animation', () => {
    const driver = createDriver();
    const seen: number[] = [];
    const clock = createPlaybackClock({
      frameCount: 48,
      onFrame: (index) => seen.push(index),
      requestFrame: driver.requestFrame,
      reducedMotion: true,
    });

    clock.start();
    driver.pump(10);

    // The end of the Match, not the start: a viewer who asked for no motion
    // still wants to see the result.
    expect(seen).toStrictEqual([47]);
    expect(driver.pending()).toBe(0);
    expect(clock.isRunning()).toBe(false);
  });

  it('does nothing for an empty film rather than emitting a negative frame', () => {
    const driver = createDriver();
    const seen: number[] = [];
    const clock = createPlaybackClock({
      frameCount: 0,
      onFrame: (index) => seen.push(index),
      requestFrame: driver.requestFrame,
    });

    clock.start();
    driver.pump(3);

    expect(seen).toStrictEqual([]);
    expect(clock.frameIndex()).toBe(-1);
  });

  it('rejects a nonsensical frame count at construction', () => {
    for (const frameCount of [-1, 1.5, Number.NaN]) {
      expect(() =>
        createPlaybackClock({
          frameCount,
          onFrame: () => undefined,
          requestFrame: createDriver().requestFrame,
        }),
      ).toThrow(/non-negative safe integer/);
    }
  });
});
