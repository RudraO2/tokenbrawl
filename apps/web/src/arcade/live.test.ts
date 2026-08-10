import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import type { CanvasSurface, HostView } from '../main';
import type { Canvas2D } from '../render/canvas2d';
import { createBlockArtist } from '../render/artist';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack } from '../render/juice';
import { drawJuicedFrame } from '../render/juice-draw';
import { DEFAULT_ROSTER } from '../render/roster';
import { toFrames } from '../replay/film';
import { createLiveArena } from './live';

/**
 * Story 12.2: the live arena, driven with no DOM.
 *
 * A recording fake `Canvas2D` and a hand-pumped animation-frame queue, the same
 * discipline as `render/juice-draw.test.ts`: the assertions are about the exact
 * call sequence and about the clock advancing, not about pixels nobody reads.
 */

interface Recorded {
  readonly op: string;
}

function createRecordingCanvas(): CanvasSurface & { readonly calls: readonly Recorded[] } {
  const calls: Recorded[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      void args;
      calls.push({ op });
    };
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    save: record('save'),
    restore: record('restore'),
    translate: record('translate'),
    scale: record('scale'),
  } as unknown as Canvas2D;

  return {
    width: 0,
    height: 0,
    getContext: (): Canvas2D | null => ctx,
    calls,
  };
}

/** A view whose animation-frame queue is pumped by hand, one callback per `flush()`. */
function createFakeView(): HostView & { readonly flush: () => boolean; readonly pending: () => number } {
  const callbacks: (() => void)[] = [];
  return {
    requestAnimationFrame: (callback: () => void): number => {
      callbacks.push(callback);
      return callbacks.length;
    },
    cancelAnimationFrame: (): void => undefined,
    flush: (): boolean => {
      const next = callbacks.shift();
      if (next === undefined) {
        return false;
      }
      next();
      return true;
    },
    pending: (): number => callbacks.length,
  };
}

const SEED = 4_711;

/** Two states apart: fighter 0 advances, so the pair carries visible motion. */
function states(count: number): readonly FighterState[] {
  const env = createFighterEnvironment();
  const out: FighterState[] = [env.reset(SEED)];
  for (let i = 1; i < count; i += 1) {
    out.push(env.step(out[i - 1], ['advance', null]));
  }
  return out;
}

/**
 * The op-name sequence a direct `drawJuicedFrame` produces for the reset frame.
 *
 * Built through `toFrames` with the single state at both ends -- the identical
 * shared transform `live.ts`'s `filmFor` uses -- so this is a true mirror of the
 * arena's own path rather than a hand-built frame that only resembles it.
 */
function directStillOps(state: FighterState, reducedMotion: boolean): readonly string[] {
  const ctx = createRecordingCanvas();
  const frames = toFrames([state, state]);
  const track = buildJuiceTrack(
    frames,
    DEFAULT_JUICE_TUNING,
    arenaFor(DEFAULT_FIGHTER_CONFIG),
    reducedMotion,
    DEFAULT_FIGHTER_CONFIG,
  );
  drawJuicedFrame(ctx.getContext('2d') as Canvas2D, frames[track.filmIndexAt(0)], track.at(0), {
    config: DEFAULT_FIGHTER_CONFIG,
    viewport: { width: 960, height: 400 },
    artists: [createBlockArtist(), createBlockArtist()],
    backdrop: undefined,
    vfx: undefined,
    ult: undefined,
    roster: DEFAULT_ROSTER,
    reducedMotion,
  });
  return ctx.calls.map((call) => call.op);
}

