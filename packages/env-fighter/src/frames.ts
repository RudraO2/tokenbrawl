/**
 * Commitment Window frame data lookups.
 *
 * A Commitment Window is `startup -> active -> recovery` ticks. State carries
 * only two integers per fighter -- which Action is committed, and how many
 * ticks of its window remain -- and every question about the window is
 * *derived* from those two plus the config. Nothing here holds state, so the
 * same functions serve `step()`, the Baseline Bots of Story 2.3, and the
 * replay renderer of Epic 4 without any of them agreeing on a private
 * convention.
 *
 * Codes rather than strings because `FighterState` is integers only: a phase
 * name in state would be unhashable by `canonicalStringify` (INV-2, AD-5).
 */

import { ACTIONS, type Action } from '@tokenbrawl/contracts';
import type { CommitmentWindow, FighterConfig } from './config';

/** No Commitment Window open: the fighter is actionable at the next Decision Point. */
export const COMMITTED_NONE = 0;
export const COMMITTED_ATTACK = 1;
export const COMMITTED_SPECIAL = 2;
/**
 * `jump` (Story 8.2). Occupies `config.jumpWindow` exactly the way `attack`
 * and `special` occupy their own windows: `startup`/`active`/`recovery` read
 * as rise/apex/fall, but the countdown machinery below does not know or care
 * -- it is the same two integers in state and the same `windowFor`/`phaseOf`
 * that every other committed Action uses.
 */
export const COMMITTED_JUMP = 3;
export type CommittedActionCode = 0 | 1 | 2 | 3;

/**
 * Zone codes (Story 8.3). `attack`/`special` target one of two Zones, and
 * `block` must match it to prevent damage. Integer codes rather than the
 * `'high' | 'low'` string the Command Log schema uses (`DecisionEntryV2.zone`,
 * Story 8.1) because `FighterState` is integers only (INV-2, AD-5) -- AD-13's
 * schema-vs-state representation split, made concrete.
 *
 * `ZONE_NONE` is not a third Zone an Agent can choose: it is what an
 * uncommitted fighter, or a fighter whose committed Action carries no Zone
 * (the Fallback Action, or any non-attack/special/block Action), reads as. A
 * `block` submitted with no Zone therefore never matches a real attacker
 * Zone -- unless the attacker also carries no Zone, in which case both sides
 * read `ZONE_NONE` and the match is exact, which is what keeps a Zone-naive
 * caller's `block` behaving exactly as before this story.
 */
export const ZONE_NONE = 0;
export const ZONE_HIGH = 1;
export const ZONE_LOW = 2;
export type ZoneCode = 0 | 1 | 2;

/** The string form used on the wire (Command Log v2, `DecisionEntryV2.zone`). */
export type Zone = 'high' | 'low';

/**
 * `null`/`undefined` -- no Zone submitted -- maps to `ZONE_NONE`, never to
 * either real Zone. Never called with the Fallback Action: `stand` carries no
 * Zone by construction (this story's Fallback-Action AC), so callers must not
 * route a Parse Failure's substituted Action through this function with a
 * caller-supplied Zone.
 */
export function zoneCodeFor(zone: Zone | null | undefined): ZoneCode {
  if (zone === 'high') {
    return ZONE_HIGH;
  }
  if (zone === 'low') {
    return ZONE_LOW;
  }
  return ZONE_NONE;
}

/** Not inside a window at all -- distinct from being inside one and between phases. */
export const PHASE_IDLE = 0;
/** For `jump`, this is the rise phase. */
export const PHASE_STARTUP = 1;
/** The only phase in which an Action can connect. For `jump`, this is the apex. */
export const PHASE_ACTIVE = 2;
/** Committed, cannot act, cannot block: the punishable phase. For `jump`, this is the fall. */
export const PHASE_RECOVERY = 3;
export type PhaseCode = 0 | 1 | 2 | 3;

