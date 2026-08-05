/**
 * Frame data for the fighter.
 *
 * Every number the simulation reads lives here -- there are no magic numbers
 * in `environment.ts`. The values below are *starting* values: Story 2.1 chose
 * the first set, Story 2.2 added the startup/active/recovery breakdown that
 * makes a Commitment Window a real state machine, and Story 2.4's
 * skill-separation gate calibrates them all.
 *
 * Ticks throughout. Nothing here is a second, and nothing here is a playback
 * rate (INV-1).
 */

/**
 * One Action's frame data: how long before it can connect, how long it can
 * connect for, and how long it is helpless afterwards.
 *
 * `active >= 1` always -- a window with no active tick is an Action that can
 * never connect, which `assertIntegerConfig` rejects rather than shipping.
 */
export interface CommitmentWindow {
  /** Ticks before the Action can connect. The opponent's window to walk out of range. */
  readonly startup: number;
  /** Ticks during which the Action connects if the opponent is inside its range band. */
  readonly active: number;
  /** Ticks after active during which the fighter cannot act, move, or block. */
  readonly recovery: number;
}

export interface FighterConfig {
  /** Ticks the simulation advances per Decision Point. */
  readonly ticksPerDecision: number;
  /** Hard cap on Match length in Ticks. */
  readonly maxTicks: number;
  readonly initialHealth: number;
  /** Inclusive arena bounds along the single horizontal axis, in integer units. */
  readonly arenaMin: number;
  readonly arenaMax: number;
  /** Starting positions for p1 and p2. */
  readonly startPosition: readonly [number, number];
  /** Fighters may never end a step closer than this. */
  readonly minSeparation: number;
  /** Movement rate; a Decision Point moves `moveUnitsPerTick * ticksPerDecision` units. */
  readonly moveUnitsPerTick: number;
  readonly attackRange: number;
  readonly attackDamage: number;
  readonly specialRange: number;
  readonly specialDamage: number;
  readonly specialMeterCost: number;
  /** Frame data for `attack`: what makes it committal, and punishable on a whiff. */
  readonly attackWindow: CommitmentWindow;
  /** Frame data for `special`. Longer in every phase than `attack`, so it is the bigger risk. */
  readonly specialWindow: CommitmentWindow;
  /**
   * Frame data for `jump`: rise -> apex -> fall, in place of startup -> active
   * -> recovery. `startup` and `recovery` double as the rise and fall Tick
   * counts gravity divides `jumpHeight` across (Story 8.2), so both must be at
   * least 1 -- `assertIntegerConfig` enforces it, the same way it already
   * enforces `active >= 1` for every Commitment Window shape.
   */
  readonly jumpWindow: CommitmentWindow;
  /** Vertical units at the apex of a `jump`. Integer, per AD-5 -- no float anywhere. */
  readonly jumpHeight: number;
  /** Damage subtracted when the defender submitted `block` at the same Decision Point. */
  readonly blockDamageReduction: number;
  readonly meterOnHitLanded: number;
  readonly meterOnHitTaken: number;
  readonly maxMeter: number;
  /** Per-side integer damage jitter drawn from the Match PRNG: adds 0 or this much. */
  readonly damageJitter: number;
  /**
   * Story 8.4: Ticks a hit's defender is locked out of Decision Points before
   * any juggle scaling is applied -- the un-scaled base every entry of
   * `juggleHitstunScalePercent` is a percentage of.
   */
  readonly hitstunTicks: number;
  /**
   * Integer percentages (`0..100`), indexed by Juggle Count, that a landed
   * hit's base damage is scaled by. Index `0` is the opening hit of a chain
   * (never yet in hitstun); an index past the array's end reads as its last
   * entry, so the table only needs one row per distinct scale rather than one
   * per `juggleMaxCount` step. A data table rather than a formula so the exit
   * gate's "never a magic number inline" reads literally.
   */
  readonly juggleDamageScalePercent: readonly number[];
  /** Same shape and indexing as `juggleDamageScalePercent`, scaling `hitstunTicks` instead. */
  readonly juggleHitstunScalePercent: readonly number[];
  /**
   * Juggle Count at which a chain is forcibly ended (AC4): the hit that would
   * push the count to this value instead drops the defender straight back to
   * `COMMITTED_NONE`, actionable next Tick, and the count resets to `0`.
   */
  readonly juggleMaxCount: number;
  /**
   * Cumulative hitstun Ticks (per `juggleHitstunFor`, summed over the chain so
   * far) a chain may hold a defender for before it is forcibly ended -- the
   * Tick-based liveness cap (OQ-7) alongside `juggleMaxCount`'s hit-count cap.
   * Computed from frame data alone (`juggleChainTicksElapsed`), so this is a
   * provable property of the table rather than a claim that needs its own
   * counter in `FighterState`.
   */
  readonly juggleTickCap: number;
}

