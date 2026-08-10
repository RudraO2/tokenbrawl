import type { Action, CommandLogV2 } from '@tokenbrawl/contracts';
import { escapeHtml, prefersReducedMotion, type CanvasSurface, type HostView } from '../main';
import type { FighterArtist } from '../render/artist';
import type { Backdrop } from '../render/backdrop';
import type { RosterPair } from '../render/roster';
import type { UltSheet } from '../render/ult-sheet';
import type { VfxSheet } from '../render/vfx-sheet';
import { createLiveArena, type LiveArena } from './live';
import { defaultKeyMap, runArcadeMatch, type ArcadeMatchHandle, type ArcadeRunConfig } from './run';

/**
 * Story 9.2: the Play-vs-CPU panel.
 *
 * A close mirror of `byok/panel.ts`'s shape and reasoning: it owns its own
 * host (`#arcade`, beside `#byok`) rather than joining `renderApp`'s, for the
 * same structural reason -- a completed arcade Match re-mounts the player
 * through the same call BYOK's completion does, and a panel living inside
 * `#app` would delete itself the moment it succeeded.
 *
 * Every DOM type here is structural, per house convention (`tsconfig.base.json`
 * has no DOM lib -- see `byok/panel.ts`'s docblock for why that must hold).
 *
 * ## Where the clamp actually lives
 *
 * This file captures raw `keydown`/tap input and hands the *raw* string
 * straight to `run.ts`'s `feedInput` -- it does not map or check legality
 * itself. `createHumanAgent` (in `arcade/agent.ts`) is the one and only place
 * an input becomes an `Action` or is dropped (AD-14): this panel is a source
 * of raw input, nothing more, which is what keeps the clamp at one boundary
 * rather than scattered across the DOM-touching layer and the Agent layer.
 *
 * ## Story 10.6: telling the player, without deciding for them
 *
 * That clamp is still the only clamp. What this file gained is the ability to
 * *narrate* it, and the distinction is worth being exact about, because getting
 * it wrong would put a second copy of the legality rule in the UI layer:
 *
 * - The Agent still decides. Every press is forwarded to `feedInput`
 *   unconditionally, including an Ultimate that cannot come out, and
 *   `createHumanAgent` drops it exactly as before.
 * - The panel only *reports the state the player is in*, from the
 *   `legalActions` the environment published for the frame it published them
 *   for. It never predicts what a press will do; it says what is currently
 *   true.
 *
 * This exists because an Arcade Match runs headlessly. Story 10.3's Super Gauge
 * is drawn on the canvas, and the canvas is not on screen until the Match has
 * already finished -- so during play the panel is the *only* surface that can
 * tell a player their bar is full. Story 10.4's visual check measured peak
 * gauge fills of 62%, 55%, 1% and 1% across four hand-played Matches, i.e. a
 * player can easily go a whole Match never knowing how close they came.
 *
 * ## Story 12.2: the fight is now on screen while it is played
 *
 * The premise the paragraph above rests on -- "the canvas is not on screen until
 * the Match has already finished" -- is no longer true. This panel now mounts a
 * live canvas under `#arcade` (`arcade/live.ts`) that draws each `FighterState`
 * as `run.ts` produces it, through the same `drawJuicedFrame` the replay player
 * uses. The Super Gauge, the fighters and every hit are on screen *during* play.
 *
 * The affordance text below is kept exactly as it was rather than removed: it is
 * `aria-live`, so it announces "Ultimate ready" to a screen reader that cannot
 * see the gauge light up, and it is the fallback on a page with no
 * `requestAnimationFrame` where the live canvas never mounts. It narrates a
 * state the canvas now also shows, which is additive, not redundant.
 *
 * When the Match ends the live canvas is torn down and the replay re-mounts on
 * `#app` exactly as before -- the two are never on screen at once.
 */

export type ArcadeEvent = 'click' | 'keydown';

export interface ArcadeKeyEvent {
  readonly key?: string;
}

