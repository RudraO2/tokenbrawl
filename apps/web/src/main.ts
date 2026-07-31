import type { CommandLog } from '@tokenbrawl/contracts';
import { DEFAULT_FIGHTER_CONFIG } from '../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { createPlaybackClock, type PlaybackClock } from './player/clock';
import { buildReplayFilm, type ReplayFilm } from './replay/film';
import {
  createReasoningSource,
  type ReasoningLookup,
  type ReasoningSource,
} from './replay/sidecar';
import type { Canvas2D } from './render/canvas2d';
import { createBlockArtist, type FighterArtist } from './render/artist';
import type { Backdrop } from './render/backdrop';
import { drawFrame } from './render/renderer';
import './styles/app.css';

/**
 * Story 4.1: the replay player. Story 4.2: it stops waiting for its own
 * decorations.
 *
 * Everything below the wiring is pure and tested elsewhere -- this file exists
 * to attach tested pieces to a page, and it is deliberately the only file in
 * the app that touches the DOM. That split is what lets the film, the renderer,
 * the clock and the reasoning source all be asserted under Vitest's default
 * `node` environment, with no jsdom and no new dependency.
 *
 * The hash is verified before a single frame is drawn, and the verdict is put
 * on the page (4.1 AC5). A player that quietly rendered a log whose replay
 * disagreed with it would be the most convincing possible way to publish a
 * wrong result.
 *
 * ## What 4.2 changed, and why it is here rather than in `startup.ts`
 *
 * The fight must be running before any sprite sheet, backdrop or reasoning
 * sidecar has arrived. That means the player cannot take its artists as
 * constructor arguments -- it has to accept them later and repaint what is
 * already on screen. So `mountPlayer` holds its dressing in closure state and
 * exposes `setArtist`/`setBackdrop`, and `startup.ts` calls them as each asset
 * decodes. The block artist needs no network at all, which is what makes frame
 * zero free.
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
  addEventListener(type: 'click' | 'pointerenter' | 'focus', listener: () => void): void;
}

export interface MountedPlayer {
  readonly film: ReplayFilm;
  readonly clock: PlaybackClock;
  /**
   * Swaps one agent's artist and repaints the frame currently on screen.
   *
   * Repainting matters: without it a sprite pack that decoded between two
   * animation frames would appear on the *next* frame, which during a paused
   * or finished playback is never.
   */
  readonly setArtist: (agentIndex: 0 | 1, artist: FighterArtist) => void;
  readonly setBackdrop: (backdrop: Backdrop) => void;
  readonly repaint: () => void;
  /** The Decision Point currently on screen. `0` before the first frame is drawn. */
  readonly decisionPoint: () => number;
}

