import type { CommandLog } from '@tokenbrawl/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildDemoLog } from '../testing/demo-log';
import { buildReplayFilm } from '../replay/film';
import { createSpectateWalk } from './walk';
import type { SpectateManifest } from './manifest';

/**
 * Story 9.3. Real Command Logs (three different seeds of the committed demo
 * pairing) rather than hand-built fixtures, for the same reason `film.test.ts`
 * uses `buildDemoLog`: a fake log risks testing this module against a shape
 * `buildReplayFilm` would never actually see.
 */

interface Driver {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly pump: (times: number) => void;
  readonly pending: () => number;
}

/**
 * A real (if minimal) `requestAnimationFrame`/`cancelAnimationFrame` pair,
 * unlike `clock.test.ts`'s driver which never needs cancellation because it
 * only ever runs one clock. This one honours `cancelFrame`, because
 * `walk.ts` starts a second clock (on a pick, or on advancing to the next
 * loop entry) whose creation calls `stop()` on the first -- and a driver that
 * left the superseded callback queued would silently consume one extra
 * `pump()` call for a no-op, which is exactly what a real browser's
 * `cancelAnimationFrame` prevents.
 */
function createDriver(): Driver {
  const queue: (number | null)[] = [];
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    requestFrame: (callback: () => void) => {
      nextHandle += 1;
      const handle = nextHandle;
      callbacks.set(handle, callback);
      queue.push(handle);
      return handle;
    },
    cancelFrame: (handle: number) => {
      callbacks.delete(handle);
    },
    pending: () => queue.filter((handle) => handle !== null && callbacks.has(handle)).length,
    pump: (times: number) => {
      let remaining = times;
      while (remaining > 0 && queue.length > 0) {
        const handle = queue.shift();
        if (handle === null || handle === undefined) {
          continue;
        }
        const callback = callbacks.get(handle);
        callbacks.delete(handle);
        if (callback === undefined) {
          // Cancelled before it fired -- a real browser never calls it either.
          continue;
        }
        callback();
        remaining -= 1;
      }
    },
  };
}