export interface ArcadeNode {
  innerHTML: string;
  disabled?: boolean;
  setAttribute?(name: string, value: string): void;
  addEventListener(type: ArcadeEvent, listener: (event?: ArcadeKeyEvent) => void): void;
  /** Optional/structural, matching this file's non-`lib.dom` convention (P3). */
  focus?(): void;
}

/**
 * The live-view canvas node (Story 12.2). Structural, matching this file's
 * non-`lib.dom` convention: the fields `createLiveArena` needs of a canvas and
 * nothing more, so a test can drive the live view with a recording fake and no
 * real DOM -- exactly as `spectate/panel.ts` declares `SpectateCanvasNode`.
 */
export interface ArcadeCanvasNode {
  width: number;
  height: number;
  getContext(id: '2d'): ReturnType<CanvasSurface['getContext']>;
}

export interface ArcadeHost {
  innerHTML: string;
  querySelector(selectors: string): ArcadeNode | null;
}

export type ArcadeState = 'idle' | 'running' | 'done' | 'error';

export interface ArcadePanelDeps {
  /** Handed the log of a completed Match. `startup.ts` re-mounts the player with it. */
  readonly onLog: (log: CommandLogV2) => void;
  /** Injectable so a test drives a whole Match with no real timers. */
  readonly run?: (config: ArcadeRunConfig) => ArcadeMatchHandle;
  /** Which side the visitor plays. Defaults to side 0. */
  readonly humanSide?: 0 | 1;
  /** Same seed default philosophy as BYOK: a constant, not a random draw. */
  readonly seed?: number;
  /**
   * Story 12.2. The page's view, for the live arena's animation-frame clock.
   *
   * Optional: absent on a page or a test with no `requestAnimationFrame`, in
   * which case the panel keeps its pre-12.2 behaviour exactly -- the Match runs
   * and the replay re-mounts afterwards -- with no live canvas. That is the same
   * warn-not-throw degrade every asset on this page takes.
   */
  readonly view?: HostView;
}

export interface ArcadePanel {
  /** Starts a Match the same way clicking "Play vs CPU" does. */
  readonly play: () => void;
  readonly state: () => ArcadeState;
  /**
   * Story 12.2. Dresses the live arena, on exactly the terms
   * `SpectatePanel.setArtist` dresses that surface: the sprite packs and
   * scenery belong to the *page* (`startup.ts` decodes them once), and this is
   * how they reach the `#arcade` canvas rather than being left to draw blocks.
   * A no-op on a panel with no live arena (no `view`, or no canvas).
   */
  readonly setArtist: (agentIndex: 0 | 1, artist: FighterArtist) => void;
  readonly setBackdrop: (backdrop: Backdrop) => void;
  /** Story 12.2. The impact FX sheet, on the same terms as `setArtist`. */
  readonly setVfx: (vfx: VfxSheet) => void;
  /** Story 12.2. The Ultimate's per-character art, on the same terms as `setArtist`. */
  readonly setUlt: (ult: UltSheet) => void;
  /**
   * Story 12.5. Which fighters this Match is drawn as. Forwarded to the live
   * arena on exactly `setUlt`'s terms, and a no-op without one -- the Match
   * itself has no notion of a character, so a panel with no live view loses
   * nothing but the picture.
   */
  readonly setRoster: (roster: RosterPair) => void;
  /**
   * Story 12.4. Suspends the live view while this screen is not showing, and
   * resumes it when it is. The Match itself is untouched: states keep arriving
   * and the film keeps building -- only the painting stops. A no-op on a panel
   * with no live arena.
   */
  readonly setPaused: (paused: boolean) => void;
}

/** Not the BYOK panel's seed, so the two demos are visibly different Matches. */
const DEFAULT_SEED = 9_201;

/**
 * The Action the Ultimate is thrown as, and the key Story 10.6 binds to it.
 *
 * Named here rather than written as `'special'` at three call sites: the panel
 * has to recognise "the player just asked for the Ultimate" in the keydown
 * handler, in the on-screen button handler, and when deciding whether the
 * affordance is showing, and three loose literals is how those three drift.
 */
