import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import { escapeHtml, prefersReducedMotion, roundPipsFor, type CanvasSurface, type HostView } from '../main';
import { createBlockArtist, type FighterArtist } from '../render/artist';
import {
  DEFAULT_AUDIO_TUNING,
  buildAudioTrack,
  createAudioDirector,
  type AudioDirector,
  type AudioSink,
  type AudioTrack,
} from '../render/audio';
import type { Backdrop } from '../render/backdrop';
import { drawJuicedFrame } from '../render/juice-draw';
import { DEFAULT_ROSTER } from '../render/roster';
import type { UltSheet } from '../render/ult-sheet';
import type { VfxSheet } from '../render/vfx-sheet';
import {
  fetchSpectateManifest,
  offsetForNow,
  readNowMs,
  type FetchLike,
  type SpectateManifest,
  type SpectateManifestEntry,
} from './manifest';
import { createSpectateWalk, type SpectateWalkHandle } from './walk';

/**
 * Story 9.3: the Spectate panel.
 *
 * Mirrors `arcade/panel.ts`'s `mount*Panel(host)` factory shape (and, through
 * it, `byok/panel.ts`'s) -- its own host (`#spectate`, beside `#app`, `#byok`
 * and `#arcade`), structural DOM interfaces throughout (`tsconfig.base.json`
 * has no DOM lib; see `arcade/panel.ts`'s docblock and `main.ts`'s for why),
 * and a `mount*Panel` factory that wires everything and returns a small
 * public handle.
 *
 * Unlike the other panels, this one owns its own canvas and does its own
 * frame drawing -- it does not go through `main.ts`'s `renderApp`/
 * `mountPlayer`, because those own exactly one film/clock pair for the life
 * of the page and Spectate's whole point is walking a *sequence* of them.
 * `createSpectateWalk` (`walk.ts`) is the sequencing layer; this file wires
 * it to a canvas and a picker list, the same relationship `main.ts` has to
 * `mountPlayer` for the single-log case. `buildReplayFilm` and
 * `createPlaybackClock` are still reused unmodified -- through `walk.ts`,
 * never reimplemented here.
 *
 * ## Story 11.6: the juice and the audio, reused rather than rebuilt
 *
 * Until this story this panel called `drawFrame` directly, so the surface a
 * visitor looks at first and longest had no hitstop, no sparks, no damage
 * numbers, no impact sheet, no Ultimate cinematic and no sound. It now paints
 * through `drawJuicedFrame` against the `JuiceTrack` `walk.ts` builds per entry,
 * dressed with the same `vfx`, `ult` and `DEFAULT_ROSTER` `main.ts` hands the
 * replay player. Nothing here draws anything of its own -- the whole story is
 * that two surfaces call one drawing layer.
 *
 * ### Why the sound started off, and why Story 12.9 reversed it
 *
 * Story 11.6's reasoning, kept because it was right for the page it was written
 * against: Spectate begins playing the moment it mounts, with no visitor action
 * at all, and the page's audio context is unlocked by *any* gesture anywhere on
 * the page -- including one aimed at Arcade. An ambient surface that starts
 * making noise because a visitor pressed something else is a defect, so the
 * default was silence and this toggle was the only thing that lifted it.
 *
 * What changed is the page, not the principle. Story 12.4 made it a cabinet:
 * one screen shows and a hidden one is idle, so a visitor whose sound this
 * surface takes over is a visitor who navigated to *this screen* to watch. The
 * default is therefore owned by the shell's page-wide control (`shell/sound.ts`)
 * and pushed in through `setAudioEnabled`, which the router already calls on
 * every show and hide. This panel keeps its own button -- it is the control
 * within arm's reach of the thing making the noise -- and reports a press back
 * through `onAudioToggle` so the two cannot disagree.
 *
 * The field below still initialises to `false` and that is deliberate: mount
 * order puts this panel on screen before the router exists, and a surface that
 * assumed sound-on would be making noise for the few milliseconds before
 * anything had asked it to.
 *
 * It also settles an ownership question this panel is the first to raise. The
 * sink is built once per *page* (Story 9.6) and Spectate is the first surface
 * that can play at the same time as the replay player -- Arcade and BYOK
 * re-mount the same `#app` player, so before this story only one director ever
 * existed. Two directors writing the same three `GainNode`s, and two looping
 * music beds, is exactly the stacking `stopAll` exists to prevent. The rule is
 * therefore: **the page's sound follows the last surface the visitor asked
 * for.** Enabling here takes ownership (`stopAll`, then this track's gains every
 * frame); a Match started in the player afterwards takes it back through
 * `mountPlayer`'s own `stopAll`, and Spectate's bed returns at its next entry.
 * Silence is the right direction for that hand-over to fail in.
 */

