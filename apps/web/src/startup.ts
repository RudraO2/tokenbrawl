import type { CommandLog } from '@tokenbrawl/contracts';
import { mountArcadePanel, type ArcadeHost, type ArcadePanel } from './arcade/panel';
import { mountByokPanel, type ByokHost, type ByokPanel } from './byok/panel';
import type { KeyStorage } from './byok/keys';
import { escapeHtml, renderApp, type HostView, type MountPoint, type MountedApp } from './main';
import { validateReasoningSidecar } from './replay/sidecar';
import { createSpriteArtist, type FighterArtist } from './render/artist';
import { createBackdrop, validateBackdropLayout, type Backdrop } from './render/backdrop';
import type { AudioSink } from './render/audio';
import { createAudioBus, type AudioContextLike, type AudioFetchResponse } from './render/audio-bus';
import { createSpriteSheet, validateSpriteSheetLayout } from './render/sprite-sheet';
import {
  createRosterSelection,
  spriteLayoutUrlFor,
  type RosterId,
  type RosterPair,
  type RosterSelection,
  type RosterSide,
} from './render/roster';
import {
  createUltSheet,
  imageUrlsFor,
  validateUltSheetLayout,
  type UltSheet,
} from './render/ult-sheet';
import { createVfxSheet, validateVfxSheetLayout, type VfxSheet } from './render/vfx-sheet';
import { mountSpectatePanel, type SpectateHost, type SpectatePanel } from './spectate/panel';
import { mountLandingPanel, type LandingHost, type LandingPanel } from './landing/panel';
import { mountNav, type NavHost } from './shell/nav';
import {
  createScreenRouter,
  type Screen,
  type ScreenElement,
  type ScreenRouter,
  type ShellView,
} from './shell/router';
import { mountSelectPanel, type SelectHost, type SelectPanel } from './shell/select';
import { ROUTE_BYOK, ROUTE_PLAY, ROUTE_REPLAY, ROUTE_WATCH, SCREENS } from './shell/screens';

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
const BACKDROP_LAYOUT_URL = '/sprites/mountain-dusk/layout.json';
/**
 * Story 11.2. The impact FX sheet's strip layout, authored in this repo beside
 * the image it describes. Same-origin like every other asset here, for INV-8's
 * reason: the site must render identically offline.
 */
const FX_LAYOUT_URL = '/fx/layout.json';
/**
 * Story 11.4. The Ultimate's per-character art, described beside the image it
 * cuts cells out of. Same-origin like every other asset here, for INV-8's
 * reason.
 */
const ULT_LAYOUT_URL = '/fx/ult-layout.json';

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
  /**
   * The browser's WebAudio constructor (Story 9.6). Absent in a test, absent in
   * an environment with no WebAudio at all, and `createAudioBus` answers both
   * with `null` -- a player mounted with no sink is silent and identical in
   * every other respect.
   *
   * Declared structurally for the same reason `window` is a `HostView` here
   * rather than a `Window`: `tsconfig.base.json` has no DOM lib and must not
   * gain one.
   */
  readonly AudioContext?: new () => AudioContextLike;
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
  /**
   * The Play-vs-CPU panel, or `null` when the page has no `#arcade` host
   * (Story 9.2). Exposed for the same reason `byok` is.
   */
  readonly arcade: ArcadePanel | null;
  /**
   * The Spectate panel, or `null` when the page has no `#spectate` host
   * (Story 9.3). Exposed for the same reason `byok` and `arcade` are.
   */
  readonly spectate: SpectatePanel | null;
  /**
   * The landing page, or `null` when the page has no `#landing` host (Story
   * 9.8). Exposed for the same reason `byok`, `arcade` and `spectate` are.
   */
  readonly landing: LandingPanel | null;
  /**
   * The character-select screen (Story 12.5), or `null` when the page has no
   * `#select` host. Exposed for the same reason every panel above is.
   */
  readonly select: SelectPanel | null;
  /**
   * Who the visitor chose to play as and against (Story 12.5).
   *
   * Exposed rather than kept private because it is the one piece of page state
   * that outlives every panel: a test asserting that a pick reaches the sprite
   * URLs needs to make the pick, and the arcade's Match, the player's re-mount
   * and the select screen's marks all read this one object.
   */
  readonly selection: RosterSelection;
  /**
   * The screen router (Story 12.4), or `null` in an environment with no
   * `location` to route on -- every test that hands `startup` a bare object,
   * and any embedding without a hash. A page with no router is the pre-12.4
   * page: every panel mounted at once, which is a worse product but not a
   * broken one, and it is the same warn-not-throw degrade every other surface
   * here takes.
   */
  readonly router: ScreenRouter | null;
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
 * Loads the impact FX sheet, or returns `undefined` (Story 11.2).
 *
 * Exactly `loadBackdrop`'s shape, and for a stronger version of the same
 * reason. A hit already reads without it -- `juice-draw.ts` still paints the
 * Story 9.5 scatter squares -- so a sheet that 404s, will not parse, or will
 * not decode must cost the page nothing but its own flash. One warning, then
 * `undefined`, and the fight carries on.
 */