const ULTIMATE_ACTION: Action = 'special';
const ULTIMATE_KEY = 'L';

/** Shown while the gauge is full. Empty at every other moment -- an affordance that is always on is decoration. */
const ULTIMATE_READY = `Ultimate ready -- press ${ULTIMATE_KEY}`;

/**
 * Said when the Ultimate is asked for and the bar is not full.
 *
 * AC2's whole point: a silent no-op is indistinguishable from a broken key, and
 * this is the same failure Story 9.3's picker guard exists to prevent. The
 * press is still forwarded and still dropped by the Agent -- this sentence is
 * the panel explaining the drop, not preventing it.
 */
const ULTIMATE_NOT_READY = 'Ultimate not ready -- the Super Gauge is not full yet. Land hits to charge it.';

const ON_SCREEN_ACTIONS: readonly { readonly action: Action; readonly label: string }[] = [
  { action: 'advance', label: 'Advance' },
  { action: 'retreat', label: 'Retreat' },
  { action: 'attack', label: 'Attack' },
  { action: 'block', label: 'Block' },
  { action: 'special', label: 'Special' },
];

function onScreenButtonsMarkup(): string {
  return ON_SCREEN_ACTIONS.map(
    ({ action, label }) =>
      `<button class="tb-button tb-arcade-key" type="button" data-arcade-action="${escapeHtml(action)}">${escapeHtml(label)}</button>`,
  ).join('');
}

/**
 * The panel's markup. Exported so the shell can be asserted without a DOM, in
 * the same spirit as `byokMarkup`.
 */
export function arcadeMarkup(): string {
  return `
    <h2 class="tb-arcade-heading">Play vs CPU</h2>
    <p class="tb-arcade-intro">
      Fight a Baseline Bot yourself, right here in the tab. Arrow keys or Z/X/C, or the buttons below
      on a touch screen. ${escapeHtml(ULTIMATE_KEY)} throws the Ultimate once the Super Gauge is full.
      No key, no signup, no server -- and this Match is never rated.
    </p>
    <button class="tb-button tb-arcade-play" type="button" data-arcade-play>Play vs CPU</button>
    <div class="tb-arcade-stage" data-arcade-stage>
      <canvas class="tb-arcade-canvas"></canvas>
    </div>
    <div class="tb-arcade-keys" data-arcade-keys tabindex="0">${onScreenButtonsMarkup()}</div>
    <p class="tb-arcade-ultimate" data-arcade-ultimate role="status" aria-live="polite"></p>
    <p class="tb-arcade-status" data-arcade-status role="status" aria-live="polite"></p>
  `;
}

/**
 * Mounts the panel and wires it.
 *
 * `data-arcade-keys` is the one element `keydown` is bound to: a focusable
 * div rather than the whole document, so a keystroke intended for the seed
 * field on the BYOK panel (or anywhere else on the page) is never read as
 * arcade input. The on-screen buttons beside it feed the identical raw value
 * a keyboard would (the Action name itself), so touch and keyboard share
 * exactly one mapping function (`defaultKeyMap`, extended to recognise its
 * own Action names as well as key codes) at exactly one boundary.
 */
