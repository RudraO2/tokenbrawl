import type { Action, CommandLogV2, TerminalResult } from '@tokenbrawl/contracts';
import type { FighterState } from '../../../../packages/env-fighter/src/state';
import type { InputMapper } from './agent';
import {
  runArcadeMatch,
  type ArcadeMatchHandle,
  type ArcadeRunConfig,
  type BaselineBotKind,
} from './run';

/**
 * Story 12.7: the arcade session -- a best-of-three set, and nothing in the
 * simulation touched.
 *
 * ## Why a session is three Matches rather than a longer Match
 *
 * The tempting design -- a `roundsPerMatch` in `FighterConfig`, health reset
 * between rounds, one Command Log covering the set -- is wrong three times over,
 * and the story spells each out:
 *
 * 1. Both command-log schemas are FROZEN. A Command Log is one Match; there is
 *    no round field and none may be added.
 * 2. Any new `FighterConfig` key changes `configHash`, which every committed log
 *    records, so every one of them would stop verifying.
 * 3. Changing `maxTicks`, health or the round structure changes every
 *    Final-State Hash in the repository and re-opens the skill-separation gates.
 *    This is a presentation epic; it re-runs no gate.
 *
 * So a session runs three **full, unmodified** Matches back to back -- each the
 * same `runArcadeMatch` the single Match already used, each with its own Command
 * Log, its own seed and its own hash. The first side to win two Matches takes the
 * set. Nothing in `packages/` is edited, no committed log is invalidated, and a
 * visitor sees best-of-three.
 *
 * ## The seeds are derived, so the set is as deterministic as a Match
 *
 * Each round's seed is a pure function of the session seed and the round index
 * (`matchSeedFor`), so the same session seed and the same inputs derive the same
 * three seeds and produce the same three logs (INV-2). A round's winner is read
 * from the log's existing `result`: `outcome` names the side, and `outcome` is
 * already what a timeout tie on `healthRemaining` resolves to -- three fields
 * that exist and are already populated.
 *
 * ## The between-round pause belongs to the caller, not here
 *
 * `onRoundEnd` may return a promise, and the session awaits it before starting
 * the next round. That is where the panel holds the KO / TIME OVER overlay for
 * its counted number of frames and restores the fresh round's canvas -- a hold
 * this module never expresses as a timer, because it has no clock at all. A
 * session with no `onRoundEnd` runs its rounds back to back with no pause, which
 * is exactly what a test wants.
 */

/** Rounds a side must win to take the set. Best-of-three. */
export const ROUNDS_TO_WIN_SET = 2;

/**
 * The most Matches a set can run.
 *
 * Three -- best-of-three. A fourth is unreachable when every round has a winner
 * (someone reaches two by the third), and this bound is what stops a pathological
 * run of drawn rounds, which count for neither side, from playing forever.
 */
export const MAX_ROUNDS = 3;

/**
 * The seed for round `round` of a session (Story 12.7).
 *
 * A pure, deterministic mix of the session seed and the round index. `>>> 0`
 * lands the result in 0..2^32-1 -- inside the frozen `seed` bound and a safe
 * integer, which is what `assertSeed` in `run.ts` requires. Mixed rather than
 * incremented so round 2's seed is not merely round 1's neighbour: consecutive
 * seeds would make the three Matches read as hand-typed variations of one rather
 * than three independent fights.
 */
export function matchSeedFor(sessionSeed: number, round: number): number {
  const mixed = Math.imul((sessionSeed ^ 0x9e3779b9) + Math.imul(round + 1, 0x85ebca77), 0xc2b2ae35);
  return mixed >>> 0;
}

/**
 * Which side won a round, or `null` for a draw.
 *
 * Read straight off the log's `result.outcome`: `p1` is side 0, `p2` is side 1.
 * A draw counts for neither -- the set can still be decided, and a set that runs
 * all three rounds with a draw among them is resolved by whoever has the most
 * round wins.
 */
export function roundWinner(result: TerminalResult): 0 | 1 | null {
  if (result.outcome === 'p1') {
    return 0;
  }
  if (result.outcome === 'p2') {
    return 1;
  }
  return null;
}

/** Whether the set is over after this tally: a side reached two, or three rounds have been played. */
export function setIsOver(roundsWon: readonly [number, number], roundsPlayed: number): boolean {
  return (
    roundsWon[0] >= ROUNDS_TO_WIN_SET ||
    roundsWon[1] >= ROUNDS_TO_WIN_SET ||
    roundsPlayed >= MAX_ROUNDS
  );
}

export interface ArcadeRoundEnd {
  /** 0-based index of the round that just ended. */
  readonly round: number;
  /** The round's Command Log -- a full, unmodified `CommandLogV2`. */
  readonly log: CommandLogV2;
  readonly result: TerminalResult;
  /** The set tally after this round, `[side0, side1]`. */
  readonly roundsWon: readonly [number, number];
  /** Whether this round ended the set. */
  readonly setOver: boolean;
}