async function loadVfx(globals: BrowserGlobals): Promise<VfxSheet | undefined> {
  try {
    if (globals.Image === undefined) {
      return undefined;
    }
    const layout = validateVfxSheetLayout(await fetchJson(globals, FX_LAYOUT_URL));
    const urls = [...new Set(Object.values(layout.poses).map((pose) => pose.image))];
    return createVfxSheet(await decodeAll(globals, urls), layout);
  } catch (error) {
    warn('Impact FX unavailable, hits will draw as plain sparks', error);
    return undefined;
  }
}

/**
 * Loads the Ultimate's per-character art, or returns `undefined` (Story 11.4).
 *
 * `loadVfx`'s shape, with one difference worth stating: only the images the
 * fighters *in play* need are fetched. The four portraits are ~200 KB each and
 * a live Match shows two fighters, so `imageUrlsFor(layout, pair)` keeps most of
 * a megabyte off a page whose whole first-frame budget is two seconds.
 *
 * Story 12.5 made that sentence's last clause true rather than hypothetical:
 * the pair is a parameter now, and a visitor who chooses gemini gets gemini's
 * portrait fetched and nobody else's. Nothing else here changed, which is what
 * `render/roster.ts`'s docblock promised character select would cost.
 *
 * A failure costs the page nothing but the cutscene's art: `juice-draw.ts`
 * still draws a procedural beam in the caster's aura, and without a roster it
 * draws Story 10.4's banner-and-band. One warning, then `undefined`.
 */
