import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CommandLog } from '@tokenbrawl/contracts';
import type { Canvas2D } from './render/canvas2d';
import type { MountPoint, MountPointChild } from './main';
import { DEMO_REPLAY_URL, resolveSidecarUrl, startup, type BrowserGlobals } from './startup';
import { runByokMatch } from './byok/run';
import { buildDemoBundle } from './testing/demo-log';
import { chatCompletionBody, createFakeTransport } from './testing/byok-transport';
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

function createCanvas(): {
  readonly surface: unknown;
  readonly paints: () => number;
  readonly texts: () => readonly string[];
} {
  const state = { paints: 0 };
  const texts: string[] = [];
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
            texts.length = 0;
          }
          // Story 4.4 asserts on the HUD's own labels, which are the only
          // thing a call log can tell apart from a rectangle.
          if (property === 'fillText' && typeof args[0] === 'string') {
            texts.push(args[0]);
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
    // Only the most recent frame's labels: the HUD is redrawn every frame, and
    // accumulating every frame's text would make "shows one meter" unfalsifiable.
    texts: () => texts,
  };
}

interface FakeRoot extends MountPoint {
  readonly node: (selector: string) => MountPointChild | null;
  readonly attribute: (selector: string, name: string) => string | undefined;
  readonly painted: () => readonly string[];
  /** Every `drawFrame` this canvas has served, across every player mounted onto it. */
  readonly paintCount: () => number;
  readonly listeners: () => ReadonlyMap<string, ((event?: { readonly pointerType?: string }) => void)[]>;
  readonly fire: (selector: string, type: string, event?: { readonly pointerType?: string }) => void;
  readonly html: () => string;
}

function createRoot(): FakeRoot {
  const canvas = createCanvas();
  const listeners = new Map<string, ((event?: { readonly pointerType?: string }) => void)[]>();
  const nodes = new Map<string, MountPointChild>();
  const attributes = new Map<string, string>();
  const state = { html: '' };

  const child = (selector: string): MountPointChild => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const node: MountPointChild = {
      innerHTML: '',
      // Only the timeline uses these two; every other node ignores them.
      value: '0',
      setAttribute: (name: string, attributeValue: string) => {
        attributes.set(`${selector}:${name}`, attributeValue);
      },
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
    node: (selector: string) => nodes.get(selector) ?? null,
    attribute: (selector: string, name: string) => attributes.get(`${selector}:${name}`),
    painted: () => canvas.texts(),
    paintCount: () => canvas.paints(),
    querySelector: (selector: string): MountPointChild | null =>
      selector === 'canvas' ? (canvas.surface as MountPointChild) : child(selector),
    listeners: () => listeners,
    fire: (selector: string, type: string, event?: { readonly pointerType?: string }): void => {
      for (const listener of listeners.get(`${selector}:${type}`) ?? []) {
        listener(event);
      }
    },
    html: () => state.html + [...nodes.values()].map((node) => node.innerHTML).join(''),
  };
}