/**
 * `ticksPerDecision` and `maxTicks` match the Timing model table in
 * `docs/ARCHITECTURE.md`: a Decision Point every 30 Ticks, a Match capped at
 * 1,200 Ticks, so ~40 Decision Points per Agent at the absolute maximum.
 *
 * Both Commitment Window totals deliberately exceed `ticksPerDecision` (40 and
 * 60 against 30), for two reasons that the ACs turn on:
 *   - a committing fighter provably skips at least one Decision Point, so "not
 *     polled during the window" is an observable property rather than a claim
 *     that is trivially true inside a single step; and
 *   - the recovery tail overlaps the *next* Decision Point's active frames, so
 *     an opponent who spaced correctly can actually land a punish on it.
 * `specialWindow` totals 60 ticks -- the same lockout Story 2.1's
 * `specialCommitmentTicks` applied, now broken into phases.
 */
export const DEFAULT_FIGHTER_CONFIG: FighterConfig = {
  ticksPerDecision: 30,
  maxTicks: 1200,
  initialHealth: 100,
  arenaMin: 0,
  arenaMax: 960,
  startPosition: [320, 640],
  minSeparation: 40,
  moveUnitsPerTick: 2,
  attackRange: 80,
  attackDamage: 7,
  specialRange: 140,
  specialDamage: 16,
  specialMeterCost: 50,
  attackWindow: { startup: 4, active: 4, recovery: 32 },
  specialWindow: { startup: 10, active: 5, recovery: 45 },
  /**
   * 34 Ticks total, also exceeding `ticksPerDecision` (30) for the same reason
   * `attackWindow`/`specialWindow` do -- a fighter that jumps provably skips a
   * Decision Point. 16 rise Ticks and 16 fall Ticks each divide `jumpHeight`
   * (32) evenly into a 2-unit-per-Tick gravity step, so `Math.floor` in
   * `frames.ts`'s `jumpRiseStepPerTick`/`jumpFallStepPerTick` never needs to
   * discard a remainder -- and `step()` still floors at the ground explicitly
   * on the Tick the window closes, so an uneven override cannot land a fighter
   * above or below the floor either.
   */
  jumpWindow: { startup: 16, active: 2, recovery: 16 },
  jumpHeight: 32,
  /**
   * A guard absorbs a basic attack completely: `attackDamage` (7) plus the
   * largest `damageJitter` draw (1) is exactly 8.
   *
   * Story 2.4 raised this from 5, and it is the single number that made the
   * skill-separation gate reachable. At 5 a guard denied 5 damage but cost the
   * guarding fighter its own attack -- worth about 7 -- so blocking was
   * strictly dominated by trading, and *no* policy could beat a bot that
   * simply attacks whenever it is in range. An exhaustive search over all 64
   * in-range policies confirmed it: zero of them beat the aggressive bot at a
   * reduction of 5, under any Commitment Window shape tried. Defensive skill
   * did not merely underperform, it did not exist.
   *
   * Full absorption is not an absolute defence, which is what keeps it from
   * becoming the only Action worth choosing: `specialDamage` (16) still puts 8
   * through a guard, so the meter-gated heavy option is the answer to a
   * fighter that holds one -- and a fighter that only ever blocks deals
   * nothing and draws at best.
   */
  blockDamageReduction: 8,
  meterOnHitLanded: 12,
  meterOnHitTaken: 6,
  maxMeter: 100,
  damageJitter: 1,
  /**
   * Story 8.4. `hitstunTicks` (34) deliberately exceeds `ticksPerDecision`
   * (30), for the same reason `attackWindow`/`specialWindow`/`jumpWindow`
   * already do: a hitstun window shorter than the cadence would close inside
   * the very step that opened it, so a defender could never actually be
   * polled again mid-chain and "regains a real Decision Point" (this story's
   * liveness property) would be true only by the window having already
   * evaporated rather than by the cap or table doing any work.
   *
   * `juggleDamageScalePercent`/`juggleHitstunScalePercent` share one table
   * shape: full scale for the opening two hits (index `0`, the fresh hit, and
   * index `1`, the first continuation), then a step down every hit after,
   * bottoming out at `0` rather than negative damage or a window that never
   * closes. `juggleMaxCount` (6) matches the table's length exactly, so the
   * chain forcibly ends the Tick after the table's last real entry rather than
   * clamping into a repeated `0` scale indefinitely. `juggleTickCap` (118) is
   * the exact sum of `hitstunTicks` (34) scaled by every entry up to
   * `juggleMaxCount` -- 34+34+25+17+8+0 -- so it is a provable property of the
   * table above rather than an independently chosen number that could drift
   * out of sync with it.
   */
  hitstunTicks: 34,
  juggleDamageScalePercent: [100, 100, 75, 50, 25, 0],
  juggleHitstunScalePercent: [100, 100, 75, 50, 25, 0],
  juggleMaxCount: 6,
  juggleTickCap: 118,
};

