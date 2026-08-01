import type { CommandLog } from '@tokenbrawl/contracts';
import { mountByokPanel, type ByokHost, type ByokPanel } from './byok/panel';
import type { KeyStorage } from './byok/keys';
import { escapeHtml, renderApp, type HostView, type MountPoint, type MountedApp } from './main';
import { validateReasoningSidecar } from './replay/sidecar';
import { createSpriteArtist, type FighterArtist } from './render/artist';
import { createBackdrop, validateBackdropLayout, type Backdrop } from './render/backdrop';
import { createSpriteSheet, validateSpriteSheetLayout } from './render/sprite-sheet';

/**
 * Story 4.2: the bootstrap, and the order it does things in.
 *
 * Story 4.1's `boot.ts` awaited both sprite packs and every backdrop layer
 * before it called `renderApp`. Measured on emulated Slow 3G, the document, JS,
 * CSS and fonts completed at 4.5 s while the first animated frame waited for
 * the last blocking sprite at **14.75 s**. The budget is 2 s. Payload was never
 * the problem -- the whole page is 93 KB -- the problem was that a decoration
 * sat on the critical path.
 *
 * So the order here is the story:
 *
 * 1. Fetch the Command Log. This one *is* the critical path: there is no fight
 *    without it, and `index.html` preloads it so the request starts alongside
 *    the module graph rather than after it.
 * 2. Mount and start. `renderApp` is synchronous, the block artist needs no
 *    network, and frame zero is painted before this function returns.
 * 3. *Then* upgrade: sprite packs, backdrop and the reasoning sidecar, each
 *    swapped into the already-running fight as it arrives.
 *
 * `startup` resolves at step 2. Step 3 settles on the returned `dressed`
 * promise, which exists so a test can await the upgrades without the
 * production path ever waiting on them. `startup.test.ts` hands this function
 * sprite fetches that never resolve and asserts the clock is running anyway --
 * that is AC1 and AC3 as a test rather than as a measurement.
 *
 * This module and `boot.ts` are the only files that touch a global. `document`
 * and `window` are reached through `globalThis` rather than as bare
 * identifiers, the same way `packages/providers/src/http.ts` resolves `fetch`:
 * `tsconfig.base.json` has no DOM lib and must not gain one, because that would
 * hand `packages/core` ambient `document` and `window` types and weaken the
 * type-level half of INV-3 repo-wide.
 *
 * Until Story 4.6 lets a visitor supply their own, the log is a precomputed
 * Match between two Baseline Bots, fetched as a static file. It is *not* built
 * in the browser: `buildCommandLog` reaches `node:crypto` through
 * `canonical-hash.ts` and pulls in Ajv, so a page that generated its own log
 * died on load. Fetching is the architecture anyway (INV-8: precompute plus
 * static hosting) and is exactly how a real tournament log will arrive.
 *
 * What still runs in the browser is the whole simulation -- `replayCommandLog`,
 * the Environment Adapter and every frame of re-simulation. That is AD-4
 * demonstrated end to end.
 */

/** Same-origin, so both are covered by the no-remote-asset sweep in `style-discipline.test.ts`. */
export const DEMO_REPLAY_URL = '/replays/demo.command-log.json';
/** One pack per agent index, so the two fighters are told apart by silhouette. */
const SPRITE_LAYOUT_URLS = [
  '/sprites/martial-hero/layout.json',
  '/sprites/martial-hero-2/layout.json',
] as const;
const BACKDROP_LAYOUT_URL = '/sprites/mountain-dusk/layout.json';

interface LoadedImage {
  readonly width: number;
  readonly height: number;
  decode(): Promise<void>;
  src: string;
}

/** What `createSpriteSheet` needs of a decoded image: its dimensions, nothing more. */
type HTMLImageElementLike = LoadedImage;

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface BrowserGlobals {
  readonly document?: {
    querySelector(selectors: string): MountPoint | null;
  };
  readonly window?: HostView;
  readonly fetch?: (url: string) => Promise<FetchResponse>;
  readonly Image?: new () => LoadedImage;
  /**
   * The visitor's own storage, for Story 4.6's opt-in key persistence. Absent
   * in a tab with storage blocked, and absent under test -- the panel treats
   * both as "there is nowhere to remember a key", which is the safe reading.
   */
  readonly localStorage?: KeyStorage;
}

