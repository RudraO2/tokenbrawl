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
      on a touch screen. No key, no signup, no server -- and this Match is never rated.
    </p>
    <button class="tb-button tb-arcade-play" type="button" data-arcade-play>Play vs CPU</button>
    <div class="tb-arcade-keys" data-arcade-keys tabindex="0">${onScreenButtonsMarkup()}</div>
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

  if (playButton === null || keysHost === null || status === null) {
    throw new Error('mountArcadePanel: the panel did not mount.');
  }

  const playNode = playButton;
  const keysNode = keysHost;
  const statusNode = status;
  const runMatch = deps.run ?? runArcadeMatch;
  const humanSide = deps.humanSide ?? 0;
  const seed = deps.seed ?? DEFAULT_SEED;

  const panelState: { value: ArcadeState; handle: ArcadeMatchHandle | null } = {
    value: 'idle',
    handle: null,
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

  /** Recovers the panel from any failure on the match-running path (P1): re-enables Play, never leaves "Fighting..." stuck. */
  const fail = (error: unknown): void => {
    panelState.handle = null;
    playNode.disabled = false;
    say('error', `Could not run the Match: ${String(error instanceof Error ? error.message : error)}`);
  };

  const play = (): void => {
    if (panelState.value === 'running') {
      return;
    }
    playNode.disabled = true;
    say('running', 'Fighting. Arrow keys or Z/X/C, or the buttons below.');

    try {
      const handle = runMatch({ seed, humanSide, mapInput });
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
    panelState.handle.feedInput(event.key);
  });

  for (const { action } of ON_SCREEN_ACTIONS) {
    const button = host.querySelector(`[data-arcade-action="${action}"]`);
    button?.addEventListener('click', () => {
      panelState.handle?.feedInput(action);
    });
  }

  playNode.addEventListener('click', () => {
    play();
  });

  say('idle', 'Fight a Baseline Bot. No key, no signup.');

  return Object.freeze({ play, state: (): ArcadeState => panelState.value });
}