/** The window a committed Action code occupies, or `null` for `COMMITTED_NONE`. */
export function windowFor(config: FighterConfig, code: number): CommitmentWindow | null {
  if (code === COMMITTED_ATTACK) {
    return config.attackWindow;
  }
  if (code === COMMITTED_SPECIAL) {
    return config.specialWindow;
  }
  if (code === COMMITTED_JUMP) {
    return config.jumpWindow;
  }
  return null;
}

export function windowTotalTicks(frames: CommitmentWindow): number {
  return frames.startup + frames.active + frames.recovery;
}

/**
 * Which phase a countdown is in. `elapsed = total - remaining`, so the phase
 * is a pure function of the two integers in state -- a window is never
 * lengthened or shortened by what happened inside it, which is what makes
 * "damageable for the full recovery duration" a statement about frame data
 * rather than about the fight.
 */
export function phaseOf(config: FighterConfig, code: number, remaining: number): PhaseCode {
  // Named `frames`, never `window`: `scripts/audit-invariants.sh`'s INV-3 sweep
  // bans a lowercase `window` followed by a dot outright, since that is exactly
  // how a DOM reference reads. The sweep does not exempt comments either, so no
  // identifier *or* sentence in this package may spell that sequence -- which
  // is why this note describes it rather than quoting it.
  const frames = windowFor(config, code);
  if (frames === null || remaining <= 0) {
    return PHASE_IDLE;
  }

  const elapsed = windowTotalTicks(frames) - remaining;
  if (elapsed < frames.startup) {
    return PHASE_STARTUP;
  }
  if (elapsed < frames.startup + frames.active) {
    return PHASE_ACTIVE;
  }
  return PHASE_RECOVERY;
}

/**
 * Inclusive ceiling of the range band an Action connects within.
 *
 * Throws for `COMMITTED_NONE` rather than returning `0`: a caller that asks
 * for the band of a fighter with no window open has a logic error, and a `0`
 * would quietly mean "connects only at zero separation" instead of saying so.
 */
export function rangeForCode(config: FighterConfig, code: number): number {
  if (code === COMMITTED_ATTACK) {
    return config.attackRange;
  }
  if (code === COMMITTED_SPECIAL) {
    return config.specialRange;
  }
  throw new Error(`rangeForCode: no range band for committed Action code ${code}`);
}

/** Base damage before jitter and block reduction. Throws for `COMMITTED_NONE`, as above. */
export function damageForCode(config: FighterConfig, code: number): number {
  if (code === COMMITTED_ATTACK) {
    return config.attackDamage;
  }
  if (code === COMMITTED_SPECIAL) {
    return config.specialDamage;
  }
  throw new Error(`damageForCode: no damage for committed Action code ${code}`);
}

/**
 * Fixed-point integer gravity: how many vertical units a rising fighter gains
 * per Tick, so `jumpHeight` is reached (bar remainder, which `step()` clamps
 * away) exactly `config.jumpWindow.startup` Ticks after `jump` is committed.
 * `Math.floor` of two safe integers is always a safe integer -- no float ever
 * enters this arithmetic (AD-5), and `assertIntegerConfig` rejects a
 * `jumpWindow.startup` of `0` before this could divide by it.
 */
export function jumpRiseStepPerTick(config: FighterConfig): number {
  return Math.floor(config.jumpHeight / config.jumpWindow.startup);
}

/** The fall's counterpart to `jumpRiseStepPerTick`, over `jumpWindow.recovery` Ticks. */
export function jumpFallStepPerTick(config: FighterConfig): number {
  return Math.floor(config.jumpHeight / config.jumpWindow.recovery);
}

/**
 * The Action grammar currently legal for a fighter with this much Super Meter.
 *
 * `special` is withheld below its cost (Story 2.2 AC3). Withholding it is the
 * honest half of the rule: `step()` still refuses an illegal submission and
 * applies the Fallback Action, so an Agent that ignores `legalActions` is not
 * rewarded, but a well-behaved one is never invited to waste a Decision Point.
 */
export function legalActionsFor(config: FighterConfig, meter: number): readonly Action[] {
  if (meter >= config.specialMeterCost) {
    return ACTIONS;
  }
  return ACTIONS.filter((action) => action !== 'special');
}