export interface StartupResult {
  readonly mounted: MountedApp;
  /** Settles once every decoration has arrived or failed. Never awaited on the page. */
  readonly dressed: Promise<void>;
  /**
   * The BYOK panel, or `null` when the page has no `#byok` host (Story 4.6).
   * Exposed so a test can drive a whole Match through the real wiring.
   */
  readonly byok: ByokPanel | null;
  /** The player currently on screen. Changes when a BYOK Match replaces the demo. */
  readonly current: () => MountedApp;
  /**
   * Re-mounts the player on another log. This is the callback the BYOK panel is
   * wired to, exposed so the re-mount can be asserted without a network: the
   * panel's own path is covered in `byok/panel.test.ts`, and what is worth
   * testing here is what happens to the *player* when a second log arrives.
   */
  readonly showLog: (log: CommandLog) => MountedApp;
}

/**
 * Resolves the log's `reasoningSidecar` against the URL the log came from.
 *
 * The frozen schema calls it a *relative* path, so it is resolved relative to
 * the log rather than to the site root: a tournament that publishes logs under
 * `/replays/2026-08/` must be able to put each sidecar beside its own log. An
 * already-rooted path is passed through. Exported because it is the one piece
 * of URL arithmetic here worth pinning, and because getting it wrong fetches
 * somebody else's reasoning.
 */
export function resolveSidecarUrl(logUrl: string, sidecar: string): string {
  // The path arrives inside a *fetched document*, so it is untrusted input.
  // `//evil.example/x.json` is protocol-relative and starts with `/`, so the
  // rooted-path branch below would have handed it straight to `fetch` and the
  // page would have loaded reasoning from another origin -- breaking the
  // offline guarantee and INV-8's "no third-party host" at once. A scheme is
  // refused for the same reason.
  if (sidecar.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(sidecar)) {
    throw new Error(
      `resolveSidecarUrl: refusing an off-origin reasoning sidecar (${sidecar}). The site must render identically offline.`,
    );
  }
  if (sidecar.startsWith('/')) {
    return sidecar;
  }
  const directoryEnd = logUrl.lastIndexOf('/');
  return directoryEnd < 0 ? sidecar : `${logUrl.slice(0, directoryEnd + 1)}${sidecar}`;
}

/** Reported, never swallowed: a decoration that silently failed looks identical to one nobody wired up. */
function warn(what: string, error: unknown): void {
  console.warn(`${what}: ${String(error instanceof Error ? error.message : error)}`);
}

async function fetchJson(globals: BrowserGlobals, url: string): Promise<unknown> {
  const response = await globals.fetch?.(url);
  if (response === undefined) {
    throw new Error(`this environment has no fetch, so ${url} cannot be loaded`);
  }
  if (!response.ok) {
    throw new Error(`could not load ${url} (HTTP ${String(response.status)})`);
  }
  return response.json();
}

async function decodeAll(
  globals: BrowserGlobals,
  urls: readonly string[],
): Promise<Map<string, HTMLImageElementLike>> {
  const images = new Map<string, HTMLImageElementLike>();
  await Promise.all(
    urls.map(async (url) => {
      const element = new (globals.Image as new () => LoadedImage)();
      element.src = url;
      await element.decode();
      images.set(url, element);
    }),
  );
  return images;
}

/** Scenery is the most skippable thing on the page: losing it must never cost the replay. */
async function loadBackdrop(globals: BrowserGlobals): Promise<Backdrop | undefined> {
  try {
    if (globals.Image === undefined) {
      return undefined;
    }
    const layout = validateBackdropLayout(await fetchJson(globals, BACKDROP_LAYOUT_URL));
    return createBackdrop(await decodeAll(globals, layout.layers), layout);
  } catch (error) {
    warn('Backdrop unavailable, the arena will render flat', error);
    return undefined;
  }
}

/**
 * Loads one sprite pack, or returns `undefined`.
 *
 * Returning `undefined` rather than throwing is deliberate. The fighters are
 * the subject of the page but they are not the *claim* it makes -- a browser
 * that cannot decode a sheet should still show a replay whose hash verifies,
 * drawn by the block artist, rather than an error page.
 */
