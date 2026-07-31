import type { CommandLog } from '@tokenbrawl/contracts';
import { DEFAULT_FIGHTER_CONFIG } from '../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { createPlaybackClock, type PlaybackClock } from './player/clock';
import { buildReplayFilm, type ReplayFilm } from './replay/film';
import type { Canvas2D } from './render/canvas2d';
import type { FighterArtist } from './render/artist';
import { drawFrame } from './render/renderer';
import './styles/app.css';

/**
 * Story 4.1: the replay player.
 *
 * Everything below the wiring is pure and tested elsewhere -- this file exists
 * to attach three tested pieces to a page, and it is deliberately the only
 * file in the app that touches the DOM. That split is what lets the film, the
 * renderer and the clock all be asserted under Vitest's default `node`
 * environment, with no jsdom and no new dependency.
 *
 * The hash is verified before a single frame is drawn, and the verdict is put
 * on the page (AC5). A player that quietly rendered a log whose replay
 * disagreed with it would be the most convincing possible way to publish a
 * wrong result.
 */

/**
 * Fixed backbuffer size; CSS scales it, so playback is resolution-independent.
 *
 * 12:5 rather than 16:9. The arena is a single horizontal axis and the
 * fighters are 160px tall, so a 540-tall stage left most of the frame empty --
 * the shape of the viewport should follow the shape of the game.
 */
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 400;

/**
 * The DOM surface this player touches, declared structurally rather than by
 * naming `HTMLCanvasElement` and `Window`.
 *
 * Same reason `packages/providers/src/http.ts` declares its own `HttpResponse`:
 * `tsconfig.base.json` -- the one project `tsc --noEmit` actually checks -- sets
 * `lib: ["ES2022"]` with no DOM, and adding DOM there would hand `packages/core`
 * ambient `document` and `window` types, weakening the type-level half of INV-3
 * across the whole repo to spare four interfaces here.
 *
 * The real DOM objects satisfy these structurally, so `main.ts` is called with
 * them unwrapped and no adapter exists.
 */
export interface CanvasSurface {
  width: number;
  height: number;
  getContext(id: '2d'): Canvas2D | null;
}

export interface HostView {
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  matchMedia?(query: string): { readonly matches: boolean };
}

export interface MountPoint {
  innerHTML: string;
  querySelector(selectors: string): MountPointChild | null;
}

export interface MountPointChild {
  innerHTML: string;
  addEventListener(type: 'click', listener: () => void): void;
}

export interface MountedPlayer {
  readonly film: ReplayFilm;
  readonly clock: PlaybackClock;
}

/**
 * Whether the viewer asked for less motion.
 *
 * Guarded rather than assumed: `matchMedia` is absent in a test environment and
 * in some embedded browsers, and a player that threw on mount because it could
 * not read a preference would be a worse accessibility outcome than the one the
 * preference exists to fix.
 */
function prefersReducedMotion(view: HostView): boolean {
  const query = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  return query?.matches === true;
}

/**
 * Mounts the player onto a canvas and returns the film and its clock.
 *
 * The clock is handed `requestAnimationFrame` wrapped so its callback takes no
 * arguments: the timestamp the browser supplies is unreachable by
 * construction, which is how INV-3 is kept here rather than merely intended.
 */
export function mountPlayer(
  canvas: CanvasSurface,
  log: unknown,
  view: HostView,
  artist?: FighterArtist,
): MountedPlayer {
  const env = createFighterEnvironment();
  const film = buildReplayFilm(log, env);

  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('mountPlayer: this browser provided no 2D canvas context.');
  }

  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const viewport = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };

  const paint = (index: number): void => {
    drawFrame(ctx, film.frames[index], { config: DEFAULT_FIGHTER_CONFIG, viewport, artist });
  };

  const clock = createPlaybackClock({
    frameCount: film.frames.length,
    requestFrame: (callback) => view.requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => view.cancelAnimationFrame(handle),
    reducedMotion: prefersReducedMotion(view),
    onFrame: paint,
  });

  // Paint frame zero up front, so the stage is never blank while the first
  // animation frame is pending.
  if (film.frames.length > 0) {
    paint(0);
  }

  return { film, clock };
}

/**
 * The verification chip's label and modifier class.
 *
 * Exported and pure so the AC5 surface can be asserted without a DOM -- the
 * thing worth testing is that a failed replay is loud, not that a span exists.
 */
export function hashChip(film: ReplayFilm): { readonly label: string; readonly modifier: string } {
  return film.matchesRecordedHash
    ? { label: 'HASH VERIFIED', modifier: 'tb-chip--verified' }
    : { label: 'HASH MISMATCH', modifier: 'tb-chip--failed' };
}

/** Decision-Point count for the readout: transitions, not states. */
export function decisionPointCount(film: ReplayFilm): number {
  return Math.max(0, film.states.length - 1);
}

/**
 * Wires the page. Kept a thin, obviously-correct sequence of DOM writes, with
 * every decision it displays computed by a pure function above.
 */
export function renderApp(
  root: MountPoint,
  log: CommandLog,
  view: HostView,
  artist?: FighterArtist,
): MountedPlayer {
  root.innerHTML = `
    <header class="tb-masthead">
      <h1 class="tb-wordmark">Tokenbrawl</h1>
      <p class="tb-tagline">Replay &mdash; re-simulated, never recorded</p>
    </header>
    <div class="tb-stage"><canvas class="tb-canvas"></canvas></div>
    <div class="tb-readout" data-readout></div>
    <button class="tb-button" type="button" data-play>Replay</button>
  `;

  const canvas = root.querySelector('canvas');
  const readout = root.querySelector('[data-readout]');
  const play = root.querySelector('[data-play]');
  if (canvas === null || readout === null || play === null) {
    throw new Error('renderApp: the shell did not mount.');
  }

  const mounted = mountPlayer(canvas as unknown as CanvasSurface, log, view, artist);
  const chip = hashChip(mounted.film);

  readout.innerHTML = `
    <span class="tb-chip ${chip.modifier}">${chip.label}</span>
    <span class="tb-chip">${String(decisionPointCount(mounted.film))} decision points</span>
    <span class="tb-chip">${mounted.film.result.outcome.toUpperCase()} &middot; ${mounted.film.result.endReason.toUpperCase()}</span>
    <span class="tb-chip tb-hash">${mounted.film.finalStateHash}</span>
  `;

  play.addEventListener('click', () => {
    mounted.clock.stop();
    mounted.clock.start();
  });
  mounted.clock.start();

  return mounted;
}