interface Harness {
  readonly globals: BrowserGlobals;
  readonly root: FakeRoot;
  /** The `#byok` host, which is a separate element from `#app` on the real page. */
  readonly byokHost: FakeRoot;
  /** The `#arcade` host (Story 9.2), separate from `#app` for the same reason `#byok` is. */
  readonly arcadeHost: FakeRoot;
  /** The `#spectate` host (Story 9.3), separate from `#app` for the same reason `#byok`/`#arcade` are. */
  readonly spectateHost: FakeRoot;
  readonly painted: () => readonly string[];
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
    /** A page with no BYOK panel at all -- which must still play the replay. */
    readonly noByokHost?: boolean;
    /** A page with no arcade panel at all -- which must still play the replay. */
    readonly noArcadeHost?: boolean;
    /** A page with no spectate panel at all -- which must still play the replay. */
    readonly noSpectateHost?: boolean;
  } = {},
): Harness {
  const root = createRoot();
  const byokHost = createRoot();
  const arcadeHost = createRoot();
  const spectateHost = createRoot();
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
    // Three hosts, because the page has three (Story 4.6, Story 9.2). `#byok`
    // and `#arcade` are separate elements outside `#app` precisely so that
    // re-mounting the player on a BYOK or an arcade Match does not delete the
    // panel that produced it -- a fake that answered every lookup with one
    // node would have a panel and the player writing over each other, which
    // is the defect the split exists to prevent.
    document: {
      querySelector: (selector: string) => {
        if (selector === '#byok') {
          return options.noByokHost === true ? null : byokHost;
        }
        if (selector === '#arcade') {
          return options.noArcadeHost === true ? null : arcadeHost;
        }
        if (selector === '#spectate') {
          return options.noSpectateHost === true ? null : spectateHost;
        }
        return root;
      },
    },
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
    byokHost,
    arcadeHost,
    spectateHost,
    painted: () => root.painted(),
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

  it('checks the schema version before it reads any other field of the log (AD-3)', async () => {
    // Every other field is deliberately absent. If the shell read `agents` or
    // `decisions` while building its markup -- which an earlier draft of this
    // story did -- the page would report an unhelpful TypeError instead of the
    // one thing a visitor can act on. A partial read of an evolved schema is
    // the failure AD-3 exists to prevent.
    //
    // Not '2.0.0': Story 9.2 made that a real, dispatched-to version (see
    // `film.test.ts`'s dispatch coverage), so an unrecognised one is needed
    // here to exercise "the demo endpoint itself serves nothing this page
    // understands at all".
    const harness = createHarness({} as CommandLog, {
      json: async () => ({ schemaVersion: '9.9.9' }),
    });

    await startup(harness.globals);

    expect(harness.root.innerHTML).toContain('Unsupported Command Log schemaVersion: 9.9.9');
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

describe("the document's own critical path (AC1)", () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

  it('preloads the replay, so its request does not wait for the module graph', () => {
    // Measured: without this line the JSON is discovered only after the bundle
    // has downloaded and executed -- one extra serial round trip, which on a
    // high-latency link costs more than every byte saved elsewhere. With it,
    // the log and the script land within 3 ms of each other on Fast 3G.
    expect(html).toMatch(/rel="preload"[\s\S]*?href="\/replays\/demo\.command-log\.json"/);
    // `crossorigin` is what makes the preload match a plain same-origin
    // `fetch()`. Without it the browser downloads the file twice, which is
    // slower than not preloading at all.
    expect(html).toMatch(/rel="preload"[\s\S]*?crossorigin/);
  });

  it('preloads nothing else, so decorations cannot crowd out the replay', () => {
    expect(html.match(/rel="preload"/g)).toHaveLength(1);
    expect(html).not.toContain('/sprites/');
  });

  it('declares an icon, so no speculative favicon request competes for the pipe', () => {
    expect(html).toContain('rel="icon"');
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

  it.each([
    ['protocol-relative', '//evil.example/reasoning.json'],
    ['absolute https', 'https://evil.example/reasoning.json'],
    ['absolute http', 'http://evil.example/reasoning.json'],
    ['a data URL', 'data:application/json,{}'],
  ])('refuses an off-origin sidecar path (%s)', (_label, path) => {
    // The path arrives inside a fetched document, so it is untrusted input.
    // `//evil.example/x.json` starts with `/` and would otherwise have taken
    // the rooted-path branch straight into `fetch`, loading reasoning from a
    // third-party host -- the offline guarantee and INV-8 broken at once.
    expect(() => resolveSidecarUrl('/replays/demo.command-log.json', path)).toThrow(/off-origin/);
  });
});

describe('untrusted text never reaches innerHTML unescaped', () => {
  it('escapes the failure message, which carries a field from the fetched log', async () => {
    // `assertSchemaVersion` interpolates the document's own `schemaVersion`
    // into its error. Story 4.6 hands the log source to the visitor, which
    // makes this path attacker-reachable rather than theoretical.
    const harness = createHarness({} as CommandLog, {
      json: async () => ({ schemaVersion: '<img src=x onerror=alert(1)>' }),
    });

    await startup(harness.globals);

    expect(harness.root.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(harness.root.innerHTML).not.toContain('<img');
  });

  it('escapes an agent id, which the log also supplies', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness({
      ...log,
      agents: [{ ...log.agents[0], id: '<script>alert(1)</script>' }, log.agents[1]],
    } as CommandLog);

    await startup(harness.globals);

    expect(harness.root.innerHTML).not.toContain('<script>alert');
  });
});

/**
 * Story 4.3, on the page: pointer, tap and keyboard all reach the same panel,
 * and all three stop the clock so the reasoning can actually be read.
 */
describe('hovering a fighter to read its reasoning (4.3)', () => {
  it('pauses playback on the frame that is on screen', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(4);
    const frozenAt = result?.mounted.clock.frameIndex();

    harness.root.fire('[data-agent="0"]', 'pointerenter');

    expect(result?.mounted.clock.isRunning()).toBe(false);
    expect(result?.mounted.clock.frameIndex()).toBe(frozenAt);
  });

  it('resumes from that frame when the pointer leaves, not from the start', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(4);
    harness.root.fire('[data-agent="0"]', 'pointerenter');
    harness.root.fire('[data-agent="0"]', 'pointerleave', { pointerType: 'mouse' });

    expect(result?.mounted.clock.isRunning()).toBe(true);
    harness.runFrames(2);
    expect(result?.mounted.clock.frameIndex()).toBe(5);
  });

  it('keeps the panel open on a touch tap, which is what a tap is for (AC4)', async () => {
    // A touch pointer *leaves* on lift, so honouring `pointerleave` for touch
    // would show the panel and hide it in the same gesture.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    harness.root.fire('[data-agent="1"]', 'click');
    const afterTap = harness.root.html();
    harness.root.fire('[data-agent="1"]', 'pointerleave', { pointerType: 'touch' });

    expect(harness.root.html()).toBe(afterTap);
    expect(afterTap).toContain('Tick');
  });

  it('reaches the same panel from the keyboard, and releases on blur (AC5)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(3);
    harness.root.fire('[data-agent="1"]', 'focus');

    expect(result?.mounted.clock.isRunning()).toBe(false);
    expect(harness.root.html()).toContain('Tick');

    // `blur` carries no pointerType, so it is a real release.
    harness.root.fire('[data-agent="1"]', 'blur');
    expect(result?.mounted.clock.isRunning()).toBe(true);
  });

  it('does not resume a clock that had already finished', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(result?.mounted.film.frames.length ?? 0);
    expect(result?.mounted.clock.isRunning()).toBe(false);

    harness.root.fire('[data-agent="0"]', 'pointerenter');
    harness.root.fire('[data-agent="0"]', 'pointerleave', { pointerType: 'mouse' });

    // It was not running when the panel opened, so letting go must not start it.
    expect(result?.mounted.clock.isRunning()).toBe(false);
  });

  it('exposes the panel to a screen reader and names each target (AC5)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);

    expect(harness.root.innerHTML).toContain('aria-live="polite"');
    expect(harness.root.innerHTML).toContain('role="status"');
    expect(harness.root.innerHTML).toContain('aria-describedby="tb-reasoning-panel"');
    expect(harness.root.innerHTML).toContain('id="tb-reasoning-panel"');
    // Each target carries an accessible name naming the fighter it reveals.
    expect(harness.root.html()).toContain(`Reasoning for ${log.agents[0].id}`);
    expect(harness.root.html()).toContain(`Reasoning for ${log.agents[1].id}`);
  });

  it('shows the Decision Point the fighter is at, with its raw response', async () => {
    const { log, sidecar } = await buildDemoBundle();
    const harness = createHarness(log, { spritesResolve: true, sidecar });

    const result = await startup(harness.globals);
    await result?.dressed;
    harness.root.fire('[data-agent="0"]', 'pointerenter');

    // The bots record no reasoning, but they do emit a line, and that line is
    // the only thing the page can honestly show for them.
    expect(harness.root.html()).toContain('Raw response');
    expect(harness.root.html()).toContain('aggressive:');
  });

  it('clears the reading selection when Replay is pressed', async () => {
    // Otherwise `resumeOnRelease` stays armed across a restart and the next
    // pointer leave resumes a clock that is already running.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(4);
    harness.root.fire('[data-agent="0"]', 'pointerenter');
    harness.root.fire('[data-play]', 'click');

    expect(result?.mounted.clock.isRunning()).toBe(true);
    expect(result?.mounted.clock.frameIndex()).toBe(-1);
    expect(harness.root.html()).toContain('Hover, tap or tab to a fighter');

    const scheduled = harness.frames();
    harness.root.fire('[data-agent="0"]', 'pointerleave', { pointerType: 'mouse' });
    expect(harness.frames()).toBe(scheduled);
  });
});

