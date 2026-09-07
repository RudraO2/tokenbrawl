import { escapeHtml } from '../main';
import {
  CABINET_ROSTER,
  cabinetFullUrl,
  cabinetLaunchUrl,
  isCabinetId,
  type CabinetId,
  type CabinetLaunch,
} from './roster';

/**
 * Play: the arcade cabinet.
 *
 * The fight itself is the reference fighter under `/arena/`, loaded in an
 * iframe and left exactly as it is -- its own loop, its own audio, its own
 * CPU. This panel is the cabinet around that screen: the coin slot, the
 * difficulty and round switches, the controls card, and the bridge that
 * hears what the arena reports (which screen it is on, who won) and tells it
 * the one thing the page decides (whether sound is on).
 *
 * Everything is written so it can be asserted without a DOM: the host is a
 * structural interface, the storage is injected, and every message from the
 * arena arrives through one function the tests can call directly.
 */

export type PlayEvent = 'click' | 'load';

export interface PlayNode {
  innerHTML: string;
  hidden?: boolean;
  disabled?: boolean;
  src?: string;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  addEventListener(type: PlayEvent, listener: () => void): void;
  focus?(): void;
  requestFullscreen?(): Promise<void> | void;
  contentWindow?: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface PlayHost {
  innerHTML: string;
  querySelector(selectors: string): PlayNode | null;
  querySelectorAll?(selectors: string): readonly PlayNode[];
}

export interface PlayStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PlayPanelDeps {
  readonly storage?: PlayStorage;
  /** Whether the page's sound switch is on; asked whenever the arena boots. */
  readonly soundEnabled?: () => boolean;
  /** Called on every click that may unlock audio elsewhere on the page. */
  readonly onGesture?: () => void;
}

export type PlayState = 'attract' | 'booting' | 'select' | 'fighting' | 'result';

export interface ArenaMessage {
  readonly source?: string;
  readonly type?: string;
  readonly screen?: string;
  readonly mode?: string;
  readonly p1?: string;
  readonly p2?: string;
  readonly wins?: readonly [number, number];
  readonly winner?: 1 | 2;
}

export interface PlayRecord {
  readonly wins: number;
  readonly losses: number;
}

export interface PlayPanel {
  readonly start: (p1?: CabinetId) => void;
  readonly quit: () => void;
  readonly state: () => PlayState;
  readonly launch: () => CabinetLaunch;
  readonly record: () => PlayRecord;
  readonly setSound: (enabled: boolean) => void;
  /** Pause a running fight (the page is leaving the screen). */
  readonly pause: () => void;
  /** Feed one message from the arena; the mounted panel wires `message` to this. */
  readonly receive: (message: unknown) => void;
}

const SETTINGS_KEY = 'tokenbrawl.play.settings';
const RECORD_KEY = 'tokenbrawl.play.record';

const CPU_LEVELS: readonly { readonly value: 1 | 2 | 3; readonly label: string }[] = [
  { value: 1, label: 'Easy' },
  { value: 2, label: 'Normal' },
  { value: 3, label: 'Hard' },
];

const ROUNDS: readonly { readonly value: 1 | 3 | 5; readonly label: string }[] = [
  { value: 1, label: 'Best of 1' },
  { value: 3, label: 'Best of 3' },
  { value: 5, label: 'Best of 5' },
];

const DEFAULT_LAUNCH: CabinetLaunch = Object.freeze({ cpu: 2, rounds: 3 });

const ATTRACT_PAIR: readonly [CabinetId, CabinetId] = ['clawde', 'chatty'];

const STATUS: Readonly<Record<PlayState, string>> = Object.freeze({
  attract: 'Insert coin. You are always Player 1, on the left.',
  booting: 'Powering up the cabinet…',
  select: 'Pick your fighter, then your opponent, then the arena. Enter confirms, G backs out.',
  fighting: 'Fight on. Enter pauses. L throws the Ultimate at full meter.',
  result: 'Set over. Enter for a rematch, or pick another fighter.',
});

function readLaunch(storage: PlayStorage | undefined): CabinetLaunch {
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    if (raw === null || raw === undefined) {
      return DEFAULT_LAUNCH;
    }
    const parsed = JSON.parse(raw) as Partial<CabinetLaunch>;
    const cpu = CPU_LEVELS.some((level) => level.value === parsed.cpu) ? parsed.cpu! : DEFAULT_LAUNCH.cpu;
    const rounds = ROUNDS.some((entry) => entry.value === parsed.rounds) ? parsed.rounds! : DEFAULT_LAUNCH.rounds;
    return { cpu, rounds };
  } catch {
    return DEFAULT_LAUNCH;
  }
}

