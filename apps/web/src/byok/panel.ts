import type { CommandLog } from '@tokenbrawl/contracts';
import { escapeHtml } from '../main';
import { byokCatalogue, type ByokProviderOption } from './catalogue';
import { ByokKeyError } from './client';
import { createKeyStore, type KeyStorage } from './keys';
import { runByokMatch, type ByokRunConfig } from './run';

/**
 * Story 4.6: the BYOK panel.
 *
 * It owns its own shell rather than joining `renderApp`'s, for two reasons that
 * point the same way. `renderApp` rewrites `#app`'s `innerHTML` wholesale, and
 * a completed BYOK Match re-mounts the player through exactly that call -- a
 * panel inside `#app` would delete itself at the moment it succeeded. And
 * Story 4.5's deferred entry asked 4.6 not to grow that function's eight-way
 * `querySelector` guard any further. So the panel lives in `#byok`, beside the
 * player, and the two communicate through one callback.
 *
 * Every DOM type here is structural, as in `main.ts`: `tsconfig.base.json` sets
 * `lib: ["ES2022"]` with no DOM, and adding one would hand `packages/core`
 * ambient `document` and `window` types and weaken the type-level half of INV-3
 * across the repo to spare a handful of interfaces here.
 */

export type ByokEvent = 'click' | 'change' | 'input';

export interface ByokNode {
  innerHTML: string;
  /** Present on inputs and selects. */
  value?: string;
  /** Present on the persistence checkbox. */
  checked?: boolean;
  /** Present on the run button, which is disabled while a Match is in flight. */
  disabled?: boolean;
  setAttribute?(name: string, value: string): void;
  addEventListener(type: ByokEvent, listener: () => void): void;
}

export interface ByokHost {
  innerHTML: string;
  querySelector(selectors: string): ByokNode | null;
}

/** Idle, running, and the two terminal states. Nothing here is a duration. */
export type ByokState = 'idle' | 'running' | 'failed' | 'done';

export interface ByokPanelDeps {
  /** Handed the log of a completed Match. `startup.ts` re-mounts the player with it. */
  readonly onLog: (log: CommandLog) => void;
  /** Injectable so a test drives a whole Match with no network. */
  readonly run?: (config: ByokRunConfig) => Promise<CommandLog>;
  /** The visitor's own `localStorage`, or nothing. Absent means the opt-in has nowhere to write. */
  readonly storage?: KeyStorage;
  readonly catalogue?: readonly ByokProviderOption[];
}

export interface ByokPanel {
  /** Runs the Match the form describes. Returns when it has succeeded or failed. */
  readonly submit: () => Promise<void>;
  readonly state: () => ByokState;
}

/**
 * Not the committed demo's seed (4101), so the first BYOK fight is a different
 * fight -- and a constant rather than a random draw, so two visitors comparing
 * notes are comparing the same starting position.
 */
const DEFAULT_SEED = 4_601;

const FIGHTER_LABELS = ['Fighter 1', 'Fighter 2'] as const;