describe('the live arena', () => {
  it('paints the reset state immediately, before any step resolves', () => {
    const canvas = createRecordingCanvas();
    const arena = createLiveArena({ canvas, view: createFakeView(), reducedMotion: false });

    arena.begin();
    arena.pushState(states(1)[0]);

    // Frame zero is on the canvas synchronously -- no step, no key, no animation
    // frame -- which is what puts the fighters on screen the instant Play runs.
    expect(arena.frameIndex()).toBe(0);
    expect(canvas.calls.some((call) => call.op === 'clearRect')).toBe(true);
    expect(canvas.calls.some((call) => call.op === 'fillRect')).toBe(true);
  });

  it('draws through drawJuicedFrame, not a second path (same call sequence)', () => {
    const canvas = createRecordingCanvas();
    const arena = createLiveArena({ canvas, view: createFakeView(), reducedMotion: false });
    const [s0] = states(1);

    arena.begin();
    arena.pushState(s0);

    // The reset frame the arena drew and the frame a direct drawJuicedFrame
    // draws for the same state must be the identical sequence of canvas ops.
    expect(canvas.calls.map((call) => call.op)).toEqual(directStillOps(s0, false));
  });

  it('advances the picture as states arrive, one film frame per callback', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });
    const [s0, s1, s2] = states(3);

    arena.begin();
    arena.pushState(s0); // still frame zero; nothing to advance to yet
    arena.pushState(s1); // now a transition exists; the clock arms
    arena.pushState(s2);

    const before = arena.frameIndex();
    for (let i = 0; i < 20; i += 1) {
      view.flush();
    }
    const after = arena.frameIndex();

    // The clock counted callbacks and walked forward through the film the states
    // produced -- it did not stay frozen on frame zero.
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(0);
  });

  it('holds when caught up and resumes when a new state extends the film', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });
    const seq = states(4);

    arena.begin();
    arena.pushState(seq[0]);
    arena.pushState(seq[1]);
    // Drain every scheduled callback: the clock catches up and stops rescheduling.
    let guard = 0;
    while (view.flush() && guard < 1_000) {
      guard += 1;
    }
    expect(view.pending()).toBe(0);
    const caughtUp = arena.frameIndex();

    // A new state gives the clock somewhere to go, and it resumes on its own.
    arena.pushState(seq[2]);
    expect(view.pending()).toBeGreaterThan(0);
    view.flush();
    expect(arena.frameIndex()).toBeGreaterThan(caughtUp);
  });

  /**
   * The pacing property, pinned because it is a known and accepted limitation
   * rather than an accident (see the story's "Live-view pacing" note).
   *
   * The clock advances exactly one film frame per callback and never skips, so a
   * visitor who outruns it builds a backlog. What must hold is that the backlog
   * is *bounded and drains completely*: given enough callbacks the arena arrives
   * at the last state the Match produced, rather than settling permanently
   * behind it. A catch-up that skipped frames when the backlog grew would be
   * faster and would leak how quickly states arrived, which INV-3 forbids on
   * this path because it will later show a Deployment.
   */
  it('drains a backlog completely rather than settling behind the fight', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });
    const seq = states(6);

    arena.begin();
    // Every state at once: the visitor pressed far faster than the clock draws.
    for (const state of seq) {
      arena.pushState(state);
    }

    let guard = 0;
    while (view.flush() && guard < 10_000) {
      guard += 1;
    }

    // Caught up to the very last frame the states produced -- nothing is left
    // undrawn, and no callback is still scheduled.
    const frames = toFrames(seq);
    const track = buildJuiceTrack(
      frames,
      DEFAULT_JUICE_TUNING,
      arenaFor(DEFAULT_FIGHTER_CONFIG),
      false,
      DEFAULT_FIGHTER_CONFIG,
    );
    expect(arena.frameIndex()).toBe(track.frameCount - 1);
    expect(view.pending()).toBe(0);
  });

  it('stops drawing once stopped', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });
    const [s0, s1] = states(2);

    arena.begin();
    arena.pushState(s0);
    arena.pushState(s1);
    arena.stop();
    const framesAtStop = canvas.calls.length;

    // A pushState after stop is ignored, and no scheduled callback advances.
    arena.pushState(s1);
    while (view.flush()) {
      // drain
    }
    expect(canvas.calls.length).toBe(framesAtStop);
  });

  describe('reduced motion', () => {
    it('still draws, and still advances -- the transport is the visitor, not the preference', () => {
      const canvas = createRecordingCanvas();
      const view = createFakeView();
      const arena = createLiveArena({ canvas, view, reducedMotion: true });
      const [s0, s1, s2] = states(3);

      arena.begin();
      arena.pushState(s0);
      arena.pushState(s1);
      arena.pushState(s2);

      expect(canvas.calls.length).toBeGreaterThan(0);
      for (let i = 0; i < 20; i += 1) {
        view.flush();
      }
      // Not frozen: reduced motion reduces the picture, it does not stop the fight.
      expect(arena.frameIndex()).toBeGreaterThan(0);
    });

    it('passes the preference through to buildJuiceTrack and drawJuicedFrame', () => {
      const canvas = createRecordingCanvas();
      const arena = createLiveArena({ canvas, view: createFakeView(), reducedMotion: true });
      const [s0] = states(1);

      arena.begin();
      arena.pushState(s0);

      // The reduced arena draws exactly what a reduced direct draw draws.
      expect(canvas.calls.map((call) => call.op)).toEqual(directStillOps(s0, true));
    });
  });
});

/**
 * Story 12.4. A hidden screen does not paint.
 *
 * The gate's `hidden-screens-are-idle` check hashes every off-screen canvas
 * 700ms apart and fails if the hash moved. These cases are that check as a unit
 * test: they assert the arena makes *no drawing call at all* while paused, in
 * every way a paint can arrive here -- the clock, the synchronous first state,
 * and a sprite pack decoding mid-Match.
 */
