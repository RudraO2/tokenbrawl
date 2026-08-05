import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { escapeHtml, type CanvasSurface, type HostView } from '../main';
import { createBlockArtist } from '../render/artist';
import { drawFrame } from '../render/renderer';
import {
  fetchSpectateManifest,
  offsetForNow,
  readNowMs,
  type FetchLike,
  type SpectateManifest,
  type SpectateManifestEntry,
} from './manifest';
import { createSpectateWalk, type SpectateWalkHandle } from './walk';

/**
 * Story 9.3: the Spectate panel.
 *
 * Mirrors `arcade/panel.ts`'s `mount*Panel(host)` factory shape (and, through
 * it, `byok/panel.ts`'s) -- its own host (`#spectate`, beside `#app`, `#byok`
 * and `#arcade`), structural DOM interfaces throughout (`tsconfig.base.json`
 * has no DOM lib; see `arcade/panel.ts`'s docblock and `main.ts`'s for why),
 * and a `mount*Panel` factory that wires everything and returns a small
 * public handle.
 *
 * Unlike the other panels, this one owns its own canvas and does its own
 * frame drawing -- it does not go through `main.ts`'s `renderApp`/
 * `mountPlayer`, because those own exactly one film/clock pair for the life
 * of the page and Spectate's whole point is walking a *sequence* of them.
 * `createSpectateWalk` (`walk.ts`) is the sequencing layer; this file wires
 * it to a canvas and a picker list, the same relationship `main.ts` has to
 * `mountPlayer` for the single-log case. `buildReplayFilm` and
 * `createPlaybackClock` are still reused unmodified -- through `walk.ts`,
 * never reimplemented here.
 */

export type SpectateEvent = 'click';

export interface SpectateNode {
  innerHTML: string;
  setAttribute?(name: string, value: string): void;
  addEventListener(type: SpectateEvent, listener: () => void): void;
}

export interface SpectateCanvasNode extends SpectateNode {
  width: number;
  height: number;
  getContext(id: '2d'): ReturnType<CanvasSurface['getContext']>;
}

export interface SpectateHost {
  innerHTML: string;
  querySelector(selectors: string): SpectateNode | null;
}

export interface SpectatePanelDeps {
  readonly view: HostView;
  readonly fetch: FetchLike;
  /** Injectable so a test can fix "now" rather than depending on the real clock. */
  readonly now?: () => number;
  /** Injectable so a test can supply a manifest with no network at all. */
  readonly loadManifest?: (fetchImpl: FetchLike) => Promise<SpectateManifest>;
}

export interface SpectatePanel {
  readonly currentEntryId: () => string | null;
  readonly pick: (entryId: string) => void;
}

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 400;