function optionMarkup(option: ByokProviderOption): string {
  const label =
    option.access === 'cli-only' ? `${option.label} — CLI ONLY` : option.label;
  // A CLI-only provider is listed and disabled, never hidden. AC5 asks for the
  // visitor to be told the provider cannot run here; a missing row tells them
  // nothing and sends them looking for it.
  return `<option value="${escapeHtml(option.id)}"${option.access === 'cli-only' ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
}

/**
 * The CLI-only providers, as a sentence beside the picker.
 *
 * Not decoration, and not a duplicate of the disabled `<option>`s: Chrome's
 * accessibility tree omits a disabled option entirely, so a screen-reader user
 * reading the picker is never told the provider exists, let alone that it is
 * CLI-only -- which is precisely what AC5 asks to be told. Found by taking an
 * a11y snapshot of the built page rather than by any test. The sentence also
 * carries each provider's *reason*, which an option label has no room for.
 */
export function cliOnlyNotice(catalogue: readonly ByokProviderOption[]): string {
  const excluded = catalogue.filter((option) => option.access === 'cli-only');
  if (excluded.length === 0) {
    return '';
  }
  return escapeHtml(
    `Not runnable in a browser: ${excluded
      .map((option) => `${option.label} (${option.cliOnlyReason ?? ''})`)
      .join(' ')}`,
  );
}

function modelMarkup(option: ByokProviderOption | undefined): string {
  return (option?.models ?? [])
    .map((model) => `<option value="${escapeHtml(model.model)}">${escapeHtml(model.model)}</option>`)
    .join('');
}

/**
 * The panel's markup.
 *
 * Exported so the shell can be asserted without a DOM, in the same spirit as
 * `hashChip` and `reasoningView` in `main.ts`: the thing worth testing is that
 * a CLI-only provider is visibly labelled and unselectable, not that a `<select>`
 * exists.
 */
export function byokMarkup(catalogue: readonly ByokProviderOption[]): string {
  const browserOptions = catalogue.filter((option) => option.access === 'browser');
  const first = browserOptions[0];

  const fighter = (agentIndex: 0 | 1): string => `
    <fieldset class="tb-byok-fighter">
      <legend class="tb-byok-legend">${FIGHTER_LABELS[agentIndex]}</legend>
      <label class="tb-byok-label" for="tb-byok-provider-${String(agentIndex)}">Provider</label>
      <div class="tb-byok-select">
        <select class="tb-byok-input" id="tb-byok-provider-${String(agentIndex)}" data-provider="${String(agentIndex)}">
          ${catalogue.map((option) => optionMarkup(option)).join('')}
        </select>
      </div>
      <label class="tb-byok-label" for="tb-byok-model-${String(agentIndex)}">Model</label>
      <div class="tb-byok-select">
        <select class="tb-byok-input" id="tb-byok-model-${String(agentIndex)}" data-model="${String(agentIndex)}">
          ${modelMarkup(first)}
        </select>
      </div>
      <label class="tb-byok-label" for="tb-byok-key-${String(agentIndex)}">API key</label>
      <input
        class="tb-byok-input"
        id="tb-byok-key-${String(agentIndex)}"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-key="${String(agentIndex)}"
      />
    </fieldset>
  `;

  return `
    <h2 class="tb-byok-heading">Run your own fight</h2>
    <p class="tb-byok-intro">
      Two free API keys, your browser, no server. Each key is sent to the provider you pick and to
      no other origin — this site is static and has no backend to send one to. Keys are not stored
      unless you tick the box.
    </p>
    <div class="tb-byok-grid">
      ${fighter(0)}
      ${fighter(1)}
      <fieldset class="tb-byok-fighter">
        <legend class="tb-byok-legend">Match</legend>
        <label class="tb-byok-label" for="tb-byok-seed">Seed</label>
        <input class="tb-byok-input" id="tb-byok-seed" type="number" min="0" max="4294967295" step="1" value="${String(DEFAULT_SEED)}" data-seed />
        <label class="tb-byok-check">
          <input type="checkbox" data-remember />
          Remember these keys in this browser
        </label>
        <button class="tb-button tb-byok-run" type="button" data-run>Run the fight</button>
      </fieldset>
    </div>
    <p class="tb-byok-cli-only">${cliOnlyNotice(catalogue)}</p>
    <p class="tb-byok-progress" data-progress></p>
    <p class="tb-byok-status" data-status role="status" aria-live="polite"></p>
  `;
}

/**
 * Mounts the panel and wires it.
 *
 * The one interesting decision in here is where the *status* lives. Progress
 * updates once per provider call, and Story 4.5 established that an `aria-live`
 * region rewritten on a fast loop is worse for a screen-reader user than
 * silence. So progress goes to an ordinary node and only the four state
 * transitions -- idle, running, failed, done -- reach the live region.
 */
export function mountByokPanel(host: ByokHost, deps: ByokPanelDeps): ByokPanel {
  const catalogue = deps.catalogue ?? byokCatalogue();
  host.innerHTML = byokMarkup(catalogue);

  const providers = [host.querySelector('[data-provider="0"]'), host.querySelector('[data-provider="1"]')];
  const models = [host.querySelector('[data-model="0"]'), host.querySelector('[data-model="1"]')];
  const keys = [host.querySelector('[data-key="0"]'), host.querySelector('[data-key="1"]')];
  const seed = host.querySelector('[data-seed]');
  const remember = host.querySelector('[data-remember]');
  const run = host.querySelector('[data-run]');
  const status = host.querySelector('[data-status]');
  const progress = host.querySelector('[data-progress]');

  if (
    providers[0] === null ||
    providers[1] === null ||
    models[0] === null ||
    models[1] === null ||
    keys[0] === null ||
    keys[1] === null ||
    seed === null ||
    remember === null ||
    run === null ||
    status === null ||
    progress === null
  ) {
    throw new Error('mountByokPanel: the panel did not mount.');
  }

  // Re-bound after the guard, exactly as `renderApp` does: TypeScript will not
  // carry a narrowing into a loop body or a listener, both of which are all
  // this function is made of.
  const providerNodes: readonly [ByokNode, ByokNode] = [providers[0], providers[1]];
  const modelNodes: readonly [ByokNode, ByokNode] = [models[0], models[1]];
  const keyNodes: readonly [ByokNode, ByokNode] = [keys[0], keys[1]];
  const seedNode = seed;
  const statusNode = status;
  const progressNode = progress;
  const runNode = run;
  const rememberNode = remember;
  const store = createKeyStore(deps.storage);
  const runMatch = deps.run ?? runByokMatch;
  const panelState: { value: ByokState } = { value: 'idle' };

  const browserOptions = catalogue.filter((option) => option.access === 'browser');
  const firstBrowserId = browserOptions[0]?.id ?? '';

  // Set on the node as well as in the markup, the same way `renderApp` sets the
  // timeline's value after writing the shell. The attribute in the template is
  // the *default* value; this is the one the form reads back, and relying on a
  // browser to have parsed the first into the second is a dependency on
  // rendering that this function otherwise has none of.
  seedNode.value = String(DEFAULT_SEED);

  const say = (state: ByokState, message: string): void => {
    panelState.value = state;
    statusNode.innerHTML = escapeHtml(message);
    // The class carries the meaning to sighted visitors; the text carries it to
    // everyone. `--failed` is the same warn fill the hash chip uses.
    statusNode.setAttribute?.('class', `tb-byok-status tb-byok-status--${state}`);
  };

  for (const agentIndex of [0, 1] as const) {
    const providerNode = providerNodes[agentIndex];
    const modelNode = modelNodes[agentIndex];
    providerNode.value = firstBrowserId;
    modelNode.innerHTML = modelMarkup(browserOptions[0]);
    // Selected explicitly rather than left to the browser's "first option wins"
    // default, so the mount path and the provider-change path below produce the
    // same state by the same statement instead of by two different mechanisms.
    modelNode.value = browserOptions[0]?.models[0]?.model ?? '';

    providerNode.addEventListener('change', () => {
      const chosen = catalogue.find((option) => option.id === providerNode.value);
      // A CLI-only id can only arrive here from a browser that ignored
      // `disabled`, or from an autofill. The models list stays empty and the
      // run refuses -- there is no path from here to a request.
      modelNode.innerHTML = modelMarkup(chosen?.access === 'browser' ? chosen : undefined);
      modelNode.value = chosen?.access === 'browser' ? (chosen.models[0]?.model ?? '') : '';
    });
  }

  // The opt-in, and the whole of it: keys are read back only if a previous
  // session ticked this box, and unticking removes them immediately rather than
  // at the next run (AC2).
  if (store.persisted()) {
    const [firstKey, secondKey] = store.load();
    keyNodes[0].value = firstKey;
    keyNodes[1].value = secondKey;
    rememberNode.checked = true;
  }

  rememberNode.addEventListener('change', () => {
    if (rememberNode.checked !== true) {
      store.forget();
    }
  });

  const submit = async (): Promise<void> => {
    if (panelState.value === 'running') {
      return;
    }
    runNode.disabled = true;
    progressNode.innerHTML = '';
    say('running', 'Running. Every Decision Point is one call to each provider; nothing is recorded anywhere but this tab.');

    const fighterKeys: [string, string] = [keyNodes[0].value ?? '', keyNodes[1].value ?? ''];

    try {
      const log = await runMatch({
        fighters: [
          {
            provider: providerNodes[0].value ?? '',
            model: modelNodes[0].value ?? '',
            apiKey: fighterKeys[0].trim(),
          },
          {
            provider: providerNodes[1].value ?? '',
            model: modelNodes[1].value ?? '',
            apiKey: fighterKeys[1].trim(),
          },
        ],
        seed: Number.parseInt(seedNode.value ?? '', 10),
        onCall: (calls) => {
          // Not a live region, and deliberately a count of calls rather than a
          // share of the Match or anything with a clock in it (INV-3).
          progressNode.innerHTML = `${String(calls)} calls made`;
        },
      });

      if (rememberNode.checked === true) {
        store.save([fighterKeys[0].trim(), fighterKeys[1].trim()]);
      }

      say('done', 'Done. Your Match is playing above. It is marked BYOK and is excluded from every rating.');
      deps.onLog(log);
    } catch (error) {
      // Attributed where it can be (AC3), and never swallowed where it cannot.
      // `ByokKeyError.message` already names the fighter, the provider and the
      // reason, and its detail has been redacted of both keys.
      say(
        'failed',
        error instanceof ByokKeyError
          ? error.message
          : `The Match did not run. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      runNode.disabled = false;
    }
  };

  runNode.addEventListener('click', () => {
    // The promise is deliberately not awaited here: a DOM listener returns
    // void, and every outcome is already reported through `say`.
    void submit();
  });

  say('idle', 'Paste two keys and run. Nothing leaves this tab except the model calls themselves.');

  return Object.freeze({ submit, state: (): ByokState => panelState.value });
}
