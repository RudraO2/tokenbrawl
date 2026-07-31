import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
} from '../../../../packages/env-fighter/src/frames';

/**
 * Story 4.1: which animation clip a fighter is playing, and which frame of it.
 *
 * This is the file that turns the simulation's frame data into something a
 * viewer can actually see. Story 2.2 built Commitment Windows as a real state
 * machine -- `attack` is 4 ticks of startup, 4 active, 32 recovery; `special`
 * is 10/5/45 -- and until now the player expressed all of that as a rectangle
 * changing colour. The mechanics were there and the presentation threw them
 * away.
 *
 * Every decision here is derived from state the simulation already carries.
 * Nothing is invented, nothing is timed against a clock, and the function is
 * pure: same state in, same clip and frame out. That matters for INV-3 as much
 * as for testability -- an animation whose frame depended on elapsed time would
 * make playback differ between a fast machine and a slow one.
 */

/**
 * The clips a sheet must provide. Deliberately named after what the fighter is
 * *doing*, not after a sprite index, so a replacement sheet (Martial Hero, or
 * anything else) maps onto it by describing its own rows rather than by
 * matching an ordering it cannot see.
 */
export type ClipName =
  | 'idle'
  | 'walk'
  | 'block'
  | 'attack-startup'
  | 'attack-active'
  | 'attack-recovery'
  | 'special-startup'
  | 'special-active'
  | 'special-recovery'
  | 'hit'
  | 'ko';

export const CLIP_NAMES: readonly ClipName[] = [
  'idle',
  'walk',
  'block',
  'attack-startup',
  'attack-active',
  'attack-recovery',
  'special-startup',
  'special-active',
  'special-recovery',
  'hit',
  'ko',
];

export interface AnimationInput {
  /** `COMMITTED_*`. Which Action owns this fighter's Commitment Window, if any. */
  readonly committedAction: number;
  /** `PHASE_*`, already derived by `phaseOf`. */
  readonly phase: number;
  /** Health now. Zero is a KO and outranks everything else. */
  readonly health: number;
  /** Health at the previous Decision Point, to detect a hit landing on this fighter. */
  readonly previousHealth: number;
  /** Arena units moved since the previous Decision Point. Sign is irrelevant -- walking is walking. */
  readonly movedUnits: number;
  /** Whether this fighter submitted `block` at this Decision Point. */
  readonly blocking: boolean;
  /** Playback frame index, used only to phase looping clips. Never a clock reading. */
  readonly frameIndex: number;
}

export interface AnimationState {
  readonly clip: ClipName;
  /** Index into the clip's frames, already wrapped. */
  readonly frame: number;
}

/** Playback frames each looping-clip frame is held for. Stepped, and constant for every Match. */
const LOOP_FRAME_HOLD = 6;

/**
 * How many frames each clip has. A sheet must supply at least this many; the
 * loader rejects one that supplies fewer rather than drawing a blank.
 */
export const CLIP_FRAME_COUNTS: Readonly<Record<ClipName, number>> = Object.freeze({
  idle: 4,
  walk: 4,
  block: 1,
  'attack-startup': 2,
  'attack-active': 2,
  'attack-recovery': 2,
  'special-startup': 3,
  'special-active': 2,
  'special-recovery': 2,
  hit: 1,
  ko: 1,
});

/** The clip a Commitment Window maps to, or `null` when the fighter is free. */
function committedClip(committedAction: number, phase: number): ClipName | null {
  if (committedAction === COMMITTED_ATTACK) {
    if (phase === PHASE_STARTUP) {
      return 'attack-startup';
    }
    if (phase === PHASE_ACTIVE) {
      return 'attack-active';
    }
    if (phase === PHASE_RECOVERY) {
      return 'attack-recovery';
    }
  }
  if (committedAction === COMMITTED_SPECIAL) {
    if (phase === PHASE_STARTUP) {
      return 'special-startup';
    }
    if (phase === PHASE_ACTIVE) {
      return 'special-active';
    }
    if (phase === PHASE_RECOVERY) {
      return 'special-recovery';
    }
  }
  return null;
}

/**
 * Chooses the clip and frame for one fighter at one playback frame.
 *
 * Priority order, and each step is a claim about what a viewer most needs to
 * see at that instant:
 *
 * 1. **KO** — the Match is over for this fighter; nothing else is worth showing.
 * 2. **Commitment Window** — startup, active and recovery are the whole point
 *    of the frame data. A fighter that is mid-`special` must not look like it
 *    is walking, because the punish window is the thing being demonstrated.
 * 3. **Hit** — took damage this Decision Point and is not otherwise committed.
 * 4. **Block** — submitted a guard.
 * 5. **Walk** — position changed.
 * 6. **Idle** — none of the above.
 *
 * Hit is deliberately *below* the Commitment Window: a fighter caught in
 * recovery while being hit is the most instructive moment in the game, and
 * showing a generic flinch there would hide exactly the mistake that lost the
 * exchange.
 */
export function animationFor(input: AnimationInput): AnimationState {
  const clip = selectClip(input);
  const count = CLIP_FRAME_COUNTS[clip];

  // One-shot clips advance with the Commitment Window itself so the pose tracks
  // the phase; looping clips are phased by the playback frame. Neither reads a
  // clock, and both are integer arithmetic.
  const frame =
    clip === 'idle' || clip === 'walk'
      ? Math.floor(input.frameIndex / LOOP_FRAME_HOLD) % count
      : Math.min(count - 1, Math.floor(input.frameIndex / LOOP_FRAME_HOLD) % count);

  return { clip, frame };
}

function selectClip(input: AnimationInput): ClipName {
  if (input.health <= 0) {
    return 'ko';
  }

  const committed = committedClip(input.committedAction, input.phase);
  if (committed !== null) {
    return committed;
  }

  if (input.health < input.previousHealth) {
    return 'hit';
  }

  if (input.blocking) {
    return 'block';
  }

  if (input.movedUnits !== 0) {
    return 'walk';
  }

  return 'idle';
}

/** True when this fighter is free to act -- used to decide whether `blocking` is even meaningful. */
export function isFree(committedAction: number): boolean {
  return committedAction === COMMITTED_NONE;
}
