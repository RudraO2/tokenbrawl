import type { CommandLog } from '@tokenbrawl/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildDemoLog } from '../testing/demo-log';
import { buildReplayFilm } from '../replay/film';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack } from '../render/juice';
import { createSpectateWalk } from './walk';
import type { SpectateManifest } from './manifest';

/**
 * Story 9.3. Real Command Logs (three different seeds of the committed demo
 * pairing) rather than hand-built fixtures, for the same reason `film.test.ts`
 * uses `buildDemoLog`: a fake log risks testing this module against a shape
 * `buildReplayFilm` would never actually see.
 *
 * Story 11.6. Every "pump an entry to its end" here counts **clock** frames,
 * which is the film's length plus every hitstop hold plus any cinematic freeze.
 * That is the whole of what this story changed in this module, and pumping the
 * film's length instead is precisely the bug it fixes -- so the counts are
 * derived from a real `buildJuiceTrack` rather than written down, and
 * `expectsMoreClockThanFilmFrames` below is what stops the two silently
 * becoming the same number again.
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
  /** Film frames, kept only so the clock/film divergence can be asserted rather than assumed. */
  let filmCounts: readonly [number, number, number];
  /** Clock frames -- the axis the clock actually runs on since Story 11.6. */
  let frameCounts: readonly [number, number, number];

  function clockFramesOf(log: CommandLog): number {
    return buildJuiceTrack(
      buildReplayFilm(log, env).frames,
      DEFAULT_JUICE_TUNING,
      arenaFor(DEFAULT_FIGHTER_CONFIG),
      false,
      DEFAULT_FIGHTER_CONFIG,
    ).frameCount;
  }

  beforeAll(async () => {
    const built = await Promise.all([
      buildDemoLog(4_101),
      buildDemoLog(4_102),
      buildDemoLog(4_103),
    ]);
    logs = [built[0], built[1], built[2]];
    filmCounts = [
      buildReplayFilm(logs[0], env).frames.length,
      buildReplayFilm(logs[1], env).frames.length,
      buildReplayFilm(logs[2], env).frames.length,
    ];
    frameCounts = [clockFramesOf(logs[0]), clockFramesOf(logs[1]), clockFramesOf(logs[2])];
  });

  it('these fixtures really do have hitstop in them, so "pump to the end" means something', () => {
    // Without this, every "advances at the end of an entry" case below would
    // still pass against a walk that never built a juice track at all -- the
    // two counts would simply be equal and the regression invisible.
    expect(frameCounts[0]).toBeGreaterThan(filmCounts[0]);
    expect(frameCounts[1]).toBeGreaterThan(filmCounts[1]);
    expect(frameCounts[2]).toBeGreaterThan(filmCounts[2]);
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
    // A hard ceiling on how many entries one case may load. No correct case in
    // this file loads more than a handful, and a walk that spins -- mounting an
    // entry, treating it as finished, mounting the next, forever -- would
    // otherwise starve the event loop and hang the suite rather than fail it.
    // Vitest's own timeout never fires against a livelock made of microtasks,
    // so the bound has to live here. Past it every entry fails to load,
    // `mount` exhausts its attempts, and the case ends on an assertion.
    const budget = { remaining: 60 };
    return async (url: string): Promise<unknown> => {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        throw new Error('the walk kept asking for entries');
      }
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

  describe('the juice layer (Story 11.6)', () => {
    it('runs the clock on the juice track, so an entry is still playing at the end of its film', async () => {
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
      // One frame short of the *film's* length, which is where the clock used
      // to end. The entry must still be "a", still running, with the hitstop
      // holds ahead of it.
      driver.pump(filmCounts[0]);
      await Promise.resolve();
      await Promise.resolve();

      expect(walk.currentEntryId()).toBe('a');
      expect(walk.currentClock()?.isRunning()).toBe(true);
    });

    it('exposes the entry track, whose frame count is the clock`s and exceeds the film`s', async () => {
      const ids = ['a'];
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

      const track = walk.currentTrack();
      const film = walk.currentFilm();
      expect(track).not.toBeNull();
      expect(track?.frameCount).toBe(frameCounts[0]);
      expect(track?.frameCount).toBeGreaterThan(film?.frames.length ?? 0);
      // The mapping the panel paints through: a clock index past the film's own
      // length still resolves to a real film frame.
      expect(track?.filmIndexAt(frameCounts[0] - 1)).toBe((film?.frames.length ?? 0) - 1);
    });

    it('hands the track to onEntryChange, and reports clock indices to onFrame', async () => {
      const ids = ['a'];
      const manifest = manifestOf(ids);
      const driver = createDriver();
      const seen: number[] = [];
      const entryTracks: number[] = [];

      const walk = createSpectateWalk({
        manifest,
        fetchJson: fetchFor(ids),
        env,
        requestFrame: driver.requestFrame,
        cancelFrame: driver.cancelFrame,
        onEntryChange: (_entry, _film, track) => entryTracks.push(track.frameCount),
        onFrame: (clockIndex) => seen.push(clockIndex),
      });

      await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
      driver.pump(3);

      expect(entryTracks).toStrictEqual([frameCounts[0]]);
      expect(seen.slice(0, 3)).toStrictEqual([0, 1, 2]);
    });

    it('joins at an offset that only exists on the track, rather than clamping to the film`s last frame', async () => {
      const ids = ['a'];
      const manifest = manifestOf(ids);
      const driver = createDriver();
      // A frame that exists on the clock and not in the film -- the exact range
      // a mid-loop join lands in once `manifest.json` records track lengths.
      const offset = filmCounts[0] + 1;

      const walk = createSpectateWalk({
        manifest,
        fetchJson: fetchFor(ids),
        env,
        requestFrame: driver.requestFrame,
        cancelFrame: driver.cancelFrame,
      });

      await walk.startLoop({ entryIndex: 0, frameOffset: offset });

      expect(offset).toBeLessThan(frameCounts[0]);
      expect(walk.currentClock()?.frameIndex()).toBe(offset);
    });

    it('clears the track with the film on stop(), so a caller never reads a stale pair', async () => {
      const ids = ['a'];
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
      expect(walk.currentTrack()).not.toBeNull();

      walk.stop();

      expect(walk.currentTrack()).toBeNull();
      expect(walk.currentFilm()).toBeNull();
    });

    it('honours reduced motion: same frame count, no shake, no autoplay', async () => {
      const ids = ['a'];
      const manifest = manifestOf(ids);
      const driver = createDriver();

      const walk = createSpectateWalk({
        manifest,
        fetchJson: fetchFor(ids),
        env,
        requestFrame: driver.requestFrame,
        cancelFrame: driver.cancelFrame,
        reducedMotion: true,
      });

      await walk.startLoop({ entryIndex: 0, frameOffset: 0 });

      const track = walk.currentTrack();
      // The mapping is deliberately not flattened -- same frame count, same
      // clock→film mapping -- so the manifest's recorded count stays correct
      // under either preference. Only the shake and the particles go.
      expect(track?.frameCount).toBe(frameCounts[0]);
      const shaken = Array.from({ length: frameCounts[0] }, (_, index) => track?.at(index)).filter(
        (frame) => frame !== undefined && (frame.shakeX !== 0 || frame.shakeY !== 0),
      );
      expect(shaken).toStrictEqual([]);
      // And the clock declines to autoplay, exactly as the player's does.
      expect(walk.currentClock()?.isRunning()).toBe(false);
    });

    it('reduced motion does not spin the manifest: a still stream fetches one entry, not every entry forever', async () => {
      const ids = ['a', 'b', 'c'];
      const manifest = manifestOf(ids);
      const driver = createDriver();
      const fetched: string[] = [];

      const load = fetchFor(ids);
      const walk = createSpectateWalk({
        manifest,
        fetchJson: async (url: string) => {
          fetched.push(url);
          return load(url);
        },
        env,
        requestFrame: driver.requestFrame,
        cancelFrame: driver.cancelFrame,
        reducedMotion: true,
      });

      await walk.startLoop({ entryIndex: 0, frameOffset: 0 });
      // A reduced-motion clock emits the final frame the instant it starts,
      // which reads exactly like an entry that finished. Left as an "advance",
      // that mounts the next entry, which emits *its* last frame, and so on:
      // the whole manifest fetched in a tight microtask chain that never yields.
      // Draining generously is what makes the absence of that chain checkable.
      for (const _ of Array.from({ length: 50 }, (__, index) => index)) {
        await Promise.resolve();
      }
      driver.pump(20);

      expect(fetched).toStrictEqual(['/replays/a.command-log.json']);
      expect(walk.currentEntryId()).toBe('a');
    });
  });
});
