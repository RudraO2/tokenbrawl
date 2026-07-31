/**
 * The whole simulation state. Every field is a safe integer -- positions,
 * health, meter and timers alike (INV-2, AD-5). There is no float, no
 * `Date`, no object identity, and no reference to anything outside this
 * package: a `FighterState` is fully described by its numbers, which is what
 * makes `hash()` a meaningful Final-State Hash.
 *
 * Index 0 is Agent p1, index 1 is Agent p2, everywhere and always.
 */
export interface FighterState {
  /** Simulation Ticks elapsed. Advances by exactly `ticksPerDecision` per `step()`. */
  readonly tick: number;
  /** The xorshift32 generator, carried in state rather than in a module global. */
  readonly rngState: number;
  readonly health: readonly [number, number];
  /** Integer units along the single horizontal axis, within the arena bounds. */
  readonly position: readonly [number, number];
  /** Super Meter. Spent by `special`, accrued by landing and taking hits. */
  readonly meter: readonly [number, number];
  /** Ticks remaining before this Agent is actionable again; `>0` means mid-Commitment-Window. */
  readonly commitmentRemaining: readonly [number, number];
  /**
   * Which Action occupies each fighter's Commitment Window, as an integer code
   * (`COMMITTED_NONE` / `COMMITTED_ATTACK` / `COMMITTED_SPECIAL` in
   * `frames.ts`). A code rather than a string because every value in this
   * object must be hashable by `canonicalStringify`, which accepts integers
   * only. Together with `commitmentRemaining` it determines the phase --
   * startup, active or recovery -- so no phase is ever stored twice.
   */
  readonly committedAction: readonly [number, number];
  /**
   * `1` once the open window has connected, `0` otherwise. Caps a Commitment
   * Window at one hit even when its active phase spans several ticks, without
   * shortening the window: recovery stays exactly as long on hit as on whiff,
   * which is what makes the punish window a property of the frame data.
   * Cleared when the window closes, so an idle fighter always reads `0`.
   */
  readonly windowHitLanded: readonly [number, number];
}
