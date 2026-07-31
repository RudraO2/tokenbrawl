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
  /** Damage subtracted when the defender submitted `block` at the same Decision Point. */
  readonly blockDamageReduction: number;
  readonly meterOnHitLanded: number;
  readonly meterOnHitTaken: number;
  readonly maxMeter: number;
  /** Per-side integer damage jitter drawn from the Match PRNG: adds 0 or this much. */
  readonly damageJitter: number;
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
  blockDamageReduction: 5,
  meterOnHitLanded: 12,
  meterOnHitTaken: 6,
  maxMeter: 100,
  damageJitter: 1,
};

/** Keys whose value is a nested `CommitmentWindow` rather than a scalar. */
const WINDOW_KEYS: readonly string[] = ['attackWindow', 'specialWindow'];

const WINDOW_FIELDS = ['startup', 'active', 'recovery'] as const;

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
  ] as const;
  for (const key of NON_NEGATIVE_KEYS) {
    if (config[key] < 0) {
      throw new Error(`FighterConfig.${key} must not be negative, received: ${config[key]}`);
    }
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
