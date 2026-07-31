import type { CommandLog } from '@tokenbrawl/contracts';
import { renderApp, type HostView, type MountPoint } from './main';
import { createSpriteArtist, type FighterArtist } from './render/artist';
import { createBackdrop, validateBackdropLayout, type Backdrop } from './render/backdrop';
import { createSpriteSheet, validateSpriteSheetLayout } from './render/sprite-sheet';

/**
 * The page entry point, and the only file that touches a global.
 *
 * Split from `main.ts` so that module carries no top-level side effect and can
 * be imported by a test without mounting anything. Everything here is the
 * bootstrap: build a log, hand it to `renderApp`, and put a failure on the page
 * rather than in a console nobody opens.
 *
 * `document` and `window` are reached through `globalThis` rather than as bare
 * identifiers, the same way `packages/providers/src/http.ts` resolves `fetch`.
 * `tsconfig.base.json` has no DOM lib and must not gain one -- that would hand
 * `packages/core` ambient `document` and `window` types, weakening the
 * type-level half of INV-3 repo-wide -- so the globals are narrowed here
 * instead, at the one boundary that genuinely needs them.
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
const DEMO_REPLAY_URL = '/replays/demo.command-log.json';
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

interface BrowserGlobals {
  readonly document?: { querySelector(selectors: string): MountPoint | null };
  readonly window?: HostView;
  readonly fetch?: (url: string) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
  readonly Image?: new () => LoadedImage;
}

/**
 * Loads the sprite sheet, or returns `null`.
 *
 * Returning `null` rather than throwing is deliberate. The fighters are the
 * subject of the page but they are not the *claim* it makes -- a browser that
 * cannot decode the sheet should still show a replay whose hash verifies, drawn
 * by the block artist, rather than an error page. The one thing that must never
 * happen is silence, so the reason is reported.
 */
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
    const response = await globals.fetch?.(BACKDROP_LAYOUT_URL);
    if (response === undefined || !response.ok || globals.Image === undefined) {
      return undefined;
    }
    const layout = validateBackdropLayout(await response.json());
    return createBackdrop(await decodeAll(globals, layout.layers), layout);
  } catch (error) {
    console.warn(
      `Backdrop unavailable, the arena will render flat: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
    return undefined;
  }
}

async function loadArtist(globals: BrowserGlobals, layoutUrl: string): Promise<FighterArtist | undefined> {
  try {
    const response = await globals.fetch?.(layoutUrl);
    if (response === undefined || !response.ok) {
      return undefined;
    }
    const layout = validateSpriteSheetLayout(await response.json());

    if (globals.Image === undefined) {
      return undefined;
    }

    // Every distinct file the layout names, decoded before the first frame is
    // drawn. `decode()` rather than an `onload` race: a sheet that is still
    // decoding when playback starts draws nothing for its first few frames,
    // which reads as a fighter that failed to appear.
    const urls = [...new Set(Object.values(layout.clips).map((clip) => clip.image))];
    return createSpriteArtist(createSpriteSheet(await decodeAll(globals, urls), layout));
  } catch (error) {
    // Reported, not swallowed: a sheet that silently failed to load looks
    // identical to one nobody ever wired up.
    console.warn(
      `Sprite sheet unavailable, falling back to the block artist: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
    return undefined;
  }
}

async function boot(): Promise<void> {
  const globals = globalThis as unknown as BrowserGlobals;
  const root = globals.document?.querySelector('#app');
  const view = globals.window;

  if (root == null || view == null || globals.fetch == null) {
    throw new Error('boot: this environment has no document, window or fetch to mount into.');
  }

  try {
    const response = await globals.fetch(DEMO_REPLAY_URL);
    if (!response.ok) {
      throw new Error(
        `could not load ${DEMO_REPLAY_URL} (HTTP ${String(response.status)})`,
      );
    }
    // Cast, not validation: `buildReplayFilm` routes through
    // `replayCommandLog`, which checks the schema version before it reads any
    // other field and guards every field it then uses (AD-3). Running Ajv here
    // would drag the validator into the bundle for no additional safety.
    const log = (await response.json()) as CommandLog;
    const artists = (
      await Promise.all(SPRITE_LAYOUT_URLS.map((url) => loadArtist(globals, url)))
    ).filter((artist): artist is FighterArtist => artist !== undefined);
    renderApp(root, log, view, artists, await loadBackdrop(globals));
  } catch (error) {
    // A player that fails silently looks identical to one that is still
    // loading. Say what went wrong, on the page, in the house style.
    root.innerHTML = `
      <header class="tb-masthead"><h1 class="tb-wordmark">Tokenbrawl</h1></header>
      <div class="tb-readout">
        <span class="tb-chip tb-chip--failed">Replay failed</span>
        <span class="tb-chip tb-hash">${String(error instanceof Error ? error.message : error)}</span>
      </div>
    `;
  }
}

void boot();
