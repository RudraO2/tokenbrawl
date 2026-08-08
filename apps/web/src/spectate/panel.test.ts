import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandLog } from '@tokenbrawl/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { buildDemoLog } from '../testing/demo-log';
import { buildReplayFilm, type ReplayFilm } from '../replay/film';
import { createBlockArtist } from '../render/artist';
import type { AudioCue, AudioSink } from '../render/audio';
import type { Canvas2D } from '../render/canvas2d';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack, type JuiceTrack } from '../render/juice';
import { drawJuicedFrame } from '../render/juice-draw';
import { DEFAULT_ROSTER } from '../render/roster';
import type { UltSheet } from '../render/ult-sheet';
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
  /** Story 11.6. Every drawing call and every style write the panel made, in order. */
  readonly calls: () => readonly string[];
  readonly clearCalls: () => void;
}

/**
 * A recording 2D context. Story 11.6.
 *
 * Property *writes* are recorded as well as calls, because the difference
 * between a cinematic drawn for the right caster and one drawn for nobody is a
 * `fillStyle` (the caster's aura) rather than a different call. `theme.ts`'s
 * palette is the only place those colours are written down, so recording the
 * value rather than asserting a literal keeps this test off that table.
 */
function createRecordingContext(): { readonly ctx: Canvas2D; readonly calls: string[] } {
  const calls: string[] = [];
  const values: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.map((arg) => String(arg)).join(',')})`);
    };
  const ctx = {
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    fill: record('fill'),
    stroke: record('stroke'),
    drawImage: record('drawImage'),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
  } as unknown as Canvas2D;
  for (const key of Object.keys(values)) {
    Object.defineProperty(ctx, key, {
      get: () => values[key],
      set: (value: unknown) => {
        values[key] = value;
        calls.push(`${key}=${String(value)}`);
      },
      enumerable: true,
      configurable: true,
    });
  }
  return { ctx, calls };
}

function createHost(): FakeHost {
  const nodes = new Map<string, SpectateNode>();
  const listeners = new Map<string, (() => void)[]>();
  const state = { html: '' };
  const recorder = createRecordingContext();

  const child = (selector: string): SpectateNode => {
    const existing = nodes.get(selector);
    if (existing !== undefined) {
      return existing;
    }
    const isCanvas = selector === 'canvas';
    const canvasContext = recorder.ctx;
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
    calls: (): readonly string[] => recorder.calls,
    clearCalls: (): void => {
      recorder.calls.length = 0;
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

/**
 * Story 11.6. The one Match in the committed stream that contains an Ultimate.
 *
 * Read through `import.meta.url` rather than `process.cwd()` so this suite runs
 * the same from the repo root and from `apps/web`, the way `hero-artefact.test.ts`
 * reads its own artefacts.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SPECTATE_03 = join(HERE, '..', '..', 'public', 'replays', 'spectate-03.command-log.json');

/** The tuning-and-arena triple every juice track in this app is built with. */
function trackOf(film: ReplayFilm): JuiceTrack {
  return buildJuiceTrack(
    film.frames,
    DEFAULT_JUICE_TUNING,
    arenaFor(DEFAULT_FIGHTER_CONFIG),
    false,
    DEFAULT_FIGHTER_CONFIG,
  );
}

/** A sink that records rather than plays. Story 11.6. */
function createRecordingSink(): {
  readonly sink: AudioSink;
  readonly played: AudioCue[];
  readonly gains: number[][];
  readonly stops: { count: number };
} {
  const played: AudioCue[] = [];
  const gains: number[][] = [];
  const stops = { count: 0 };
  return {
    played,
    gains,
    stops,
    sink: {
      play: (cue) => played.push(cue),
      stopAll: () => {
        stops.count += 1;
      },
      setGains: (music, sfx, voice) => gains.push([music, sfx, voice]),
      unlock: () => undefined,
    },
  };
}

describe('the Spectate panel (Story 9.3)', () => {
  const env = createFighterEnvironment();
  let logs: readonly [CommandLog, CommandLog];
  /** Clock frames -- what the manifest records and what the clock runs on since Story 11.6. */
  let frameCounts: readonly [number, number];
  let filmCounts: readonly [number, number];

  beforeAll(async () => {
    const built = await Promise.all([buildDemoLog(4_101), buildDemoLog(4_102)]);
    logs = [built[0], built[1]];
    const films = [buildReplayFilm(logs[0], env), buildReplayFilm(logs[1], env)] as const;
    filmCounts = [films[0].frames.length, films[1].frames.length];
    frameCounts = [trackOf(films[0]).frameCount, trackOf(films[1]).frameCount];
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

    // Clock frames, not film frames: since Story 11.6 an entry is over when its
    // *juice track* is, which is longer by every hitstop hold in it.
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

  it('shows a fail-soft status when every manifest entry fails to load, rather than staying stuck on "Loading…"', async () => {
    const host = createHost();
    const driver = createDriver();
    const deps: SpectatePanelDeps = {
      ...baseDeps(driver),
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    };

    mountSpectatePanel(host, deps);
    await flush();

    const status = host.node('[data-spectate-status]').innerHTML;
    expect(status).not.toContain('Loading');
    expect(status).toContain('unavailable');
  });

  it('throws a clear error when the host is missing required elements, rather than mounting half a panel', () => {
    const brokenHost: SpectateHost = {
      innerHTML: '',
      querySelector: () => null,
    };
    const driver = createDriver();
    expect(() => mountSpectatePanel(brokenHost, baseDeps(driver))).toThrow(/did not mount/);
  });

  describe('the juice layer (Story 11.6)', () => {
    /**
     * The comparison every drawing case here rests on: what `drawJuicedFrame`
     * itself emits for one clock frame, recorded off a second context.
     *
     * Asserting the panel's calls *equal* these -- rather than asserting some
     * juice-shaped call appears among them -- is what makes "the same effects
     * the replay player draws, through the existing juice layer" checkable. A
     * panel that drew its own approximation of sparks would pass a
     * "contains a translate" test and fail this one.
     */
    function expectedCalls(
      film: ReplayFilm,
      track: JuiceTrack,
      clockIndex: number,
      options: {
        readonly roster?: typeof DEFAULT_ROSTER;
        readonly reducedMotion?: boolean;
        readonly ult?: UltSheet;
      } = {},
    ): readonly string[] {
      const recorder = createRecordingContext();
      const blockArtist = createBlockArtist();
      drawJuicedFrame(recorder.ctx, film.frames[track.filmIndexAt(clockIndex)], track.at(clockIndex), {
        config: DEFAULT_FIGHTER_CONFIG,
        viewport: { width: 960, height: 400 },
        artists: [blockArtist, blockArtist],
        roster: DEFAULT_ROSTER,
        ...options,
      });
      return recorder.calls;
    }

    it('paints through drawJuicedFrame, call for call, rather than through drawFrame', async () => {
      const host = createHost();
      const driver = createDriver();
      mountSpectatePanel(host, baseDeps(driver));
      await flush();

      const film = buildReplayFilm(logs[0], env);
      const track = trackOf(film);
      // A frame deep enough into the Match that the bots have traded, so the
      // juice frame under test actually carries something.
      const target = Math.floor(track.frameCount / 2);
      driver.pump(target);
      host.clearCalls();
      driver.pump(1);

      expect(host.calls()).toStrictEqual(expectedCalls(film, track, target + 1));
    });

    it('holds a hitstop frame rather than advancing the film through it', async () => {
      const host = createHost();
      const driver = createDriver();
      mountSpectatePanel(host, baseDeps(driver));
      await flush();

      const track = trackOf(buildReplayFilm(logs[0], env));
      // Somewhere in this track a clock frame presents the same film frame as
      // the one before it: that is a hold, and it is the thing Spectate never
      // had. Asserted as a property of what the panel is playing, not of the
      // pure track alone -- the panel's clock is what has to run long enough to
      // reach it.
      const holds = Array.from({ length: track.frameCount }, (_, index) => index).filter(
        (index) => index > 0 && track.filmIndexAt(index) === track.filmIndexAt(index - 1),
      );
      expect(holds.length).toBeGreaterThan(0);
      expect(track.frameCount).toBeGreaterThan(filmCounts[0]);
    });

    it('draws the Ultimate cinematic on the one streamed Match that contains one', async () => {
      const log = JSON.parse(readFileSync(SPECTATE_03, 'utf8')) as CommandLog;
      const film = buildReplayFilm(log, env);
      const track = trackOf(film);
      expect(track.cinematics.length).toBe(1);

      // The clock frame the freeze opens on -- the same index `audio.ts` keys
      // the Ultimate's cue off, found by asking the track rather than by
      // writing 401 down.
      const cinematicClock = Array.from({ length: track.frameCount }, (_, index) => index).find(
        (index) => track.at(index).cinematic !== null,
      );
      expect(cinematicClock).toBeDefined();

      const host = createHost();
      const driver = createDriver();
      const manifest: SpectateManifest = {
        schemaVersion: '1.0.0',
        loopStartEpochMs: 0,
        totalLoopDurationMs: 1,
        entries: [
          {
            id: 'ult',
            commandLogUrl: '/replays/ult.command-log.json',
            schemaVersion: '1.0.0',
            frameCount: track.frameCount,
          },
        ],
      };
      mountSpectatePanel(host, {
        ...baseDeps(driver),
        loadManifest: async () => manifest,
        fetch: async () => ({ ok: true, status: 200, json: async () => log }),
      });
      await flush();

      driver.pump(cinematicClock! - 1);
      host.clearCalls();
      driver.pump(1);

      const calls = host.calls();
      // Story 10.4's banner: without the Ultimate sheet decoded this is what the
      // cinematic draws, and `drawFrame` alone never draws it at all.
      expect(calls.some((call) => call.includes('ULTIMATE'))).toBe(true);
      expect(calls).toStrictEqual(expectedCalls(film, track, cinematicClock!));
      // And the caster really is resolved through the roster: dropping `roster`
      // from the paint's options changes what the cinematic draws, which is the
      // level-3 degrade this surface used to take by default.
      expect(calls).not.toStrictEqual(
        expectedCalls(film, track, cinematicClock!, { roster: undefined }),
      );
    });

    it('threads a decoded Ultimate sheet into the cinematic it draws', async () => {
      // `setUlt` storing the sheet and never handing it to `drawJuicedFrame` is
      // invisible to "the cinematic drew" -- Story 10.4's banner draws either
      // way. So the sheet is handed over and the *same* frame is asserted to
      // draw differently because of it, which is the only difference a call log
      // can see between the second degrade level and the first.
      const log = JSON.parse(readFileSync(SPECTATE_03, 'utf8')) as CommandLog;
      const film = buildReplayFilm(log, env);
      const track = trackOf(film);
      const cinematicClocks = Array.from({ length: track.frameCount }, (_, index) => index).filter(
        (index) => track.at(index).cinematic !== null,
      );
      // The middle of the run, not its first frame: the portrait and the beam
      // both ease in from nothing, so on the opening frame a sheet and no sheet
      // legitimately draw the same picture.
      const cinematicClock = cinematicClocks[Math.floor(cinematicClocks.length / 2)];
      expect(cinematicClock).toBeDefined();

      const frame = { image: { width: 208, height: 208 }, sx: 0, sy: 0, sw: 208, sh: 208 };
      const ult: UltSheet = {
        fighters: ['clawde'],
        imageUrls: ['/fx/ult.png'],
        partFor: (id) => (id === 'clawde' ? frame : undefined),
        portraitFor: (id) => (id === 'clawde' ? frame : undefined),
      };

      const host = createHost();
      const driver = createDriver();
      const panel = mountSpectatePanel(host, {
        ...baseDeps(driver),
        loadManifest: async () => ({
          schemaVersion: '1.0.0',
          loopStartEpochMs: 0,
          totalLoopDurationMs: 1,
          entries: [
            {
              id: 'ult',
              commandLogUrl: '/replays/ult.command-log.json',
              schemaVersion: '1.0.0',
              frameCount: track.frameCount,
            },
          ],
        }),
        fetch: async () => ({ ok: true, status: 200, json: async () => log }),
      });
      await flush();
      panel.setUlt(ult);

      driver.pump(cinematicClock! - 1);
      host.clearCalls();
      driver.pump(1);

      expect(host.calls()).toStrictEqual(expectedCalls(film, track, cinematicClock!, { ult }));
      expect(host.calls()).not.toStrictEqual(expectedCalls(film, track, cinematicClock!));
    });

    it('honours reduced motion: no shake, and no loop churn', async () => {
      const host = createHost();
      const driver = createDriver();
      const panel = mountSpectatePanel(host, {
        ...baseDeps(driver),
        view: {
          requestAnimationFrame: driver.requestAnimationFrame,
          cancelAnimationFrame: driver.cancelAnimationFrame,
          matchMedia: (query: string) => ({ matches: query.includes('reduced-motion') }),
        },
      });
      await flush();

      const film = buildReplayFilm(logs[0], env);
      const reduced = buildJuiceTrack(
        film.frames,
        DEFAULT_JUICE_TUNING,
        arenaFor(DEFAULT_FIGHTER_CONFIG),
        true,
        DEFAULT_FIGHTER_CONFIG,
      );
      // A reduced-motion clock emits the last frame once and never schedules;
      // `startLoop` then seeks to the join offset, which is frame 0 for this
      // manifest. Two paints, no third, and nothing scheduled after them --
      // the still stream, joined where AD-17 says a visitor joins.
      const recorder = createRecordingContext();
      const blockArtist = createBlockArtist();
      for (const index of [reduced.frameCount - 1, 0]) {
        drawJuicedFrame(recorder.ctx, film.frames[reduced.filmIndexAt(index)], reduced.at(index), {
          config: DEFAULT_FIGHTER_CONFIG,
          viewport: { width: 960, height: 400 },
          artists: [blockArtist, blockArtist],
          roster: DEFAULT_ROSTER,
          reducedMotion: true,
        });
      }

      expect(panel.currentEntryId()).toBe('first');
      expect(host.calls()).toStrictEqual(recorder.calls);
      // And pumping changes nothing, because nothing was ever scheduled.
      const settled = [...host.calls()];
      driver.pump(20);
      expect(host.calls()).toStrictEqual(settled);
      // No `translate` with a non-zero offset anywhere: the camera shake is the
      // canonical vestibular trigger and the single most important thing this
      // preference has to switch off.
      expect(host.calls().filter((call) => call.startsWith('translate(') && call !== 'translate(0,0)')).toStrictEqual([]);
    });
  });

  describe('the sound, and who owns it (Story 11.6)', () => {
    it('makes no noise at all until a visitor asks for it', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();
      driver.pump(30);

      expect(panel.audioEnabled()).toBe(false);
      expect(recording.played).toStrictEqual([]);
      expect(recording.gains).toStrictEqual([]);
      // Not even a stop: an ambient surface that is not making sound must not
      // reach into a shared graph the replay player beside it may be using.
      expect(recording.stops.count).toBe(0);
      expect(host.node('[data-spectate-sound]').innerHTML).toContain('off');
    });

    it('the toggle unlocks the context, takes the buses over, and starts the bed', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const gestures = { count: 0 };
      mountSpectatePanel(host, {
        ...baseDeps(driver),
        sink: recording.sink,
        onGesture: () => {
          gestures.count += 1;
        },
      });
      await flush();
      driver.pump(5);

      host.fire('[data-spectate-sound]', 'click');

      expect(gestures.count).toBe(1);
      expect(recording.stops.count).toBe(1);
      // The looping music bed, which only ever rides clock frame 0 -- so a
      // visitor enabling sound mid-Match hears the bed rather than hits over
      // silence.
      expect(recording.played.filter((cue) => cue.loop && cue.bus === 'music').length).toBe(1);
      expect(host.node('[data-spectate-sound]').innerHTML).toContain('on');
    });

    it('does not start a second bed when the frames keep coming after the toggle', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      host.fire('[data-spectate-sound]', 'click');
      driver.pump(40);

      expect(recording.played.filter((cue) => cue.loop).length).toBe(1);
      // And the gains really are being written every frame after the toggle,
      // which is the state half of the director's contract.
      expect(recording.gains.length).toBeGreaterThan(30);
    });

    it('enabling on the very first frame does not double the bed either', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      // Before any frame has been pumped: the enable's own `atFrame(0)` and the
      // clock's first real frame 0 are the same index, and the second must read
      // as a jump rather than as a second start.
      host.fire('[data-spectate-sound]', 'click');
      driver.pump(10);

      expect(recording.played.filter((cue) => cue.loop).length).toBe(1);
    });

    it('turning it off stops the bed and writes nothing further', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      panel.setAudioEnabled(true);
      driver.pump(10);
      const playedWhileOn = recording.played.length;
      const gainsWhileOn = recording.gains.length;

      panel.setAudioEnabled(false);
      driver.pump(20);

      expect(panel.audioEnabled()).toBe(false);
      expect(recording.stops.count).toBe(2);
      expect(recording.played.length).toBe(playedWhileOn);
      expect(recording.gains.length).toBe(gainsWhileOn);
    });

    it('setting the same state twice is a no-op, so a repeated click cannot restack the bed', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      panel.setAudioEnabled(true);
      panel.setAudioEnabled(true);
      driver.pump(5);

      expect(recording.stops.count).toBe(1);
      expect(recording.played.filter((cue) => cue.loop).length).toBe(1);
    });

    it('an entry change with the sound on stops the outgoing entry`s sources and starts the next bed', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      panel.setAudioEnabled(true);
      const stopsAfterEnable = recording.stops.count;
      driver.pump(frameCounts[0]);
      await flush();
      driver.pump(2);

      expect(panel.currentEntryId()).toBe('second');
      expect(recording.stops.count).toBe(stopsAfterEnable + 1);
      expect(recording.played.filter((cue) => cue.loop).length).toBe(2);
    });

    it('off and on again gets its bed back, rather than staying silent for the rest of the entry', async () => {
      // The director is replaced on every enable precisely so this works. A
      // director kept across the mute would see the resumed frame as a jump --
      // gains, no cues -- and the stream would play hits over silence until the
      // next entry, which is up to a whole Match away.
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      panel.setAudioEnabled(true);
      driver.pump(10);
      panel.setAudioEnabled(false);
      driver.pump(10);
      panel.setAudioEnabled(true);
      driver.pump(10);

      expect(recording.played.filter((cue) => cue.loop).length).toBe(2);
    });

    it('enabling before the stream has loaded still starts the bed when it does', async () => {
      // The ordering a visitor who clicks fast actually produces: there is no
      // track to build a director from yet, so the enable can only record the
      // decision and the first entry to mount has to honour it.
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });

      panel.setAudioEnabled(true);
      expect(recording.played).toStrictEqual([]);

      await flush();
      driver.pump(10);

      expect(recording.played.filter((cue) => cue.loop && cue.bus === 'music').length).toBe(1);
      expect(recording.gains.length).toBeGreaterThan(5);
    });

    it('an entry change with the sound off leaves the shared graph alone entirely', async () => {
      const host = createHost();
      const driver = createDriver();
      const recording = createRecordingSink();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: recording.sink });
      await flush();

      driver.pump(frameCounts[0]);
      await flush();
      driver.pump(5);

      expect(panel.currentEntryId()).toBe('second');
      expect(recording.stops.count).toBe(0);
      expect(recording.played).toStrictEqual([]);
    });

    it('a page with no WebAudio toggles and plays exactly as it otherwise would', async () => {
      const host = createHost();
      const driver = createDriver();
      const panel = mountSpectatePanel(host, { ...baseDeps(driver), sink: null });
      await flush();

      expect(() => panel.setAudioEnabled(true)).not.toThrow();
      expect(panel.audioEnabled()).toBe(true);
      expect(() => driver.pump(20)).not.toThrow();
      expect(panel.currentEntryId()).toBe('first');
    });
  });
});