/**
 * AC2 and AC3 end to end.
 *
 * The committed demo Match is two Baseline Bots, so it contains no Reflex-Mode
 * call and no Parse Failure -- the two states the story asks for by name are
 * unreachable on the page today. Pinning them only against the pure view
 * function would leave the wiring between the sidecar, the resolver and the DOM
 * untested for exactly the two cases a visitor most needs to be told about, so
 * the flags are injected through the sidecar, which is where a real Deployment
 * log carries them.
 */
describe('the states a Deployment log will carry (4.3 AC2, AC3)', () => {
  async function panelFor(patch: Record<string, unknown>): Promise<string> {
    const { log, sidecar } = await buildDemoBundle();
    const first = sidecar.entries[0];
    const harness = createHarness(log, {
      spritesResolve: true,
      sidecar: {
        ...sidecar,
        entries: sidecar.entries.map((entry) =>
          entry.tick === first.tick && entry.agentIndex === first.agentIndex
            ? { ...entry, ...patch }
            : entry,
        ),
      },
    });

    const result = await startup(harness.globals);
    await result?.dressed;
    // Frame zero is on screen, which is the Decision Point the patch targets.
    harness.root.fire(`[data-agent="${String(first.agentIndex)}"]`, 'pointerenter');
    return harness.root.html();
  }

  it('displays a Reflex-Mode call as such rather than as blank reasoning (AC2)', async () => {
    const html = await panelFor({ reflexMode: true, reasoning: null });

    expect(html).toContain('Reflex mode');
    expect(html).toContain('Token Bank');
    expect(html).toContain('tb-chip--reflex');
  });

  it('says a Parse Failure happened and shows the raw response (AC3)', async () => {
    const html = await panelFor({
      parseFailure: true,
      reasoning: null,
      rawResponse: 'I reckon I will step forward now.',
    });

    expect(html).toContain('Parse failure');
    expect(html).toContain('tb-chip--failed');
    expect(html).toContain('Raw response');
    expect(html).toContain('I reckon I will step forward now.');
  });

  it('renders real reasoning as the body when a Deployment supplies it', async () => {
    const html = await panelFor({ reasoning: 'It is out of range, so I close the gap.' });

    expect(html).toContain('It is out of range, so I close the gap.');
    expect(html).toContain('tb-reasoning--text');
  });
});

