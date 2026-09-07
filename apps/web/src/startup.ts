import type { CommandLog } from '@tokenbrawl/contracts';
import { mountPlayPanel, type PlayHost, type PlayPanel } from './cabinet/panel';
import type { CabinetId } from './cabinet/roster';
import { mountByokPanel, type ByokHost, type ByokPanel } from './byok/panel';
import type { KeyStorage } from './byok/keys';
import { escapeHtml, renderApp, type HostView, type MountPoint, type MountedApp } from './main';
import { validateReasoningSidecar } from './replay/sidecar';
import {
  createSpriteArtist,
  type FighterArtist,
  type HitFlash,
  type HitFlashSource,
} from './render/artist';
import { createBackdrop, validateBackdropLayout, type Backdrop } from './render/backdrop';
import { createGatedSink, type AudioSink } from './render/audio';
import { createAudioBus, type AudioContextLike, type AudioFetchResponse } from './render/audio-bus';
import { createSpriteSheet, validateSpriteSheetLayout } from './render/sprite-sheet';
import {
  DEFAULT_ROSTER,
  createRosterSelection,
  spriteLayoutUrlFor,
  type RosterId,
  type RosterPair,
  type RosterSelection,
  type RosterSide,
} from './render/roster';
import {
  createStageSelection,
  stageForSeed,
  stageLayoutUrlFor,
  type StageId,
  type StageSelection,
} from './render/stages';
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
import { mountSoundControl, type SoundControl, type SoundHost } from './shell/sound';
import {
  createScreenRouter,
  type Screen,
  type ScreenElement,
  type ScreenRouter,
  type ShellView,
} from './shell/router';
import { mountSelectPanel, type SelectHost, type SelectPanel } from './shell/select';
import { ROUTE_BYOK, ROUTE_PLAY, ROUTE_REPLAY, ROUTE_SELECT, ROUTE_WATCH, SCREENS } from './shell/screens';

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

/**
 * The flagship replay the player opens on. Same-origin, so it is covered by the
 * no-remote-asset sweep in `style-discipline.test.ts`.
 *
 * **Story 12.12 repointed this**, from `demo.command-log.json` -- a Baseline Bot
 * against a Baseline Bot -- to the exhibition Match between two language models.
 * The page's own description meta claims "language models fighting under a fixed
 * token budget", and until this story the first thing a visitor saw was two
 * scripted bots with `reasoning: null` on every one of their decisions. Story
 * 4.3's hover reasoning is `docs/stories/README.md`'s stated centrepiece feature
 * and a visitor hovering a Decision Point got nothing, because there was nothing
 * in the corpus for it to show.
 *
 * The constant keeps its name. `demo` is what this slot *is* -- the demonstration
 * replay the page mounts before a visitor chooses anything -- and renaming it
 * would touch `startup.test.ts`'s four call sites and `spectate/manifest.ts`'s and
 * `landing/leaderboard-view.ts`'s docblocks to say the same thing differently.
 *
 * `demo.command-log.json` is still committed and still built by
 * `src/testing/demo-log.ts`: it is the v1 fixture ~81 test call sites read as a
 * `CommandLog`, including `replay/film.test.ts`'s direct v1 `replayCommandLog`
 * path (see Story 12.11's interpretation note). It is no longer what a visitor
 * lands on.
 *
 * The exhibition log is **v2**, and nothing here branches on that: the cast below
 * is the same cast this line always made, and `buildReplayFilm` dispatches on
 * `schemaVersion` to `replayCommandLogV2`. That is the property Story 9.2 built
 * and Story 12.11 relied on, now load-bearing on the landing path.
 */
export const DEMO_REPLAY_URL = '/replays/exhibition.command-log.json';
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
/**
 * Story 12.8. The white hit-flash silhouette, composited over a struck fighter
 * in place of the old `--tb-warn` debug bracket. A single 800x200 strip of four
 * 200x200 cells that ships under `martial-hero/` and, until this story, was
 * drawn nowhere (`docs/ASSETS.md`). Same-origin like every other asset here.
 *
 * Shared across every fighter rather than fetched per pack: it is the one flash,
 * not a per-character pose, so it is decoded once and handed to every sprite
 * artist. Its absence is a named degrade -- the fighter draws un-flashed -- so a
 * decode failure costs the flash and nothing else.
 */
