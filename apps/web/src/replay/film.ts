import type { EnvironmentAdapter, TerminalResult } from '@tokenbrawl/contracts';
import { replayCommandLog } from '../../../../packages/core/src/replay';
import type { FighterState } from '../../../../packages/env-fighter/src/state';

/**
 * Story 4.1: the film -- what the player draws, derived entirely by
 * re-running the engine.
 *
 * The Command Log stores decisions, not frames. There is no per-tick position
 * anywhere in the schema, so reproducing visual state is not a lookup, it is a
 * re-simulation: reset from the seed, apply the logged Actions in order, keep
 * every intermediate state. That is AC1, and it is why the player is a live
 * determinism check rather than a video player (INV-2).
 *
 * **Nothing here reads a clock.** The log carries no timing field and this
 * module asks for none. Playback length is `decisionPoints *
 * FRAMES_PER_DECISION` and nothing else, so a Match between two Deployments
 * that took forty seconds a move plays back in exactly as long as one between
 * two that took two hundred milliseconds (AC2, INV-3). There is no delta-time
 * path to regress into, because there is no time input at all.
 *
 * ## Why this loop exists alongside `replayCommandLog`
 *
 * `replayCommandLog` is the authority on AC5 and returns only the final hash
 * -- it deliberately keeps no intermediate state, because the cross-process
 * determinism gate runs it 100 times in 100 bare Node children and every
 * retained array is memory that gate does not need. The player needs every
 * intermediate state, so it steps the environment itself.
 *
 * Two loops over one structure drift. So this module calls `replayCommandLog`
 * as well, carries its verdict, and `film.test.ts` asserts the two agree on
 * the final hash. A divergence is a test failure rather than a rendering
 * glitch nobody notices.
 */

/** Frames drawn per playback second. AC4 pins this at 60. */
export const PLAYBACK_FPS = 60;

/**
 * Playback frames each Decision Point occupies. 12 at 60fps means five
 * Decision Points per second, so a full 40-Decision-Point Match plays in eight
 * seconds -- long enough to follow, short enough to watch several.
 *
 * A constant, never a function of the Match. This single fact is AC2.
 */
export const FRAMES_PER_DECISION = 12;

/** Progress within a Decision Point is integer basis points, never a float. */
export const BASIS_POINTS_FULL = 10_000;

export interface RenderFrame {
  /** 0-based index into the film. */
  readonly index: number;
  /** Which Decision Point this frame sits inside. */
  readonly decisionPoint: number;
  /**
   * How far through the Decision Point, in basis points (0..9999).
   *
   * Integer on purpose. The simulation is integer-only (INV-2) and the frame
   * model stays that way; the renderer is the only place a float appears, and
   * only as the pixel coordinate it hands to the canvas. Interpolation is a
   * drawing concern and is never fed back into state.
   */
  readonly progressBasisPoints: number;
  /** The simulated state at the start of this Decision Point. */
  readonly from: FighterState;
  /** The simulated state at the end of it. Equal to `from` on the final step. */
  readonly to: FighterState;
}

export interface ReplayFilm {
  readonly frames: readonly RenderFrame[];
  /** Every simulated state, in order, starting from `env.reset(seed)`. */
  readonly states: readonly FighterState[];
  /** Recomputed by this module from the state it actually arrived at. */
  readonly finalStateHash: string;
  /** What the log claims. Kept separate so the two can be shown side by side. */
  readonly recordedStateHash: string;
  /** AC5. Never assumed -- always recomputed and compared. */
  readonly matchesRecordedHash: boolean;
  readonly result: TerminalResult;
  /** Passed through from `replayCommandLog`; a faithful log reports none. */
  readonly divergences: readonly string[];
}

/**
 * Re-drives the log and produces every state the Match passed through.
 *
 * The loop mirrors `replayCommandLog`'s exactly -- ask `isActionable` against
 * the pre-step state, assemble one action pair, `step` once, advance by
 * `ticksPerDecision`, re-test `terminal`. It is intentionally a copy of that
 * shape rather than a clever generalisation: the two must agree, and the
 * cheapest way to keep them agreeing is for them to look the same.
 *
 * A log the environment disagrees with still produces a film. Refusing to
 * render a divergent log would hide the divergence; the verdict travels with
 * the film so the UI can show it.
 */