function readRecord(storage: PlayStorage | undefined): PlayRecord {
  try {
    const raw = storage?.getItem(RECORD_KEY);
    if (raw === null || raw === undefined) {
      return { wins: 0, losses: 0 };
    }
    const parsed = JSON.parse(raw) as Partial<PlayRecord>;
    return {
      wins: Number.isInteger(parsed.wins) && parsed.wins! >= 0 ? parsed.wins! : 0,
      losses: Number.isInteger(parsed.losses) && parsed.losses! >= 0 ? parsed.losses! : 0,
    };
  } catch {
    return { wins: 0, losses: 0 };
  }
}

function segmented<T extends number>(
  name: string,
  label: string,
  entries: readonly { readonly value: T; readonly label: string }[],
  current: T,
): string {
  const buttons = entries
    .map(
      (entry) =>
        `<button class="tb-segment" type="button" data-play-${name}="${String(entry.value)}" aria-pressed="${entry.value === current ? 'true' : 'false'}">${escapeHtml(entry.label)}</button>`,
    )
    .join('');
  return `<div><span class="tb-segmented-label">${escapeHtml(label)}</span><div class="tb-segmented" role="group" aria-label="${escapeHtml(label)}">${buttons}</div></div>`;
}

function keysMarkup(): string {
  const rows: readonly { readonly keys: readonly string[]; readonly does: string; readonly gold?: boolean }[] = [
    { keys: ['A', 'D'], does: 'Move' },
    { keys: ['W'], does: 'Jump' },
    { keys: ['S'], does: 'Crouch' },
    { keys: ['F'], does: 'Light' },
    { keys: ['G'], does: 'Heavy' },
    { keys: ['H'], does: 'Blast' },
    { keys: ['J'], does: 'Power charge' },
    { keys: ['K'], does: 'Dash' },
    { keys: ['L'], does: 'Ultimate', gold: true },
    { keys: ['Enter'], does: 'Start · pause' },
  ];
  return rows
    .map(
      (row) =>
        `<div class="tb-key-row"><span class="tb-key-set">${row.keys.map((key) => `<kbd class="tb-key${row.gold === true ? ' tb-key--gold' : ''}">${escapeHtml(key)}</kbd>`).join('')}</span><span class="tb-key-does">${escapeHtml(row.does)}</span></div>`,
    )
    .join('');
}

