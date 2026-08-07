import type { Action, CommandLogV2 } from '@tokenbrawl/contracts';
import { escapeHtml } from '../main';
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
}

export interface ArcadePanel {
  /** Starts a Match the same way clicking "Play vs CPU" does. */
  readonly play: () => void;
  readonly state: () => ArcadeState;
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

    try {
      const handle = runMatch({
        seed,
        humanSide,
        mapInput,
        onLegalActions: (legalActions) => {
          setArmed(legalActions.includes(ULTIMATE_ACTION));
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
  say('idle', 'Fight a Baseline Bot. No key, no signup.');

  return Object.freeze({ play, state: (): ArcadeState => panelState.value });
}