const HIT_FLASH_URL = '/sprites/martial-hero/take-hit---white-silhouette.png';
/**
 * The white cell's source rectangle within the 800x200 strip. Only the *second*
 * of its four 200x200 cells is a pure-white silhouette; the other three are the
 * pack's ordinary coloured take-hit frames. `render/animation.test.ts` decodes
 * the PNG and pins this offset, so a re-authored strip cannot silently point the
 * flash at a coloured cell.
 */
const HIT_FLASH_SX = 200;
const HIT_FLASH_FRAME_PX = 200;
/**
 * The silhouette's own placement: Martial Hero's `anchorY` 120 at scale 3, the
 * same numbers `martial-hero/layout.json` uses. Drawn at its own geometry rather
 * than the struck fighter's, so it stands on the floor at roughly the fighter's
 * height instead of floating at the wrong anchor -- see `render/artist.ts`.
 */
const HIT_FLASH_ANCHOR_Y = 120;
const HIT_FLASH_SCALE = 3;

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
  readonly play: PlayPanel | null;
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

/**
 * Loads one stage's backdrop (Story 12.10).
 *
 * Scenery is the most skippable thing on the page: losing it must never cost the
 * replay, so a 404, a malformed layout, a remote image or an undecodable PNG is
 * one warning and a flat arena. Only the *chosen* stage is fetched -- the six
 * scenes are 4.7 MB on disk and a load pulls ~0.8 MB of them, the same lazy
 * shape the sprite packs have (`imageUrlsFor` fetches two of four).
 */