export interface ArcadeSetEnd {
  readonly roundsWon: readonly [number, number];
  /** Up to three Command Logs, one per round played, in order. */
  readonly logs: readonly CommandLogV2[];
  /** Whether the visitor's own side took the set. */
  readonly humanWon: boolean;
}

export interface ArcadeSessionConfig {
  /** The session seed. Each round's seed is derived from it deterministically. */
  readonly seed: number;
  readonly humanSide: 0 | 1;
  readonly botKind?: BaselineBotKind;
  readonly mapInput: InputMapper;
  /** Injectable so a test drives a whole set with no real Match. Defaults to `runArcadeMatch`. */
  readonly run?: (config: ArcadeRunConfig) => ArcadeMatchHandle;
  readonly onLegalActions?: (legalActions: readonly Action[]) => void;
  readonly onState?: (state: FighterState) => void;
  /**
   * A round ended. The tally is updated and the log is in hand. Returning a
   * promise pauses the session on it before the next round starts -- the panel's
   * counted overlay hold -- and it is awaited only when the set is not over.
   */
  readonly onRoundEnd?: (event: ArcadeRoundEnd) => void | Promise<void>;
  /** The set ended: a side reached two wins (or three rounds were played). */
  readonly onSetEnd?: (event: ArcadeSetEnd) => void;
  /** A round's Match rejected. The set stops here rather than hanging. */
  readonly onError?: (error: unknown) => void;
}

export interface ArcadeSessionHandle {
  /** Forwarded to the round currently in play; a no-op between rounds. */
  readonly feedInput: (raw: string) => void;
  /** The set tally so far, `[side0, side1]`. */
  readonly roundsWon: () => readonly [number, number];
  /** Stops the set: the current round plays out but no further round starts. */
  readonly cancel: () => void;
}

/**
 * Runs a best-of-three set (Story 12.7).
 *
 * Starts round 0 immediately and returns a handle to drive it. Each round's log
 * settles, its winner is tallied, `onRoundEnd` fires, and -- if the set is not
 * over -- the session awaits whatever `onRoundEnd` returned and then starts the
 * next round on a freshly derived seed. The `feedInput` handle always forwards
 * to the round in play, so the panel wires one input path across the whole set.
 */
export function runArcadeSession(config: ArcadeSessionConfig): ArcadeSessionHandle {
  const run = config.run ?? runArcadeMatch;
  const otherSide: 0 | 1 = config.humanSide === 0 ? 1 : 0;

  const state: {
    roundsWon: [number, number];
    round: number;
    logs: CommandLogV2[];
    current: ArcadeMatchHandle | null;
    cancelled: boolean;
  } = {
    roundsWon: [0, 0],
    round: 0,
    logs: [],
    current: null,
    cancelled: false,
  };

  const startRound = (): void => {
    if (state.cancelled) {
      return;
    }
    const handle = run({
      seed: matchSeedFor(config.seed, state.round),
      humanSide: config.humanSide,
      botKind: config.botKind,
      mapInput: config.mapInput,
      onLegalActions: config.onLegalActions,
      onState: config.onState,
    });
    state.current = handle;
    handle.log
      .then((log) => onRoundLog(log))
      .catch((error) => {
        state.current = null;
        config.onError?.(error);
      });
  };

  const onRoundLog = async (log: CommandLogV2): Promise<void> => {
    state.current = null;
    state.logs.push(log);
    const winner = roundWinner(log.result);
    if (winner !== null) {
      state.roundsWon[winner] += 1;
    }
    state.round += 1;
    const setOver = setIsOver(state.roundsWon, state.round);

    const hold = config.onRoundEnd?.({
      round: state.round - 1,
      log,
      result: log.result,
      roundsWon: [state.roundsWon[0], state.roundsWon[1]],
      setOver,
    });

    if (setOver) {
      config.onSetEnd?.({
        roundsWon: [state.roundsWon[0], state.roundsWon[1]],
        logs: [...state.logs],
        humanWon: state.roundsWon[config.humanSide] > state.roundsWon[otherSide],
      });
      return;
    }

    // The counted overlay hold the panel returned, awaited before the next round
    // so the KO / TIME OVER screen is on the canvas while it holds and the fresh
    // round's states arrive only once it is done.
    await hold;
    if (!state.cancelled) {
      startRound();
    }
  };

  startRound();

  return Object.freeze({
    feedInput: (raw: string): void => {
      state.current?.feedInput(raw);
    },
    roundsWon: (): readonly [number, number] => [state.roundsWon[0], state.roundsWon[1]],
    cancel: (): void => {
      state.cancelled = true;
    },
  });
}