export function playMarkup(launch: CabinetLaunch = DEFAULT_LAUNCH, record: PlayRecord = { wins: 0, losses: 0 }): string {
  const [left, right] = ATTRACT_PAIR;
  return `
    <div class="tb-play-head">
      <div>
        <span class="tb-eyebrow">Arcade cabinet · you vs the CPU</span>
        <h2 class="tb-screen-heading">Play</h2>
      </div>
      <div class="tb-play-settings">
        ${segmented('cpu', 'CPU difficulty', CPU_LEVELS, launch.cpu)}
        ${segmented('rounds', 'Rounds', ROUNDS, launch.rounds)}
      </div>
    </div>
    <div class="tb-cabinet" data-play-cabinet>
      <div class="tb-cabinet-screen" data-play-screen>
        <iframe class="tb-play-frame" title="Tokenbrawl arena" data-play-frame allow="fullscreen; gamepad; autoplay" tabindex="0"></iframe>
        <div class="tb-play-attract" data-play-attract>
          <div class="tb-play-attract-art" aria-hidden="true">
            <img src="${escapeHtml(cabinetFullUrl(left))}" alt="" />
            <img src="${escapeHtml(cabinetFullUrl(right))}" alt="" />
          </div>
          <h3 class="tb-play-attract-title">Choose your fighter</h3>
          <p class="tb-play-attract-sub">
            Eight fighters, six arenas, a transformation ladder and a one-button Ultimate. Same engine,
            same audio and same pacing as the arcade original -- you just take the left side.
          </p>
          <button class="tb-button tb-button--gold tb-button--large" type="button" data-play-start>Insert coin</button>
          <span class="tb-play-coin" aria-hidden="true">Press to start</span>
        </div>
      </div>
      <div class="tb-play-bar">
        <p class="tb-play-status" data-play-status role="status" aria-live="polite">${escapeHtml(STATUS.attract)}</p>
        <div class="tb-play-score" aria-label="Your record on this machine">
          <span class="tb-chip tb-chip--verified" data-play-wins>W ${String(record.wins)}</span>
          <span class="tb-chip" data-play-losses>L ${String(record.losses)}</span>
        </div>
        <div class="tb-play-actions">
          <button class="tb-button" type="button" data-play-fullscreen>Fullscreen</button>
          <button class="tb-button tb-button--ghost" type="button" data-play-quit disabled>Quit</button>
        </div>
      </div>
    </div>
    <div class="tb-play-below">
      <section class="tb-card tb-controls-card" aria-label="Controls">
        <h3>Controls · keyboard</h3>
        <div class="tb-keys">${keysMarkup()}</div>
      </section>
      <section class="tb-card tb-notes-card" aria-label="How the cabinet fits the benchmark">
        <h3>What this is</h3>
        <p>The same fighter the language models are benchmarked on, played by a human. Gamepads and touch work too -- the cabinet picks them up on its own.</p>
        <p>Hold <strong>J</strong> to charge ki; release at full ki to transform up the ladder. Land hits to fill the super meter, then <strong>L</strong> for the cinematic finisher.</p>
        <p>Nothing you play here is rated. The leaderboard only ever reads Command Logs from the tournament runner.</p>
      </section>
    </div>
  `;
}