describe('two hover targets, one selection', () => {
  it('will not let a stale release close the panel a visitor moved to', async () => {
    // Tab to one fighter, then move the mouse onto the other. The second takes
    // the selection and the first's `blur` arrives afterwards -- which without
    // a guard closes a panel that is being read.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    harness.root.fire('[data-agent="0"]', 'focus');
    harness.root.fire('[data-agent="1"]', 'pointerenter');
    const showingP2 = harness.root.html();
    harness.root.fire('[data-agent="0"]', 'blur');

    expect(harness.root.html()).toBe(showingP2);
    expect(showingP2).toContain(log.agents[1].id);
  });

  it('still resumes when the target that owns the selection releases', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(2);
    harness.root.fire('[data-agent="0"]', 'focus');
    harness.root.fire('[data-agent="1"]', 'pointerenter');
    expect(result?.mounted.clock.isRunning()).toBe(false);

    harness.root.fire('[data-agent="1"]', 'pointerleave', { pointerType: 'mouse' });

    expect(result?.mounted.clock.isRunning()).toBe(true);
    expect(harness.root.html()).toContain('Hover, tap or tab to a fighter');
  });
});

/**
 * Story 4.4 end to end.
 *
 * The committed demo Match is two Baseline Bots, which is AC3's case and not
 * AC1's or AC2's -- so a metered log is synthesised by adding `bankRemaining`
 * to the same real Match. The simulation is untouched: `bankRemaining` is
 * metadata about the call, not an input to it, so the film, the hash and every
 * frame are identical either way. That is the property the first case asserts.
 */
describe('the Token Bank HUD (4.4)', () => {
  function metered(log: CommandLog, levels: readonly number[]): CommandLog {
    let index = 0;
    return {
      ...log,
      tokenBankStart: 25_000,
      decisions: log.decisions.map((entry) => {
        if (entry.agentIndex !== 0) {
          return entry;
        }
        const level = levels[Math.min(index, levels.length - 1)];
        index += 1;
        return { ...entry, bankRemaining: level };
      }),
    };
  }

  it('changes nothing about the simulation it annotates', async () => {
    const { log } = await buildDemoBundle();
    const plain = createHarness(log);
    const withBank = createHarness(metered(log, [24_000, 12_000, 0]));

    const a = await startup(plain.globals);
    const b = await startup(withBank.globals);

    // Same hash, same frame count, same verdict. A HUD that moved the fight
    // would be a far worse defect than one that failed to draw.
    expect(b?.mounted.film.finalStateHash).toBe(a?.mounted.film.finalStateHash);
    expect(b?.mounted.film.frames.length).toBe(a?.mounted.film.frames.length);
    expect(b?.mounted.film.matchesRecordedHash).toBe(true);
  });

  it('draws a meter for the metered Agent and none for the bot (AC1, AC3)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(metered(log, [24_000, 12_000, 0]));

    await startup(harness.globals);

    const bankTexts = harness.painted().filter((text) => text.startsWith('BANK'));
    const reflexTexts = harness.painted().filter((text) => text.includes('REFLEX'));
    // Exactly one fighter has a bank, so exactly one meter is drawn per frame.
    expect(bankTexts.length + reflexTexts.length).toBe(1);
    expect(bankTexts[0]).toBe('BANK 24000');
  });

  it('enters the exhausted state once the bank empties, and keeps playing (AC2, AC4)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(metered(log, [24_000, 12_000, 0]));

    const result = await startup(harness.globals);
    // Far enough in that the third recorded level is the one on screen.
    harness.runFrames(60);

    expect(harness.painted().some((text) => text.includes('REFLEX'))).toBe(true);
    // The fight did not stop when the thinking did.
    expect(result?.mounted.clock.isRunning()).toBe(true);
  });

  it('shows no meter at all for the committed Baseline-Bot demo (AC3)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    harness.runFrames(20);

    expect(harness.painted().some((text) => text.startsWith('BANK'))).toBe(false);
    expect(harness.painted().some((text) => text.includes('REFLEX'))).toBe(false);
  });
});

/**
 * Story 4.5 on the page: the timeline, the transport, and both fighters at
 * once.
 */