async function loadStage(globals: BrowserGlobals, id: StageId): Promise<Backdrop | undefined> {
  try {
    if (globals.Image === undefined) {
      return undefined;
    }
    const layout = validateBackdropLayout(await fetchJson(globals, stageLayoutUrlFor(id)));
    return createBackdrop(await decodeAll(globals, layout.layers.map((layer) => layer.image)), layout);
  } catch (error) {
    warn('Stage unavailable, the arena will render flat', error);
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
 * Loads the white hit-flash silhouette, or returns `undefined` (Story 12.8).
 *
 * `loadBackdrop`/`loadVfx`'s shape: a decode failure is one warning and then
 * `undefined`, and the sprite artist is built without a flash rather than not
 * built at all. A hit that does not flash is worse-looking, never broken, and
 * that degrade is exactly the one `hero/raster.ts` takes by construction.
 */
async function loadHitFlash(globals: BrowserGlobals): Promise<HitFlash | undefined> {
  try {
    if (globals.Image === undefined) {
      return undefined;
    }
    const element = new (globals.Image as new () => LoadedImage)();
    element.src = HIT_FLASH_URL;
    await element.decode();
    return {
      image: element,
      sx: HIT_FLASH_SX,
      sy: 0,
      frameWidth: HIT_FLASH_FRAME_PX,
      frameHeight: HIT_FLASH_FRAME_PX,
      anchorY: HIT_FLASH_ANCHOR_Y,
      scale: HIT_FLASH_SCALE,
    };
  } catch (error) {
    warn('Hit flash unavailable, hits will not flash the fighter', error);
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
 *
 * The `flash` is a getter (Story 12.8), never awaited here: it is one shared
 * silhouette handed to every artist, and it must not sit on any pack's critical
 * path. The artist is built the moment this pack's own sprites decode and reads
 * the flash from the getter at draw time, so a flash that is slow -- or never --
 * to decode costs a hit its flash and nothing else, exactly as an un-decodable
 * pack costs a fighter its sprites and nothing else. Gating the artist on the
 * flash promise would instead strand all three surfaces on the block artist for
 * the whole session behind one stalled image, with no warning.
 */
async function loadArtist(
  globals: BrowserGlobals,
  layoutUrl: string,
  flash: HitFlashSource,
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
    const sheet = createSpriteSheet(await decodeAll(globals, urls), layout);
    return createSpriteArtist(sheet, flash);
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
 * Mounts the Play cabinet, or returns `null` when this page has no `#arcade`
 * host. Mirrors `mountByok` exactly, including the warn-not-throw failure
 * mode: the replay is the page's claim and the cabinet is an offer.
 *
 * The cabinet is the reference fighter under `/arena/`, loaded in an iframe
 * and left exactly as it is. What this page owns is the frame around it: the
 * coin slot, the difficulty and round switches, and the one message it sends
 * in (whether sound is on). Every message the arena sends out arrives through
 * the page's `message` event and is handed to the panel's `receive`.
 */
function mountPlay(
  globals: BrowserGlobals,
  soundEnabled: () => boolean,
  onGesture: () => void,
): PlayPanel | null {
  const host = globals.document?.querySelector('#arcade');
  if (host == null) {
    return null;
  }
  try {
    const panel = mountPlayPanel(host as unknown as PlayHost, {
      ...(globals.localStorage === undefined ? {} : { storage: globals.localStorage }),
      soundEnabled,
      onGesture,
    });
    const view = globals.window as unknown as Partial<MessageView> | undefined;
    if (view != null && typeof view.addEventListener === 'function') {
      view.addEventListener('message', (event) => {
        panel.receive(event?.data);
      });
    }
    return panel;
  } catch (error) {
    warn('Play cabinet unavailable', error);
    return null;
  }
}

interface MessageView {
  addEventListener(type: 'message', listener: (event?: { readonly data?: unknown }) => void): void;
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
  /** Story 12.9. Reports a press of *this panel's* sound button to the page's switch. */
  onAudioToggle: (enabled: boolean) => void,
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
      onAudioToggle,
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
      },
      onSpectateCta: () => {
        onGesture();
        navigate(ROUTE_WATCH);
      },
      onByokCta: () => {
        onGesture();
        navigate(ROUTE_BYOK);
      },
    });
  } catch (error) {
    warn('Landing panel unavailable', error);
    return null;
  }
}

/**
 * Mounts the Fighters gallery, or returns `null` when this page has no
 * `#select` host. Warn-not-throw, like every other mount here.
 *
 * The one callback is deliberately thin: `shell/select.ts` never imports the
 * Play panel, so the gallery knows how to show a roster and nothing about how
 * a fight starts. Navigation happens *before* `start()` so the cabinet's frame
 * is on screen when it boots.
 */
function mountSelect(
  globals: BrowserGlobals,
  play: PlayPanel | null,
  onGesture: () => void,
  navigate: (route: string) => void,
): SelectPanel | null {
  const host = globals.document?.querySelector('#select');
  if (host == null) {
    return null;
  }
  try {
    return mountSelectPanel(host as unknown as SelectHost, {
      onPlayAs: (id: CabinetId) => {
        onGesture();
        navigate(ROUTE_PLAY);
        if (play === null) {
          warn('Fighters', 'Play is unavailable: the cabinet did not mount.');
        } else {
          play.start(id);
        }
      },
    });
  } catch (error) {
    warn('Fighters unavailable', error);
    return null;
  }
}

/**
 * Mounts the page's sound switch, or returns `null` when this page has no
 * `#screen-sound` host (Story 12.9).
 *
 * `null` is a supported configuration and it is what every existing test is in:
 * `startup.test.ts` hands this function a document whose `querySelector` answers
 * for a handful of ids. A page with no switch is a page whose sound is simply
 * on, which is this story's default -- so the degrade is the feature, not a
 * silent mute.
 */
function mountSound(
  globals: BrowserGlobals,
  onChange: (enabled: boolean) => void,
): SoundControl | null {
  const host = globals.document?.querySelector('#screen-sound') as unknown as SoundHost | null;
  if (host == null || typeof host.querySelector !== 'function') {
    return null;
  }
  try {
    return mountSoundControl(host, {
      // Absent in a tab with storage blocked, and absent under test -- both read
      // as "there is nowhere to remember this", which lasts one session.
      ...(globals.localStorage === undefined ? {} : { storage: globals.localStorage }),
      onChange,
    });
  } catch (error) {
    warn('Sound control unavailable', error);
    return null;
  }
}

/**
 * What a browser needs to offer for the first gesture to be noticed. Story 12.9.
 *
 * Declared structurally for this file's standing reason -- `tsconfig.base.json`
 * has no DOM lib -- and deliberately *not* the same shape as `ShellView`: this
 * one listens for three input events and does not care about `location`.
 */
interface GestureView {
  addEventListener(
    type: 'pointerdown' | 'keydown' | 'touchstart',
    listener: () => void,
    options?: { once?: boolean; passive?: boolean },
  ): void;
}

/**
 * Resumes the audio context on the first click, keypress or tap anywhere on the
 * page (Story 12.9, AC2).
 *
 * "Sound on by default" cannot mean sound before a gesture -- no browser allows
 * it, and Chrome says so in the console line the visual gate allowlists. So the
 * graph is built early and *armed*: the page listens once for each of the three
 * ways a visitor first touches it, and the first one to fire resumes.
 *
 * Before this, unlocking happened only in handlers the panels bound -- pressing
 * Play, picking a Spectate entry, running a BYOK Match. A visitor who clicked
 * anywhere else first, or who simply pressed a key, watched a silent fight with
 * a control that said the sound was on.
 *
 * `once` on each listener rather than a flag: the browser drops them after they
 * fire, so there is no per-event work left on the page and no module-level
 * mutable binding to hold the flag in (`source-discipline.test.ts` bans one).
 * `passive` on `touchstart` because this handler never cancels a scroll.
 */
function armAudioOnFirstGesture(globals: BrowserGlobals, unlock: () => void): void {
  const view = globals.window as unknown as Partial<GestureView> | undefined;
  if (view == null || typeof view.addEventListener !== 'function') {
    return;
  }
  const listening = view as GestureView;
  try {
    listening.addEventListener('pointerdown', unlock, { once: true });
    listening.addEventListener('keydown', unlock, { once: true });
    listening.addEventListener('touchstart', unlock, { once: true, passive: true });
  } catch (error) {
    // A host that rejects the options object, or an embedding with no input
    // events at all. The panels' own gesture hooks still unlock; this is the
    // wider net, not the only one.
    warn('Audio could not be armed on the first gesture', error);
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
    // Every screen change starts at the top. A cabinet whose Fighters screen
    // opens scrolled to wherever Play left the page reads as one long page,
    // which is exactly what the router exists to stop.
    const scrollTop = (shellView as { scrollTo?: (x: number, y: number) => void }).scrollTo;
    return createScreenRouter({
      view: shellView as ShellView,
      screens,
      onRoute: (route: string): void => {
        markCurrent?.(route);
        try {
          scrollTop?.call(shellView, 0, 0);
        } catch {
          // A view with no scroll is a view already at the top.
        }
      },
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
     * Which stage the fight is drawn on, and the box a pick travels through
     * (Story 12.10).
     *
     * The same shape as the roster selection above and for the same reason:
     * reacting to a pick means fetching that stage's scenery, and that needs the
     * dressing that needs the selection. The initial stage is
     * `stageForSeed(log.seed)` -- derived from the demo log's own seed, so the
     * same log always draws on the same scene (a direct replay link is stable)
     * without any stage ever being recorded in a Command Log. It is the seed's
     * stage, not a fixed one: a different log, or the hero's own seed, derives a
     * different scene.
     */
    const chosenStage: { apply: (id: StageId) => void } = {
      apply: () => {
        // Replaced below, once there is something to dress.
      },
    };
    const stageSelection = createStageSelection({
      initial: stageForSeed(log.seed),
      onChange: (id) => {
        chosenStage.apply(id);
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
    const graph = createAudioBus({
      AudioContext: globals.AudioContext,
      fetch: (url: string) =>
        globals.fetch!(url) as unknown as Promise<AudioFetchResponse>,
    });

    /**
     * Story 12.9. The page's sound switch, and the box its changes travel
     * through.
     *
     * Mounted here, before the player, because the gated sink below has to be
     * able to ask it whether sound is on from the very first frame -- and its
     * `onChange` needs the panels, which need `mount`, which needs the player.
     * The box breaks that cycle the same way `chosen`/`shell.router` above do.
     */
    const soundChanged: { apply: (enabled: boolean) => void } = {
      apply: () => {
        // Replaced below, once there is something to make audible. A press
        // that arrived before then has nothing to turn on, and the switch has
        // already remembered itself either way.
      },
    };
    const soundControl = mountSound(globals, (enabled) => {
      soundChanged.apply(enabled);
    });

    /**
     * The sink every surface is handed: the real graph, behind the page's
     * switch (Story 12.9).
     *
     * Wrapped rather than each panel checking a flag, because the buses are the
     * page's and the switch is the page's -- see `createGatedSink`. `?? true`
     * for a page with no switch: this story's default is on, and a missing
     * control must not be a silent mute.
     */
    const sink =
      graph === null ? null : createGatedSink(graph, () => soundControl?.enabled() ?? true);

    // Story 12.9, AC2. On by default means *armed*: the graph is built and
    // suspended, and the first gesture anywhere resumes it. The panels' own
    // `onGesture` hooks stay -- this is the wider net around them.
    armAudioOnFirstGesture(globals, () => {
      sink?.unlock();
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
    const panels: { spectate: SpectatePanel | null } = {
      spectate: null,
    };

    /**
     * Records a decoded pack on the page and pushes it to the surfaces the
     * visitor's own choice governs: the replay player and the Arcade live view.
     *
     * **Not Spectate**, since Story 12.5. The stream walks committed Command
     * Logs and the fighters drawn on it are a property of those logs, not of who
     * the visitor happens to have picked -- an independent review of this story
     * caught the packs reaching it and putting grokk's silhouette on a Match
     * recorded as somebody else, with the cinematic underneath still saying
     * CLAWDE. Spectate is dressed by `dressStream*` below, always from
     * `DEFAULT_ROSTER`.
     */
    const dressArtist = (agentIndex: 0 | 1, artist: FighterArtist): void => {
      dressing.artists[agentIndex] = artist;
      player.mounted.setArtist(agentIndex, artist);
      // Story 12.2. The Arcade live view draws through the same compositor now,
      // so a pack that reached only the player would leave a live Match on the
      // block artist for the whole session.
    };
    const dressBackdrop = (backdrop: Backdrop): void => {
      dressing.backdrop = backdrop;
      player.mounted.setBackdrop(backdrop);
      panels.spectate?.setBackdrop(backdrop);
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
    };
    /**
     * Story 11.4, widened by Story 11.6 for the reason `dressVfx` gives, and
     * narrowed again by Story 12.5 for `dressArtist`'s reason.
     *
     * This sheet holds only the *chosen* pair's portraits (`imageUrlsFor` fetches
     * two of four, which is most of a megabyte saved), so handing it to Spectate
     * would take clawde's and chatty's cut-ins away from the stream the moment a
     * visitor picked anyone else -- a cinematic silently dropping to Story 10.4's
     * banner with no warning anywhere. Spectate gets its own sheet below.
     */
    const dressUlt = (ult: UltSheet): void => {
      dressing.ult = ult;
      player.mounted.setUlt(ult);
    };
    /**
     * Story 12.5. The stream's own art: the sprite packs and the Ultimate sheet
     * for `DEFAULT_ROSTER`, and nobody else's.
     *
     * Held separately from `dressing` because the two answer different questions
     * -- "who did the visitor pick" and "who is drawn on a committed log" -- and
     * because the Spectate panel mounts after these loads start, so it has to be
     * able to adopt whatever already landed.
     */
    const streamDressing: {
      artists: (FighterArtist | undefined)[];
      ult: UltSheet | undefined;
    } = { artists: [undefined, undefined], ult: undefined };
    const dressStreamArtist = (agentIndex: 0 | 1, artist: FighterArtist): void => {
      streamDressing.artists[agentIndex] = artist;
      panels.spectate?.setArtist(agentIndex, artist);
    };
    const dressStreamUlt = (ult: UltSheet): void => {
      streamDressing.ult = ult;
      panels.spectate?.setUlt(ult);
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
    /**
     * One load per fighter and one per pair, however many times they are asked
     * for.
     *
     * Two pairs are in play at once now -- the visitor's and the stream's fixed
     * `DEFAULT_ROSTER` -- and on a first load they are the same pair. Without
     * memoising, every page load would fetch and decode both sprite packs twice,
     * and a visitor picking back and forth would re-decode a pack they already
     * had. Promises rather than results, so two callers arriving before the
     * first resolves still share one fetch.
     */
    /**
     * The one shared hit-flash silhouette (Story 12.8), decoded once and held in
     * a box every artist reads through `flashSource` at draw time. A box rather
     * than a value threaded in at construction, because the decode is a late
     * upgrade like every sprite pack: the artists are built before it lands and
     * pick it up whenever it does, and a decode that stalls or fails never keeps
     * them on the block artist -- the getter simply keeps returning `undefined`.
     * Fire-and-forget, and deliberately **not** in `upgrades`: the flash is read
     * live through the getter, so nothing needs to await it, and awaiting it
     * would be a foot-gun -- it decodes an `Image` rather than fetching JSON, so
     * a test whose fetch fake fails every asset (to settle `dressed` fast) would
     * hang on the flash's still-pending `decode()`. `loadHitFlash` swallows its
     * own failure, so this promise never rejects.
     */
    const hitFlash: { current: HitFlash | undefined } = { current: undefined };
    void loadHitFlash(globals).then((flash) => {
      hitFlash.current = flash;
    });
    const flashSource: HitFlashSource = () => hitFlash.current;
    const artistCache = new Map<RosterId, Promise<FighterArtist | undefined>>();
    const artistFor = (id: RosterId): Promise<FighterArtist | undefined> => {
      const existing = artistCache.get(id);
      if (existing !== undefined) {
        return existing;
      }
      const loading = loadArtist(globals, spriteLayoutUrlFor(id), flashSource);
      artistCache.set(id, loading);
      return loading;
    };
    const ultCache = new Map<string, Promise<UltSheet | undefined>>();
    const ultFor = (pair: RosterPair): Promise<UltSheet | undefined> => {
      const key = pair.join('+');
      const existing = ultCache.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const loading = loadUlt(globals, pair);
      ultCache.set(key, loading);
      return loading;
    };
    const loadRosterArt = async (pair: RosterPair): Promise<void> => {
      art.generation += 1;
      const generation = art.generation;
      const current = (): boolean => art.generation === generation;
      await Promise.all([
        ...pair.map(async (id, index) => {
          const artist = await artistFor(id);
          if (artist !== undefined && current()) {
            dressArtist(index as 0 | 1, artist);
          }
        }),
        (async (): Promise<void> => {
          const ult = await ultFor(pair);
          if (ult !== undefined && current()) {
            dressUlt(ult);
          }
        })(),
      ]);
    };
    /**
     * The stream's art, loaded once and never reloaded: `DEFAULT_ROSTER` is what
     * every committed log is drawn as, and no pick changes it. No generation
     * counter, because there is only ever one of these.
     */
    const loadStreamArt = async (): Promise<void> => {
      await Promise.all([
        ...DEFAULT_ROSTER.map(async (id, index) => {
          const artist = await artistFor(id);
          if (artist !== undefined) {
            dressStreamArtist(index as 0 | 1, artist);
          }
        }),
        (async (): Promise<void> => {
          const ult = await ultFor(DEFAULT_ROSTER);
          if (ult !== undefined) {
            dressStreamUlt(ult);
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

    /**
     * Fetches a stage's scenery and dresses every live surface with it (Story
     * 12.10). A pick re-dresses immediately -- while the visitor is still on the
     * select screen -- so the scene is decoded by the time the Match starts
     * rather than swapping in mid-fight, the same as a roster pick above.
     *
     * The generation guard makes a fast second pick win: two picks in flight can
     * resolve out of order (a small scene decodes before a large one begun
     * earlier), and without this the *earlier* pick's stage would dress last and
     * stick. Only the latest pick's result is allowed to dress.
     */
    const stageGeneration = { current: 0 };
    const loadStageInto = async (id: StageId): Promise<void> => {
      const generation = (stageGeneration.current += 1);
      const backdrop = await loadStage(globals, id);
      if (backdrop !== undefined && generation === stageGeneration.current) {
        dressBackdrop(backdrop);
      }
    };
    chosenStage.apply = (id: StageId): void => {
      void loadStageInto(id);
    };

    const upgrades: Promise<void>[] = [loadRosterArt(selection.pair()), loadStreamArt()];
    upgrades.push(loadStageInto(stageSelection.stage()));
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

    const playPanel = mountPlay(
      globals,
      () => soundControl?.enabled() ?? true,
      () => {
        sink?.unlock();
      },
    );
    const spectatePanel = mountSpectate(
      globals,
      () => {
        sink?.unlock();
      },
      sink,
      // Story 12.9. This panel's own button, reported so the page's switch
      // follows it. `set` is idempotent, so the two cannot ping-pong.
      (enabled) => {
        soundControl?.set(enabled);
      },
    );
    panels.spectate = spectatePanel;
    // Adopt whatever already landed. The upgrades started before this mount, so
    // on a warm cache a pack can resolve first and would otherwise be recorded
    // in `dressing` and pushed to nobody -- Spectate would then play as blocks
    // for the whole session precisely when the assets loaded *fastest*.
    if (spectatePanel !== null) {
      // Story 12.5: from `streamDressing`, not `dressing`. The packs and the
      // Ultimate sheet this surface adopts are the ones its committed logs are
      // drawn as, and adopting the visitor's choice here would be the same
      // defect the split exists to prevent, arriving through the warm-cache
      // path instead of the loading one.
      for (const agentIndex of [0, 1] as const) {
        const artist = streamDressing.artists[agentIndex];
        if (artist !== undefined) {
          spectatePanel.setArtist(agentIndex, artist);
        }
      }
      if (dressing.backdrop !== undefined) {
        // The scenery and the impact sheet are not keyed by a fighter, so both
        // stay shared: there is one chosen stage's backdrop and one FX sheet.
        spectatePanel.setBackdrop(dressing.backdrop);
      }
      // Story 11.6. The two sheets adopt on exactly the same terms the packs
      // and the backdrop do -- a warm cache resolves them before this mount,
      // and a surface dressed only by the *later* of the two paths is dressed
      // by neither when the assets load fastest.
      if (dressing.vfx !== undefined) {
        spectatePanel.setVfx(dressing.vfx);
      }
      if (streamDressing.ult !== undefined) {
        spectatePanel.setUlt(streamDressing.ult);
      }
    }
    const landingPanel = mountLanding(
      globals,
      () => {
        sink?.unlock();
      },
      (route: string) => {
        shell.router?.go(route);
      },
    );
    const selectPanel = mountSelect(
      globals,
      playPanel,
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
    /**
     * What the watch screen has to be told when it comes back.
     *
     * Story 12.4 remembered two things here: whether the stream was running and
     * whether it was driving the page's audio. The second is gone, and its
     * absence is load-bearing rather than a tidy-up.
     *
     * Both were remembered by reading the panel back on `onHide`. For the
     * transport that is right -- a visitor who paused the stream must not come
     * back to it playing. For the audio it stopped being right the moment Story
     * 12.9 gave the page a switch: the router applies the current route *on
     * construction*, and on any landing other than `#/watch` that means an
     * `onHide` for a panel which has never been shown, whose `audioEnabled()` is
     * still its own mount-time `false`. The page's default was therefore
     * overwritten by the panel's initial state on every single load, and the
     * watch screen came back muted with the switch reading on. The visual gate's
     * `hidden-screens-are-silent` caught it.
     *
     * So the audio half is read from the switch at every show instead. There is
     * one source of truth for whether the page makes noise, the panel's own
     * button writes *into* it (`onAudioToggle`), and nothing reads it back out.
     */
    const watch = {
      playing: spectatePanel?.isPlaying() ?? false,
    };
    const screens: Screen[] = SCREENS.map((spec) => {
      const element = (globals.document?.querySelector(spec.selector) ??
        null) as unknown as ScreenElement | null;
      const base = { route: spec.route, label: spec.label, element };
      if (spec.route === ROUTE_PLAY) {
        return {
          ...base,
          onShow: (): void => {
            playPanel?.setSound(soundControl?.enabled() ?? true);
          },
          onHide: (): void => {
            // Leaving the screen mutes the cabinet and pauses its fight; the
            // cabinet keeps its state, so coming back resumes where it was.
            playPanel?.setSound(false);
            playPanel?.pause();
          },
        };
      }
      if (spec.route === ROUTE_WATCH) {
        return {
          ...base,
          onShow: (): void => {
            spectatePanel?.setPlaying(watch.playing);
            // Story 12.9: from the page's switch, every time. See `watch`.
            spectatePanel?.setAudioEnabled(soundControl?.enabled() ?? true);
          },
          onHide: (): void => {
            // Remembered, not assumed: a visitor who paused the stream and
            // navigated away must not come back to it playing.
            watch.playing = spectatePanel?.isPlaying() ?? watch.playing;
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
            // Story 12.9, and the cost `onHide` below recorded as this story's
            // to pay: the bed is a looping cue on clock frame 0, so a visitor
            // returning mid-film used to get the fight back with no music under
            // it. `rearmAudio` is the verb that was missing. Guarded by the
            // switch so returning to this screen muted starts nothing.
            if (soundControl?.enabled() ?? true) {
              player.mounted.rearmAudio();
            }
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
            // The cost used to be that a visitor returning mid-film got the
            // fight back without its bed, because the bed's cue is at frame 0
            // and there was no verb for "re-arm the music". Story 12.9 added
            // one (`rearmAudio`) and `onShow` above calls it.
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

    /**
     * What flipping the page's sound switch does. Story 12.9.
     *
     * Written here, after the router, for the reason every screen callback
     * above is: this is the one file holding every panel handle, and neither
     * `shell/sound.ts` nor a panel should have to learn what the other surfaces
     * are.
     *
     * Turning it **off** is unconditional and stops the graph, because the
     * looping music bed outlives whatever was firing one-shots and is the one
     * cue a visitor most wants stopped. Turning it **on** is routed to the
     * surface currently on screen: the bed lives on clock frame 0, so every
     * surface needs to be *told* to start it again rather than waiting for a
     * frame that will never carry it. A screen with no audio of its own
     * (`/play`, `/select`, `/byok`, `/`) needs nothing done -- the next Match
     * that mounts starts its own bed through `mountPlayer`.
     */
    const applySoundToCurrentScreen = (enabled: boolean): void => {
      if (!enabled) {
        spectatePanel?.setAudioEnabled(false);
        playPanel?.setSound(false);
        sink?.stopAll();
        return;
      }
      if (shell.router?.current() === ROUTE_PLAY) {
        playPanel?.setSound(true);
        return;
      }
      if (shell.router?.current() === ROUTE_WATCH) {
        spectatePanel?.setAudioEnabled(true);
        return;
      }
      if (shell.router === null || shell.router.current() === ROUTE_REPLAY) {
        player.mounted.rearmAudio();
      }
    };

    soundChanged.apply = (enabled: boolean): void => {
      // Flipping a switch is a gesture, and it may be the first one on the
      // page: a visitor whose only interaction is turning sound back on must
      // not have to press something else to be heard. Only here, and not in
      // `applySoundToCurrentScreen` below -- resuming a context nobody has
      // touched yet is a browser policy violation, not an unlock.
      sink?.unlock();
      applySoundToCurrentScreen(enabled);
    };

    /**
     * Tell the screen that is *already* showing what the switch says. Story 12.9.
     *
     * The router's first apply deliberately fires `onHide` for every other
     * screen and **no `onShow` at all** -- the panels have already mounted and
     * started themselves, so showing the one that is showing would restart a
     * clock rather than leave it alone (`shell/router.ts`). Correct for a clock,
     * and wrong for sound: nothing had told the panel what the page's switch
     * said, so a visitor landing straight on `#/watch` -- a bookmark, a shared
     * link, a reload, which is a route this product deliberately supports --
     * watched a silent stream under a control reading "Sound: on", while the
     * *replay player's* bed looped behind a screen they could not see. The
     * visual gate's `audio-starts-on-first-gesture` is what found it.
     *
     * After the router rather than before, because it reads `current()`.
     */
    applySoundToCurrentScreen(soundControl?.enabled() ?? true);

    return {
      mounted: demoPlayer,
      // `then(() => undefined)` rather than the array: callers await completion,
      // not results, and every upgrade already handles its own failure.
      dressed: Promise.all(upgrades).then(() => undefined),
      byok: byokPanel,
      play: playPanel,
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
