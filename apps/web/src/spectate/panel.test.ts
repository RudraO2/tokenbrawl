import type { CommandLog } from '@tokenbrawl/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildDemoLog } from '../testing/demo-log';
import { buildReplayFilm } from '../replay/film';
import {
  mountSpectatePanel,
  spectateMarkup,
  type SpectateCanvasNode,
  type SpectateHost,
  type SpectateNode,
  type SpectatePanelDeps,
} from './panel';
import type { SpectateManifest } from './manifest';

/**
 * Story 9.3. Structural fakes under Vitest's default `node` environment, the
 * same discipline `arcade/panel.test.ts` and `byok/panel.test.ts` use.
 */

interface FakeHost extends SpectateHost {
  readonly node: (selector: string) => SpectateNode;
  readonly fire: (selector: string, type: 'click') => void;
}

function createHost(): FakeHost {
  const nodes = new Map<string, SpectateNode>();
  const listeners = new Map<string, (() => void)[]>();
  const state = { html: '' };

  const child = (selector: string): SpectateNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const isCanvas = selector === 'canvas';
    const canvasContext = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: '',
      imageSmoothingEnabled: false,
      globalAlpha: 1,
      clearRect: (): void => undefined,
      fillRect: (): void => undefined,
      strokeRect: (): void => undefined,
      fillText: (): void => undefined,
      beginPath: (): void => undefined,
      moveTo: (): void => undefined,
      lineTo: (): void => undefined,
      closePath: (): void => undefined,
      fill: (): void => undefined,
      stroke: (): void => undefined,
      drawImage: (): void => undefined,
      save: (): void => undefined,
      restore: (): void => undefined,
      translate: (): void => undefined,
      scale: (): void => undefined,
    };
    const node: (SpectateNode & Partial<SpectateCanvasNode>) = {
      innerHTML: '',
      setAttribute: (): void => undefined,
      addEventListener: (type, listener): void => {
        const key = `${selector}:${type}`;
        listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      },
      ...(isCanvas
        ? {
            width: 0,
            height: 0,
            getContext: () => canvasContext as unknown as ReturnType<SpectateCanvasNode['getContext']>,
          }
        : {}),
    };
    nodes.set(selector, node);
    return node;
  };

  return {
    get innerHTML(): string {
      return state.html;
    },
    set innerHTML(value: string) {
      state.html = value;
    },
    querySelector: (selector: string): SpectateNode | null => child(selector),
    node: child,
    fire: (selector: string, type: 'click'): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener();
      }
    },
  };
}

interface Driver {
  readonly requestAnimationFrame: (callback: () => void) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
  readonly pump: (times: number) => void;
}

function createDriver(): Driver {
  const queue: (number | null)[] = [];
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  return {
    requestAnimationFrame: (callback: () => void) => {
      nextHandle += 1;
      const handle = nextHandle;
      callbacks.set(handle, callback);
      queue.push(handle);
      return handle;
    },
    cancelAnimationFrame: (handle: number) => {
      callbacks.delete(handle);
    },
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
          continue;
        }
        callback();
        remaining -= 1;
      }
    },
  };
}

