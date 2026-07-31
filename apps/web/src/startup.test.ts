import { describe, expect, it } from 'vitest';
import type { CommandLog } from '@tokenbrawl/contracts';
import type { Canvas2D } from './render/canvas2d';
import type { MountPoint, MountPointChild } from './main';
import { DEMO_REPLAY_URL, resolveSidecarUrl, startup, type BrowserGlobals } from './startup';
import { buildDemoBundle } from './testing/demo-log';
import { DEMO_SIDECAR_PATH } from './testing/sidecar-split';

/**
 * Story 4.2, AC1 / AC2 / AC3 as tests rather than as a measurement.
 *
 * Story 4.1 shipped a page whose first animated frame arrived at 14.75 s on
 * emulated Slow 3G because `boot.ts` awaited every sprite pack and every
 * backdrop layer before it mounted anything. That defect was invisible to the
 * whole suite: nothing asserted an *ordering*, only outcomes, and the ordering
 * was the bug.
 *
 * So the cases below hold the decorations open -- sprite fetches that never
 * resolve, a sidecar that never arrives -- and assert the fight is running
 * anyway. A Lighthouse number is a measurement someone took once; this fails in
 * CI the first time an `await` moves back onto the critical path.
 *
 * Everything runs under Vitest's default `node` environment against structural
 * fakes. `apps/web` stays at `vite` plus `vitest`.
 */

