import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import type { CanvasSurface, HostView } from '../main';
import type { Canvas2D } from '../render/canvas2d';
import { createBlockArtist, type FighterArtist } from '../render/artist';
import type { Backdrop } from '../render/backdrop';
import {
  DEFAULT_JUICE_TUNING,
  arenaFor,
  buildJuiceTrack,
  type JuiceTrack,
} from '../render/juice';
import { drawJuicedFrame } from '../render/juice-draw';
import { DEFAULT_ROSTER } from '../render/roster';
import type { UltSheet } from '../render/ult-sheet';
import type { VfxSheet } from '../render/vfx-sheet';
import { toFrames, type RenderFrame } from '../replay/film';

/**
 * Story 12.2: the Arcade live view.
 *
 * Until this story an Arcade Match ran headlessly -- `runArcadeMatch` returned a
 * `Promise<CommandLogV2>` and `startup.ts` awaited it, then re-mounted the
 * player on the finished log. Nothing drew *during* play, because there was
 * nothing to draw from: the film only exists once the Match is over. A visitor
 * pressed keys blind for a whole fight and was shown a replay afterwards.
 *
 * This module is the live frame source that closes that gap, and its whole
 * discipline is: **draw the fight, do not re-draw the fighter.** It reuses
 * `drawJuicedFrame` -- the exact compositor the replay player and Spectate both
 * paint through -- and reuses `toFrames` and `buildJuiceTrack` to turn the
 * states into the same `RenderFrame`/`JuiceTrack` pair a replay would. Nothing
 * here calls `drawImage`; a second drawing path is precisely how Story 9.3's
 * Spectate ended up on coloured blocks beside the player's real art.
 *
 * ## The frame source
 *
 * `run.ts` tees `env.reset`/`env.step` and reports every `FighterState` the
 * Match passes through to `pushState` here. That sequence is exactly the
 * `states` array `buildReplayFilm` rebuilds from the finished log, so a
 * live-viewed Match and the replay that re-mounts after it are identical frame
 * for frame -- the frame model is single-sourced through `toFrames`.
 *
 * A Match against a Baseline Bot is paced by the visitor's own hands: a
 * Decision Point resolves only when a key is fed, so states arrive one press at
 * a time rather than on a schedule. The film therefore *grows* while it plays,
 * and this module's clock draws through whatever is available and holds on the
 * last frame until more arrives.
 *
 * ## The clock counts callbacks, exactly as `player/clock.ts` does
 *
 * One film frame advances per animation-frame callback. The callback takes no
 * argument -- the timestamp `requestAnimationFrame` supplies is unreachable by
 * construction (`HostView.requestAnimationFrame` is wrapped the same way
 * `mountPlayer` wraps it) -- so there is no delta-time path and no wall clock on
 * this surface (INV-1, INV-3). The one thing this clock does that
 * `createPlaybackClock` cannot is resume when the film grows: the replay clock's
 * `frameCount` is fixed at construction because a replay's film is, and a live
 * film's is not.
 *
 * ## Reduced motion reduces the picture, it does not stop the fight
 *
 * `prefers-reduced-motion` is threaded into `buildJuiceTrack` exactly as the
 * player threads it -- no camera shake, no sparks -- but it does **not** freeze
 * the clock the way it freezes the replay player's. Story 11.6 is the
 * precedent read the other way: porting a "do not animate" policy onto a
 * surface with no transport produced a dead surface, and the arcade's transport
 * is the visitor's own hands. A reduced-motion visitor who presses a key must
 * still see their fighter move.
 */

/** Fixed backbuffer, matching the replay player and Spectate (`main.ts`). CSS scales it. */
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 400;

export interface LiveArenaDeps {
  /** The `#arcade` canvas. Sized here to the fixed backbuffer, exactly as `mountPlayer` sizes the player's. */
  readonly canvas: CanvasSurface;
  readonly view: HostView;
  /**
   * The one `prefersReducedMotion(view)` read the panel already made, threaded
   * in rather than taken again here -- two surfaces on one page must not
   * disagree about a preference the visitor expressed once (`main.ts`).
   */
  readonly reducedMotion: boolean;
}

export interface LiveArena {
  /** Clears the film and arms the clock for a fresh Match. Called by the panel on Play. */
  readonly begin: () => void;
  /** Reports one `FighterState`; the arena draws the fight as far as the states allow. */
  readonly pushState: (state: FighterState) => void;
  /** Dresses one fighter and repaints the current frame, exactly as `MountedApp.setArtist` does. */
  readonly setArtist: (agentIndex: 0 | 1, artist: FighterArtist) => void;
  readonly setBackdrop: (backdrop: Backdrop) => void;
  /** Story 11.2's impact sheet, absent-tolerant on the same terms the player's is. */
  readonly setVfx: (vfx: VfxSheet) => void;
  /** Story 11.4's Ultimate art, absent-tolerant on the same terms as `setVfx`. */
  readonly setUlt: (ult: UltSheet) => void;
  /** Halts the clock. Called by the panel when the Match ends and the replay re-mounts. */
  readonly stop: () => void;
  /** The film frame most recently drawn, or `-1` before the first. Exposed for the panel's tests. */
  readonly frameIndex: () => number;
}

/**
 * The film for however many states have arrived.
 *
 * `toFrames` needs at least two states to emit a transition, and on the very
 * first `pushState` -- the reset state, reported synchronously the moment the
 * Match starts -- there is only one. Rather than hand-building a frame here,
 * the single state is passed as *both* ends of one transition: `toFrames` then
 * expands it exactly as it expands a real step, and the fighters stand at their
 * start positions until the visitor's first key. That matters beyond tidiness --
 * this module's first constraint is that the frame model is single-sourced, and
 * a hand-built `RenderFrame` would be the one shape on this surface that no
 * replay ever produces and no replay test could reach.
 */