async function loadArtist(
  globals: BrowserGlobals,
  layoutUrl: string,
): Promise<FighterArtist | undefined> {
  try {
    if (globals.Image === undefined) {
      return undefined;
    }
    const layout = validateSpriteSheetLayout(await fetchJson(globals, layoutUrl));

    // Every distinct file the layout names, decoded before the artist is
    // handed over. `decode()` rather than an `onload` race: a sheet that is
    // still decoding when it is drawn paints nothing for its first few frames,
    // which reads as a fighter that failed to appear.
    const urls = [...new Set(Object.values(layout.clips).map((clip) => clip.image))];
    return createSpriteArtist(createSpriteSheet(await decodeAll(globals, urls), layout));
  } catch (error) {
    warn('Sprite sheet unavailable, falling back to the block artist', error);
    return undefined;
  }
}

/**
 * Fetches the reasoning sidecar and hands it to the mounted app.
 *
 * Both outcomes are terminal states of the source, and both are displayed:
 * `ready` shows the reasoning, `unavailable` says it will not arrive. What must
 * never happen is the source sitting in `loading` forever, because that is the
 * state a visitor cannot tell apart from a page that is simply broken (AC4).
 */
async function loadSidecar(
  globals: BrowserGlobals,
  mounted: MountedApp,
  logUrl: string,
  sidecarPath: string,
  matchId: string,
  /**
   * Whether the player this sidecar belongs to is still the one on screen.
   *
   * Story 4.6 makes that a real question: a BYOK Match replaces the player, and
   * its log is a different Match with its own inline reasoning. Adopting the
   * demo's sidecar into it would put one Match's thinking under another
   * Match's fight. The window is small -- the sidecar lands in milliseconds and
   * a BYOK run needs a human -- which is exactly the kind of race that is never
   * reproduced and never fixed once it ships.
   */
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const url = resolveSidecarUrl(logUrl, sidecarPath);
    const sidecar = validateReasoningSidecar(await fetchJson(globals, url), matchId);
    if (!isCurrent()) {
      return;
    }
    mounted.reasoning.adopt(sidecar);
  } catch (error) {
    warn('Reasoning sidecar unavailable', error);
    if (!isCurrent()) {
      return;
    }
    mounted.reasoning.markUnavailable(error instanceof Error ? error.message : String(error));
  }
  mounted.refresh();
}

/**
 * Mounts the BYOK panel, or returns `null` when this page has no host for it.
 *
 * Wrapped, and the failure is a warning rather than a throw, for the same
 * reason the sprite packs are: the replay is the page's claim and the panel is
 * an offer. A visitor whose browser choked on the panel should still get a
 * fight whose hash verifies.
 *
 * The cast is the one `main.ts` already makes for the canvas, for the same
 * reason: `tsconfig.base.json` has no DOM lib, so every host object here is
 * described structurally, and one lookup cannot be typed as two different
 * structural shapes at once. The real `Element` satisfies both.
 */
function mountByok(
  globals: BrowserGlobals,
  mount: (log: CommandLog) => MountedApp,
): ByokPanel | null {
  const host = globals.document?.querySelector('#byok');
  if (host == null) {
    return null;
  }
  try {
    return mountByokPanel(host as unknown as ByokHost, {
      // Absent in a tab with storage blocked and under test alike. The panel
      // treats that as "there is nowhere to remember a key", which is the safe
      // reading of an absent storage rather than a reason to fail.
      storage: globals.localStorage,
      onLog: (log) => {
        mount(log);
      },
    });
  } catch (error) {
    warn('BYOK panel unavailable', error);
    return null;
  }
}

/**
 * The house-style failure card. A player that fails silently looks identical to
 * one still loading.
 *
 * The message is escaped, and that is not decoration. `assertSchemaVersion`
 * interpolates the *fetched document's* own `schemaVersion` into its error, so
 * a log carrying `schemaVersion: "<img src=x onerror=…>"` would previously have
 * put attacker-controlled markup into this page's `innerHTML`. Story 4.6 hands
 * the log source to the visitor, which makes it live rather than theoretical.
 */
function renderFailure(root: MountPoint, error: unknown): void {
  const message = escapeHtml(String(error instanceof Error ? error.message : error));
  root.innerHTML = `
    <header class="tb-masthead"><h1 class="tb-wordmark">Tokenbrawl</h1></header>
    <div class="tb-readout">
      <span class="tb-chip tb-chip--failed">Replay failed</span>
      <span class="tb-chip tb-hash">${message}</span>
    </div>
  `;
}