export type SpectateEvent = 'click';

export interface SpectateNode {
  innerHTML: string;
  setAttribute?(name: string, value: string): void;
  addEventListener(type: SpectateEvent, listener: () => void): void;
}

export interface SpectateCanvasNode extends SpectateNode {
  width: number;
  height: number;
  getContext(id: '2d'): ReturnType<CanvasSurface['getContext']>;
}

export interface SpectateHost {
  innerHTML: string;
  querySelector(selectors: string): SpectateNode | null;
}

export interface SpectatePanelDeps {
  readonly view: HostView;
  readonly fetch: FetchLike;
  /** Injectable so a test can fix "now" rather than depending on the real clock. */
  readonly now?: () => number;
  /** Injectable so a test can supply a manifest with no network at all. */
  readonly loadManifest?: (fetchImpl: FetchLike) => Promise<SpectateManifest>;
  /**
   * Called on the visitor's gesture here (Story 9.6).
   *
   * This panel plays no audio of its own, so the hook exists for the *page*:
   * browsers keep an audio context suspended until a gesture, and a visitor
   * whose only interaction is picking a Match to Spectate would otherwise leave
   * the player's context suspended for the whole session.
   */
  readonly onGesture?: () => void;
  /**
   * Story 11.6. The page's one audio graph (Story 9.6), or absent/null on a
   * browser with no WebAudio and in every test that does not assert on sound.
   *
   * Absent is a supported configuration rather than a degraded one: the toggle
   * still flips and still reads back, and the director runs sink-less -- which
   * is its own documented no-op path, the same one `mountPlayer` relies on.
   */
  readonly sink?: AudioSink | null;
  /**
   * Story 12.9. Called when the visitor works *this panel's* sound button, so
   * the shell's page-wide control can follow it.
   *
   * Deliberately fired from the click handler and not from `setAudioEnabled`,
   * which the router also calls: leaving the watch screen mutes this surface
   * (that is what "a hidden screen makes no sound" means), and reporting that
   * as a visitor's choice would silently flip the page's control to off every
   * time somebody navigated away.
   */
  readonly onAudioToggle?: (enabled: boolean) => void;
}

export interface SpectatePanel {
  readonly currentEntryId: () => string | null;
  readonly pick: (entryId: string) => void;
  /**
   * Dresses one fighter, exactly as `MountedApp.setArtist` dresses the player's.
   *
   * This panel draws its own canvas rather than going through `renderApp`, and
   * before Story 9.3's asset wiring landed that meant it never saw the sprite
   * packs and backdrop `startup.ts` decodes: it hard-coded the block artist and
   * passed no scenery, so the ambient stream played as coloured rectangles on
   * flat ground while the player beside it ran the real art. The packs belong to
   * the *page*, not to whichever surface happened to request them.
   */
  readonly setArtist: (agentIndex: 0 | 1, artist: FighterArtist) => void;
  readonly setBackdrop: (backdrop: Backdrop) => void;
  /**
   * Story 11.6. The impact FX sheet, on the same terms the player's is: absent
   * until it decodes, absent forever if it never does, and its absence is Story
   * 9.5's square-spark path rather than a failure.
   */
  readonly setVfx: (vfx: VfxSheet) => void;
  /** Story 11.6. The Ultimate's per-character art, on the same terms as `setVfx`. */
  readonly setUlt: (ult: UltSheet) => void;
  /** Story 11.6. Whether this surface is currently driving the page's audio. Starts `false`. */
  readonly audioEnabled: () => boolean;
  /**
   * Story 11.6. What the panel's sound button does, exposed so the decision is
   * assertable without dispatching a DOM event -- and so a later surface (Story
   * 9.8's carousel) can make the same choice without duplicating it.
   */
  readonly setAudioEnabled: (enabled: boolean) => void;
  /**
   * Story 11.6. Whether the stream is running. Starts `false` for a visitor who
   * asked for reduced motion -- the preference declines to *start* the stream,
   * and this is the control that starts it.
   */
  readonly isPlaying: () => boolean;
  readonly setPlaying: (playing: boolean) => void;
}

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 400;