/** Keys whose value is a nested `CommitmentWindow` rather than a scalar. */
const WINDOW_KEYS: readonly string[] = ['attackWindow', 'specialWindow', 'jumpWindow'];

const WINDOW_FIELDS = ['startup', 'active', 'recovery'] as const;

/** Keys whose value is a percentage table (Story 8.4) rather than a scalar. */
const PERCENT_TABLE_KEYS: readonly string[] = [
  'juggleDamageScalePercent',
  'juggleHitstunScalePercent',
];

/**
 * Validate one juggle scaling table: every entry a safe integer percentage
 * `0..100`, and at least one entry -- an empty table would leave
 * `scalePercent`'s `table.length - 1` index at `-1`.
 */
function assertPercentTable(key: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`FighterConfig.${key} must be a non-empty array of percentages`);
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry)) {
      throw new Error(
        `FighterConfig.${key}[${index}] must be a safe integer, received: ${String(entry)}`,
      );
    }
    if (entry < 0 || entry > 100) {
      throw new Error(
        `FighterConfig.${key}[${index}] must be a percentage between 0 and 100, received: ${entry}`,
      );
    }
  }
}

/**
 * Validate one Commitment Window.
 *
 * `active < 1` is rejected because such a window is an Action that opens, locks
 * the fighter out of Decision Points, and can never connect with anything --
 * indistinguishable in state from a working Action, and it would hash
 * deterministically the whole way to a leaderboard.
 */
function assertCommitmentWindow(key: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `FighterConfig.${key} must be a Commitment Window object, received: ${String(value)}`,
    );
  }

  // Named `frames`, never `window`: `scripts/audit-invariants.sh`'s INV-3 sweep
  // bans a lowercase `window` followed by a dot -- how a DOM reference reads --
  // and it does not exempt comments either. See the same note in `frames.ts`.
  const frames = value as Record<string, unknown>;
  for (const field of WINDOW_FIELDS) {
    const ticks = frames[field];
    if (typeof ticks !== 'number' || !Number.isSafeInteger(ticks)) {
      throw new Error(
        `FighterConfig.${key}.${field} must be a safe integer, received: ${String(ticks)}`,
      );
    }
    if (ticks < 0) {
      throw new Error(`FighterConfig.${key}.${field} must not be negative, received: ${ticks}`);
    }
  }

  if ((frames.active as number) < 1) {
    throw new Error(
      `FighterConfig.${key}.active must be at least 1 tick, or the Action could never connect`,
    );
  }
}

/**
 * Reject a config that could put a non-integer into state.
 *
 * Cheap, and it fails at the one boundary a float can realistically cross:
 * a caller computing an override (`initialHealth: base / 3`) rather than
 * writing a literal. Without it the float would travel all the way to
 * `hash()` before anything complained.
 *
 * Every key is visited, and each is routed to exactly one check -- the nested
 * windows, the position pair, or the safe-integer scalar rule. A key that is
 * neither a window nor `startPosition` must be a safe integer, so a field added
 * to `FighterConfig` later is validated by default rather than by remembering
 * to list it here.
 */
