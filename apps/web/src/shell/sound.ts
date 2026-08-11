import { escapeHtml } from '../main';

/**
 * Story 12.9: the page's sound switch, and the reversal of a recorded decision.
 *
 * Sound used to be off by default on the surface a visitor was most likely to
 * meet. Story 11.6 measured that and wrote down why: *"an ambient surface that
 * starts making noise unprompted is a defect, so Spectate's sound is off until
 * asked for."* That was correct for the page it was written against -- five
 * panels mounted at once, three of them animating, Spectate looping forever
 * whether or not anybody was looking.
 *
 * Story 12.4 changed the premise. There is one screen at a time now and a hidden
 * screen is idle, so a visitor on the watch screen has chosen to watch. The
 * default flips, and *how* it flips is the part that must not be sloppy:
 *
 * - **The control reads ON on first load** and is a real, visible, keyboard
 *   reachable button that sits outside every screen, so silence is one click
 *   away from wherever the visitor is.
 * - **No sound is produced before a gesture**, because no browser would allow
 *   it. On by default means *armed*: `startup.ts` resumes the context on the
 *   first click, keypress or tap anywhere, and until then the graph is built and
 *   suspended -- which is what Chrome's own autoplay notice describes and why
 *   that notice is on the visual gate's console allowlist rather than silenced.
 * - **The choice persists.** A visitor who turns it off does not have it turned
 *   back on by a reload.
 *
 * ## Why the state lives here and not in a panel
 *
 * The page has one audio graph (Story 9.6) and, since 12.4, one screen at a
 * time. Muting is therefore a property of the *page*: implemented per panel it
 * would be four decisions that can disagree, which is how Spectate ended up the
 * only surface with a sound control at all. This module owns the bit and the
 * storage; `startup.ts` owns what changing it does, because that is the one file
 * holding every panel handle. Spectate keeps its own button -- it is the control
 * within arm's reach of the noise -- and reports a press back here so the two
 * cannot drift.
 *
 * ## Page chrome, so every `docs/DESIGN.md` rule applies
 *
 * This is not the arena and it takes none of the arena's three exemptions. The
 * button is `.tb-button` unchanged: flat fill, square corners, 3px ink border,
 * hard shadow, stepped transition, a real focus ring. Its `aria-pressed` is the
 * selector its "on" fill hangs off, exactly as `.tb-nav-link[aria-current]`
 * works, so the announced state and the visible state cannot drift apart.
 */

/** The shape this needs of one node. Structural, per house convention -- there is no DOM lib. */
export interface SoundNode {
  innerHTML: string;
  setAttribute?(name: string, value: string): void;
  addEventListener(type: 'click', listener: () => void): void;
}

export interface SoundHost {
  innerHTML: string;
  querySelector(selectors: string): SoundNode | null;
}

/**
 * The visitor's own storage, and the two verbs this needs of it.
 *
 * A subset of `byok/keys.ts`'s `KeyStorage` rather than an import of it: a real
 * `localStorage` satisfies both, and the sound preference has nothing to do with
 * an API key beyond happening to be remembered the same way.
 */
export interface SoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SoundControlDeps {
  /** Absent in a tab with storage blocked, and absent under test. Then the choice lasts one session. */
  readonly storage?: SoundStorage;
  /** Called after every change that is a change. `startup.ts` is what makes it audible. */
  readonly onChange?: (enabled: boolean) => void;
}

export interface SoundControl {
  readonly enabled: () => boolean;
  /** Sets the switch, persists it and reports it. A no-op when it already reads that way. */
  readonly set: (enabled: boolean) => void;
}

/**
 * Where the choice is remembered. Namespaced like `byok/keys.ts`'s own key: a
 * bare `sound` in a visitor's `localStorage` is somebody else's key waiting to
 * happen.
 */
const STORAGE_KEY = 'tokenbrawl.sound';

/**
 * The two stored values, written out rather than `String(boolean)`.
 *
 * `'off'` is the only value that means off, so a corrupted or half-written entry
 * reads as on -- which is the default, and the direction a broken read should
 * fail in. A `'false'`/`'true'` pair would make `''` and `'0'` both ambiguous.
 */
const STORED = Object.freeze({ on: 'on', off: 'off' });

/** The button's two labels, a frozen table for the reason `SOUND_LABEL` in `spectate/panel.ts` is one. */
const LABEL = Object.freeze({ on: 'Sound: on', off: 'Sound: off' });

/**
 * The remembered choice, or `true`.
 *
 * Wrapped, because `localStorage` throws on access in a tab with third-party
 * storage blocked -- the same read `byok/keys.ts` guards for the same reason.
 * Every failure lands on the default, which is what this story is for.
 */
function storedPreference(storage: SoundStorage | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) !== STORED.off;
  } catch {
    return true;
  }
}

/**
 * The control's markup. Exported so the shell can be asserted with no DOM, in
 * the same spirit as `navMarkup`/`spectateMarkup`.
 *
 * The initial `aria-pressed` and label are handed in rather than hard-coded on:
 * the markup is written once and updated from a different line, and a button
 * that shipped `Sound: on` and was then set off by a remembered choice would
 * flicker the wrong state on every load a returning visitor makes.
 */
export function soundMarkup(enabled: boolean): string {
  return `<div class="tb-sound"><button class="tb-button tb-sound-toggle" type="button" data-sound aria-pressed="${enabled ? 'true' : 'false'}">${escapeHtml(enabled ? LABEL.on : LABEL.off)}</button></div>`;
}

export function mountSoundControl(host: SoundHost, deps: SoundControlDeps = {}): SoundControl {
  // Closure state in a factory, never a module-level binding
  // (`source-discipline.test.ts` bans the latter).
  const state = { enabled: storedPreference(deps.storage) };

  host.innerHTML = soundMarkup(state.enabled);
  const button = host.querySelector('[data-sound]');
  if (button === null) {
    throw new Error('mountSoundControl: the control did not mount.');
  }

  const render = (): void => {
    button.innerHTML = escapeHtml(state.enabled ? LABEL.on : LABEL.off);
    button.setAttribute?.('aria-pressed', state.enabled ? 'true' : 'false');
  };

  const remember = (): void => {
    try {
      deps.storage?.setItem(STORAGE_KEY, state.enabled ? STORED.on : STORED.off);
    } catch {
      // Storage disabled, or full in Safari's private mode. The choice still
      // holds for this session; it simply will not outlive it.
    }
  };

  const set = (enabled: boolean): void => {
    if (state.enabled === enabled) {
      return;
    }
    state.enabled = enabled;
    render();
    remember();
    deps.onChange?.(enabled);
  };

  // Written once at mount as well as on every change, the same discipline
  // `spectate/panel.ts` follows and for the same reason: the markup's default is
  // a string in a template and the label a visitor reads comes from `LABEL`, so
  // rendering once here is what stops the two ever being different sentences.
  render();
  button.addEventListener('click', () => {
    set(!state.enabled);
  });

  return Object.freeze({
    enabled: (): boolean => state.enabled,
    set,
  });
}
