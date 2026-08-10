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
import type { MatchEndOverlay } from '../render/renderer';
import { DEFAULT_ROSTER, type RosterPair } from '../render/roster';
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
  /**
   * Story 12.5. Which fighters this Match is drawn as, on exactly `setUlt`'s
   * terms: the visitor chooses on another screen, and a live arena that had
   * captured the pair at construction would draw the previous choice for the
   * rest of the session.
   */
  readonly setRoster: (roster: RosterPair) => void;
  /**
   * Story 12.7. The set score, drawn as the round pips. Retained across a round
   * so the pips a visitor earned stay filled into the next Match, and repainted
   * at once so a win shows the instant it is tallied.
   */
  readonly setRoundsWon: (roundsWon: readonly [number, number]) => void;
  /**
   * Story 12.7. The KO / TIME OVER overlay, or `null` to take it back down.
   *
   * Drawn over the held final frame of a round; the panel holds it for a counted
   * number of animation frames and then clears it before the next round begins.
   * A pure repaint of the current frame -- the overlay is a function of the
   * result, not a timer.
   */
  readonly showMatchEnd: (matchEnd: MatchEndOverlay | null) => void;
  /**
   * Story 12.7. Jumps to the round's final frame and draws it, before the overlay
   * goes over it.
   *
   * A Match against a human resolves only as fast as they press keys, and the
   * clock draws one film frame per animation frame, so when the round's log
   * settles the clock is usually still catching up. Stamping the KO / TIME OVER
   * overlay on whatever frame it happened to reach -- and then clearing the
   * states for the next round -- would draw the ending over a mid-round pose and
   * throw away the frames the visitor never saw, the KO among them. `finish`
   * draws the true last frame first, so the overlay sits on the fight's actual
   * final moment.
   */
  readonly finish: () => void;
  /** Halts the clock. Called by the panel on failure. */
  readonly stop: () => void;
  /**
   * Story 12.4. Suspends and resumes painting without ending the Match.
   *
   * `stop()` cannot express this: it clears `active`, so a `pushState` arriving
   * while the visitor is on another screen would be dropped and the Match would
   * resume with a hole in its film. Pausing keeps every state, keeps the film
   * building, and simply stops putting pixels on a canvas nobody can see --
   * which is the whole of what "a hidden screen does not paint" means here.
   */
  readonly setPaused: (paused: boolean) => void;
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
    /** Story 12.5. Who the visitor chose, or the default pair until they do. */
    roster: RosterPair;
  } = {
    artists: [blockArtist, blockArtist],
    backdrop: undefined,
    vfx: undefined,
    ult: undefined,
    roster: DEFAULT_ROSTER,
  };

  const sim: {
    states: FighterState[];
    frames: readonly RenderFrame[];
    track: JuiceTrack | null;
  } = { states: [], frames: [], track: null };

  /**
   * The set-level HUD state (Story 12.7): the pips a visitor has earned and the
   * match-end overlay, if one is showing. Separate from `sim` because both
   * outlive a single round's states -- the pips carry into the next Match and
   * the overlay is drawn over a round's held final frame.
   */
  const hud: { roundsWon: readonly [number, number]; matchEnd: MatchEndOverlay | null } = {
    roundsWon: [0, 0],
    matchEnd: null,
  };

  /**
   * `active` spans one Match (Play to end); `running` is whether the rAF loop is
   * scheduled; `paused` is Story 12.4's "this screen is not showing", which
   * suspends painting without ending the Match.
   */
  const clock = { active: false, running: false, paused: false, index: -1, handle: 0 };

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
      roster: dressing.roster,
      reducedMotion,
      // Story 12.7. The set score and, on a round's final held frame, the KO /
      // TIME OVER overlay -- both read the same way the replay player reads them.
      roundsWon: hud.roundsWon,
      matchEnd: hud.matchEnd ?? undefined,
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

  /**
   * Puts frame zero on the canvas the first time there is one to put there.
   *
   * The one paint that does not go through the clock, and therefore the one a
   * `running`-flag guard would miss: it must not fire while the screen is
   * hidden (Story 12.4), and it must fire the moment the screen is shown again
   * for a Match that was started while hidden -- the landing CTA navigates and
   * then plays, so that is the ordinary path, not the corner case.
   */
  const paintFirstFrame = (): void => {
    if (clock.paused || clock.index >= 0 || sim.track === null || sim.track.frameCount === 0) {
      return;
    }
    clock.index = 0;
    paint(0);
  };

  const ensureRunning = (): void => {
    if (!clock.active || clock.running || clock.paused) {
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

  /**
   * Draws the last frame the states allow, right now, and stops advancing.
   *
   * Not `stop()`: the arena stays `active` so the overlay repaint and the next
   * round's `begin` still work. Only the scheduled advance ends -- the clock is
   * parked on the final frame so the overlay lands on it. A no-op when no frame
   * has been produced yet (a round that ended before its first state, which the
   * environment cannot do, but the guard keeps the paint honest).
   */
  const finish = (): void => {
    const end = availableEnd();
    if (end < 0) {
      return;
    }
    clock.running = false;
    cancel();
    clock.index = end;
    if (!clock.paused) {
      paint(end);
    }
  };

  const begin = (): void => {
    stop();
    sim.states = [];
    sim.frames = [];
    sim.track = null;
    clock.active = true;
    clock.running = false;
    clock.index = -1;
    // The overlay belongs to the round that just ended; a fresh round clears it.
    // The pips do not -- the set score carries across rounds (AC: pips retained).
    hud.matchEnd = null;
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
    paintFirstFrame();
    ensureRunning();
  };

  const repaint = (): void => {
    // A pack that decodes while the visitor is on another screen must not
    // repaint this canvas: `hidden-screens-are-idle` hashes it, and a dressing
    // upgrade is exactly the kind of paint that arrives without a clock.
    if (!clock.paused && clock.index >= 0) {
      paint(clock.index);
    }
  };

  /**
   * Story 12.4. Suspends painting while this screen is hidden, and picks the
   * fight back up where it left off when it is shown again.
   *
   * States keep arriving and the film keeps building throughout -- only the
   * pixels stop. Resuming repaints the frame the clock is on before scheduling,
   * so the first thing a returning visitor sees is the current fight rather
   * than whatever was on the canvas when they left.
   */
  const setPaused = (paused: boolean): void => {
    if (clock.paused === paused) {
      return;
    }
    clock.paused = paused;
    if (paused) {
      clock.running = false;
      cancel();
      return;
    }
    // One paint, not two: frame zero for a Match that began while hidden, the
    // current frame for one that was already running.
    if (clock.index < 0) {
      paintFirstFrame();
    } else {
      repaint();
    }
    ensureRunning();
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
    setRoster: (roster: RosterPair): void => {
      dressing.roster = roster;
      repaint();
    },
    setRoundsWon: (roundsWon: readonly [number, number]): void => {
      hud.roundsWon = [roundsWon[0], roundsWon[1]];
      repaint();
    },
    showMatchEnd: (matchEnd: MatchEndOverlay | null): void => {
      hud.matchEnd = matchEnd;
      repaint();
    },
    finish,
    stop,
    setPaused,
    frameIndex: (): number => clock.index,
  });
}