describe('the timeline scrub (4.5)', () => {
  const TIMELINE = '[data-timeline]';

  function seekTo(harness: Harness, frameIndex: number): void {
    const node = harness.root.node(TIMELINE);
    if (node !== null) {
      node.value = String(frameIndex);
    }
    harness.root.fire(TIMELINE, 'input');
  }

  it('spans the whole film, so every Decision Point is reachable', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);

    expect(harness.root.attribute(TIMELINE, 'max')).toBe(
      String((result?.mounted.film.frames.length ?? 0) - 1),
    );
  });

  it('seeks to the frame asked for (AC1)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    seekTo(harness, 96);

    expect(result?.mounted.clock.frameIndex()).toBe(96);
  });

  it('seeks backwards without restarting the Match (AC3)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(120);
    seekTo(harness, 24);

    expect(result?.mounted.clock.frameIndex()).toBe(24);
    // The film was not rebuilt: the same verdict, the same states.
    expect(result?.mounted.film.matchesRecordedHash).toBe(true);
  });

  it('keeps one frame per callback after a scrub (AC4)', async () => {
    // Seeking changes which frame, never the rate. This is INV-3 on the page.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(4);
    seekTo(harness, 200);
    harness.runFrames(6);

    expect(result?.mounted.clock.frameIndex()).toBe(206);
  });

  it('shows both fighters reasoning at every position, side by side (AC2)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    seekTo(harness, 60);

    const html = harness.root.html();
    expect(html).toContain(log.agents[0].id);
    expect(html).toContain(log.agents[1].id);
    expect(html.match(/tb-reasoning-card/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('moves both cards to the Decision Point that was seeked to (AC1, AC2)', async () => {
    // The gap a mutation found: every other case here seeks to a position whose
    // panel content already matched what the initial render produced, so
    // deleting the panel refresh from the paint path passed all 245 tests while
    // leaving the reasoning frozen at frame zero for the whole Match.
    const { log, sidecar } = await buildDemoBundle();
    const harness = createHarness(log, {
      spritesResolve: true,
      sidecar: {
        ...sidecar,
        entries: sidecar.entries.map((entry) => ({
          ...entry,
          reasoning: `agent-${String(entry.agentIndex)}-tick-${String(entry.tick)}`,
        })),
      },
    });

    const result = await startup(harness.globals);
    await result?.dressed;

    seekTo(harness, 0);
    const atStart = harness.root.html();
    expect(atStart).toContain('agent-0-tick-0');

    seekTo(harness, 150);
    const atMiddle = harness.root.html();

    expect(atMiddle).not.toBe(atStart);
    expect(atMiddle).not.toContain('agent-0-tick-0');
    expect(atMiddle).toContain('Tick 360');
  });

  it('gives each card its own Agent Decision Point, never the other one', async () => {
    const { log, sidecar } = await buildDemoBundle();
    const harness = createHarness(log, {
      spritesResolve: true,
      sidecar: {
        ...sidecar,
        entries: sidecar.entries.map((entry) => ({
          ...entry,
          reasoning: `agent-${String(entry.agentIndex)}-tick-${String(entry.tick)}`,
        })),
      },
    });

    const result = await startup(harness.globals);
    await result?.dressed;
    seekTo(harness, 0);

    // Both, and each labelled with its own index. A card reading the other
    // fighter's entry is the defect this case exists to catch.
    expect(harness.root.html()).toContain('agent-0-tick-0');
    expect(harness.root.html()).toContain('agent-1-tick-0');
  });

  it('reports the position in Decision Points and ticks, never a duration (INV-3)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    seekTo(harness, 60);

    const readout = harness.root.node('[data-timeline-readout]')?.innerHTML ?? '';
    expect(readout).toMatch(/DP \d+\/\d+/);
    expect(readout).toMatch(/Tick \d+/);
    expect(readout).not.toMatch(/\b(ms|sec|second|elapsed|remaining)\b/i);
  });

  it('pauses and resumes in place, and restarts only at the end', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(10);

    harness.root.fire('[data-toggle]', 'click');
    expect(result?.mounted.clock.isRunning()).toBe(false);
    expect(harness.root.node('[data-toggle]')?.innerHTML).toBe('Play');

    harness.root.fire('[data-toggle]', 'click');
    expect(result?.mounted.clock.isRunning()).toBe(true);
    harness.runFrames(2);
    // Continued from frame 9, not from zero.
    expect(result?.mounted.clock.frameIndex()).toBe(11);
  });

  it('restarts rather than doing nothing when Play is pressed at the end', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(result?.mounted.film.frames.length ?? 0);
    expect(result?.mounted.clock.isRunning()).toBe(false);

    harness.root.fire('[data-toggle]', 'click');
    harness.runFrames(1);

    // `start()` rewinds and the first frame arrives on the next callback, which
    // is the same path the Replay button takes.
    expect(result?.mounted.clock.isRunning()).toBe(true);
    expect(result?.mounted.clock.frameIndex()).toBe(0);
  });

  it('announces only on a deliberate interaction, never once per frame', async () => {
    // The visible panel follows playback and changes five times a second. A
    // live region doing the same is worse for a screen-reader user than
    // silence, so the announcement is a separate hidden node written on hover,
    // focus, tap or seek and at no other time.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    await startup(harness.globals);
    harness.runFrames(40);
    expect(harness.root.node('[data-announce]')?.innerHTML).toBe('');

    harness.root.fire('[data-agent="0"]', 'focus');
    expect(harness.root.node('[data-announce]')?.innerHTML).toContain(log.agents[0].id);
  });
});

