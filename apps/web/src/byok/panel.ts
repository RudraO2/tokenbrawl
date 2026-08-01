import type { CommandLog } from '@tokenbrawl/contracts';
import type { HttpFetch } from '../../../../packages/providers/src/http';
import { escapeHtml } from '../main';
import {
  ADVANCED_PRESETS,
  discoverByokModels,
  discoveredModelOptions,
  originVerdict,
  type ByokDiscoveryConfig,
} from './advanced';
import {
  byokCatalogue,
  byokModelOption,
  modelOptionLabel,
  modelOptionNotice,
  type ByokModelOption,
  type ByokProviderOption,
} from './catalogue';
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
 *
 * ---------------------------------------------------------------------------
 * Story 4.7: progressive disclosure, and why it is a `<details>`
 * ---------------------------------------------------------------------------
 *
 * The default view is exactly what 4.6 shipped -- provider, model, key -- and
 * the story is explicit that a visitor who wants the simple thing must not have
 * to read about base URLs to find it. Everything 4.7 adds therefore sits inside
 * one `<details>` per fighter.
 *
 * A native `<details>` rather than a rebuilt disclosure: it is keyboard
 * operable, announced as expandable, and remembers nothing across a rebuild,
 * all without a line of JavaScript. The same reasoning as 4.6's `accent-color`
 * checkbox -- rebuilding a platform control means rebuilding its behaviour, and
 * this file has no framework to do that with.
 *
 * The three controls inside it are, in the order a visitor needs them:
 *
 *   Fetch my models   populates the picker from the pasted key (AC4)
 *   Custom model      a name on no list, sent in the request body (AC3)
 *   Base URL          an endpoint of the visitor's own, with the resolved
 *                     origin echoed back *before* the first request (AC5, AC6)
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
  /** Injectable so "fetch my models" is testable without a network (AC4). */
  readonly discover?: (config: ByokDiscoveryConfig) => Promise<readonly string[]>;
  /** Handed to discovery. The Match's own transport comes through `run` instead. */
  readonly fetch?: HttpFetch;
}

