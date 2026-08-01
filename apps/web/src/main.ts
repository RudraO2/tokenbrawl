import type { CommandLog } from '@tokenbrawl/contracts';
import { DEFAULT_FIGHTER_CONFIG } from '../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import { createPlaybackClock, type PlaybackClock } from './player/clock';
import { buildReplayFilm, type ReplayFilm } from './replay/film';
import { resolveDecision, type ResolvedDecision } from './replay/decision-point';
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

/**
 * The events the shell binds, and the one property of one of them it reads.
 *
 * `pointerType` is load-bearing rather than incidental. On a touch device
 * `pointerleave` fires on lift, so treating it as "the visitor looked away"
 * would make a tap show the panel and hide it in the same gesture -- AC4 asks
 * for the opposite. A mouse leave really is looking away, so the two are told
 * apart by the only thing that distinguishes them.
 */
export interface PointerLike {
  readonly pointerType?: string;
}

export type ShellEvent = 'click' | 'pointerenter' | 'pointerleave' | 'focus' | 'blur';

export interface MountPointChild {
  innerHTML: string;
  addEventListener(type: ShellEvent, listener: (event?: PointerLike) => void): void;
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

export interface PanelChip {
  readonly label: string;
  readonly modifier: string;
}

export interface ReasoningView {
  readonly heading: string;
  /** `TICK 120`, or empty when this Agent has not acted yet. */
  readonly tickLabel: string;
  readonly chips: readonly PanelChip[];
  readonly body: string;
  readonly bodyModifier: string;
  /** Verbatim provider response. Shown whenever there is one, required when the call was a Parse Failure. */
  readonly rawResponse: string | null;
  /** The whole panel as one string, for the screen-reader announcement. */
  readonly announcement: string;
}

/**
 * What the reasoning panel says, as a pure function of one lookup and one
 * resolved Decision Point.
 *
 * The three states this separates are three different facts about a Deployment
 * and the story asks for all three by name:
 *
 * - **Reflex Mode (AC2)** -- the Token Bank was depleted and the call was
 *   served at `max_tokens=8`. There is no reasoning because there was no budget
 *   for any, and a blank panel would read as a model with nothing to say. It is
 *   the Bank that ran out, and the panel says which.
 * - **Parse Failure (AC3)** -- no valid Action could be extracted and the
 *   Fallback Action was applied. The raw response is shown verbatim, because
 *   Story 1.6's discipline is that a failure is published and auditable rather
 *   than retried away, and a failure a visitor cannot read is not published.
 * - **Nothing recorded** -- a Baseline Bot, or a provider that returned no
 *   text. Ordinary, and neither of the above.
 *
 * `resolved.polled === false` is the fourth state and it is the one AC1 turns
 * on: this fighter was inside a Commitment Window and was never asked. What it
 * is doing was decided earlier, and the panel names that Decision Point rather
 * than either blanking or -- worse -- showing whichever entry happens to be
 * nearest. See `replay/decision-point.ts`.
 *
 * **Nothing here reads or implies a duration** (INV-3). Ticks are simulation
 * time: identical for a Match between two slow Deployments and one between two
 * fast ones. The loading copy is a constant string with no estimate in it.
 */
export function reasoningView(
  lookup: ReasoningLookup,
  resolved: ResolvedDecision | null,
  agentId: string,
): ReasoningView {
  const chips: PanelChip[] = [];
  const tickLabel = resolved === null ? '' : `Tick ${String(resolved.tick)}`;

  if (resolved !== null && !resolved.polled) {
    chips.push({ label: 'Still committed', modifier: 'tb-chip--committed' });
  }
  if (lookup.reflexMode) {
    chips.push({ label: 'Reflex mode', modifier: 'tb-chip--reflex' });
  }
  if (lookup.parseFailure) {
    chips.push({ label: 'Parse failure', modifier: 'tb-chip--failed' });
  }

  const view = (body: string, bodyModifier: string, rawResponse: string | null): ReasoningView =>
    Object.freeze({
      heading: agentId,
      tickLabel,
      chips: Object.freeze(chips),
      body,
      bodyModifier,
      rawResponse,
      announcement: [agentId, tickLabel, ...chips.map((chip) => chip.label), body, rawResponse ?? '']
        .filter((part) => part.length > 0)
        .join('. '),
    });

  if (resolved === null) {
    return view('This fighter has not acted yet.', 'tb-reasoning--absent', null);
  }
  if (lookup.status === 'loading') {
    // 4.2's AC4, kept: a sidecar in flight is not a model that said nothing.
    return view('Fetching reasoning…', 'tb-reasoning--loading', null);
  }
  if (lookup.status === 'unavailable') {
    return view('Reasoning unavailable for this Match.', 'tb-reasoning--absent', null);
  }
  if (!lookup.found) {
    // The resolver returned a tick, so the log should carry that entry. Reaching
    // here means the sidecar and the log disagree about which Decision Points
    // exist, which is worth saying plainly rather than rendering an empty box.
    return view('No record for this Decision Point.', 'tb-reasoning--absent', null);
  }

  if (lookup.parseFailure) {
    return view(
      'No valid Action could be read from this response, so the Fallback Action was applied. It was not retried.',
      'tb-reasoning--warn',
      lookup.rawResponse,
    );
  }
  if (lookup.reasoning !== null && lookup.reasoning.length > 0) {
    return view(lookup.reasoning, 'tb-reasoning--text', lookup.rawResponse);
  }
  if (lookup.reflexMode) {
    return view(
      'Served in Reflex Mode: this Deployment had spent its Token Bank, so the call was capped at eight tokens. There was no budget to reason with.',
      'tb-reasoning--absent',
      lookup.rawResponse,
    );
  }
  return view('No reasoning recorded for this Decision Point.', 'tb-reasoning--absent', lookup.rawResponse);
}

/**
 * Escapes text that came out of a log before it goes into `innerHTML`.
 *
 * Every string this page displays that it did not author itself passes through
 * here: agent ids, reasoning text, and the messages in `startup.ts`'s failure
 * card -- `assertSchemaVersion` interpolates the fetched document's own
 * `schemaVersion` into its error, so that path is attacker-reachable the moment
 * Story 4.6 lets a visitor choose the log.
 */
export function escapeHtml(value: string): string {
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
  // The panel carries `role="status"` and `aria-live="polite"`, so a screen
  // reader announces it when it changes. That is only safe because hovering or
  // focusing a fighter pauses playback: an unpaused panel changes five times a
  // second, and a live region firing five times a second is worse for a
  // screen-reader user than no announcement at all. Each target points at the
  // panel with `aria-describedby`, so the reasoning is reachable from the
  // control that reveals it (AC5).
  root.innerHTML = `
    <header class="tb-masthead">
      <h1 class="tb-wordmark">Tokenbrawl</h1>
      <p class="tb-tagline">Replay &mdash; re-simulated, never recorded</p>
    </header>
    <div class="tb-arena">
      <div class="tb-stage">
        <canvas class="tb-canvas"></canvas>
        <button
          class="tb-fighter-target tb-fighter-target--p1"
          type="button"
          data-agent="0"
          aria-describedby="tb-reasoning-panel"
        ></button>
        <button
          class="tb-fighter-target tb-fighter-target--p2"
          type="button"
          data-agent="1"
          aria-describedby="tb-reasoning-panel"
        ></button>
      </div>
      <div
        class="tb-reasoning"
        id="tb-reasoning-panel"
        data-reasoning
        role="status"
        aria-live="polite"
      ></div>
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

  // Re-bound after the guard above so the hoisted `renderPanel` sees a
  // non-nullable node: TypeScript will not carry a narrowing into a function
  // declaration, which may legally be called before the narrowing runs.
  const panelNode = panel;

  // Which fighter the pointer or focus last landed on, what the panel last
  // showed, and whether letting go should put playback back. `null` means
  // nothing is selected and the panel shows its resting prompt. `renderedKey`
  // exists so following playback costs one comparison per frame instead of an
  // `innerHTML` write per frame.
  const selection: {
    agentIndex: 0 | 1 | null;
    renderedKey: string;
    resumeOnRelease: boolean;
  } = { agentIndex: null, renderedKey: '', resumeOnRelease: false };

  function renderPanel(): void {
    if (selection.agentIndex === null) {
      if (selection.renderedKey !== 'idle') {
        selection.renderedKey = 'idle';
        panelNode.innerHTML =
          '<p class="tb-reasoning-body tb-reasoning--idle">Hover, tap or tab to a fighter to read what it was thinking. Playback pauses while you read.</p>';
      }
      return;
    }
    const agentIndex = selection.agentIndex;
    // AC1. The Decision Point on screen is exact -- it is the frame's own index
    // -- but a fighter inside a Commitment Window was never polled there, so
    // `resolveDecision` walks back to the decision it is still executing and
    // says which. It never looks forward and never rounds to whichever entry is
    // nearest. See `replay/decision-point.ts`.
    const resolved = resolveDecision(
      mounted.decisionPoint(),
      agentIndex,
      (tick, agent) => reasoning.at(tick, agent).found,
      DEFAULT_FIGHTER_CONFIG.ticksPerDecision,
    );
    const lookup = reasoning.at(resolved?.tick ?? -1, agentIndex);
    const key = `${String(agentIndex)}:${String(resolved?.tick ?? -1)}:${String(resolved?.polled ?? false)}:${lookup.status}`;
    if (key === selection.renderedKey) {
      return;
    }
    selection.renderedKey = key;

    const panelView = reasoningView(lookup, resolved, log.agents[agentIndex].id);
    const chips = panelView.chips
      .map((chip) => `<span class="tb-chip ${chip.modifier}">${escapeHtml(chip.label)}</span>`)
      .join('');
    const raw =
      panelView.rawResponse === null
        ? ''
        : `<p class="tb-reasoning-label">Raw response</p><pre class="tb-reasoning-raw">${escapeHtml(panelView.rawResponse)}</pre>`;

    panelNode.innerHTML = `
      <p class="tb-reasoning-heading">${escapeHtml(panelView.heading)}</p>
      <div class="tb-reasoning-meta">
        ${panelView.tickLabel === '' ? '' : `<span class="tb-chip tb-chip--tick">${escapeHtml(panelView.tickLabel)}</span>`}
        ${chips}
      </div>
      <p class="tb-reasoning-body ${panelView.bodyModifier}">${escapeHtml(panelView.body)}</p>
      ${raw}
    `;
  }

  const mounted = mountPlayer(canvas as unknown as CanvasSurface, log, view, () => {
    if (selection.agentIndex !== null) {
      renderPanel();
    }
  });
  // After `mountPlayer`, never before: this walks `log.decisions`, and
  // `replayCommandLog` (reached through `mountPlayer`) is what establishes that
  // the document is a version this player understands at all (AD-3).
  const reasoning = createReasoningSource(log);
  const chip = hashChip(mounted.film);

  readout.innerHTML = `
    <span class="tb-chip ${chip.modifier}">${chip.label}</span>
    <span class="tb-chip">${String(decisionPointCount(mounted.film))} decision points</span>
    <span class="tb-chip">${mounted.film.result.outcome.toUpperCase()} &middot; ${mounted.film.result.endReason.toUpperCase()}</span>
    <span class="tb-chip tb-hash">${mounted.film.finalStateHash}</span>
  `;

  // The shell above is written with no field from the log in it, and the
  // agent-derived labels are filled in only here -- after `mountPlayer` has
  // routed the document through `replayCommandLog`, which checks the schema
  // version before it reads anything else (AD-3). An earlier draft
  // interpolated `log.agents[0].id` straight into the template, which read an
  // unvalidated field first and turned a clean "unsupported schemaVersion"
  // into an unhelpful TypeError on a malformed document.
  for (const agentIndex of [0, 1] as const) {
    const target = targets[agentIndex];
    if (target === null) {
      continue;
    }
    target.innerHTML = `<span class="tb-visually-hidden">Reasoning for ${escapeHtml(log.agents[agentIndex].id)}</span>`;

    /**
     * Pointer, tap and keyboard all land here (AC4, AC5), and all three pause.
     *
     * Reading is the point of this feature and it is impossible at five
     * Decision Points per second, so the clock stops on the frame that is on
     * screen -- which is also what makes AC1's "at that exact position" a
     * position that holds still long enough to be read.
     */
    const select = (): void => {
      if (selection.agentIndex === null) {
        selection.resumeOnRelease = mounted.clock.isRunning();
      }
      mounted.clock.stop();
      selection.agentIndex = agentIndex;
      renderPanel();
    };

    /**
     * Letting go puts playback back where it was.
     *
     * `pointerType === 'touch'` is excluded deliberately: a touch pointer
     * *leaves* on lift, so honouring it would show the panel and hide it in the
     * same tap. On touch the selection is sticky, which is what AC4 asks for --
     * "when a visitor taps a fighter, then the same reasoning appears", and
     * stays appeared.
     */
    const release = (event?: PointerLike): void => {
      if (event?.pointerType === 'touch') {
        return;
      }
      // Only the target that owns the current selection may end it. Reachable:
      // tab to one fighter, then move the mouse onto the other. The second
      // takes the selection, and the first's `blur` arrives afterwards -- which
      // without this guard closes a panel the visitor is looking at.
      if (selection.agentIndex !== agentIndex) {
        return;
      }
      selection.agentIndex = null;
      renderPanel();
      if (selection.resumeOnRelease) {
        selection.resumeOnRelease = false;
        mounted.clock.resume();
      }
    };

    target.addEventListener('pointerenter', select);
    target.addEventListener('focus', select);
    target.addEventListener('click', select);
    target.addEventListener('pointerleave', release);
    target.addEventListener('blur', release);
  }

  renderPanel();

  play.addEventListener('click', () => {
    // Clears the reading selection too. Without this a visitor who tapped a
    // fighter (touch selections are sticky, by design) and then pressed Replay
    // would watch the fight restart with `resumeOnRelease` still armed, and the
    // next pointer leave would resume a clock that was already running.
    selection.agentIndex = null;
    selection.resumeOnRelease = false;
    renderPanel();
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