describe('the BYOK panel and the player it replaces (Story 4.6)', () => {
  /** A real BYOK log, played out over a fake transport -- no network, no keys that exist. */
  async function byokLog(): Promise<CommandLog> {
    const transport = createFakeTransport({
      body: (call) => chatCompletionBody(call % 2 === 0 ? 'ACTION: advance' : 'ACTION: block'),
    });
    return runByokMatch({
      fighters: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', apiKey: 'gsk_test_key_000000001' },
        { provider: 'cerebras', model: 'llama3.1-8b', apiKey: 'csk_test_key_000000002' },
      ],
      seed: 4_601,
      fetch: transport.fetch,
    });
  }

  it('mounts the panel into its own host, outside the player shell', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);

    expect(result?.byok).not.toBeNull();
    expect(harness.byokHost.innerHTML).toContain('Run your own fight');
    // And the player's own shell is untouched by it.
    expect(harness.root.innerHTML).not.toContain('Run your own fight');
    expect(harness.root.innerHTML).toContain('tb-canvas');
  });

  it('replays a BYOK Match through the same player, hash verified (AC4)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);

    const mounted = result?.showLog(await byokLog());

    expect(mounted?.film.matchesRecordedHash).toBe(true);
    expect(result?.current()).toBe(mounted);
    expect(mounted?.clock.isRunning()).toBe(true);
  });

  it('marks the replaced Match as excluded from ratings (AD-11)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);

    expect(harness.root.html()).not.toContain('not rated');
    result?.showLog(await byokLog());
    expect(harness.root.html()).toContain('not rated');
  });

  it('stops the previous clock, so two fights never run at once', async () => {
    // Without this the old `requestAnimationFrame` loop keeps painting a canvas
    // that is no longer in the document.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);
    const demo = result?.mounted;

    result?.showLog(await byokLog());

    expect(demo?.clock.isRunning()).toBe(false);
    expect(result?.current().clock.isRunning()).toBe(true);
  });

  it('paints the replacement immediately, so the stage is never blank', async () => {
    const { log } = await buildDemoBundle();
    // No `await dressed` here, deliberately: the sidecar is left pending, which
    // is the state a slow link is actually in, and the replacement must paint
    // without waiting for it -- the same rule Story 4.2 set for the first mount.
    const harness = createHarness(log, { spritesResolve: true });
    const result = await startup(harness.globals);

    const before = harness.root.paintCount();
    result?.showLog(await byokLog());

    // `renderApp` paints frame zero before it returns, on the new log as much
    // as on the first one.
    expect(harness.root.paintCount()).toBeGreaterThan(before);
  });

  it('never pours the demo reasoning into the Match that replaced it', async () => {
    // The sidecar is fetched for the demo log and lands after a BYOK Match may
    // already have taken the stage. Adopting it then would put one Match's
    // thinking under another Match's fight -- a race that is never reproduced
    // once it ships, which is why the guard is explicit rather than a
    // this-cannot-happen comment.
    const { log, sidecar } = await buildDemoBundle();

    // The sidecar is held open until the swap has happened, which is the only
    // ordering that exercises the guard at all. An earlier version of this case
    // passed a resolved sidecar and let `await byokLog()` run first -- by then
    // the sidecar had already been adopted into the demo player, so the case
    // was green with the guard deleted. A mutation found it.
    const gate: { open: (value: unknown) => void } = { open: () => undefined };
    const heldSidecar = new Promise<unknown>((resolve) => {
      gate.open = resolve;
    });
    const harness = createHarness(log, {
      json: async (url) => {
        if (url === DEMO_REPLAY_URL) {
          return log;
        }
        if (url.endsWith(DEMO_SIDECAR_PATH)) {
          return heldSidecar;
        }
        throw new Error('no art here');
      },
    });
    const result = await startup(harness.globals);

    const replacement = result?.showLog(await byokLog());
    gate.open(sidecar);
    await result?.dressed;

    // A BYOK log carries its reasoning inline, so `inline` is the honest state.
    // `ready` here would mean the demo's sidecar had been adopted into it.
    expect(replacement?.reasoning.status()).toBe('inline');
    expect(result?.current()).toBe(replacement);

    // And the observable that actually bites. `adopt` targets the old player's
    // own source, so it alone is harmless; what is not harmless is the
    // `refresh()` that follows it, which repaints the *shared* canvas and
    // rewrites the *shared* reasoning panel from the Match that is no longer on
    // screen. The panel must still name the fighters of the Match that is.
    const panel = harness.root.node('[data-reasoning]')?.innerHTML ?? '';
    expect(panel).toContain('byok');
    expect(panel).not.toContain(log.agents[0].id);
  });

  it('leaves the player alone when the page has no BYOK host at all', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log, { noByokHost: true });

    const result = await startup(harness.globals);

    expect(result?.byok).toBeNull();
    expect(result?.mounted.clock.isRunning()).toBe(true);
  });
});

/**
 * Story 9.2's wiring, mirroring the BYOK coverage above: its own host, its
 * own re-mount of the player through the same `showLog`/`mount` mechanism,
 * and graceful absence when the page has no `#arcade` host.
 *
 * Driving a whole arcade Match to completion (rather than only asserting the
 * panel mounted) needs `fire` to carry a `key`, which `FakeRoot.fire`'s type
 * does not declare -- it was written for `ShellEvent`'s `pointerType` only.
 * Cast through `unknown` at the call site rather than widening that shared
 * type for one caller.
 */
