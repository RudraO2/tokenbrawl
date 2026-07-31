/**
 * Frame data for the fighter.
 *
 * Every number the simulation reads lives here -- there are no magic numbers
 * in `environment.ts`. The values below are *starting* values chosen by Story
 * 2.1; Story 2.4's skill-separation gate calibrates them, and Story 2.2 adds
 * the startup/active/recovery breakdown that turns `specialCommitmentTicks`
 * into a real Commitment Window state machine.
 *
 * Ticks throughout. Nothing here is a second, and nothing here is a playback
 * rate (INV-1).
 */
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
  /** Ticks the attacker is locked out of Decision Points after a `special`. */
  readonly specialCommitmentTicks: number;
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
  specialCommitmentTicks: 60,
  blockDamageReduction: 5,
  meterOnHitLanded: 12,
  meterOnHitTaken: 6,
  maxMeter: 100,
  damageJitter: 1,
};

/**
 * Reject a config that could put a non-integer into state.
 *
 * Cheap, and it fails at the one boundary a float can realistically cross:
 * a caller computing an override (`initialHealth: base / 3`) rather than
 * writing a literal. Without it the float would travel all the way to
 * `hash()` before anything complained.
 */
export function assertIntegerConfig(config: FighterConfig): void {
  const scalarEntries = Object.entries(config).filter(([, value]) => !Array.isArray(value));
  for (const [key, value] of scalarEntries) {
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
    'specialCommitmentTicks',
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