export function assertIntegerConfig(config: FighterConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (key === 'startPosition') {
      continue;
    }
    if (WINDOW_KEYS.includes(key)) {
      assertCommitmentWindow(key, value);
      continue;
    }
    if (PERCENT_TABLE_KEYS.includes(key)) {
      assertPercentTable(key, value);
      continue;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error(`FighterConfig.${key} must be a safe integer, received: ${String(value)}`);
    }
  }
  for (const [index, value] of config.startPosition.entries()) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `FighterConfig.startPosition[${index}] must be a safe integer, received: ${String(value)}`,
      );
    }
  }

  // A negative value in any of these is not a playable variant, it is a
  // simulation that runs backwards: negative `moveUnitsPerTick` turns
  // `advance` into a retreat, negative `minSeparation` lets fighters walk
  // through each other, and a negative range or damage silently disables a
  // whole Action. Every one of them would still hash deterministically, so
  // nothing downstream would ever report the config as the cause.
  const NON_NEGATIVE_KEYS = [
    'initialHealth',
    'minSeparation',
    'moveUnitsPerTick',
    'attackRange',
    'attackDamage',
    'specialRange',
    'specialDamage',
    'specialMeterCost',
    'blockDamageReduction',
    'meterOnHitLanded',
    'meterOnHitTaken',
    'maxMeter',
    'damageJitter',
    'jumpHeight',
    'hitstunTicks',
    'juggleMaxCount',
    'juggleTickCap',
  ] as const;
  for (const key of NON_NEGATIVE_KEYS) {
    if (config[key] < 0) {
      throw new Error(`FighterConfig.${key} must not be negative, received: ${config[key]}`);
    }
  }

  // A `juggleMaxCount` of `0` would force every chain to end before its
  // opening hit is even recorded, which is indistinguishable from the
  // mechanic not existing at all -- `assertCommitmentWindow`'s `active < 1`
  // rejection above is the same shape of guard for the same reason.
  if (config.juggleMaxCount < 1) {
    throw new Error(
      `FighterConfig.juggleMaxCount must be at least 1, received: ${config.juggleMaxCount}`,
    );
  }

  // A Commitment Window no longer than the cadence unwinds completely inside
  // the step that opened it, so its fighter is actionable again at the very next
  // Decision Point and the Action costs nothing at all. That deletes the whole
  // mechanic this environment is built around -- and it deletes it silently,
  // because such a Match still runs, still hashes, and still produces a
  // leaderboard row. The header comment above already claims both totals exceed
  // `ticksPerDecision`; this makes the claim enforceable rather than aspirational.
  for (const key of WINDOW_KEYS) {
    const frames = config[key as 'attackWindow' | 'specialWindow'];
    const total = frames.startup + frames.active + frames.recovery;
    if (total <= config.ticksPerDecision) {
      throw new Error(
        `FighterConfig.${key} totals ${total} Ticks, which does not exceed ticksPerDecision (${config.ticksPerDecision}) -- the Action would commit its fighter for no Decision Point at all`,
      );
    }
  }

  // A range band at or below `minSeparation` can never connect: separation is
  // floored at `minSeparation` by the closing cap, and two mutual closers
  // conserve separation parity, so the last reachable unit above the floor may
  // be `minSeparation + 1`. An Action configured inside that gap is an Action
  // that silently does nothing -- the same failure mode the
  // `specialMeterCost > maxMeter` check below exists to prevent.
  const RANGE_KEYS = ['attackRange', 'specialRange'] as const;
  for (const key of RANGE_KEYS) {
    if (config[key] <= config.minSeparation) {
      throw new Error(
        `FighterConfig.${key} (${config[key]}) must exceed minSeparation (${config.minSeparation}), or the Action could never connect`,
      );
    }
  }

  // `jumpRiseStepPerTick`/`jumpFallStepPerTick` in `frames.ts` divide
  // `jumpHeight` by these two counts; a `0` would divide by zero and a
  // negative one is already rejected by `assertCommitmentWindow`'s Tick
  // fields. `active >= 1` is already enforced generically, but rise and fall
  // are the two fields no other window shape depends on for arithmetic.
  if (config.jumpWindow.startup < 1 || config.jumpWindow.recovery < 1) {
    throw new Error(
      `FighterConfig.jumpWindow.startup and .recovery must each be at least 1 Tick, or gravity has nothing to divide jumpHeight across`,
    );
  }

  if (config.specialMeterCost > config.maxMeter) {
    // `special` would be unusable forever, and no test of meter accrual could
    // ever reach it -- a config that quietly deletes an Action.
    throw new Error(
      `FighterConfig.specialMeterCost (${config.specialMeterCost}) exceeds maxMeter (${config.maxMeter}), making special unusable`,
    );
  }

  if (config.ticksPerDecision <= 0) {
    // A zero or negative cadence means `tick` never advances, so `terminal()`
    // could never reach its timeout branch and a Match with no KO would spin
    // forever inside the Harness loop.
    throw new Error(
      `FighterConfig.ticksPerDecision must be positive, received: ${config.ticksPerDecision}`,
    );
  }
  if (config.maxTicks <= 0) {
    throw new Error(`FighterConfig.maxTicks must be positive, received: ${config.maxTicks}`);
  }
  if (config.arenaMax <= config.arenaMin) {
    throw new Error(
      `FighterConfig.arenaMax must exceed arenaMin, received: ${config.arenaMin}..${config.arenaMax}`,
    );
  }
  for (const [index, value] of config.startPosition.entries()) {
    if (value < config.arenaMin || value > config.arenaMax) {
      throw new Error(
        `FighterConfig.startPosition[${index}] must lie within the arena, received: ${value}`,
      );
    }
  }
  if (Math.abs(config.startPosition[0] - config.startPosition[1]) < config.minSeparation) {
    throw new Error('FighterConfig.startPosition must respect minSeparation');
  }
}