function simulate(
  log: {
    readonly seed: number;
    readonly decisions: readonly { readonly tick: number; readonly agentIndex: 0 | 1; readonly action: string }[];
  },
  env: EnvironmentAdapter<FighterState>,
): readonly FighterState[] {
  const byKey = new Map<string, string>();
  for (const entry of log.decisions) {
    byKey.set(`${entry.tick}:${entry.agentIndex}`, entry.action);
  }

  const states: FighterState[] = [];
  let state = env.reset(log.seed);
  states.push(state);

  let tick = 0;
  // The same budget `replayCommandLog` uses, and for the same reason: an
  // adapter whose `terminal` never fires would otherwise hang the browser tab
  // with no diagnostic.
  const budget = Math.ceil(env.maxTicks / env.ticksPerDecision) + 1;
  let steps = 0;

  while (env.terminal(state) === null) {
    steps += 1;
    if (steps > budget) {
      throw new Error(
        `buildReplayFilm: exceeded the Decision-Point budget (${budget}) at tick ${tick} without reaching a terminal state.`,
      );
    }

    const actions: [string | null, string | null] = [null, null];
    for (const agentIndex of [0, 1] as const) {
      if (!env.isActionable(state, agentIndex)) {
        continue;
      }
      actions[agentIndex] = byKey.get(`${tick}:${agentIndex}`) ?? null;
    }

    state = env.step(state, actions as Parameters<typeof env.step>[1]);
    states.push(state);
    tick += env.ticksPerDecision;
  }

  return states;
}

/** Expands the simulated states into one entry per playback frame. */
function toFrames(states: readonly FighterState[]): readonly RenderFrame[] {
  const frames: RenderFrame[] = [];
  // `states.length - 1` transitions: the last state is a destination, not the
  // start of another step, and giving it its own frames would hold the final
  // pose for an extra beat that no Decision Point corresponds to.
  const transitions = Math.max(0, states.length - 1);

  for (let step = 0; step < transitions; step += 1) {
    for (let offset = 0; offset < FRAMES_PER_DECISION; offset += 1) {
      frames.push({
        index: step * FRAMES_PER_DECISION + offset,
        decisionPoint: step,
        // `Math.floor` keeps this an integer for every FRAMES_PER_DECISION,
        // including values that do not divide 10,000 evenly.
        progressBasisPoints: Math.floor((offset * BASIS_POINTS_FULL) / FRAMES_PER_DECISION),
        from: states[step],
        to: states[step + 1],
      });
    }
  }

  return frames;
}

/**
 * Builds the film for a Command Log.
 *
 * `replayCommandLog` runs first and runs unconditionally: it is the module
 * that validates the document (schema version before any other field, AD-3;
 * seed range; hash shape; adapter identity; decision ordering), and routing
 * every log through it means the player inherits all of that rather than
 * reimplementing a weaker version. If it throws, the film does not exist,
 * which is the correct outcome for a log the player cannot honestly render.
 */
export function buildReplayFilm(
  candidate: unknown,
  env: EnvironmentAdapter<FighterState>,
): ReplayFilm {
  const verdict = replayCommandLog(candidate, env);
  const log = candidate as Parameters<typeof simulate>[0];

  const states = simulate(log, env);
  const finalState = states[states.length - 1];
  const finalStateHash = env.hash(finalState);

  return Object.freeze({
    frames: toFrames(states),
    states: Object.freeze(states),
    finalStateHash,
    recordedStateHash: verdict.finalStateHash,
    // Compared against what the replayer independently arrived at, not against
    // the field the log carries -- `replayCommandLog` already checked that, and
    // agreeing with the authority is the stronger statement (AC5).
    matchesRecordedHash: verdict.matchesRecordedHash && finalStateHash === verdict.finalStateHash,
    result: verdict.result,
    divergences: verdict.divergences,
  });
}