export interface ByokPanel {
  /** Runs the Match the form describes. Returns when it has succeeded or failed. */
  readonly submit: () => Promise<void>;
  /** Repopulates one fighter's model picker from its provider (AC4). */
  readonly discover: (agentIndex: 0 | 1) => Promise<void>;
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

/**
 * The model `<select>`'s contents.
 *
 * Each option's own label carries its RPM/RPD and Matches-per-day (AC2), which
 * is where a visitor comparing two models is actually looking. `extra` carries
 * models that came from discovery or that the visitor typed: they are appended
 * rather than merged into the sorted list, so the measured ones stay first.
 */
export function modelMarkup(
  option: ByokProviderOption | undefined,
  extra: readonly string[] = [],
): string {
  const listed = (option?.models ?? []).map(
    (model) =>
      `<option value="${escapeHtml(model.model)}">${escapeHtml(modelOptionLabel(model))}</option>`,
  );

  const known = new Set((option?.models ?? []).map((model) => model.model));
  const discovered = extra
    .filter((model) => !known.has(model))
    .map((model) => {
      // Resolved through the catalogue so a discovered model carries the
      // provider's defaults and is labelled as inheriting them, rather than
      // appearing with no numbers at all beside models that have some.
      const resolved = resolveQuietly(option?.id ?? '', model);
      const label = resolved === null ? model : modelOptionLabel(resolved);
      return `<option value="${escapeHtml(model)}">${escapeHtml(label)}</option>`;
    });

  return [...listed, ...discovered].join('');
}

/** The catalogue lookup, or `null`. Markup must never throw halfway through a `<select>`. */
function resolveQuietly(providerId: string, model: string): ByokModelOption | null {
  try {
    return byokModelOption(providerId, model);
  } catch {
    return null;
  }
}

/** The line under a model picker: empty for an ordinary model, a warning otherwise (AC2). */
export function modelNoticeText(providerId: string, model: string): string {
  const resolved = resolveQuietly(providerId, model);
  return resolved === null ? '' : modelOptionNotice(resolved);
}

function presetMarkup(): string {
  return ADVANCED_PRESETS.map(
    (preset) =>
      `<option value="${escapeHtml(preset.baseUrl)}">${escapeHtml(preset.label)} — ${escapeHtml(preset.baseUrl)}</option>`,
  ).join('');
}

/** The Advanced disclosure for one fighter. Collapsed by default; nothing here is needed to run a fight. */
function advancedMarkup(agentIndex: 0 | 1): string {
  const index = String(agentIndex);
  return `
      <details class="tb-byok-advanced">
        <summary class="tb-byok-summary">Advanced</summary>
        <button class="tb-button tb-byok-discover" type="button" data-discover="${index}">Fetch my models</button>
        <label class="tb-byok-label" for="tb-byok-custom-${index}">Custom model name</label>
        <input
          class="tb-byok-input"
          id="tb-byok-custom-${index}"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="openai/gpt-oss-120b"
          data-custom="${index}"
        />
        <label class="tb-byok-label" for="tb-byok-base-${index}">Base URL — any OpenAI-compatible endpoint</label>
        <div class="tb-byok-select">
          <select class="tb-byok-input" data-preset="${index}">
            <option value="">Pick a known endpoint…</option>
            ${presetMarkup()}
          </select>
        </div>
        <input
          class="tb-byok-input"
          id="tb-byok-base-${index}"
          type="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="https://openrouter.ai/api/v1"
          data-base="${index}"
        />
        <p class="tb-byok-origin" data-origin="${index}"></p>
      </details>
  `;
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
      <p class="tb-byok-limits" data-limits="${String(agentIndex)}"></p>
      <label class="tb-byok-label" for="tb-byok-key-${String(agentIndex)}">API key</label>
      <input
        class="tb-byok-input"
        id="tb-byok-key-${String(agentIndex)}"
        type="password"
        autocomplete="off"
        spellcheck="false"
        data-key="${String(agentIndex)}"
      />
      ${advancedMarkup(agentIndex)}
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
  const customs = [host.querySelector('[data-custom="0"]'), host.querySelector('[data-custom="1"]')];
  const bases = [host.querySelector('[data-base="0"]'), host.querySelector('[data-base="1"]')];
  const presets = [host.querySelector('[data-preset="0"]'), host.querySelector('[data-preset="1"]')];
  const origins = [host.querySelector('[data-origin="0"]'), host.querySelector('[data-origin="1"]')];
  const limitsLines = [host.querySelector('[data-limits="0"]'), host.querySelector('[data-limits="1"]')];
  const discovers = [host.querySelector('[data-discover="0"]'), host.querySelector('[data-discover="1"]')];
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
    customs[0] === null ||
    customs[1] === null ||
    bases[0] === null ||
    bases[1] === null ||
    presets[0] === null ||
    presets[1] === null ||
    origins[0] === null ||
    origins[1] === null ||
    limitsLines[0] === null ||
    limitsLines[1] === null ||
    discovers[0] === null ||
    discovers[1] === null ||
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
  const customNodes: readonly [ByokNode, ByokNode] = [customs[0], customs[1]];
  const baseNodes: readonly [ByokNode, ByokNode] = [bases[0], bases[1]];
  const presetNodes: readonly [ByokNode, ByokNode] = [presets[0], presets[1]];
  const originNodes: readonly [ByokNode, ByokNode] = [origins[0], origins[1]];
  const limitsNodes: readonly [ByokNode, ByokNode] = [limitsLines[0], limitsLines[1]];
  const discoverNodes: readonly [ByokNode, ByokNode] = [discovers[0], discovers[1]];
  const seedNode = seed;
  const statusNode = status;
  const progressNode = progress;
  const runNode = run;
  const rememberNode = remember;
  const store = createKeyStore(deps.storage);
  const runMatch = deps.run ?? runByokMatch;
  const discoverModels = deps.discover ?? discoverByokModels;
  const panelState: { value: ByokState } = { value: 'idle' };
  // Models a provider told us about, per fighter. Not module-level -- a shipped
  // file here may declare no mutable binding outside a function, and this is
  // per-mount state anyway.
  const discovered: [string[], string[]] = [[], []];

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

  /**
   * What this fighter will actually run, read off the form.
   *
   * One function, used by the run, by the limits line and by discovery, so the
   * three can never disagree about which of the three sources wins. The order
   * is base URL, then custom model, then the picker -- most specific first, and
   * each one is something the visitor had to open a disclosure and type.
   */
  const fighterFrom = (agentIndex: 0 | 1): {
    provider: string;
    model: string;
    baseUrl: string;
  } => {
    const baseUrl = (baseNodes[agentIndex].value ?? '').trim();
    const custom = (customNodes[agentIndex].value ?? '').trim();
    return {
      provider: providerNodes[agentIndex].value ?? '',
      model: custom.length > 0 ? custom : (modelNodes[agentIndex].value ?? ''),
      baseUrl,
    };
  };

  /** AC2's line, and AC6's. Both are "what will happen", written before it does. */
  const refreshNotices = (agentIndex: 0 | 1): void => {
    const fighter = fighterFrom(agentIndex);

    // AC6: the origin, echoed back before the first request. `originVerdict`
    // returns a message for the bad cases too, so a mistyped URL is answered
    // where it was typed rather than by a failed Match.
    const verdict = originVerdict(fighter.baseUrl);
    originNodes[agentIndex].innerHTML = escapeHtml(verdict.message);
    originNodes[agentIndex].setAttribute?.(
      'class',
      `tb-byok-origin${verdict.message.length > 0 && !verdict.ok ? ' tb-byok-origin--refused' : ''}`,
    );

    // A visitor-supplied endpoint publishes no quota this build knows, so there
    // is nothing honest to say about how long a Match will take on it.
    const notice =
      fighter.baseUrl.length > 0 ? '' : modelNoticeText(fighter.provider, fighter.model);
    limitsNodes[agentIndex].innerHTML = escapeHtml(notice);
  };

  const repaintModels = (agentIndex: 0 | 1, chosen: ByokProviderOption | undefined): void => {
    const modelNode = modelNodes[agentIndex];
    const browserChosen = chosen?.access === 'browser' ? chosen : undefined;
    modelNode.innerHTML = modelMarkup(browserChosen, discovered[agentIndex]);
    // Selected explicitly rather than left to the browser's "first option wins"
    // default, so every path that repaints this list produces the same state by
    // the same statement instead of by three different mechanisms.
    modelNode.value = browserChosen?.models[0]?.model ?? discovered[agentIndex][0] ?? '';
    refreshNotices(agentIndex);
  };

  for (const agentIndex of [0, 1] as const) {
    const providerNode = providerNodes[agentIndex];
    providerNode.value = firstBrowserId;
    repaintModels(agentIndex, browserOptions[0]);

    providerNode.addEventListener('change', () => {
      // A provider's models are its own: a list fetched for Groq must not
      // survive a switch to Cerebras, where none of those ids exist.
      discovered[agentIndex] = [];
      // A CLI-only id can only arrive here from a browser that ignored
      // `disabled`, or from an autofill. The models list stays empty and the
      // run refuses -- there is no path from here to a request.
      repaintModels(
        agentIndex,
        catalogue.find((option) => option.id === providerNode.value),
      );
    });

    modelNodes[agentIndex].addEventListener('change', () => {
      refreshNotices(agentIndex);
    });
    customNodes[agentIndex].addEventListener('input', () => {
      refreshNotices(agentIndex);
    });
    baseNodes[agentIndex].addEventListener('input', () => {
      refreshNotices(agentIndex);
    });
    presetNodes[agentIndex].addEventListener('change', () => {
      const picked = presetNodes[agentIndex].value ?? '';
      if (picked.length > 0) {
        // A preset fills the field rather than becoming a mode: the visitor can
        // overwrite it with anything, which is the point of Advanced.
        baseNodes[agentIndex].value = picked;
        refreshNotices(agentIndex);
      }
    });
    discoverNodes[agentIndex].addEventListener('click', () => {
      void discover(agentIndex);
    });
  }

  /**
   * "Fetch my models" (AC4).
   *
   * The key goes to one origin -- the one derived from the completions endpoint
   * this selection already resolves to -- and the picker is repopulated from
   * what came back. A failure is reported and changes nothing: a visitor whose
   * key was rejected keeps the list they had rather than losing it as well.
   */
  const discover = async (agentIndex: 0 | 1): Promise<void> => {
    const button = discoverNodes[agentIndex];
    if (button.disabled === true) {
      return;
    }
    const fighter = fighterFrom(agentIndex);
    const apiKey = (keyNodes[agentIndex].value ?? '').trim();

    button.disabled = true;
    try {
      const models = await discoverModels({
        provider: fighter.provider,
        baseUrl: fighter.baseUrl,
        apiKey,
        fetch: deps.fetch,
      });

      // A model the provider serves but this build cannot address -- a Google
      // model with no allowlist entry -- is dropped rather than offered, since
      // offering it would put a selection in the picker that fails on use.
      discovered[agentIndex] =
        fighter.baseUrl.length > 0
          ? [...models]
          : [...discoveredModelOptions(fighter.provider, models)];

      repaintModels(
        agentIndex,
        catalogue.find((option) => option.id === fighter.provider),
      );
      say(
        panelState.value === 'running' ? 'running' : 'idle',
        `${FIGHTER_LABELS[agentIndex]}: ${String(discovered[agentIndex].length)} models this key can use.`,
      );
    } catch (error) {
      say(
        'failed',
        `${FIGHTER_LABELS[agentIndex]}: could not fetch models. ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      button.disabled = false;
    }
  };

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
          { ...fighterFrom(0), apiKey: fighterKeys[0].trim() },
          { ...fighterFrom(1), apiKey: fighterKeys[1].trim() },
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

  return Object.freeze({ submit, discover, state: (): ByokState => panelState.value });
}