/** Escapes `\` and `"` so `id` is safe to interpolate inside a double-quoted `[attr="..."]` CSS attribute selector. */
function escapeAttributeSelector(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pickerMarkup(entries: readonly SpectateManifestEntry[]): string {
  return entries
    .map(
      (entry) =>
        `<button class="tb-button tb-spectate-pick" type="button" data-spectate-pick="${escapeHtml(entry.id)}">${escapeHtml(entry.id)}</button>`,
    )
    .join('');
}

/**
 * The panel's markup. Exported so the shell can be asserted with no DOM, in
 * the spirit of `arcadeMarkup`/`byokMarkup`.
 */
export function spectateMarkup(entries: readonly SpectateManifestEntry[] = []): string {
  return `
    <h2 class="tb-spectate-heading">Spectate</h2>
    <p class="tb-spectate-intro">
      An always-running AI-vs-AI stream. Every Match is a precomputed Baseline-Bot pairing,
      walked client-side -- no server, no live inference, no cost.
    </p>
    <div class="tb-spectate-stage">
      <canvas class="tb-spectate-canvas"></canvas>
    </div>
    <p class="tb-spectate-status" data-spectate-status role="status" aria-live="polite"></p>
    <div class="tb-spectate-picker" data-spectate-picker>${pickerMarkup(entries)}</div>
  `;
}

/**
 * Mounts the panel and returns as soon as the loop is (or, if the manifest
 * fetch is still in flight, will shortly be) playing.
 *
 * The manifest fetch and the first entry's Command Log fetch are both
 * awaited internally before this function's own promise resolves is *not*
 * how this works: like `startup.ts`'s critical-path discipline, the shell is
 * written and returned synchronously, and the loop starts once the manifest
 * has loaded -- a slow manifest fetch must not block the rest of the page
 * (mirrors AC1's "no click, key or network call beyond initial static asset
 * fetches", not "resolves before the network answers").
 */
export function mountSpectatePanel(host: SpectateHost, deps: SpectatePanelDeps): SpectatePanel {
  host.innerHTML = spectateMarkup();

  const canvasNode = host.querySelector('canvas');
  const statusNode = host.querySelector('[data-spectate-status]');
  const pickerNode = host.querySelector('[data-spectate-picker]');

  if (canvasNode === null || statusNode === null || pickerNode === null) {
    throw new Error('mountSpectatePanel: the panel did not mount.');
  }

  const canvas = canvasNode as unknown as SpectateCanvasNode;
  const status = statusNode;
  const picker = pickerNode;

  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('mountSpectatePanel: this browser provided no 2D canvas context.');
  }
  const viewport = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const blockArtist = createBlockArtist();
  const env = createFighterEnvironment();

  const say = (message: string): void => {
    status.innerHTML = escapeHtml(message);
  };

  const state: { walk: SpectateWalkHandle | null; manifest: SpectateManifest | null } = {
    walk: null,
    manifest: null,
  };

  // A `const` arrow function, not a `function` declaration: TypeScript does
  // not carry a narrowing into a hoisted function declaration (it could in
  // principle be called before the guard above runs), but it does into a
  // `const` closure created after it -- the same reason `main.ts`'s `paint`
  // is written the same way.
  const paint = (frameIndex: number): void => {
    const film = state.walk?.currentFilm();
    const frame = film?.frames[frameIndex];
    if (frame === undefined) {
      return;
    }
    drawFrame(ctx, frame, {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport,
      artists: [blockArtist, blockArtist],
    });
  };

  /**
   * Runs `walk.playSpecific`/`resumeLoop` from a DOM event handler or from
   * the returned `pick()` handle, without ever leaving an unhandled promise
   * rejection behind. `walk.ts` already catches everything it can reach
   * internally (fetch failures, hash failures, a throwing callback), so this
   * is a second, narrower net around the one thing outside its control: the
   * handle itself being `null` briefly, in the small window between the
   * manifest resolving and `state.walk` being assigned.
   */
  function play(entryId: string): void {
    if (state.walk === null) {
      console.warn(`Spectate: could not play "${entryId}" -- the stream has not finished loading yet.`);
      return;
    }
    state.walk.playSpecific(entryId).catch((error: unknown) => {
      console.warn(`Spectate: could not play "${entryId}". ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function renderPicker(): void {
    const entries = state.manifest?.entries ?? [];
    picker.innerHTML = pickerMarkup(entries);
    for (const entry of entries) {
      // `manifest.ts`'s `id` field is only guaranteed non-empty, not free of
      // characters like `"` or `\` that would break or mis-target a
      // hand-built `[attr="..."]` selector -- `escapeAttributeSelector`
      // closes that gap the same way `escapeHtml` does for the markup above.
      const button = host.querySelector(`[data-spectate-pick="${escapeAttributeSelector(entry.id)}"]`);
      button?.addEventListener('click', () => {
        // A visitor clicking twice fast (or clicking while a previous pick is
        // still loading) is handled entirely by `walk.ts`'s own generation
        // guard: the second call simply supersedes the first, and the first's
        // eventual (stale) load is dropped rather than mounted.
        play(entry.id);
        say(`Playing ${entry.id}. Returns to the loop when it finishes.`);
      });
    }
  }

  say('Loading the Spectate stream…');

  const loadManifest = deps.loadManifest ?? fetchSpectateManifest;
  const nowFn = deps.now ?? readNowMs;

  // Fire-and-forget from this function's own point of view: the shell above
  // is already on screen, and the loop starts as soon as the manifest
  // resolves. A rejection here (a bad or missing manifest.json) is the "the
  // manifest itself fails to load" row of the I/O matrix -- reported, never
  // thrown into an unhandled rejection.
  void (async (): Promise<void> => {
    try {
      const manifest = await loadManifest(deps.fetch);
      state.manifest = manifest;

      const walk = createSpectateWalk({
        manifest,
        fetchJson: async (url: string) => {
          const response = await deps.fetch(url);
          if (!response.ok) {
            throw new Error(`could not load ${url} (HTTP ${String(response.status)})`);
          }
          return response.json();
        },
        env,
        requestFrame: (callback) => deps.view.requestAnimationFrame(() => callback()),
        cancelFrame: (handle) => deps.view.cancelAnimationFrame(handle),
        onFrame: paint,
        onEntryChange: (entry) => {
          say(`Now playing ${entry.id}.`);
        },
        onWarning: (message) => {
          console.warn(message);
        },
      });
      state.walk = walk;
      // Rendered only now, after `state.walk` is set: a click landing in the
      // gap between the picker existing and the walk handle being assigned
      // would otherwise be a silent no-op (`play` guards it with `?.`, so it
      // could not crash, but it could also do nothing that a visitor could
      // tell apart from a broken button).
      renderPicker();

      const offset = offsetForNow(manifest, nowFn());
      await walk.startLoop(offset);
      if (walk.currentEntryId() === null) {
        // Every manifest entry failed to load or hash-verify -- `walk.ts`
        // already warned per-entry; the status text must not be left stuck
        // on "Loading…" forever (the fail-soft path still needs a visible
        // terminal state for a human watching the page, not just the log).
        say('Spectate stream unavailable: every manifest entry failed to load.');
      }
    } catch (error) {
      say(
        `Spectate stream unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.warn(`Spectate: could not start the stream. ${String(error instanceof Error ? error.message : error)}`);
    }
  })();

  return Object.freeze({
    currentEntryId: (): string | null => state.walk?.currentEntryId() ?? null,
    pick: (entryId: string): void => {
      play(entryId);
    },
  });
}