async function loadUlt(globals: BrowserGlobals, pair: RosterPair): Promise<UltSheet | undefined> {
  try {
    if (globals.Image === undefined) {
      return undefined;
    }
    const layout = validateUltSheetLayout(await fetchJson(globals, ULT_LAYOUT_URL));
    const urls = imageUrlsFor(layout, pair);
    return createUltSheet(await decodeAll(globals, urls), layout);
  } catch (error) {
    warn('Ultimate FX unavailable, the cinematic will draw without per-character art', error);
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
 * Mounts the Play-vs-CPU panel, or returns `null` when this page has no host
 * for it. Mirrors `mountByok` exactly, including the warn-not-throw failure
 * mode: the replay is the page's claim and the panel is an offer.
 *
 * `buildArcadeCommandLog` produces a v2 `CommandLogV2` -- a human `Agent`
 * has nowhere to go in the frozen v1 `AgentIdentity` shape -- so the value
 * handed to `mount` here is cast, the same way `startup()` below casts the
 * fetched demo document rather than re-validating it. This is no longer a
 * lie: `mount()` calls `renderApp`, which calls `mountPlayer`, which builds
 * the film through `buildReplayFilm` -- and that function now dispatches on
 * `schemaVersion`, routing a v2 document to `replayCommandLogV2` instead of
 * hard-failing it the way the v1-only reader once did. A v2 arcade log
 * therefore replays through exactly the same player a v1 log does, with no
 * arcade-specific branch anywhere in `main.ts` or `film.ts`'s public shape.
 */
function mountArcade(
  globals: BrowserGlobals,
  mount: (log: CommandLog) => MountedApp,
  /** Story 12.2. The page's view, for the live arena's animation-frame clock. */
  view: HostView,
): ArcadePanel | null {
  const host = globals.document?.querySelector('#arcade');
  if (host == null) {
    return null;
  }
  try {
    return mountArcadePanel(host as unknown as ArcadeHost, {
      // Story 12.2. The live view draws the fight while it is being played,
      // through the same `drawJuicedFrame` the replay player uses. Handed the
      // page's view so its clock can count animation-frame callbacks.
      view,
      onLog: (log) => {
        // `mount` routes through `buildReplayFilm`, which can throw (e.g. an
        // unrecognised schema version). Left unwrapped, that throw escaped
        // `onLog` as an unhandled rejection instead of reaching the page's
        // usual failure card (P1).
        try {
          mount(log as unknown as CommandLog);
        } catch (error) {
          warn('Arcade Match could not be replayed', error);
        }
      },
    });
  } catch (error) {
    warn('Arcade panel unavailable', error);
    return null;
  }
}

/**
 * Mounts the Spectate panel, or returns `null` when this page has no host
 * for it. Mirrors `mountByok`/`mountArcade`'s warn-not-throw shape: the
 * ambient stream is an offer, not the page's central claim, so a browser
 * that could not start it must still show the demo replay.
 *
 * Unlike BYOK and Arcade, this panel never calls back into `mount`: it owns
 * its own film/clock sequence entirely (`spectate/walk.ts`) rather than
 * replacing the `#app` player.
 */
function mountSpectate(
  globals: BrowserGlobals,
  onGesture: () => void,
  /** Story 11.6. The page's one graph, shared with the player -- see `spectate/panel.ts` on who owns it when. */
  sink: AudioSink | null,
): SpectatePanel | null {
  const host = globals.document?.querySelector('#spectate');
  const view = globals.window;
  if (host == null || view == null || globals.fetch == null) {
    return null;
  }
  try {
    return mountSpectatePanel(host as unknown as SpectateHost, {
      view,
      // Story 9.6: a visitor whose only gesture is picking a Match here would
      // otherwise leave the page's audio context suspended for the rest of the
      // session. Story 11.6 gives this panel sound of its own, so the same hook
      // now also unlocks the context for the stream itself.
      onGesture,
      sink,
      // Not `globals.fetch` handed through directly: a real browser's
      // `fetch` is a WebIDL operation branded to `Window`, and extracting it
      // as a bare reference detaches that binding. `startup.ts`'s own
      // `fetchJson` never hits this because it always calls
      // `globals.fetch?.(url)` -- a member-access call, which keeps `this`
      // bound to `globals`. `spectate/panel.ts` and `spectate/walk.ts`,
      // downstream, call their injected `fetch` as `deps.fetch(url)` --
      // also a member-access call, but bound to *their own* `deps` object
      // instead, which is exactly the mismatched receiver that throws
      // "Illegal invocation". Wrapping it in an arrow function here, whose
      // own body performs the correctly-bound call, is what keeps the
      // binding correct no matter how many object-shaped layers later call
      // through it. Found via the Story 9.3 live browser check: every
      // manifest-entry fetch failed with this error while the manifest
      // fetch itself (invoked one call-shape earlier) happened to survive.
      fetch: (url: string) => globals.fetch!(url),
    });
  } catch (error) {
    warn('Spectate panel unavailable', error);
    return null;
  }
}

/**
 * Mounts the landing page, or returns `null` when this page has no host for
 * it. Mirrors `mountByok`/`mountArcade`/`mountSpectate`'s warn-not-throw
 * shape: the pitch is an entry point, not the page's central claim, so a
 * browser that could not start it must still show the demo replay beneath.
 *
 * The two CTAs are deliberately thin here: "Play vs CPU" calls the real
 * Arcade panel's own `play()` (the same Match `arcadeMarkup`'s own button
 * starts); "Watch Spectate" only navigates, since the Spectate stream starts
 * itself the moment its screen is shown. Neither duplicates panel logic --
 * `landing/panel.ts` never imports `ArcadePanel` or `SpectatePanel`, only
 * these two callbacks.
 *
 * Story 12.4 turned both from scrolls into routes, which is the change the
 * story is named for: `scrollTo('#arcade')` was the honest expression of a
 * page that was five stacked panels, and a cabinet has screens instead.
 * Navigation happens *before* `play()`, not after -- the live arena will not
 * paint while its screen is hidden, so starting the Match first would drop the
 * opening frames on the floor.
 */
function mountLanding(
  globals: BrowserGlobals,
  arcade: ArcadePanel | null,
  onGesture: () => void,
  navigate: (route: string) => void,
): LandingPanel | null {
  const host = globals.document?.querySelector('#landing');
  if (host == null || globals.fetch == null) {
    return null;
  }
  try {
    return mountLandingPanel(host as unknown as LandingHost, {
      fetch: (url: string) => globals.fetch!(url),
      onWarning: (message) => {
        warn('Landing page', message);
      },
      onPlayCta: () => {
        onGesture();
        navigate(ROUTE_PLAY);
        if (arcade === null) {
          warn('Landing page', 'Play vs CPU is unavailable: the Arcade panel did not mount.');
        } else {
          arcade.play();
        }
      },
      onSpectateCta: () => {
        onGesture();
        navigate(ROUTE_WATCH);
      },
    });
  } catch (error) {
    warn('Landing panel unavailable', error);
    return null;
  }
}

/**
 * Mounts the character-select screen, or returns `null` when this page has no
 * `#select` host (Story 12.5). Mirrors every other mount here, warn-not-throw
 * included.
 *
 * The two callbacks are deliberately thin, exactly as the landing CTAs are:
 * `shell/select.ts` never imports `ArcadePanel`, so the screen knows how to
 * offer a roster and nothing whatever about how a Match starts. Navigation
 * happens *before* `play()` for the reason `mountLanding` records -- the live
 * arena does not paint while its screen is hidden, so starting the Match first
 * would drop its opening frames on the floor.
 */
function mountSelect(
  globals: BrowserGlobals,
  selection: RosterSelection,
  arcade: ArcadePanel | null,
  onGesture: () => void,
  navigate: (route: string) => void,
): SelectPanel | null {
  const host = globals.document?.querySelector('#select');
  if (host == null) {
    return null;
  }
  try {
    return mountSelectPanel(host as unknown as SelectHost, {
      pair: () => selection.pair(),
      onPick: (side: RosterSide, id: RosterId) => {
        selection.select(side, id);
      },
      onFight: () => {
        onGesture();
        navigate(ROUTE_PLAY);
        if (arcade === null) {
          warn('Character select', 'Play vs CPU is unavailable: the Arcade panel did not mount.');
        } else {
          arcade.play();
        }
      },
    });
  } catch (error) {
    warn('Character select unavailable', error);
    return null;
  }
}

/**
 * Builds the screen router and the nav strip, or returns `null` when this
 * environment has no hash to route on (Story 12.4).
 *
 * `null` is a supported configuration rather than a failure, and it is the one
 * every existing test is in: `startup.test.ts` hands this function a bare
 * object with `document`, `window` and `fetch` and nothing else. A page with no
 * router is the pre-12.4 page -- every panel mounted at once -- which is a
 * worse product but not a broken one, so this degrades the same warn-not-throw
 * way every asset here does.
 *
 * The cast is the boundary one this file already makes for every host object:
 * `tsconfig.base.json` has no DOM lib, so `globals.window` is declared as the
 * shape the *player* needs of it (`HostView`: two animation-frame methods) and
 * the router needs a different one. One lookup cannot be typed as two
 * structural shapes at once; the real `Window` satisfies both.
 */
function mountRouter(globals: BrowserGlobals, screens: readonly Screen[]): ScreenRouter | null {
  const shellView = globals.window as unknown as Partial<ShellView> | undefined;
  if (
    shellView == null ||
    typeof shellView.addEventListener !== 'function' ||
    shellView.location == null ||
    typeof shellView.location.hash !== 'string'
  ) {
    return null;
  }
  try {
    const navHost = globals.document?.querySelector('#screen-nav') as unknown as NavHost | null;
    // A nav that could not mount must not cost the visitor the router: the
    // links are one way to reach a screen, the URL is another, and the
    // callbacks the panels hold are a third.
    const markCurrent =
      navHost == null || typeof navHost.querySelectorAll !== 'function'
        ? null
        : mountNav(
            navHost,
            screens.map((screen) => ({ route: screen.route, label: screen.label })),
          );
    return createScreenRouter({
      view: shellView as ShellView,
      screens,
      ...(markCurrent === null ? {} : { onRoute: markCurrent }),
    });
  } catch (error) {
    warn('Screen router unavailable, every panel will show at once', error);
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
     * Who is fighting, and the box a choice travels through (Story 12.5).
     *
     * The selection is built first because the dressing below is initialised
     * from it, and its `onChange` is routed through a box for the reason
     * `shell.router` is one: reacting to a pick means fetching that fighter's
     * sprite pack and Ultimate art, and those functions need the dressing that
     * needs the selection. A box breaks the cycle without turning either into a
     * module-level binding.
     */
    const chosen: { apply: (pair: RosterPair) => void } = {
      apply: () => {
        // Replaced below, once there is something to dress. A pick that
        // arrived before then would be a pick made on a screen that has not
        // mounted, so doing nothing is the honest answer rather than a throw.
      },
    };
    const selection = createRosterSelection({
      onChange: (pair) => {
        chosen.apply(pair);
      },
    });

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
      /** Story 11.2. The impact FX sheet, held here so a re-mount keeps it. */
      vfx: VfxSheet | undefined;
      /** Story 11.4. The Ultimate's per-character art, held for the same reason. */
      ult: UltSheet | undefined;
      /**
       * Story 12.5. Who the visitor chose to play as, held here for exactly the
       * reason the sheets above are: it belongs to the *page*, so a Match that
       * re-mounts the player keeps it and a surface mounted later adopts it.
       */
      roster: RosterPair;
    } = {
      artists: [undefined, undefined],
      backdrop: undefined,
      vfx: undefined,
      ult: undefined,
      roster: selection.pair(),
    };
    /**
     * The audio graph, built once and held outside any one mount (Story 9.6),
     * for exactly the reason the dressing above is: a BYOK or Arcade Match
     * re-mounts the player, and the three buses belong to the *page*. Building
     * a context per mount would leave every previous Match's graph alive and
     * ungovernable.
     *
     * `null` on a browser with no WebAudio, and `null` under test. The cast is
     * the boundary one: `startup.ts` describes a response as the shape *it*
     * needs (`json()`), and the audio loader needs a different one
     * (`arrayBuffer()`). One lookup cannot be typed as two structural shapes at
     * once; the real `Response` satisfies both, and the loader treats a missing
     * method as one more absent cue.
     */
    const sink = createAudioBus({
      AudioContext: globals.AudioContext,
      fetch: (url: string) =>
        globals.fetch!(url) as unknown as Promise<AudioFetchResponse>,
    });

    const player: { mounted: MountedApp } = { mounted: renderApp(root, log, view, sink) };

    /**
     * The router, once it exists (Story 12.4).
     *
     * Held in a box for the same reason `panels` below is: `mount` is created
     * before the router -- the router's screen callbacks need the panel handles,
     * and the panels need `mount` -- and a finished Match has to be able to
     * navigate to the screen it re-mounted on.
     */
    const shell: { router: ScreenRouter | null } = { router: null };

    /** Re-mounts the player on a new log, stopping the old clock first. */
    const mount = (nextLog: CommandLog): MountedApp => {
      // Without this the previous clock keeps its `requestAnimationFrame` loop
      // alive, painting a canvas that is no longer in the document -- two
      // fights running at once, one of them invisible.
      player.mounted.clock.stop();
      // A re-mount is always downstream of a gesture in a panel `main.ts` does
      // not bind (BYOK's Run, Arcade's Play), so this is where those gestures
      // reach the audio context. `mountPlayer` stops the outgoing Match's
      // sources; this resumes a context that was never unlocked.
      sink?.unlock();
      // The same sink, not a new one: one graph per page (Story 9.6).
      const mounted = renderApp(root, nextLog, view, sink);
      for (const agentIndex of [0, 1] as const) {
        const artist = dressing.artists[agentIndex];
        if (artist !== undefined) {
          mounted.setArtist(agentIndex, artist);
        }
      }
      if (dressing.backdrop !== undefined) {
        mounted.setBackdrop(dressing.backdrop);
      }
      if (dressing.vfx !== undefined) {
        mounted.setVfx(dressing.vfx);
      }
      if (dressing.ult !== undefined) {
        mounted.setUlt(dressing.ult);
      }
      // Story 12.5. Always set rather than guarded: there is always a pair, and
      // a re-mounted player that kept `DEFAULT_ROSTER` would draw the arcade
      // Match the visitor just played as somebody else the moment its replay
      // threw an Ultimate.
      mounted.setRoster(dressing.roster);
      player.mounted = mounted;
      // Story 12.4. Show the visitor the fight they just finished. Before the
      // router this was a re-mount into whatever section they happened to be
      // scrolled to; on a cabinet, a completed Match that re-mounts on a screen
      // nobody is on is a replay played to an empty room.
      //
      // Only from the screen that started it. An arcade Match keeps running
      // while its screen is hidden -- that is deliberate (`live.ts`: states
      // keep arriving, only the pixels stop) -- so a visitor who wandered off
      // to Spectate would otherwise be yanked onto the Replay screen mid-watch
      // by a fight they had already left. An independent review of this story
      // found it; it also made the gate order-dependent, since a Match
      // completing mid-sweep would navigate out from under the running check.
      const at = shell.router?.current();
      if (at === ROUTE_PLAY || at === ROUTE_BYOK) {
        shell.router?.go(ROUTE_REPLAY);
      }
      return mounted;
    };

    /**
     * The Spectate panel, once it exists.
     *
     * Held in a box rather than read from a `const` because the upgrade
     * closures below are created *before* `mountSpectate` runs, and a decoded
     * pack has to reach whichever surfaces are on screen when it lands. The
     * panel draws its own canvas outside `renderApp`, so unlike BYOK and Arcade
     * -- which re-mount through `mount` and are dressed by it at line ~577 --
     * nothing else would ever hand it the art.
     */
    const panels: { spectate: SpectatePanel | null; arcade: ArcadePanel | null } = {
      spectate: null,
      arcade: null,
    };

    /** Records a decoded pack on the page and pushes it to every live surface. */
    const dressArtist = (agentIndex: 0 | 1, artist: FighterArtist): void => {
      dressing.artists[agentIndex] = artist;
      player.mounted.setArtist(agentIndex, artist);
      panels.spectate?.setArtist(agentIndex, artist);
      // Story 12.2. The Arcade live view draws through the same compositor now,
      // so a pack that reached only the player would leave a live Match on the
      // block artist for the whole session.
      panels.arcade?.setArtist(agentIndex, artist);
    };
    const dressBackdrop = (backdrop: Backdrop): void => {
      dressing.backdrop = backdrop;
      player.mounted.setBackdrop(backdrop);
      panels.spectate?.setBackdrop(backdrop);
      panels.arcade?.setBackdrop(backdrop);
    };
    /**
     * Story 11.2, widened by Story 11.6: both live surfaces, not the player
     * alone. Spectate paints through the same `drawJuicedFrame` now, so a sheet
     * that reached only the player would leave the ambient stream drawing the
     * square-spark fallback for the whole session.
     */
    const dressVfx = (vfx: VfxSheet): void => {
      dressing.vfx = vfx;
      player.mounted.setVfx(vfx);
      panels.spectate?.setVfx(vfx);
      // Story 12.2. The Arcade live view too, for the reason above.
      panels.arcade?.setVfx(vfx);
    };
    /** Story 11.4, widened by Story 11.6 for the reason `dressVfx` gives. */
    const dressUlt = (ult: UltSheet): void => {
      dressing.ult = ult;
      player.mounted.setUlt(ult);
      panels.spectate?.setUlt(ult);
      panels.arcade?.setUlt(ult);
    };
    /**
     * Story 12.5. Who the two fighters are drawn as, pushed to the surfaces a
     * choice can reach.
     *
     * **Not** Spectate. Its entries are fixed by their committed Command Logs
     * and the pair drawn there is a property of the log, not of the visitor --
     * a stream that changed characters when somebody browsed the roster would
     * be describing a Match that never happened.
     */
    const dressRoster = (pair: RosterPair): void => {
      dressing.roster = pair;
      player.mounted.setRoster(pair);
      panels.arcade?.setRoster(pair);
    };

    /**
     * Fetches the chosen pair's sprite packs and Ultimate art, and dresses every
     * live surface with them.
     *
     * The generation counter is the part worth reading. A visitor clicking
     * across the roster starts a fetch per pick, and those land in whatever
     * order the network gives them: without this, picking gemini and then grokk
     * could dress the fight as gemini, because gemini's pack resolved second.
     * A stale load is dropped rather than cancelled -- the browser's cache keeps
     * what it fetched, so re-picking is free.
     */
    const art: { generation: number } = { generation: 0 };
    const loadRosterArt = async (pair: RosterPair): Promise<void> => {
      art.generation += 1;
      const generation = art.generation;
      const current = (): boolean => art.generation === generation;
      await Promise.all([
        ...pair.map(async (id, index) => {
          const artist = await loadArtist(globals, spriteLayoutUrlFor(id));
          if (artist !== undefined && current()) {
            dressArtist(index as 0 | 1, artist);
          }
        }),
        (async (): Promise<void> => {
          const ult = await loadUlt(globals, pair);
          if (ult !== undefined && current()) {
            dressUlt(ult);
          }
        })(),
      ]);
    };

    // The box declared above, now that there is something to dress. A pick
    // re-dresses immediately -- while the visitor is still on the select screen
    // -- rather than when they press Fight, so the packs are decoded by the time
    // the Match starts instead of swapping in mid-fight.
    chosen.apply = (pair: RosterPair): void => {
      dressRoster(pair);
      void loadRosterArt(pair);
    };

    const upgrades: Promise<void>[] = [loadRosterArt(selection.pair())];
    upgrades.push(
      (async (): Promise<void> => {
        const backdrop = await loadBackdrop(globals);
        if (backdrop !== undefined) {
          dressBackdrop(backdrop);
        }
      })(),
    );
    upgrades.push(
      (async (): Promise<void> => {
        const vfx = await loadVfx(globals);
        if (vfx !== undefined) {
          dressVfx(vfx);
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

    const arcadePanel = mountArcade(globals, mount, view);
    panels.arcade = arcadePanel;
    // Adopt whatever already landed, for the reason the Spectate block below
    // gives: the upgrades started before this mount, so on a warm cache a pack
    // resolves first and is recorded in `dressing` and pushed to nobody -- a
    // live Arcade Match would then draw blocks precisely when the assets loaded
    // fastest. The dressing lives on the panel's live arena, so this is correct
    // even though the arena's canvas is not on screen until the visitor plays.
    if (arcadePanel !== null) {
      for (const agentIndex of [0, 1] as const) {
        const artist = dressing.artists[agentIndex];
        if (artist !== undefined) {
          arcadePanel.setArtist(agentIndex, artist);
        }
      }
      if (dressing.backdrop !== undefined) {
        arcadePanel.setBackdrop(dressing.backdrop);
      }
      if (dressing.vfx !== undefined) {
        arcadePanel.setVfx(dressing.vfx);
      }
      if (dressing.ult !== undefined) {
        arcadePanel.setUlt(dressing.ult);
      }
      // Story 12.5, and unconditional for the reason the re-mount above is: a
      // live arena left on `DEFAULT_ROSTER` would draw the visitor's chosen
      // fighter's sprites under clawde's aura and clawde's name.
      arcadePanel.setRoster(dressing.roster);
    }
    const spectatePanel = mountSpectate(
      globals,
      () => {
        sink?.unlock();
      },
      sink,
    );
    panels.spectate = spectatePanel;
    // Adopt whatever already landed. The upgrades started before this mount, so
    // on a warm cache a pack can resolve first and would otherwise be recorded
    // in `dressing` and pushed to nobody -- Spectate would then play as blocks
    // for the whole session precisely when the assets loaded *fastest*.
    if (spectatePanel !== null) {
      for (const agentIndex of [0, 1] as const) {
        const artist = dressing.artists[agentIndex];
        if (artist !== undefined) {
          spectatePanel.setArtist(agentIndex, artist);
        }
      }
      if (dressing.backdrop !== undefined) {
        spectatePanel.setBackdrop(dressing.backdrop);
      }
      // Story 11.6. The two sheets adopt on exactly the same terms the packs
      // and the backdrop do -- a warm cache resolves them before this mount,
      // and a surface dressed only by the *later* of the two paths is dressed
      // by neither when the assets load fastest.
      if (dressing.vfx !== undefined) {
        spectatePanel.setVfx(dressing.vfx);
      }
      if (dressing.ult !== undefined) {
        spectatePanel.setUlt(dressing.ult);
      }
    }
    const landingPanel = mountLanding(
      globals,
      arcadePanel,
      () => {
        sink?.unlock();
      },
      (route: string) => {
        shell.router?.go(route);
      },
    );
    const selectPanel = mountSelect(
      globals,
      selection,
      arcadePanel,
      () => {
        sink?.unlock();
      },
      (route: string) => {
        shell.router?.go(route);
      },
    );
    const byokPanel = mountByok(globals, mount);

    // --- Story 12.4: the cabinet -------------------------------------------
    //
    // Built last, because every screen callback below needs a panel handle and
    // every panel needed `mount`. The router applies the current hash on
    // construction, so the first thing it does is stop the four clocks the
    // mounts above just started -- which is the point of the story that is not
    // about layout.
    //
    // What each screen does when it is hidden is written here rather than in
    // `router.ts` for the same reason the CTAs are two callbacks rather than a
    // panel import: this is the one file that already holds every handle, and
    // the router must not learn what a Spectate walk or a playback clock is.
    const watch = {
      playing: spectatePanel?.isPlaying() ?? false,
      /**
       * Whether Spectate was driving the page's audio when its screen was
       * hidden (Story 12.4).
       *
       * The stream's music bed is a looping source: pausing the walk stops new
       * cues from starting but leaves the bed running, so a visitor who turned
       * sound on and navigated away kept hearing Spectate from a screen they
       * could not see. An independent review of this story found it.
       *
       * `setAudioEnabled` is the fix rather than a bare `sink.stopAll()`,
       * because the panel's own toggle already owns both edges of this: turning
       * it off calls `stopAll`, turning it back on re-arms the director from
       * frame zero (`spectate/panel.ts`). Reusing it means the returning
       * visitor gets their bed back rather than silence.
       */
      audible: false,
    };
    const screens: Screen[] = SCREENS.map((spec) => {
      const element = (globals.document?.querySelector(spec.selector) ??
        null) as unknown as ScreenElement | null;
      const base = { route: spec.route, label: spec.label, element };
      if (spec.route === ROUTE_PLAY) {
        return {
          ...base,
          onShow: (): void => {
            arcadePanel?.setPaused(false);
          },
          onHide: (): void => {
            arcadePanel?.setPaused(true);
          },
        };
      }
      if (spec.route === ROUTE_WATCH) {
        return {
          ...base,
          onShow: (): void => {
            spectatePanel?.setPlaying(watch.playing);
            spectatePanel?.setAudioEnabled(watch.audible);
          },
          onHide: (): void => {
            // Remembered, not assumed: a visitor who paused the stream or
            // muted it and navigated away must not come back to it playing or
            // to sound they had turned off.
            watch.playing = spectatePanel?.isPlaying() ?? watch.playing;
            watch.audible = spectatePanel?.audioEnabled() ?? watch.audible;
            spectatePanel?.setPlaying(false);
            // The looping bed outlives a paused walk; this is what actually
            // makes "a hidden screen makes no sound" true.
            spectatePanel?.setAudioEnabled(false);
          },
        };
      }
      if (spec.route === ROUTE_REPLAY) {
        return {
          ...base,
          // `resume` rather than `start`: `start` rewinds (see `player/clock.ts`),
          // so returning to this screen would restart the Match from frame zero
          // rather than continue it.
          onShow: (): void => {
            player.mounted.clock.resume();
          },
          onHide: (): void => {
            player.mounted.clock.stop();
            // A stopped clock starts no new cue, but the music bed is a
            // *looping* source begun at clock frame 0 (`render/audio.ts`) and
            // outlives the clock that started it. Stopping the graph is what
            // makes "a hidden screen makes no sound" true here. Safe against
            // the incoming screen because every `onHide` runs before any
            // `onShow` -- see `shell/router.ts`.
            //
            // The cost is that a visitor returning mid-film gets the fight
            // back without its bed, because the bed's cue is at frame 0 and
            // there is no verb for "re-arm the music". Deferred to `12-9`,
            // which owns audio defaults and is where that verb belongs.
            sink?.stopAll();
          },
        };
      }
      // `#landing`, `#select` and `#byok` paint nothing and make no sound, so
      // there is nothing for them to stop. Left without callbacks rather than
      // given empty ones, so a screen that grows a clock has to say so.
      return base;
    });
    shell.router = mountRouter(globals, screens);

    return {
      mounted: demoPlayer,
      // `then(() => undefined)` rather than the array: callers await completion,
      // not results, and every upgrade already handles its own failure.
      dressed: Promise.all(upgrades).then(() => undefined),
      byok: byokPanel,
      arcade: arcadePanel,
      spectate: spectatePanel,
      landing: landingPanel,
      select: selectPanel,
      selection,
      router: shell.router,
      current: (): MountedApp => player.mounted,
      showLog: mount,
    };
  } catch (error) {
    renderFailure(root, error);
    return null;
  }
}