describe('the manifest walk (Story 9.3)', () => {
  const env = createFighterEnvironment();
  let logs: readonly [CommandLog, CommandLog, CommandLog];
  let frameCounts: readonly [number, number, number];

  beforeAll(async () => {
    const built = await Promise.all([
      buildDemoLog(4_101),
      buildDemoLog(4_102),
      buildDemoLog(4_103),
    ]);
    logs = [built[0], built[1], built[2]];
    frameCounts = [
      buildReplayFilm(logs[0], env).frames.length,
      buildReplayFilm(logs[1], env).frames.length,
      buildReplayFilm(logs[2], env).frames.length,
    ];
  });

  function manifestOf(ids: readonly string[]): SpectateManifest {
    return {
      schemaVersion: '1.0.0',
      loopStartEpochMs: 0,
      totalLoopDurationMs: 1,
      entries: ids.map((id, index) => ({
        id,
        commandLogUrl: `/replays/${id}.command-log.json`,
        schemaVersion: '1.0.0',
        frameCount: frameCounts[index % frameCounts.length],
      })),
    };
  }

  function fetchFor(ids: readonly string[], broken: ReadonlySet<string> = new Set()) {
    return async (url: string): Promise<unknown> => {
      const id = ids.find((candidate) => url.includes(`/${candidate}.command-log`));
      if (id === undefined) {
        throw new Error(`unexpected url ${url}`);
      }
      if (broken.has(id)) {
        throw new Error(`network down for ${id}`);
      }
      const index = ids.indexOf(id);
      return logs[index % logs.length];
    };
  }

  it('starts the loop at the requested entry and plays its frames', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();
    const warnings: string[] = [];

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
      onWarning: (message) => warnings.push(message),
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });

    expect(walk.currentEntryId()).toBe('a');
    expect(walk.currentClock()?.isRunning()).toBe(true);
    expect(warnings).toStrictEqual([]);
  });

  it('joins mid-entry at the computed frame offset, never at frame zero when the offset says otherwise', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 1, frameOffset: 5 });

    expect(walk.currentEntryId()).toBe('b');
    expect(walk.currentClock()?.frameIndex()).toBe(5);
  });

  it('advances to the next manifest entry when the current one finishes, at constant pacing', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
    driver.pump(frameCounts[0]);
    // Draining the loop's own async mount (the `onFinished` callback awaits
    // `loadEntry`, which is a resolved promise here but still a microtask).
    await Promise.resolve();
    await Promise.resolve();

    expect(walk.currentEntryId()).toBe('b');
    expect(walk.currentClock()?.isRunning()).toBe(true);
  });

  it('wraps to the first entry once the last one completes', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 2, frameOffset: 0 });
    driver.pump(frameCounts[2]);
    await Promise.resolve();
    await Promise.resolve();

    expect(walk.currentEntryId()).toBe('a');
  });

  it('suspends the loop for a manual pick, then resumes from the position after the entry that was showing', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
    expect(walk.currentEntryId()).toBe('a');

    await walk.playSpecific('c');
    expect(walk.currentEntryId()).toBe('c');

    // Letting the picked entry finish returns to the loop, at the position
    // after "c" -- which is "a" again (wrap), not wherever the ambient loop
    // would have been had it kept running.
    driver.pump(frameCounts[2]);
    await Promise.resolve();
    await Promise.resolve();

    expect(walk.currentEntryId()).toBe('a');
  });

  it('warns and does nothing for an id that is not in the manifest', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();
    const warnings: string[] = [];

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
      onWarning: (message) => warnings.push(message),
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
    await walk.playSpecific('does-not-exist');

    expect(walk.currentEntryId()).toBe('a');
    expect(warnings.some((message) => message.includes('does-not-exist'))).toBe(true);
  });

  it('fails soft: a broken entry is skipped with a warning, and the walk lands on the next one', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();
    const warnings: string[] = [];

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids, new Set(['a'])),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
      onWarning: (message) => warnings.push(message),
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });

    expect(walk.currentEntryId()).toBe('b');
    expect(warnings.some((message) => message.includes('a'))).toBe(true);
  });

  it('never crashes when every entry in the manifest is broken', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();
    const warnings: string[] = [];

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids, new Set(ids)),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
      onWarning: (message) => warnings.push(message),
    });

    await expect(walk.startLoop({ entryIndex: 0, frameOffset: 0 })).resolves.toBeUndefined();

    expect(walk.currentEntryId()).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('skips a manifest entry that fails hash verification', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();
    const warnings: string[] = [];

    const walk = createSpectateWalk({
      manifest,
      fetchJson: async (url: string) => {
        if (url.includes('/a.command-log')) {
          // A tampered log: valid shape, wrong recorded hash.
          return { ...logs[0], finalStateHash: 'f'.repeat(64) };
        }
        return fetchFor(ids)(url);
      },
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
      onWarning: (message) => warnings.push(message),
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });

    expect(walk.currentEntryId()).toBe('b');
    expect(warnings.some((message) => message.includes('hash verification'))).toBe(true);
  });

  it('re-entrancy: calling playSpecific twice fast leaves only the second pick mounted, never both racing', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });

    const first = walk.playSpecific('b');
    const second = walk.playSpecific('c');
    await Promise.all([first, second]);

    expect(walk.currentEntryId()).toBe('c');
  });

  it('stop() halts the clock and further scheduled frames do nothing', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
    walk.stop();

    expect(walk.currentClock()).toBeNull();
    expect(() => driver.pump(5)).not.toThrow();
  });

  it('resumeLoop() after stop() actually resumes playback, not a silent no-op', async () => {
    const ids = ['a', 'b', 'c'];
    const manifest = manifestOf(ids);
    const driver = createDriver();

    const walk = createSpectateWalk({
      manifest,
      fetchJson: fetchFor(ids),
      env,
      requestFrame: driver.requestFrame,
      cancelFrame: driver.cancelFrame,
    });

    await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
    walk.stop();
    expect(walk.currentClock()).toBeNull();

    await walk.resumeLoop();
    // resumeLoop -> playLoopFrom is fire-and-forget internally (mirrors the
    // loop-advance path), so give its async `mount` a tick to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(walk.currentEntryId()).toBe('a');
    expect(walk.currentClock()).not.toBeNull();
  });
});