export function mountPlayPanel(host: PlayHost, deps: PlayPanelDeps = {}): PlayPanel {
  const settings = { launch: readLaunch(deps.storage) };
  const scoreboard = { record: readRecord(deps.storage) };

  host.innerHTML = playMarkup(settings.launch, scoreboard.record);

  const frame = host.querySelector('[data-play-frame]');
  const attract = host.querySelector('[data-play-attract]');
  const startButton = host.querySelector('[data-play-start]');
  const status = host.querySelector('[data-play-status]');
  const cabinet = host.querySelector('[data-play-cabinet]');
  const screen = host.querySelector('[data-play-screen]');
  const quitButton = host.querySelector('[data-play-quit]');
  const fullscreenButton = host.querySelector('[data-play-fullscreen]');
  const winsNode = host.querySelector('[data-play-wins]');
  const lossesNode = host.querySelector('[data-play-losses]');

  if (frame === null || attract === null || startButton === null || status === null) {
    throw new Error('mountPlayPanel: the cabinet did not mount.');
  }

  const panelState: { value: PlayState; sound: boolean } = {
    value: 'attract',
    sound: deps.soundEnabled?.() ?? true,
  };

  const say = (state: PlayState, message: string = STATUS[state], tone: '' | 'live' | 'win' | 'loss' = ''): void => {
    panelState.value = state;
    status.innerHTML = escapeHtml(message);
    status.setAttribute?.('class', tone === '' ? 'tb-play-status' : `tb-play-status tb-play-status--${tone}`);
    cabinet?.setAttribute?.('class', state === 'fighting' ? 'tb-cabinet tb-cabinet--live' : 'tb-cabinet');
    if (quitButton !== null) {
      quitButton.disabled = state === 'attract';
    }
  };

  const remember = (): void => {
    try {
      deps.storage?.setItem(SETTINGS_KEY, JSON.stringify(settings.launch));
    } catch {
      // A full or refused storage loses only the preference.
    }
  };

  const showRecord = (): void => {
    if (winsNode !== null) {
      winsNode.innerHTML = `W ${String(scoreboard.record.wins)}`;
    }
    if (lossesNode !== null) {
      lossesNode.innerHTML = `L ${String(scoreboard.record.losses)}`;
    }
    try {
      deps.storage?.setItem(RECORD_KEY, JSON.stringify(scoreboard.record));
    } catch {
      // Same: the record is a nicety.
    }
  };

  const tell = (message: Record<string, unknown>): void => {
    try {
      frame.contentWindow?.postMessage({ source: 'tb-host', ...message }, '*');
    } catch {
      // A frame that is not there yet hears nothing; it asks on boot.
    }
  };

  const wireSegments = (name: 'cpu' | 'rounds'): void => {
    const nodes = host.querySelectorAll?.(`[data-play-${name}]`) ?? [];
    const entries = name === 'cpu' ? CPU_LEVELS : ROUNDS;
    nodes.forEach((node, index) => {
      const entry = entries[index];
      if (entry === undefined) {
        return;
      }
      node.addEventListener('click', () => {
        deps.onGesture?.();
        settings.launch =
          name === 'cpu'
            ? { ...settings.launch, cpu: entry.value as 1 | 2 | 3 }
            : { ...settings.launch, rounds: entry.value as 1 | 3 | 5 };
        nodes.forEach((other, otherIndex) => {
          other.setAttribute?.('aria-pressed', otherIndex === index ? 'true' : 'false');
        });
        remember();
      });
    });
  };
  wireSegments('cpu');
  wireSegments('rounds');

  const start = (p1?: CabinetId): void => {
    deps.onGesture?.();
    const launch: CabinetLaunch = p1 === undefined ? settings.launch : { ...settings.launch, p1 };
    attract.hidden = true;
    frame.src = cabinetLaunchUrl(launch);
    say('booting');
    frame.focus?.();
  };

  const quit = (): void => {
    frame.src = 'about:blank';
    attract.hidden = false;
    say('attract');
  };

  const receive = (raw: unknown): void => {
    const message = raw as ArenaMessage | null;
    if (message === null || typeof message !== 'object' || message.source !== 'tb-arena') {
      return;
    }
    if (message.type === 'ready') {
      tell({ type: 'sound', enabled: panelState.sound });
      return;
    }
    if (message.type === 'screen') {
      const screenName = message.screen ?? '';
      if (screenName === 'select' || screenName === 'stageSelect' || screenName === 'vs') {
        say('select', STATUS.select);
      } else if (screenName === 'fight') {
        say('fighting', STATUS.fighting, 'live');
      } else if (screenName === 'result') {
        // The result message carries the outcome; keep whatever it said.
        if (panelState.value !== 'result') {
          say('result');
        }
      }
      return;
    }
    if (message.type === 'result') {
      const youWon = message.winner === 1;
      const p1 = isCabinetId(message.p1) ? CABINET_ROSTER[message.p1].name : 'You';
      const p2 = isCabinetId(message.p2) ? CABINET_ROSTER[message.p2].name : 'the CPU';
      const wins = message.wins ?? [0, 0];
      scoreboard.record = youWon
        ? { ...scoreboard.record, wins: scoreboard.record.wins + 1 }
        : { ...scoreboard.record, losses: scoreboard.record.losses + 1 };
      showRecord();
      say(
        'result',
        youWon
          ? `You win, ${String(wins[0])}-${String(wins[1])}. ${p1} takes the set over ${p2}. Enter for a rematch.`
          : `You lose, ${String(wins[0])}-${String(wins[1])}. ${p2} takes the set over ${p1}. Enter for a rematch.`,
        youWon ? 'win' : 'loss',
      );
    }
  };

  startButton.addEventListener('click', () => {
    start();
  });
  frame.addEventListener('load', () => {
    if (panelState.value === 'booting') {
      say('select');
    }
    frame.focus?.();
  });
  quitButton?.addEventListener('click', () => {
    deps.onGesture?.();
    quit();
  });
  fullscreenButton?.addEventListener('click', () => {
    deps.onGesture?.();
    try {
      void screen?.requestFullscreen?.();
    } catch {
      // Not every host allows it; the cabinet still plays in the page.
    }
    frame.focus?.();
  });

  return Object.freeze({
    start,
    quit,
    state: (): PlayState => panelState.value,
    launch: (): CabinetLaunch => settings.launch,
    record: (): PlayRecord => scoreboard.record,
    setSound: (enabled: boolean): void => {
      panelState.sound = enabled;
      tell({ type: 'sound', enabled });
    },
    pause: (): void => {
      tell({ type: 'pause' });
    },
    receive,
  });
}