/** A never-settling promise, which is what a decoration on a slow link *is*. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function createCanvas(): { readonly surface: unknown; readonly paints: () => number } {
  const state = { paints: 0 };
  // A Proxy rather than a hand-written stub: `Canvas2D` has fourteen members
  // and this file cares about none of them individually -- only that the
  // player painted at all. A stub would need updating every time the renderer
  // reaches for one more operation, which is churn in the wrong file.
  const context = new Proxy<Record<string, unknown>>(
    {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
      textAlign: '',
      imageSmoothingEnabled: false,
      globalAlpha: 1,
    },
    {
      get(target, property: string): unknown {
        if (property in target) {
          return target[property];
        }
        return (...args: unknown[]): void => {
          // `clearRect` opens every `drawFrame`, so counting it counts paints.
          if (property === 'clearRect' && args.length === 4) {
            state.paints += 1;
          }
        };
      },
      set(target, property: string, value: unknown): boolean {
        target[property] = value;
        return true;
      },
    },
  ) as unknown as Canvas2D;

  return {
    surface: { width: 0, height: 0, getContext: () => context },
    paints: () => state.paints,
  };
}

interface FakeRoot extends MountPoint {
  readonly listeners: () => ReadonlyMap<string, (() => void)[]>;
  readonly fire: (selector: string, type: string) => void;
  readonly html: () => string;
}

function createRoot(): FakeRoot {
  const canvas = createCanvas();
  const listeners = new Map<string, (() => void)[]>();
  const nodes = new Map<string, MountPointChild>();
  const state = { html: '' };

  const child = (selector: string): MountPointChild => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: MountPointChild = {
      innerHTML: '',
      addEventListener: (type, listener) => {
        const key = `${selector}:${type}`;
        listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      },
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
    querySelector: (selector: string): MountPointChild | null =>
      selector === 'canvas' ? (canvas.surface as MountPointChild) : child(selector),
    listeners: () => listeners,
    fire: (selector: string, type: string): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener();
      }
    },
    html: () => state.html + [...nodes.values()].map((node) => node.innerHTML).join(''),
  };
}

interface Harness {
  readonly globals: BrowserGlobals;
  readonly root: FakeRoot;
  readonly frames: () => number;
  readonly runFrames: (count: number) => void;
  readonly requested: () => readonly string[];
}

function createHarness(
  log: CommandLog,
  options: {
    readonly sidecar?: unknown;
    readonly spritesResolve?: boolean;
    readonly json?: (url: string) => Promise<unknown>;
  } = {},
): Harness {
  const root = createRoot();
  const queue: (() => void)[] = [];
  const requested: string[] = [];

  const respond = async (url: string): Promise<unknown> => {
    requested.push(url);
    if (options.json !== undefined) {
      return options.json(url);
    }
    if (url === DEMO_REPLAY_URL) {
      return log;
    }
    if (url.endsWith(DEMO_SIDECAR_PATH)) {
      return options.sidecar ?? pending<unknown>();
    }
    // Sprite and backdrop layouts. `pending` is the default because "held open
    // forever" is the state this file exists to prove the player survives.
    return options.spritesResolve === true ? { clips: {} } : pending<unknown>();
  };

  const globals: BrowserGlobals = {
    document: { querySelector: () => root },
    window: {
      requestAnimationFrame: (callback) => {
        queue.push(callback);
        return queue.length;
      },
      cancelAnimationFrame: () => undefined,
    },
    fetch: async (url: string) => ({ ok: true, status: 200, json: async () => respond(url) }),
    Image: class {
      readonly width = 64;
      readonly height = 96;
      src = '';
      decode(): Promise<void> {
        return pending<void>();
      }
    },
  };

  return {
    globals,
    root,
    frames: () => queue.length,
    runFrames: (count: number): void => {
      for (let index = 0; index < count; index += 1) {
        queue.shift()?.();
      }
    },
    requested: () => requested,
  };
}

describe('startup ordering (AC1, AC3)', () => {
  it('mounts and starts the fight while every decoration is still in flight', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);

    // Every sprite fetch, the backdrop and the sidecar are all still pending
    // at this point, by construction: their promises never settle.
    expect(result).not.toBeNull();
    expect(result?.mounted.film.frames.length).toBeGreaterThan(0);
    expect(result?.mounted.clock.isRunning()).toBe(true);
    // A frame has been requested, which is what "already running" means.
    expect(harness.frames()).toBe(1);
  });

  it('draws frame zero before any animation frame is delivered', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const canvasPaints = harness.root.html();

    await startup(harness.globals);

    // The stage is never blank while the first callback is pending: the shell
    // is written and the canvas has been painted synchronously.
    expect(harness.root.html()).not.toBe(canvasPaints);
    expect(harness.root.html()).toContain('tb-stage');
  });

  it('fetches the replay first and the decorations only after mounting', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);

    expect(harness.requested()[0]).toBe(DEMO_REPLAY_URL);
    // And the decorations were requested -- lazily, but really. A player that
    // never asked for its sprites would pass the ordering check by doing less.
    expect(harness.requested().length).toBeGreaterThan(1);
  });

  it('keeps playing when a sprite pack rejects outright', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log, {
      json: async (url) => {
        if (url === DEMO_REPLAY_URL) {
          return log;
        }
        throw new Error('network is down');
      },
    });

    const result = await startup(harness.globals);
    await result?.dressed;

    expect(result?.mounted.clock.isRunning()).toBe(true);
    // The block artist is still drawing, so playback advances normally.
    harness.runFrames(3);
    expect(result?.mounted.clock.frameIndex()).toBeGreaterThan(0);
  });

  it('requires no click: the clock is running before anyone touches the page (AC2)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(5);

    expect(result?.mounted.clock.frameIndex()).toBe(4);
  });

  it('reports a failed replay on the page rather than in a console', async () => {
    const harness = createHarness({} as CommandLog, {
      json: async () => ({ schemaVersion: '9.9.9' }),
    });

    const result = await startup(harness.globals);

    expect(result).toBeNull();
    expect(harness.root.innerHTML).toContain('Replay failed');
    expect(harness.root.innerHTML).toContain('tb-chip--failed');
  });

  it('refuses to mount into an environment with no document', async () => {
    await expect(startup({})).rejects.toThrow(/no document, window or fetch/);
  });
});

describe('the reasoning sidecar on the page (AC4)', () => {
  it('shows a loading state while the sidecar is in flight, never a blank', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    expect(result?.mounted.reasoning.status()).toBe('loading');

    // Hovering the first fighter while the sidecar is still on the wire.
    harness.root.fire('[data-agent="0"]', 'pointerenter');
    expect(harness.root.html()).toContain('Fetching reasoning');
    // Not an error, and not an empty panel.
    expect(harness.root.html()).not.toContain('unavailable');
  });

  it('swaps in the real reasoning once the sidecar lands', async () => {
    const { log, sidecar } = await buildDemoBundle();
    const harness = createHarness(log, {
      // Sprites settle (as a rejected layout) so `dressed` can be awaited at
      // all; the point of this case is the sidecar, not the art.
      spritesResolve: true,
      sidecar: {
        ...sidecar,
        entries: sidecar.entries.map((entry, index) =>
          index === 0 ? { ...entry, reasoning: 'closing the gap early' } : entry,
        ),
      },
    });

    const result = await startup(harness.globals);
    harness.root.fire('[data-agent="0"]', 'pointerenter');
    await result?.dressed;

    expect(result?.mounted.reasoning.status()).toBe('ready');
    expect(harness.root.html()).toContain('closing the gap early');
  });

  it('says so, once, when the sidecar cannot be fetched', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log, {
      json: async (url) => {
        if (url === DEMO_REPLAY_URL) {
          return log;
        }
        throw new Error(url.endsWith(DEMO_SIDECAR_PATH) ? 'HTTP 404' : 'no art here');
      },
    });

    const result = await startup(harness.globals);
    await result?.dressed;
    harness.root.fire('[data-agent="1"]', 'pointerenter');

    expect(result?.mounted.reasoning.status()).toBe('unavailable');
    expect(harness.root.html()).toContain('Reasoning unavailable');
  });

  it('rejects a sidecar belonging to another Match rather than displaying it', async () => {
    const { log, sidecar } = await buildDemoBundle();
    const harness = createHarness(log, {
      spritesResolve: true,
      sidecar: { ...sidecar, matchId: 'f'.repeat(64) },
    });

    const result = await startup(harness.globals);
    await result?.dressed;

    expect(result?.mounted.reasoning.status()).toBe('unavailable');
  });

  it('is reachable by keyboard focus, not only by a pointer', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    harness.root.fire('[data-agent="1"]', 'focus');

    expect(harness.root.html()).toContain('Fetching reasoning');
  });
});

describe('resolveSidecarUrl', () => {
  it('resolves a relative path against the log, so a log directory can carry both', () => {
    expect(resolveSidecarUrl('/replays/2026-08/m1.command-log.json', 'm1.reasoning.json')).toBe(
      '/replays/2026-08/m1.reasoning.json',
    );
  });

  it('passes a rooted path through unchanged', () => {
    expect(resolveSidecarUrl('/replays/demo.command-log.json', '/reasoning/demo.json')).toBe(
      '/reasoning/demo.json',
    );
  });

  it('handles a bare filename with no directory at all', () => {
    expect(resolveSidecarUrl('demo.command-log.json', 'demo.reasoning.json')).toBe(
      'demo.reasoning.json',
    );
  });
});