describe('the arcade panel and the player it replaces (Story 9.2)', () => {
  const KEYS = ['ArrowRight', 'z', 'x', 'c', 'ArrowLeft'] as const;

  function fireKey(host: FakeRoot, selector: string, key: string): void {
    (host.fire as unknown as (selector: string, type: string, event?: { key?: string }) => void)(
      selector,
      'keydown',
      { key },
    );
  }

  it('mounts the panel into its own host, outside the player shell', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);

    expect(result?.arcade).not.toBeNull();
    expect(harness.arcadeHost.innerHTML).toContain('Play vs CPU');
    // Neither the player's shell nor the BYOK panel is touched by it.
    expect(harness.root.innerHTML).not.toContain('Play vs CPU');
    expect(harness.root.innerHTML).toContain('tb-canvas');
    expect(harness.byokHost.innerHTML).not.toContain('Play vs CPU');
  });

  it('leaves the player alone when the page has no arcade host at all', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log, { noArcadeHost: true });

    const result = await startup(harness.globals);

    expect(result?.arcade).toBeNull();
    expect(result?.mounted.clock.isRunning()).toBe(true);
  });

  /**
   * A completed arcade Match's Command Log is schema v2 (`AgentIdentityV2`
   * carries `kind: 'human'`, which the frozen v1 `AgentIdentity` cannot
   * express). `buildReplayFilm` (`replay/film.ts`) now dispatches on
   * `schemaVersion`, routing a v2 document to `packages/core`'s
   * `replayCommandLogV2` -- added alongside `replayCommandLog` rather than
   * replacing it -- so this Match replays through the very same
   * `renderApp`/`mountPlayer` call any other Match does, with no
   * arcade-specific branch in either.
   */
  it('replays a completed arcade Match through the same player, hash verified (AC1, AC4)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);
    const demo = result?.mounted;

    harness.arcadeHost.fire('[data-arcade-play]', 'click');

    let index = 0;
    let iterations = 0;
    while (result?.current() === demo && iterations < 5_000) {
      fireKey(harness.arcadeHost, '[data-arcade-keys]', KEYS[index % KEYS.length]);
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }

    const mounted = result?.current();
    expect(mounted).not.toBe(demo);
    expect(mounted?.film.matchesRecordedHash).toBe(true);
    expect(mounted?.clock.isRunning()).toBe(true);
  });

  it('stops the previous clock, so two fights never run at once', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);
    const demo = result?.mounted;

    harness.arcadeHost.fire('[data-arcade-play]', 'click');
    let index = 0;
    let iterations = 0;
    while (result?.current() === demo && iterations < 5_000) {
      fireKey(harness.arcadeHost, '[data-arcade-keys]', KEYS[index % KEYS.length]);
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }

    expect(demo?.clock.isRunning()).toBe(false);
    expect(result?.current().clock.isRunning()).toBe(true);
  });

  it('marks the arcade Match as excluded from ratings, the same as BYOK (AD-11, AD-14)', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);
    const demo = result?.mounted;

    expect(harness.root.html()).not.toContain('not rated');

    harness.arcadeHost.fire('[data-arcade-play]', 'click');
    let index = 0;
    let iterations = 0;
    while (result?.current() === demo && iterations < 5_000) {
      fireKey(harness.arcadeHost, '[data-arcade-keys]', KEYS[index % KEYS.length]);
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }

    expect(harness.root.html()).toContain('not rated');
  });

  it('catches a mount() throw during onLog and reports it rather than leaving an unhandled rejection (P1)', async () => {
    // `mount`'s remount path (`renderApp`) requests an animation frame as
    // part of starting the new player's clock. Failing precisely that second
    // request -- the first belongs to the demo player mounted by `startup`
    // itself -- reaches `mount` with a real, generically-caused throw, which
    // is exactly what P1's wrapping must catch regardless of its cause.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    let rafCalls = 0;
    const globals = {
      ...harness.globals,
      window: {
        ...harness.globals.window,
        requestAnimationFrame: (callback: () => void): number => {
          rafCalls += 1;
          if (rafCalls > 1) {
            throw new Error('remount blew up');
          }
          return harness.globals.window?.requestAnimationFrame(callback) ?? 0;
        },
      },
    } as unknown as BrowserGlobals;

    const consoleWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };

    try {
      const result = await startup(globals);
      const demo = result?.mounted;

      expect(() => {
        harness.arcadeHost.fire('[data-arcade-play]', 'click');
      }).not.toThrow();

      let index = 0;
      let iterations = 0;
      // Drive the real Match to completion; onLog fires when it does, and the
      // throw above happens inside it rather than escaping as an unhandled
      // rejection.
      while (iterations < 5_000) {
        (
          harness.arcadeHost.fire as unknown as (
            selector: string,
            type: string,
            event?: { key?: string },
          ) => void
        )('[data-arcade-keys]', 'keydown', { key: KEYS[index % KEYS.length] });
        index += 1;
        iterations += 1;
        await Promise.resolve();
        if (warnings.length > 0) {
          break;
        }
      }

      // The demo player is still the one on screen: the throw was caught
      // before it could replace it, and reported through the usual `warn`
      // path rather than left unhandled.
      expect(result?.current()).toBe(demo);
      expect(warnings.some((args) => String(args[0]).includes('remount blew up'))).toBe(true);
    } finally {
      console.warn = consoleWarn;
    }
  });

  it('never crashes on an unmapped key mid-Match, and the Match still completes and replays', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const result = await startup(harness.globals);
    const demo = result?.mounted;

    harness.arcadeHost.fire('[data-arcade-play]', 'click');
    let index = 0;
    let iterations = 0;
    while (result?.current() === demo && iterations < 5_000) {
      fireKey(harness.arcadeHost, '[data-arcade-keys]', 'Escape');
      fireKey(harness.arcadeHost, '[data-arcade-keys]', KEYS[index % KEYS.length]);
      index += 1;
      iterations += 1;
      await Promise.resolve();
    }

    const mounted = result?.current();
    expect(mounted).not.toBe(demo);
    expect(mounted?.film.matchesRecordedHash).toBe(true);
  });
});