/**
 * Mounts the page and returns as soon as the fight is running.
 *
 * Note what is *not* awaited before the return: sprites, backdrop, sidecar.
 * Adding an `await` to any of them puts it back on the critical path and
 * re-creates the 14.75 s first frame this story exists to remove.
 */
export async function startup(globals: BrowserGlobals): Promise<StartupResult | null> {
  const root = globals.document?.querySelector('#app');
  const view = globals.window;

  if (root == null || view == null || globals.fetch == null) {
    throw new Error('startup: this environment has no document, window or fetch to mount into.');
  }

  try {
    // Cast, not validation: `buildReplayFilm` routes through
    // `replayCommandLog`, which checks the schema version before it reads any
    // other field and guards every field it then uses (AD-3). Running Ajv here
    // would drag the validator into the bundle for no additional safety.
    const log = (await fetchJson(globals, DEMO_REPLAY_URL)) as CommandLog;

    /**
     * The dressing, held outside any one mount (Story 4.6).
     *
     * A BYOK Match re-mounts the player with a different log, and the sprite
     * packs and backdrop it already decoded belong to the *page*, not to the
     * Match that happened to be on screen when they arrived. Keeping them here
     * means a visitor's own fight is drawn with sprites immediately instead of
     * dropping back to blocks, and means an asset that lands *after* a
     * re-mount reaches the player that is actually on screen.
     *
     * Every slot is filled explicitly rather than left sparse: `drawFrame`
     * falls back from a missing index to index 0, so a half-filled array
     * dresses both fighters in pack one -- a constraint Story 4.2 recorded and
     * 4.4 restated.
     */
    const dressing: {
      artists: (FighterArtist | undefined)[];
      backdrop: Backdrop | undefined;
    } = { artists: [undefined, undefined], backdrop: undefined };
    const player: { mounted: MountedApp } = { mounted: renderApp(root, log, view) };

    /** Re-mounts the player on a new log, stopping the old clock first. */
    const mount = (nextLog: CommandLog): MountedApp => {
      // Without this the previous clock keeps its `requestAnimationFrame` loop
      // alive, painting a canvas that is no longer in the document -- two
      // fights running at once, one of them invisible.
      player.mounted.clock.stop();
      const mounted = renderApp(root, nextLog, view);
      for (const agentIndex of [0, 1] as const) {
        const artist = dressing.artists[agentIndex];
        if (artist !== undefined) {
          mounted.setArtist(agentIndex, artist);
        }
      }
      if (dressing.backdrop !== undefined) {
        mounted.setBackdrop(dressing.backdrop);
      }
      player.mounted = mounted;
      return mounted;
    };

    const upgrades: Promise<void>[] = SPRITE_LAYOUT_URLS.map(async (url, index) => {
      const artist = await loadArtist(globals, url);
      if (artist !== undefined) {
        const agentIndex = index as 0 | 1;
        dressing.artists[agentIndex] = artist;
        player.mounted.setArtist(agentIndex, artist);
      }
    });
    upgrades.push(
      (async (): Promise<void> => {
        const backdrop = await loadBackdrop(globals);
        if (backdrop !== undefined) {
          dressing.backdrop = backdrop;
          player.mounted.setBackdrop(backdrop);
        }
      })(),
    );
    const demoPlayer = player.mounted;
    if (typeof log.reasoningSidecar === 'string' && log.reasoningSidecar.length > 0) {
      upgrades.push(
        loadSidecar(
          globals,
          demoPlayer,
          DEMO_REPLAY_URL,
          log.reasoningSidecar,
          log.matchId,
          () => player.mounted === demoPlayer,
        ),
      );
    }

    return {
      mounted: demoPlayer,
      // `then(() => undefined)` rather than the array: callers await completion,
      // not results, and every upgrade already handles its own failure.
      dressed: Promise.all(upgrades).then(() => undefined),
      byok: mountByok(globals, mount),
      current: (): MountedApp => player.mounted,
      showLog: mount,
    };
  } catch (error) {
    renderFailure(root, error);
    return null;
  }
}