/** Drains pending microtasks (and a macrotask tick) so the panel's own fire-and-forget manifest/entry loads settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('the Spectate panel (Story 9.3)', () => {
  const env = createFighterEnvironment();
  let logs: readonly [CommandLog, CommandLog];
  let frameCounts: readonly [number, number];

  beforeAll(async () => {
    const built = await Promise.all([buildDemoLog(4_101), buildDemoLog(4_102)]);
    logs = [built[0], built[1]];
    frameCounts = [
      buildReplayFilm(logs[0], env).frames.length,
      buildReplayFilm(logs[1], env).frames.length,
    ];
  });

  function manifestOf(): SpectateManifest {
    return {
      schemaVersion: '1.0.0',
      loopStartEpochMs: 0,
      totalLoopDurationMs: 1,
      entries: [
        { id: 'first', commandLogUrl: '/replays/first.command-log.json', schemaVersion: '1.0.0', frameCount: frameCounts[0] },
        { id: 'second', commandLogUrl: '/replays/second.command-log.json', schemaVersion: '1.0.0', frameCount: frameCounts[1] },
      ],
    };
  }

  function baseDeps(driver: Driver, requests: string[] = []): SpectatePanelDeps {
    const manifest = manifestOf();
    return {
      view: {
        requestAnimationFrame: driver.requestAnimationFrame,
        cancelAnimationFrame: driver.cancelAnimationFrame,
      },
      fetch: async (url: string) => {
        requests.push(url);
        if (url.includes('/first.command-log')) {
          return { ok: true, status: 200, json: async () => logs[0] };
        }
        if (url.includes('/second.command-log')) {
          return { ok: true, status: 200, json: async () => logs[1] };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
      loadManifest: async () => manifest,
      now: () => 0,
    };
  }

  it('mounts markup with a canvas and a picker', () => {
    const host = createHost();
    const driver = createDriver();
    mountSpectatePanel(host, baseDeps(driver));

    expect(host.innerHTML).toContain('tb-spectate-canvas');
    expect(host.innerHTML).toContain('tb-spectate-picker');
  });

  it('renders the markup helper standalone (structural test with no DOM)', () => {
    const html = spectateMarkup([
      { id: 'x', commandLogUrl: '/x.json', schemaVersion: '1.0.0', frameCount: 10 },
    ]);
    expect(html).toContain('data-spectate-pick="x"');
  });

  it('starts playing the default loop entry with no click, key or extra network call beyond the manifest and the entry itself', async () => {
    const host = createHost();
    const driver = createDriver();
    const requests: string[] = [];
    const panel = mountSpectatePanel(host, baseDeps(driver, requests));

    // Let the async manifest-then-first-entry load settle.
    await flush();

    expect(panel.currentEntryId()).toBe('first');
    expect(requests).toContain('/replays/first.command-log.json');
  });

  it('joins mid-loop through the real now() -> offsetForNow -> walk.startLoop chain, not just the pure function in isolation', async () => {
    // Every other test in this file pins `now: () => 0` with `loopStartEpochMs:
    // 0`, which always trivially resolves to entry index 0, frame 0 -- proving
    // nothing about AD-17's headline behavior beyond what `manifest.test.ts`
    // already proves for `offsetForNow` alone. This wires a non-zero clock
    // value through the actual panel so a visitor "arriving mid-loop" is
    // verified end to end, through `mountSpectatePanel`'s own `readNowMs`/`now`
    // wiring into `walk.startLoop`, not asserted only at the pure-function or
    // the direct-`walk`-call layer.
    const host = createHost();
    const driver = createDriver();
    const requests: string[] = [];
    const manifest = manifestOf();
    const totalFrames = frameCounts[0] + frameCounts[1];
    const deps: SpectatePanelDeps = {
      ...baseDeps(driver, requests),
      loadManifest: async () => ({
        ...manifest,
        totalLoopDurationMs: totalFrames,
      }),
      // One millisecond per frame (matching `totalLoopDurationMs` above) and a
      // "now" a few frames past the end of the first entry -- enough to land
      // inside the second entry without depending on exact rounding.
      now: () => frameCounts[0] + 3,
    };
    const panel = mountSpectatePanel(host, deps);

    await flush();

    // Landed inside "second", not "first" -- the visible, panel-level proof
    // that a fresh visitor is shown the loop already in progress.
    expect(panel.currentEntryId()).toBe('second');
    expect(requests).toContain('/replays/second.command-log.json');
  });

  it('renders one picker button per manifest entry, and picking one plays it', async () => {
    const host = createHost();
    const driver = createDriver();
    const panel = mountSpectatePanel(host, baseDeps(driver));

    await flush();

    expect(host.node('[data-spectate-picker]').innerHTML).toContain('data-spectate-pick="first"');
    expect(host.node('[data-spectate-picker]').innerHTML).toContain('data-spectate-pick="second"');

    host.fire('[data-spectate-pick="second"]', 'click');
    await flush();

    expect(panel.currentEntryId()).toBe('second');
  });

  it('picking programmatically through the returned handle also works', async () => {
    const host = createHost();
    const driver = createDriver();
    const panel = mountSpectatePanel(host, baseDeps(driver));

    await flush();

    panel.pick('second');
    await flush();

    expect(panel.currentEntryId()).toBe('second');
  });

  it('a picked entry finishing returns to the ambient loop', async () => {
    const host = createHost();
    const driver = createDriver();
    const panel = mountSpectatePanel(host, baseDeps(driver));

    await flush();
    expect(panel.currentEntryId()).toBe('first');

    panel.pick('second');
    await flush();
    expect(panel.currentEntryId()).toBe('second');

    driver.pump(frameCounts[1]);
    await flush();

    // Wraps back to "first" (the position after "second").
    expect(panel.currentEntryId()).toBe('first');
  });

  it('shows a fail-soft status when the manifest itself cannot be loaded, and never throws', async () => {
    const host = createHost();
    const driver = createDriver();
    const deps: SpectatePanelDeps = {
      ...baseDeps(driver),
      loadManifest: async () => {
        throw new Error('network down');
      },
    };

    expect(() => mountSpectatePanel(host, deps)).not.toThrow();
    await flush();

    expect(host.node('[data-spectate-status]').innerHTML).toContain('unavailable');
  });

  it('throws a clear error when the host is missing required elements, rather than mounting half a panel', () => {
    const brokenHost: SpectateHost = {
      innerHTML: '',
      querySelector: () => null,
    };
    const driver = createDriver();
    expect(() => mountSpectatePanel(brokenHost, baseDeps(driver))).toThrow(/did not mount/);
  });
});