export function mountArcadePanel(host: ArcadeHost, deps: ArcadePanelDeps): ArcadePanel {
  host.innerHTML = arcadeMarkup();

  const playButton = host.querySelector('[data-arcade-play]');
  const keysHost = host.querySelector('[data-arcade-keys]');
  const status = host.querySelector('[data-arcade-status]');
  const ultimate = host.querySelector('[data-arcade-ultimate]');

  if (playButton === null || keysHost === null || status === null || ultimate === null) {
    throw new Error('mountArcadePanel: the panel did not mount.');
  }

  const playNode = playButton;
  const keysNode = keysHost;
  const statusNode = status;
  const ultimateNode = ultimate;
  const runMatch = deps.run ?? runArcadeMatch;
  const humanSide = deps.humanSide ?? 0;
  const seed = deps.seed ?? DEFAULT_SEED;

  /**
   * The live arena, or `null` when this environment cannot mount one (Story
   * 12.2).
   *
   * Built once, here, over the persistent `#arcade` canvas: it holds the page's
   * dressing across Matches (each Play resets only the states, never the sprite
   * packs) exactly as the replay player's dressing outlives a re-mount. `null`
   * when there is no `view` to drive an animation-frame clock, or no canvas with
   * a 2D context -- both the shapes a test with no DOM has -- and in that case
   * the panel behaves exactly as it did before this story: the Match runs and
   * the replay re-mounts afterwards, with no live view. Warn-not-throw is the
   * same degrade every asset on this page takes.
   */
  const stageNode = host.querySelector('[data-arcade-stage]');
  const canvasNode = host.querySelector('canvas');
  const liveArena: LiveArena | null = ((): LiveArena | null => {
    if (deps.view === undefined || canvasNode === null) {
      return null;
    }
    const asCanvas = canvasNode as unknown as ArcadeCanvasNode;
    if (typeof asCanvas.getContext !== 'function') {
      return null;
    }
    try {
      return createLiveArena({
        canvas: asCanvas as unknown as CanvasSurface,
        view: deps.view,
        reducedMotion: prefersReducedMotion(deps.view),
      });
    } catch {
      // A browser that gave no 2D context. The Match still runs headlessly and
      // the replay still re-mounts; only the live view is lost.
      return null;
    }
  })();

  /** Shows or hides the live canvas. Hidden when idle so it never sits blank beside the panel. */
  const showStage = (live: boolean): void => {
    stageNode?.setAttribute?.('class', live ? 'tb-arcade-stage tb-arcade-stage--live' : 'tb-arcade-stage');
  };

  const panelState: {
    value: ArcadeState;
    handle: ArcadeMatchHandle | null;
    /** Whether the environment last reported the Ultimate as legal, i.e. the gauge full. */
    armed: boolean;
  } = {
    value: 'idle',
    handle: null,
    armed: false,
  };

  const say = (state: ArcadeState, message: string): void => {
    panelState.value = state;
    statusNode.innerHTML = escapeHtml(message);
    statusNode.setAttribute?.('class', `tb-arcade-status tb-arcade-status--${state}`);
  };

  /** Maps a raw keyboard code or a button's own Action name to an Action. */
  const mapInput = (raw: string): Action | null => {
    const asAction = ON_SCREEN_ACTIONS.find((entry) => entry.action === raw);
    if (asAction !== undefined) {
      return asAction.action;
    }
    return defaultKeyMap(raw);
  };

  /**
   * Shows or clears the affordance (AC3).
   *
   * Written on every Decision Point rather than only on the transition: the
   * node's content is a function of the current armed state, so a repeat write
   * of the same string is a no-op the browser coalesces, and there is no
   * "did I already show this" flag to get out of step with the Match.
   */
  const setArmed = (armed: boolean): void => {
    panelState.armed = armed;
    ultimateNode.innerHTML = armed ? escapeHtml(ULTIMATE_READY) : '';
    ultimateNode.setAttribute?.(
      'class',
      armed ? 'tb-arcade-ultimate tb-arcade-ultimate--ready' : 'tb-arcade-ultimate',
    );
  };

  /**
   * Forwards one raw input, and narrates it when it was a request for the
   * Ultimate.
   *
   * The forward is unconditional. `createHumanAgent` decides; this only speaks
   * (AC2). Keyboard and the on-screen button both come through here, so touch
   * and keys get the identical explanation rather than one of them getting
   * silence.
   */
  const feed = (raw: string): void => {
    if (panelState.handle === null) {
      return;
    }
    const asksForUltimate = mapInput(raw) === ULTIMATE_ACTION;
    panelState.handle.feedInput(raw);
    if (asksForUltimate && !panelState.armed) {
      say('running', ULTIMATE_NOT_READY);
    }
  };

  /** Recovers the panel from any failure on the match-running path (P1): re-enables Play, never leaves "Fighting..." stuck. */
  const fail = (error: unknown): void => {
    panelState.handle = null;
    playNode.disabled = false;
    setArmed(false);
    // The live view stops with the Match: a stalled fight left drawing on screen
    // would be as misleading as a stuck "Fighting...".
    liveArena?.stop();
    showStage(false);
    say('error', `Could not run the Match: ${String(error instanceof Error ? error.message : error)}`);
  };

  const play = (): void => {
    if (panelState.value === 'running') {
      return;
    }
    playNode.disabled = true;
    // Cleared before the Match starts, not after the last one ended: a panel
    // that opened a new fight still showing the previous one's "Ultimate ready"
    // would be telling the player something about a Match that no longer exists.
    setArmed(false);
    say('running', `Fighting. Arrow keys or Z/X/C, ${ULTIMATE_KEY} for the Ultimate, or the buttons below.`);

    // Arm the live view and reveal its canvas before the Match starts, so the
    // reset state (reported synchronously the instant `runMatch` reaches
    // `env.reset`) has a canvas to land on and the first frame is drawn without
    // waiting for the visitor's first key.
    liveArena?.begin();
    showStage(liveArena !== null);

    try {
      const handle = runMatch({
        seed,
        humanSide,
        mapInput,
        onLegalActions: (legalActions) => {
          setArmed(legalActions.includes(ULTIMATE_ACTION));
        },
        // Story 12.2. Every state the Match passes through, drawn as it is
        // produced. A no-op when there is no live arena.
        onState: (state) => {
          liveArena?.pushState(state);
        },
      });
      panelState.handle = handle;
      // Right when the Match starts, so keyboard input is captured without
      // requiring a visitor to click into the key-capture div first (P3).
      keysNode.focus?.();

      handle.log
        .then((log) => {
          // Only announced/handed off once the Match has actually resolved
          // successfully (P1): a rejection below is routed to `fail`, never here.
          panelState.handle = null;
          playNode.disabled = false;
          // The Match is over, so there is no gauge to be full any more.
          setArmed(false);
          // The live view gives way to the replay rather than both being on
          // screen at once: stop the live clock and hide its canvas here, before
          // `onLog` re-mounts the replay player on `#app`.
          liveArena?.stop();
          showStage(false);
          say('done', 'Done. Your Match is playing above. It is excluded from every rating.');
          deps.onLog(log);
        })
        .catch(fail);
    } catch (error) {
      // A synchronous throw from starting the match (e.g. `assertSeed`).
      fail(error);
    }
  };

  keysNode.addEventListener('keydown', (event) => {
    if (panelState.handle === null || event?.key === undefined) {
      return;
    }
    feed(event.key);
  });

  for (const { action } of ON_SCREEN_ACTIONS) {
    const button = host.querySelector(`[data-arcade-action="${action}"]`);
    button?.addEventListener('click', () => {
      feed(action);
    });
  }

  playNode.addEventListener('click', () => {
    play();
  });

  setArmed(false);
  showStage(false);
  say('idle', 'Fight a Baseline Bot. No key, no signup.');

  return Object.freeze({
    play,
    state: (): ArcadeState => panelState.value,
    // Story 12.2. Forwarded to the live arena, which holds the dressing across
    // Matches. A no-op when there is no live arena (no `view`, or no canvas).
    setArtist: (agentIndex: 0 | 1, artist: FighterArtist): void => {
      liveArena?.setArtist(agentIndex, artist);
    },
    setBackdrop: (backdrop: Backdrop): void => {
      liveArena?.setBackdrop(backdrop);
    },
    setVfx: (vfx: VfxSheet): void => {
      liveArena?.setVfx(vfx);
    },
    setUlt: (ult: UltSheet): void => {
      liveArena?.setUlt(ult);
    },
    setRoster: (roster: RosterPair): void => {
      liveArena?.setRoster(roster);
    },
    // Story 12.4. The router calls this when the play screen stops or starts
    // showing. A no-op when there is no live arena, exactly like the dressing
    // setters above.
    setPaused: (paused: boolean): void => {
      liveArena?.setPaused(paused);
    },
  });
}
