import type { CommandLog } from '@tokenbrawl/contracts';
import { renderApp, type HostView, type MountPoint, type MountedApp } from './main';
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
  readonly document?: { querySelector(selectors: string): MountPoint | null };
  readonly window?: HostView;
  readonly fetch?: (url: string) => Promise<FetchResponse>;
  readonly Image?: new () => LoadedImage;
}

export interface StartupResult {
  readonly mounted: MountedApp;
  /** Settles once every decoration has arrived or failed. Never awaited on the page. */
  readonly dressed: Promise<void>;
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
): Promise<void> {
  const url = resolveSidecarUrl(logUrl, sidecarPath);
  try {
    mounted.reasoning.adopt(validateReasoningSidecar(await fetchJson(globals, url), matchId));
  } catch (error) {
    warn('Reasoning sidecar unavailable', error);
    mounted.reasoning.markUnavailable(error instanceof Error ? error.message : String(error));
  }
  mounted.refresh();
}

/** The house-style failure card. A player that fails silently looks identical to one still loading. */
function renderFailure(root: MountPoint, error: unknown): void {
  root.innerHTML = `
    <header class="tb-masthead"><h1 class="tb-wordmark">Tokenbrawl</h1></header>
    <div class="tb-readout">
      <span class="tb-chip tb-chip--failed">Replay failed</span>
      <span class="tb-chip tb-hash">${String(error instanceof Error ? error.message : error)}</span>
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
    const mounted = renderApp(root, log, view);

    const upgrades: Promise<void>[] = SPRITE_LAYOUT_URLS.map(async (url, agentIndex) => {
      const artist = await loadArtist(globals, url);
      if (artist !== undefined) {
        mounted.setArtist(agentIndex as 0 | 1, artist);
      }
    });
    upgrades.push(
      (async (): Promise<void> => {
        const backdrop = await loadBackdrop(globals);
        if (backdrop !== undefined) {
          mounted.setBackdrop(backdrop);
        }
      })(),
    );
    if (typeof log.reasoningSidecar === 'string' && log.reasoningSidecar.length > 0) {
      upgrades.push(
        loadSidecar(globals, mounted, DEMO_REPLAY_URL, log.reasoningSidecar, log.matchId),
      );
    }

    return {
      mounted,
      // `then(() => undefined)` rather than the array: callers await completion,
      // not results, and every upgrade already handles its own failure.
      dressed: Promise.all(upgrades).then(() => undefined),
    };
  } catch (error) {
    renderFailure(root, error);
    return null;
  }
}
