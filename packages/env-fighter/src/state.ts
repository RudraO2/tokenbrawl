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
  /**
   * Integer units above the floor along the vertical axis. `0` is grounded.
   * Story 8.2: driven by `jump`'s Commitment Window (rise -> apex -> fall) and
   * gravity in `environment.ts`'s `step()`, never set directly elsewhere.
   * Floored at `0` on every Tick resolution -- it can never go negative.
   */
  readonly verticalPosition: readonly [number, number];
  /**
   * Which phase of a `jump` a fighter is in, as one of `frames.ts`'s
   * `PHASE_*` codes (`PHASE_IDLE` when grounded or mid-*any other* Commitment
   * Window). A projection of `committedAction`/`commitmentRemaining` rather
   * than an independent state machine -- reusing `phaseOf` is what "no
   * parallel window system" (Story 8.2) means in practice -- but stored
   * rather than recomputed on read, so Story 8.4's air-attack and juggle work
   * can consume it without threading `committedAction` through as well.
   */
  readonly airState: readonly [number, number];
  /**
   * Story 8.3: the Zone (`ZONE_NONE` / `ZONE_HIGH` / `ZONE_LOW` in
   * `frames.ts`) a fighter's *current* `committedAction` targets, when that
   * Action is `attack` or `special`. Stored per Agent, alongside
   * `committedAction`, for the same reason `committedAction` itself is
   * stored rather than recomputed: the active-phase Tick that judges a hit
   * can fall in a later `step()` call than the one that committed it, so the
   * Zone has to survive between calls. An integer code, never the
   * `'high' | 'low'` string the Command Log carries (INV-2, AD-13) -- that
   * split is the concrete point of this story.
   *
   * Meaningless (and unread) whenever `committedAction` is not `attack` or
   * `special`; cleared to `ZONE_NONE` alongside `committedAction` when a
   * window closes, so a stale value can never leak into the next commitment.
   */
  readonly committedZone: readonly [number, number];
  /**
   * Story 8.4: consecutive hits landed on this Agent while it has not
   * regained a real Decision Point -- reset to `0` the moment it lands its
   * own hit, blocks successfully, or its hitstun window closes without a
   * further hit ("returns to neutral"). Read by `frames.ts`'s juggle-scaling
   * lookups so damage and hitstun shrink as a chain gets longer, and by
   * `environment.ts`'s liveness cap so no chain can hold a defender past a
   * configured limit. An integer count, never a float (INV-2, AD-5).
   */
  readonly juggleCount: readonly [number, number];
}