export interface MountedApp extends MountedPlayer {
  readonly reasoning: ReasoningSource;
  /** Repaints the frame and re-renders whichever reasoning panel is open. */
  readonly refresh: () => void;
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
 * Mounts the player onto a canvas and returns the film, its clock, and the
 * handles that let its dressing be replaced while it plays.
 *
 * The clock is handed `requestAnimationFrame` wrapped so its callback takes no
 * arguments: the timestamp the browser supplies is unreachable by
 * construction, which is how INV-3 is kept here rather than merely intended.
 */
export function mountPlayer(
  canvas: CanvasSurface,
  log: unknown,
  view: HostView,
  /** Called after every paint, so a panel showing per-Decision-Point data can follow playback. */
  onPaint?: (frameIndex: number) => void,
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

  // Closure state rather than a module-level binding (banned by
  // `source-discipline.test.ts`) and rather than parameters, because these
  // arrive after mount by design. `artists` is sparse until each pack decodes;
  // `drawFrame` falls back to the block artist for any index still empty.
  const dressing: {
    artists: (FighterArtist | undefined)[];
    backdrop: Backdrop | undefined;
    frameIndex: number;
  } = { artists: [], backdrop: undefined, frameIndex: 0 };
  const blockArtist = createBlockArtist();

  const paint = (index: number): void => {
    dressing.frameIndex = index;
    drawFrame(ctx, film.frames[index], {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport,
      // Padded rather than filtered. `drawFrame` falls back from a missing
      // index to index 0, so handing it `[undefined, packTwo]` would dress
      // *both* fighters in pack two -- the one thing the two packs exist to
      // prevent. Each slot is therefore filled explicitly, with the block
      // artist standing in for whichever pack has not decoded yet.
      artists:
        dressing.artists[0] === undefined && dressing.artists[1] === undefined
          ? undefined
          : [dressing.artists[0] ?? blockArtist, dressing.artists[1] ?? blockArtist],
      backdrop: dressing.backdrop,
    });
    onPaint?.(index);
  };

  const clock = createPlaybackClock({
    frameCount: film.frames.length,
    requestFrame: (callback) => view.requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => view.cancelAnimationFrame(handle),
    reducedMotion: prefersReducedMotion(view),
    onFrame: paint,
  });

  const repaint = (): void => {
    if (film.frames.length > 0) {
      paint(Math.min(Math.max(dressing.frameIndex, 0), film.frames.length - 1));
    }
  };

  // Paint frame zero up front, so the stage is never blank while the first
  // animation frame is pending. This is the frame that has to arrive inside the
  // 2-second budget, and it costs no network at all.
  repaint();

  return Object.freeze({
    film,
    clock,
    setArtist: (agentIndex: 0 | 1, artist: FighterArtist): void => {
      dressing.artists[agentIndex] = artist;
      repaint();
    },
    setBackdrop: (backdrop: Backdrop): void => {
      dressing.backdrop = backdrop;
      repaint();
    },
    repaint,
    decisionPoint: (): number => film.frames[dressing.frameIndex]?.decisionPoint ?? 0,
  });
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
 * What the reasoning panel says, as a pure function of one lookup.
 *
 * Story 4.2's AC4 lives here: a sidecar still in flight produces a *loading*
 * body, distinct both from "this Agent recorded no reasoning" and from "the
 * reasoning could not be fetched". Collapsing those three is how a slow network
 * gets reported to a viewer as a silent model.
 *
 * **The loading copy is a constant.** No elapsed value, no estimate, no
 * "taking longer than usual" -- INV-3 forbids the UI from hinting at how long
 * anything took, and a loading affordance is the obvious place to leak it.
 *
 * Story 4.3 owns the full panel: Reflex Mode and Parse Failure presentation,
 * touch, and screen-reader exposure. What is here is the source-state half,
 * which is what 4.2's AC4 asks for.
 */
export function reasoningPanel(
  lookup: ReasoningLookup,
  agentId: string,
): { readonly heading: string; readonly body: string; readonly modifier: string } {
  if (lookup.status === 'loading') {
    return {
      heading: agentId,
      body: 'Fetching reasoning…',
      modifier: 'tb-reasoning--loading',
    };
  }
  if (lookup.status === 'unavailable') {
    return {
      heading: agentId,
      body: 'Reasoning unavailable for this Match.',
      modifier: 'tb-reasoning--absent',
    };
  }
  if (!lookup.found) {
    return {
      heading: agentId,
      body: 'This Agent was not polled at this Decision Point.',
      modifier: 'tb-reasoning--absent',
    };
  }
  if (lookup.reasoning === null || lookup.reasoning.length === 0) {
    return {
      heading: agentId,
      body: 'No reasoning recorded for this Decision Point.',
      modifier: 'tb-reasoning--absent',
    };
  }
  return { heading: agentId, body: lookup.reasoning, modifier: 'tb-reasoning--text' };
}

/** Escapes text that came out of a log before it goes into `innerHTML`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wires the page. Kept a thin, obviously-correct sequence of DOM writes, with
 * every decision it displays computed by a pure function above.
 */
export function renderApp(root: MountPoint, log: CommandLog, view: HostView): MountedApp {
  root.innerHTML = `
    <header class="tb-masthead">
      <h1 class="tb-wordmark">Tokenbrawl</h1>
      <p class="tb-tagline">Replay &mdash; re-simulated, never recorded</p>
    </header>
    <div class="tb-arena">
      <div class="tb-stage">
        <canvas class="tb-canvas"></canvas>
        <button class="tb-fighter-target tb-fighter-target--p1" type="button" data-agent="0">
          <span class="tb-visually-hidden">Reasoning for ${escapeHtml(log.agents[0].id)}</span>
        </button>
        <button class="tb-fighter-target tb-fighter-target--p2" type="button" data-agent="1">
          <span class="tb-visually-hidden">Reasoning for ${escapeHtml(log.agents[1].id)}</span>
        </button>
      </div>
      <div class="tb-reasoning" data-reasoning></div>
    </div>
    <div class="tb-readout" data-readout></div>
    <button class="tb-button" type="button" data-play>Replay</button>
  `;

  const canvas = root.querySelector('canvas');
  const readout = root.querySelector('[data-readout]');
  const panel = root.querySelector('[data-reasoning]');
  const play = root.querySelector('[data-play]');
  const targets = [root.querySelector('[data-agent="0"]'), root.querySelector('[data-agent="1"]')];
  if (canvas === null || readout === null || panel === null || play === null) {
    throw new Error('renderApp: the shell did not mount.');
  }

  const reasoning = createReasoningSource(log);
  // Re-bound after the guard above so the hoisted `renderPanel` sees a
  // non-nullable node: TypeScript will not carry a narrowing into a function
  // declaration, which may legally be called before the narrowing runs.
  const panelNode = panel;

  // Which fighter the pointer or focus last landed on, and what the panel last
  // showed. `null` means nothing is selected and the panel shows its resting
  // prompt. `renderedKey` exists so following playback costs one comparison per
  // frame instead of an `innerHTML` write per frame.
  const selection: { agentIndex: 0 | 1 | null; renderedKey: string } = {
    agentIndex: null,
    renderedKey: '',
  };

  function renderPanel(): void {
    if (selection.agentIndex === null) {
      if (selection.renderedKey !== 'idle') {
        selection.renderedKey = 'idle';
        panelNode.innerHTML =
          '<p class="tb-reasoning-body tb-reasoning--idle">Hover a fighter to read what it was thinking.</p>';
      }
      return;
    }
    const agentIndex = selection.agentIndex;
    // The Decision Point on screen right now, mapped to the tick the log keys
    // its decisions by. Story 4.3 pins the exactness of this correspondence;
    // 4.2 needs it only to have something real to display.
    const tick = mounted.decisionPoint() * DEFAULT_FIGHTER_CONFIG.ticksPerDecision;
    const lookup = reasoning.at(tick, agentIndex);
    const key = `${String(agentIndex)}:${String(tick)}:${lookup.status}`;
    if (key === selection.renderedKey) {
      return;
    }
    selection.renderedKey = key;

    const panelView = reasoningPanel(lookup, log.agents[agentIndex].id);
    panelNode.innerHTML = `
      <p class="tb-reasoning-heading">${escapeHtml(panelView.heading)}</p>
      <p class="tb-reasoning-body ${panelView.modifier}">${escapeHtml(panelView.body)}</p>
    `;
  }

  const mounted = mountPlayer(canvas as unknown as CanvasSurface, log, view, () => {
    if (selection.agentIndex !== null) {
      renderPanel();
    }
  });
  const chip = hashChip(mounted.film);

  readout.innerHTML = `
    <span class="tb-chip ${chip.modifier}">${chip.label}</span>
    <span class="tb-chip">${String(decisionPointCount(mounted.film))} decision points</span>
    <span class="tb-chip">${mounted.film.result.outcome.toUpperCase()} &middot; ${mounted.film.result.endReason.toUpperCase()}</span>
    <span class="tb-chip tb-hash">${mounted.film.finalStateHash}</span>
  `;

  for (const agentIndex of [0, 1] as const) {
    const target = targets[agentIndex];
    if (target === null) {
      continue;
    }
    const select = (): void => {
      selection.agentIndex = agentIndex;
      renderPanel();
    };
    target.addEventListener('pointerenter', select);
    target.addEventListener('focus', select);
    target.addEventListener('click', select);
  }

  renderPanel();

  play.addEventListener('click', () => {
    mounted.clock.stop();
    mounted.clock.start();
  });
  mounted.clock.start();

  return Object.freeze({
    ...mounted,
    reasoning,
    refresh: (): void => {
      mounted.repaint();
      renderPanel();
    },
  });
}