/**
 * Story 9.3's wiring, mirroring the arcade/BYOK coverage above: its own host,
 * mounted alongside (not replacing) the demo player, and graceful absence
 * when the page has no `#spectate` host at all.
 *
 * The default harness answers `/replays/manifest.json` with `pending()`
 * (the same "held open forever" default every decoration gets), which is
 * enough to prove the panel mounts and never blocks the demo replay -- the
 * manifest-driven loop itself is covered end to end by `spectate/panel.test.ts`
 * and `spectate/walk.test.ts` with no need to re-derive it here.
 */
describe('the Spectate panel, mounted alongside the demo player (Story 9.3)', () => {
  it('mounts the panel into its own host, outside the player shell', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);

    expect(result?.spectate).not.toBeNull();
    expect(harness.spectateHost.innerHTML).toContain('Spectate');
    // Neither the player's shell nor the other panels are touched by it.
    expect(harness.root.innerHTML).not.toContain('tb-spectate-canvas');
    expect(harness.root.innerHTML).toContain('tb-canvas');
    expect(harness.byokHost.innerHTML).not.toContain('tb-spectate-canvas');
    expect(harness.arcadeHost.innerHTML).not.toContain('tb-spectate-canvas');
  });

  it('leaves the player alone when the page has no spectate host at all', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log, { noSpectateHost: true });

    const result = await startup(harness.globals);

    expect(result?.spectate).toBeNull();
    expect(result?.mounted.clock.isRunning()).toBe(true);
  });

  it('never blocks the demo replay while its own manifest fetch is still in flight', async () => {
    // The manifest fetch never resolves in this harness by default -- the same
    // "still in flight" state every other decoration is tested against in the
    // ordering suite above. The demo player must still be running regardless.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);

    const result = await startup(harness.globals);
    harness.runFrames(5);

    expect(result?.mounted.clock.isRunning()).toBe(true);
    expect(result?.mounted.clock.frameIndex()).toBe(4);
  });

  it('does not crash startup when the spectate panel itself throws on mount', async () => {
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    // A spectate host whose querySelector always fails the panel's own
    // internal element lookups, forcing `mountSpectatePanel` to throw.
    const brokenSpectateHost = {
      innerHTML: '',
      querySelector: () => null,
    };
    const globals = {
      ...harness.globals,
      document: {
        querySelector: (selector: string) => {
          if (selector === '#spectate') {
            return brokenSpectateHost as unknown as ReturnType<
              NonNullable<typeof harness.globals.document>['querySelector']
            >;
          }
          return harness.globals.document?.querySelector(selector) ?? null;
        },
      },
    };

    const result = await startup(globals);

    expect(result?.spectate).toBeNull();
    expect(result?.mounted.clock.isRunning()).toBe(true);
  });

  it('calls a receiver-branded fetch (like a real Window.fetch) without an Illegal-invocation error', async () => {
    // Regression test for the bug the manual browser check surfaced: a real
    // `Window.fetch` is a WebIDL operation branded to `Window` and throws
    // "Illegal invocation" if extracted and called with a different (or no)
    // receiver -- something no plain-function test double reproduces. This
    // fetch stub mimics that by asserting `this` at call time, the same way
    // a real browser's would, so a regression that reintroduces the bug (by
    // handing `globals.fetch` through as a bare reference instead of an
    // arrow function that closes over `globals`) fails this test.
    const { log } = await buildDemoBundle();
    const harness = createHarness(log);
    const brandedWindow = {
      fetch(this: unknown, _url: string) {
        if (this !== brandedWindow) {
          throw new TypeError('Illegal invocation');
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ entries: [] }) });
      },
    };
    // The bare method reference, exactly as `window.fetch` would arrive if
    // extracted -- `mountSpectate`'s own fetch dep must still call it in a
    // way that supplies the correct receiver.
    const globals = { ...harness.globals, fetch: brandedWindow.fetch };

    const result = await startup(globals);

    expect(result?.spectate).not.toBeNull();
  });
});