/**
 * The sound button's two labels. Story 11.6.
 *
 * A frozen table rather than a ternary at the one call site, so the default the
 * markup ships with and the label the toggle writes cannot drift apart -- the
 * button is rendered once, statically, and updated later from a different line.
 */
const SOUND_LABEL = Object.freeze({ off: 'Sound: off', on: 'Sound: on' });

/**
 * The transport button's two labels. Story 11.6.
 *
 * The label names what pressing it *does*, not what the stream is doing --
 * "Play" on a held stream, "Pause" on a running one -- which is the convention
 * every media control on the web uses and the one the replay player's own
 * transport already follows.
 */
const PLAY_LABEL = Object.freeze({ play: 'Play', pause: 'Pause' });

/** Escapes `\` and `"` so `id` is safe to interpolate inside a double-quoted `[attr="..."]` CSS attribute selector. */
function escapeAttributeSelector(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pickerMarkup(entries: readonly SpectateManifestEntry[]): string {
  return entries
    .map(
      (entry) =>
        `<button class="tb-button tb-spectate-pick" type="button" data-spectate-pick="${escapeHtml(entry.id)}">${escapeHtml(entry.id)}</button>`,
    )
    .join('');
}

/**
 * The panel's markup. Exported so the shell can be asserted with no DOM, in
 * the spirit of `arcadeMarkup`/`byokMarkup`.
 */
export function spectateMarkup(entries: readonly SpectateManifestEntry[] = []): string {
  return `
    <h2 class="tb-spectate-heading">Spectate</h2>
    <p class="tb-spectate-intro">
      An always-running AI-vs-AI stream. Every Match is a precomputed Baseline-Bot pairing,
      walked client-side -- no server, no live inference, no cost.
    </p>
    <div class="tb-spectate-stage">
      <canvas class="tb-spectate-canvas"></canvas>
    </div>
    <p class="tb-spectate-status" data-spectate-status role="status" aria-live="polite"></p>
    <button class="tb-button tb-spectate-play" type="button" data-spectate-play>${PLAY_LABEL.pause}</button>
    <button class="tb-button tb-sound-toggle tb-spectate-sound" type="button" data-spectate-sound aria-pressed="false">${SOUND_LABEL.off}</button>
    <div class="tb-spectate-picker" data-spectate-picker>${pickerMarkup(entries)}</div>
  `;
}

/**
 * Mounts the panel and returns as soon as the loop is (or, if the manifest
 * fetch is still in flight, will shortly be) playing.
 *
 * The manifest fetch and the first entry's Command Log fetch are both
 * awaited internally before this function's own promise resolves is *not*
 * how this works: like `startup.ts`'s critical-path discipline, the shell is
 * written and returned synchronously, and the loop starts once the manifest
 * has loaded -- a slow manifest fetch must not block the rest of the page
 * (mirrors AC1's "no click, key or network call beyond initial static asset
 * fetches", not "resolves before the network answers").
 */
export function mountSpectatePanel(host: SpectateHost, deps: SpectatePanelDeps): SpectatePanel {
  host.innerHTML = spectateMarkup();

  const canvasNode = host.querySelector('canvas');
  const statusNode = host.querySelector('[data-spectate-status]');
  const pickerNode = host.querySelector('[data-spectate-picker]');
  const soundNode = host.querySelector('[data-spectate-sound]');
  const playNode = host.querySelector('[data-spectate-play]');

  if (
    canvasNode === null ||
    statusNode === null ||
    pickerNode === null ||
    soundNode === null ||
    playNode === null
  ) {
    throw new Error('mountSpectatePanel: the panel did not mount.');
  }

  const canvas = canvasNode as unknown as SpectateCanvasNode;
  const status = statusNode;
  const picker = pickerNode;
  const soundButton = soundNode;
  const playButton = playNode;

  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('mountSpectatePanel: this browser provided no 2D canvas context.');
  }
  const viewport = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const blockArtist = createBlockArtist();
  const env = createFighterEnvironment();

  /**
   * The art, swapped in as it decodes. Mirrors `startup.ts`'s own `dressing`
   * and for the same reason: the packs arrive after the first frame is already
   * painted, so every slot starts empty and the block artist covers the gap.
   *
   * Both slots are filled explicitly rather than left sparse -- `drawFrame`
   * falls back from a missing index to index 0, so a half-filled array would
   * dress both fighters in pack one.
   */
  const dressing: {
    artists: [FighterArtist, FighterArtist];
    backdrop: Backdrop | undefined;
    /** Story 11.6. The impact sheet, absent until `startup.ts` decodes it. */
    vfx: VfxSheet | undefined;
    /** Story 11.6. The Ultimate's art, on the same terms. */
    ult: UltSheet | undefined;
    /**
     * Story 11.6. The clock frame currently on screen, so a pack that decodes
     * can be drawn onto it. Mirrors `mountPlayer`'s own `dressing.frameIndex`.
     */
    clockIndex: number;
  } = {
    artists: [blockArtist, blockArtist],
    backdrop: undefined,
    vfx: undefined,
    ult: undefined,
    clockIndex: 0,
  };

  /**
   * Read once, at mount, and threaded into the paint -- never re-read per frame.
   *
   * The same value `walk.ts` hands `buildJuiceTrack` and the clock, so the
   * track's shape, the transport's autoplay decision and what the overlay draws
   * cannot disagree about a preference the visitor expressed once.
   */
  const reducedMotion = prefersReducedMotion(deps.view);

  const say = (message: string): void => {
    status.innerHTML = escapeHtml(message);
  };

  const state: { walk: SpectateWalkHandle | null; manifest: SpectateManifest | null } = {
    walk: null,
    manifest: null,
  };

  /**
   * Story 11.6. This surface's audio, and whether it is switched on.
   *
   * `track` is kept alongside the director because the director has to be
   * *replaced* rather than reused in two places -- see `resetDirector`.
   */
  const audio: { enabled: boolean; track: AudioTrack | null; director: AudioDirector | null } = {
    enabled: false,
    track: null,
    director: null,
  };

  /**
   * A fresh director over the current entry's audio track.
   *
   * Replaced rather than reused, on every entry change and on every enable,
   * because `createAudioDirector` holds `last` and treats `last === -1` as "the
   * first frame ever presented" -- which is the only condition under which the
   * looping music bed at clock frame 0 starts. A director carried across an
   * entry boundary would see the next entry's frame 0 as a backwards jump,
   * re-apply gains, fire nothing, and leave the stream playing hits over
   * silence.
   */
  const resetDirector = (): void => {
    audio.director =
      audio.track === null
        ? null
        : createAudioDirector({ track: audio.track, sink: deps.sink ?? null });
  };

  // A `const` arrow function, not a `function` declaration: TypeScript does
  // not carry a narrowing into a hoisted function declaration (it could in
  // principle be called before the guard above runs), but it does into a
  // `const` closure created after it -- the same reason `main.ts`'s `paint`
  // is written the same way.
  const paint = (clockIndex: number): void => {
    const film = state.walk?.currentFilm();
    const track = state.walk?.currentTrack();
    if (film == null || track == null) {
      return;
    }
    dressing.clockIndex = clockIndex;
    // Clock index in, film index out -- the same mapping `main.ts` makes, and
    // the reason a hitstop hold repaints the frame the hit landed on instead of
    // advancing past it.
    const frame = film.frames[track.filmIndexAt(clockIndex)];
    if (frame === undefined) {
      return;
    }
    // Story 12.7. The Match a visitor is watching also ends with something on
    // screen, not just fighters that stop. Six of the seven committed spectate
    // logs end in timeout, so this is the surface where the silence was loudest:
    // across the film's final Decision Point the winner's pip fills and the KO /
    // TIME OVER overlay draws, read off the film's own `result` exactly as the
    // replay player reads it, pure in the frame position.
    const atMatchEnd = film.states.length >= 2 && frame.decisionPoint >= film.states.length - 2;
    drawJuicedFrame(ctx, frame, track.at(clockIndex), {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport,
      artists: dressing.artists,
      backdrop: dressing.backdrop,
      roundsWon: atMatchEnd ? roundPipsFor(film.result.outcome) : undefined,
      matchEnd: atMatchEnd
        ? { endReason: film.result.endReason, outcome: film.result.outcome }
        : undefined,
      // Story 11.6. Absent until each decodes; absent is a named degrade in both
      // cases (9.5's square sparks, and 11.4's procedural beam) rather than a
      // failure.
      vfx: dressing.vfx,
      ult: dressing.ult,
      // Always passed. `render/roster.ts` is the single place an `agentIndex`
      // becomes a fighter id, so the caster's aura and portrait are resolved
      // here exactly as they are on the replay player -- Spectate passing
      // neither sheet nor roster was the level-3 degrade this story exists to
      // stop taking.
      roster: DEFAULT_ROSTER,
      reducedMotion,
    });
    // Last, and after the draw, for the reason `main.ts` gives: the audio
    // describes the frame now on screen. Gated rather than sink-less, so a
    // muted Spectate writes nothing at all to a graph the replay player may be
    // using at the same moment.
    if (audio.enabled) {
      audio.director?.atFrame(clockIndex);
    }
  };

  /**
   * Redraws the frame already on screen. Story 11.6.
   *
   * The dressing arrives after the first frame is painted -- that is the whole
   * point of Story 4.2's critical path -- so every setter has to put what it
   * received onto the canvas rather than wait. This panel used to leave that to
   * the clock, on the reasoning that the next frame was at most one frame away.
   *
   * That reasoning stopped being true the moment this surface started honouring
   * `prefers-reduced-motion`: a reduced-motion clock paints once and never
   * schedules again, so there *is* no next frame, and the sprite packs and the
   * backdrop -- which decode a few hundred milliseconds after the first paint --
   * would never reach the canvas at all. A reduced-motion visitor got the block
   * artists on a black stage, permanently. `mountPlayer` has always called
   * `repaint()` from each of its setters; this is the same discipline, now that
   * this panel has the same need.
   *
   * Painting the same clock index twice is safe by construction: the audio
   * director treats a repeated index as a jump, so gains are re-applied and no
   * cue fires -- which is exactly what `main.ts` relies on when a pack decodes
   * mid-Match.
   */
  const repaint = (): void => {
    paint(dressing.clockIndex);
  };

  /**
   * Runs `walk.playSpecific`/`resumeLoop` from a DOM event handler or from
   * the returned `pick()` handle, without ever leaving an unhandled promise
   * rejection behind. `walk.ts` already catches everything it can reach
   * internally (fetch failures, hash failures, a throwing callback), so this
   * is a second, narrower net around the one thing outside its control: the
   * handle itself being `null` briefly, in the small window between the
   * manifest resolving and `state.walk` being assigned.
   */
  function play(entryId: string): void {
    if (state.walk === null) {
      console.warn(`Spectate: could not play "${entryId}" -- the stream has not finished loading yet.`);
      return;
    }
    // Picking a Match *is* asking to watch it, so it starts the transport even
    // when the stream was held. This is not the preference being overridden
    // behind a visitor's back: choosing a fight from the picker is as direct a
    // request for motion as pressing Play, and the alternative -- a click that
    // swaps one frozen frame for another -- is what this surface shipped with
    // and what came back as "it's just one frame that shows no actual fight".
    setPlaying(true);
    state.walk.playSpecific(entryId).catch((error: unknown) => {
      console.warn(`Spectate: could not play "${entryId}". ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function renderPicker(): void {
    const entries = state.manifest?.entries ?? [];
    picker.innerHTML = pickerMarkup(entries);
    for (const entry of entries) {
      // `manifest.ts`'s `id` field is only guaranteed non-empty, not free of
      // characters like `"` or `\` that would break or mis-target a
      // hand-built `[attr="..."]` selector -- `escapeAttributeSelector`
      // closes that gap the same way `escapeHtml` does for the markup above.
      const button = host.querySelector(`[data-spectate-pick="${escapeAttributeSelector(entry.id)}"]`);
      button?.addEventListener('click', () => {
        deps.onGesture?.();
        // A visitor clicking twice fast (or clicking while a previous pick is
        // still loading) is handled entirely by `walk.ts`'s own generation
        // guard: the second call simply supersedes the first, and the first's
        // eventual (stale) load is dropped rather than mounted.
        play(entry.id);
        say(`Playing ${entry.id}. Returns to the loop when it finishes.`);
      });
    }
  }

  /**
   * Turns this surface's sound on or off. Story 11.6.
   *
   * Enabling is a visitor gesture and does three things in order: unlocks the
   * page's context through `deps.onGesture` (the same hook a pick already
   * uses), stops whatever the page had running so no second music bed can
   * accumulate under this one, and starts a fresh director.
   *
   * `atFrame(0)` immediately afterwards is what makes enabling *mid-Match*
   * sound like enabling at the start of one: clock frame 0 is the only frame
   * carrying the looping bed, so a director that never sees it plays hits over
   * silence until the next entry. It cannot double the bed, because the very
   * next real frame is a jump as far as the director is concerned -- including
   * when the enable happens on frame 0 itself, where `index === last` is not
   * `last + 1`.
   */
  /**
   * The transport, and the one thing that decides whether this surface moves.
   *
   * Starts held exactly when the visitor asked for less motion. That is the
   * whole of what the preference does to the transport now: it declines to
   * start *on its own*, and leaves the visitor a control. The picture stays
   * reduced either way -- `buildJuiceTrack` gets the preference regardless, so
   * pressing Play gives a stream with no camera shake and no particles rather
   * than the full one.
   */
  const transport = { playing: !reducedMotion };

  const renderPlay = (): void => {
    playButton.innerHTML = escapeHtml(transport.playing ? PLAY_LABEL.pause : PLAY_LABEL.play);
  };

  const setPlaying = (playing: boolean): void => {
    if (transport.playing === playing) {
      return;
    }
    transport.playing = playing;
    renderPlay();
    if (playing) {
      state.walk?.play();
    } else {
      state.walk?.pause();
    }
  };

  const renderSound = (): void => {
    soundButton.innerHTML = escapeHtml(audio.enabled ? SOUND_LABEL.on : SOUND_LABEL.off);
    soundButton.setAttribute?.('aria-pressed', audio.enabled ? 'true' : 'false');
  };

  const setAudioEnabled = (enabled: boolean): void => {
    if (audio.enabled === enabled) {
      return;
    }
    audio.enabled = enabled;
    renderSound();
    if (enabled) {
      deps.onGesture?.();
    }
    // Both edges. Enabling takes the buses over; disabling has to actually stop
    // the bed, which is a looping source and would otherwise outlive the mute.
    deps.sink?.stopAll();
    if (enabled) {
      resetDirector();
      audio.director?.atFrame(0);
    }
  };

  // Written once at mount as well as on every change, so the label a visitor
  // reads is always the one `SOUND_LABEL` says -- the markup's own default is a
  // string in a template, and a panel whose button said "off" while its state
  // said otherwise would be a lie about the only control it has.
  renderSound();
  soundButton.addEventListener('click', () => {
    const next = !audio.enabled;
    // Story 12.9, and the order is load-bearing. Report *first*, then apply.
    //
    // The sink this panel holds is gated by the page's switch (`startup.ts`),
    // so pressing this button while the page is muted used to enable the panel
    // against a closed gate: `setAudioEnabled` fires clock frame 0's looping
    // music bed, the gate drops it, and the shell's own call a moment later is
    // an idempotent no-op because `audio.enabled` is already true. Both buttons
    // then read "Sound: on" over a stream with hits and no bed under them until
    // the next entry -- which is the exact "hits over silence" failure `rearm`
    // exists to prevent, arriving through call ordering. An independent review
    // of this story found it.
    //
    // Reporting first opens the gate before anything is played: the shell's
    // `onChange` reaches back into `setAudioEnabled` with the gate already open,
    // and the call below is then the no-op. With no shell control listening
    // (`onAudioToggle` absent), the call below is still what does the work.
    deps.onAudioToggle?.(next);
    setAudioEnabled(next);
  });

  renderPlay();
  playButton.addEventListener('click', () => {
    // A gesture like any other on this panel: a visitor who presses Play may
    // also be unlocking the page's audio context for the first time.
    deps.onGesture?.();
    setPlaying(!transport.playing);
  });

  say('Loading the Spectate stream…');

  const loadManifest = deps.loadManifest ?? fetchSpectateManifest;
  const nowFn = deps.now ?? readNowMs;

  // Fire-and-forget from this function's own point of view: the shell above
  // is already on screen, and the loop starts as soon as the manifest
  // resolves. A rejection here (a bad or missing manifest.json) is the "the
  // manifest itself fails to load" row of the I/O matrix -- reported, never
  // thrown into an unhandled rejection.
  void (async (): Promise<void> => {
    try {
      const manifest = await loadManifest(deps.fetch);
      state.manifest = manifest;

      const walk = createSpectateWalk({
        manifest,
        fetchJson: async (url: string) => {
          const response = await deps.fetch(url);
          if (!response.ok) {
            throw new Error(`could not load ${url} (HTTP ${String(response.status)})`);
          }
          return response.json();
        },
        env,
        requestFrame: (callback) => deps.view.requestAnimationFrame(() => callback()),
        cancelFrame: (handle) => deps.view.cancelAnimationFrame(handle),
        reducedMotion,
        // The preference stops the stream starting itself; it no longer stops
        // the stream being startable. See `transport` above.
        autoplay: transport.playing,
        onFrame: paint,
        onEntryChange: (entry, _film, track) => {
          // Story 11.6. The audio for this entry, built from the same juice
          // track its clock runs on -- `buildAudioTrack` takes the juice track
          // rather than the film precisely so the two layers cannot each own a
          // timer source (Story 9.6's constraint, unchanged here).
          // Story 12.9. `DEFAULT_ROSTER`, and the same pair the paint above
          // draws with -- never the visitor's pick. The fighters in this stream
          // are a property of its committed logs (Story 12.5's finding), so
          // taking the page's chosen pair here would put grokk's voice on a
          // Match drawn as somebody else, which is that defect with sound on.
          audio.track = buildAudioTrack(track, DEFAULT_AUDIO_TUNING, DEFAULT_ROSTER);
          resetDirector();
          if (audio.enabled) {
            // The outgoing entry's sources, the looping bed included. Only when
            // this surface owns the sound: Spectate advances every few seconds,
            // and stopping a shared graph it is not driving would silence the
            // replay player beside it.
            deps.sink?.stopAll();
          }
          say(`Now playing ${entry.id}.`);
        },
        onWarning: (message) => {
          console.warn(message);
        },
      });
      state.walk = walk;
      // Rendered only now, after `state.walk` is set: a click landing in the
      // gap between the picker existing and the walk handle being assigned
      // would otherwise be a silent no-op (`play` guards it with `?.`, so it
      // could not crash, but it could also do nothing that a visitor could
      // tell apart from a broken button).
      renderPicker();

      const offset = offsetForNow(manifest, nowFn());
      await walk.startLoop(offset);
      if (walk.currentEntryId() === null) {
        // Every manifest entry failed to load or hash-verify -- `walk.ts`
        // already warned per-entry; the status text must not be left stuck
        // on "Loading…" forever (the fail-soft path still needs a visible
        // terminal state for a human watching the page, not just the log).
        say('Spectate stream unavailable: every manifest entry failed to load.');
      }
    } catch (error) {
      say(
        `Spectate stream unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.warn(`Spectate: could not start the stream. ${String(error instanceof Error ? error.message : error)}`);
    }
  })();

  return Object.freeze({
    currentEntryId: (): string | null => state.walk?.currentEntryId() ?? null,
    pick: (entryId: string): void => {
      play(entryId);
    },
    // Every setter repaints (Story 11.6). See `repaint`'s docblock: waiting for
    // the clock's next frame is only correct on a surface whose clock has one.
    setArtist: (agentIndex: 0 | 1, artist: FighterArtist): void => {
      dressing.artists[agentIndex] = artist;
      repaint();
    },
    setBackdrop: (backdrop: Backdrop): void => {
      dressing.backdrop = backdrop;
      repaint();
    },
    setVfx: (vfx: VfxSheet): void => {
      dressing.vfx = vfx;
      repaint();
    },
    setUlt: (ult: UltSheet): void => {
      dressing.ult = ult;
      repaint();
    },
    audioEnabled: (): boolean => audio.enabled,
    setAudioEnabled,
    isPlaying: (): boolean => transport.playing,
    setPlaying,
  });
}