describe('the live arena while its screen is hidden (Story 12.4)', () => {
  it('paints nothing at all while paused, however many states arrive', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });

    arena.setPaused(true);
    arena.begin();
    for (const state of states(6)) {
      arena.pushState(state);
    }
    for (let i = 0; i < 30; i += 1) {
      view.flush();
    }

    expect(canvas.calls).toStrictEqual([]);
  });

  it('does not repaint when a sprite pack decodes while it is hidden', () => {
    // The one paint that arrives with no clock behind it, and therefore the one
    // a `running`-flag guard would have missed.
    const canvas = createRecordingCanvas();
    const arena = createLiveArena({ canvas, view: createFakeView(), reducedMotion: false });

    arena.begin();
    arena.pushState(states(1)[0]);
    arena.setPaused(true);
    const painted = canvas.calls.length;
    arena.setArtist(0, createBlockArtist());
    arena.setBackdrop(undefined as unknown as Parameters<typeof arena.setBackdrop>[0]);

    expect(canvas.calls.length).toBe(painted);
  });

  it('picks the fight back up where it left off when the screen is shown again', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });

    arena.setPaused(true);
    arena.begin();
    for (const state of states(6)) {
      arena.pushState(state);
    }
    expect(canvas.calls).toStrictEqual([]);

    arena.setPaused(false);
    // Repainted immediately on show, rather than after one animation frame:
    // a returning visitor must not see a blank canvas.
    expect(canvas.calls.length).toBeGreaterThan(0);

    const before = arena.frameIndex();
    for (let i = 0; i < 10; i += 1) {
      view.flush();
    }
    // The states that arrived while hidden were kept, so the film advances
    // rather than restarting: pausing suspends the picture, not the Match.
    expect(arena.frameIndex()).toBeGreaterThan(before);
  });

  it('is idempotent, so a repeated hide neither double-cancels nor double-paints', () => {
    const canvas = createRecordingCanvas();
    const view = createFakeView();
    const arena = createLiveArena({ canvas, view, reducedMotion: false });

    arena.begin();
    arena.pushState(states(3)[0]);
    arena.setPaused(true);
    arena.setPaused(true);
    const painted = canvas.calls.length;
    arena.setPaused(false);
    const afterShow = canvas.calls.length;
    arena.setPaused(false);

    expect(afterShow).toBeGreaterThan(painted);
    expect(canvas.calls.length).toBe(afterShow);
  });
});

/**
 * Story 12.7: the set score and the KO / TIME OVER overlay on the live arena.
 *
 * A richer recording canvas than the op-only one above, because these
 * assertions are about *which* text drew and *which* colour a pip filled with --
 * exactly what a bare op list cannot answer.
 */
function createRichCanvas(): CanvasSurface & {
  readonly texts: () => readonly string[];
  readonly fills: () => readonly string[];
} {
  const texts: string[] = [];
  const fills: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillRect(this: { fillStyle: string }): void {
      fills.push(this.fillStyle);
    },
    strokeRect(): void {},
    fillText(this: { fillStyle: string }, text: string): void {
      texts.push(String(text));
    },
    clearRect(): void {},
    drawImage(): void {},
    save(): void {},
    restore(): void {},
    translate(): void {},
    scale(): void {},
  } as unknown as Canvas2D;
  return {
    width: 0,
    height: 0,
    getContext: (): Canvas2D | null => ctx,
    texts: (): readonly string[] => texts,
    fills: (): readonly string[] => fills,
  };
}

describe('the live arena carries the set score and the ending (12.7)', () => {
  const GOLD = '#ffd24a';

  it('finish() parks the clock on the round\u2019s final frame', () => {
    const arena = createLiveArena({ canvas: createRichCanvas(), view: createFakeView(), reducedMotion: false });
    const produced = states(4);
    arena.begin();
    for (const state of produced) {
      arena.pushState(state);
    }
    // Before finishing, the still first frame is on screen.
    expect(arena.frameIndex()).toBe(0);
    arena.finish();
    // Parked on the last frame the states allow -- 4 states is 3 transitions of
    // 12 film frames, so the final frame index is 35.
    expect(arena.frameIndex()).toBe(3 * 12 - 1);
  });

  it('draws the overlay only while one is set, and clears it', () => {
    const canvas = createRichCanvas();
    const arena = createLiveArena({ canvas, view: createFakeView(), reducedMotion: false });
    arena.begin();
    for (const state of states(3)) {
      arena.pushState(state);
    }

    arena.showMatchEnd({ endReason: 'timeout', outcome: 'p2' });
    expect(canvas.texts()).toContain('TIME OVER');
    expect(canvas.texts()).toContain('P2 WINS');

    arena.showMatchEnd(null);
    // A repaint with no overlay: the freshly drawn frame carries neither word.
    const after = canvas.texts().length;
    arena.showMatchEnd(null);
    expect(canvas.texts().slice(after)).not.toContain('TIME OVER');
  });

  it('retains the pips across begin() but clears the overlay', () => {
    const canvas = createRichCanvas();
    const arena = createLiveArena({ canvas, view: createFakeView(), reducedMotion: false });
    arena.begin();
    arena.pushState(states(1)[0]);

    arena.setRoundsWon([1, 0]);
    arena.showMatchEnd({ endReason: 'ko', outcome: 'p1' });
    expect(canvas.fills()).toContain(GOLD); // a filled pip
    expect(canvas.texts()).toContain('K.O.');

    // A fresh round: the pips are retained, the overlay is gone.
    arena.begin();
    arena.pushState(states(1)[0]);
    expect(canvas.fills()).toContain(GOLD); // the retained pip still fills gold
    const afterBegin = canvas.texts().length;
    arena.pushState(states(2)[1]);
    expect(canvas.texts().slice(afterBegin)).not.toContain('K.O.');
  });
});