function filmFor(states: readonly FighterState[]): readonly RenderFrame[] {
  if (states.length === 0) {
    return [];
  }
  return toFrames(states.length === 1 ? [states[0], states[0]] : states);
}

/**
 * Builds a live arena over the `#arcade` canvas.
 *
 * Throws when the browser gives no 2D context, matching `mountPlayer`: the
 * panel constructs this inside a try and falls back to the headless path, so a
 * surface that cannot draw is a warning rather than a broken Play button.
 */
export function createLiveArena(deps: LiveArenaDeps): LiveArena {
  const { canvas, view, reducedMotion } = deps;

  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('createLiveArena: this browser provided no 2D canvas context.');
  }
  const surface: Canvas2D = ctx;

  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const viewport = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  const arena = arenaFor(DEFAULT_FIGHTER_CONFIG);
  const blockArtist = createBlockArtist();

  /**
   * The art, swapped in as it decodes -- mirrors `startup.ts`'s `dressing` and
   * `mountPlayer`'s, and for the same reason: the sprite packs and scenery land
   * after the first frame is painted, so both slots start on the block artist.
   * Both are filled explicitly rather than left sparse, because `drawFrame`
   * falls back from a missing index to index 0 and a half-filled array would
   * dress both fighters in pack one.
   */
  const dressing: {
    artists: [FighterArtist, FighterArtist];
    backdrop: Backdrop | undefined;
    vfx: VfxSheet | undefined;
    ult: UltSheet | undefined;
  } = { artists: [blockArtist, blockArtist], backdrop: undefined, vfx: undefined, ult: undefined };

  const sim: {
    states: FighterState[];
    frames: readonly RenderFrame[];
    track: JuiceTrack | null;
  } = { states: [], frames: [], track: null };

  /** `active` spans one Match (Play to end); `running` is whether the rAF loop is scheduled. */
  const clock = { active: false, running: false, index: -1, handle: 0 };

  const availableEnd = (): number => (sim.track === null ? -1 : sim.track.frameCount - 1);

  const rebuild = (): void => {
    sim.frames = filmFor(sim.states);
    sim.track =
      sim.frames.length > 0
        ? buildJuiceTrack(sim.frames, DEFAULT_JUICE_TUNING, arena, reducedMotion, DEFAULT_FIGHTER_CONFIG)
        : null;
  };

  const paint = (clockIndex: number): void => {
    const track = sim.track;
    if (track === null) {
      return;
    }
    const clamped = Math.max(0, Math.min(clockIndex, track.frameCount - 1));
    const frame = sim.frames[track.filmIndexAt(clamped)];
    if (frame === undefined) {
      return;
    }
    drawJuicedFrame(surface, frame, track.at(clamped), {
      config: DEFAULT_FIGHTER_CONFIG,
      viewport,
      // Both slots always filled (see `dressing`): the block artist stands in
      // for whichever pack has not decoded, never `undefined`.
      artists: dressing.artists,
      backdrop: dressing.backdrop,
      // Absent means the named degrade, never a failure: Story 9.5's square
      // sparks without the sheet, Story 10.4's banner without the Ultimate art.
      vfx: dressing.vfx,
      ult: dressing.ult,
      // Always passed, exactly as Spectate passes it: `render/roster.ts` is the
      // single place an agent index becomes a fighter id, so the caster's aura
      // and portrait resolve here the same way they do on the player.
      roster: DEFAULT_ROSTER,
      reducedMotion,
    });
  };

  const cancel = (): void => {
    if (clock.handle !== 0) {
      view.cancelAnimationFrame(clock.handle);
      clock.handle = 0;
    }
  };

  // Wrapped so its callback takes no argument: the timestamp is unreachable by
  // construction, which is how INV-3 is kept here rather than merely intended
  // (mirrors `mountPlayer`'s clock and `player/clock.ts`).
  const schedule = (): void => {
    clock.handle = view.requestAnimationFrame(() => tick());
  };

  function tick(): void {
    clock.handle = 0;
    if (!clock.running) {
      return;
    }
    const end = availableEnd();
    if (clock.index < end) {
      clock.index += 1;
      paint(clock.index);
      schedule();
      return;
    }
    // Caught up to the newest state the visitor has produced. Stop scheduling
    // rather than spin redrawing a static frame at 60fps; `ensureRunning`
    // restarts the loop the moment `pushState` extends the film.
    clock.running = false;
  }

  const ensureRunning = (): void => {
    if (!clock.active || clock.running) {
      return;
    }
    if (clock.index < availableEnd()) {
      clock.running = true;
      if (clock.handle === 0) {
        schedule();
      }
    }
  };

  const stop = (): void => {
    clock.active = false;
    clock.running = false;
    cancel();
  };

  const begin = (): void => {
    stop();
    sim.states = [];
    sim.frames = [];
    sim.track = null;
    clock.active = true;
    clock.running = false;
    clock.index = -1;
  };

  const pushState = (state: FighterState): void => {
    if (!clock.active) {
      return;
    }
    sim.states.push(state);
    rebuild();
    // The first state (the reset) is painted synchronously, so the canvas
    // carries the two fighters at their start positions from frame zero rather
    // than a blank stage until the animation loop or the visitor's first key.
    if (clock.index < 0 && sim.track !== null && sim.track.frameCount > 0) {
      clock.index = 0;
      paint(0);
    }
    ensureRunning();
  };

  const repaint = (): void => {
    if (clock.index >= 0) {
      paint(clock.index);
    }
  };

  return Object.freeze({
    begin,
    pushState,
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
    stop,
    frameIndex: (): number => clock.index,
  });
}
