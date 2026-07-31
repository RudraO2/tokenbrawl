/**
 * `@tokenbrawl/env-fighter` -- the deterministic 2D fighter.
 *
 * Integer-only state, a fixed timestep, a seeded PRNG carried inside the
 * state object, and a hash over a key-sorted canonical serialisation. The
 * package imports no Node built-in and touches no DOM, canvas, or clock API,
 * so the same module runs in CI and in a visitor's browser tab unchanged
 * (AD-4, INV-1, INV-3). `scripts/audit-invariants.sh` enforces all of that;
 * `source-discipline.test.ts` enforces it a second time from inside the suite.
 */

export { createFighterEnvironment } from './environment';

export { DEFAULT_FIGHTER_CONFIG, assertIntegerConfig } from './config';
export type { CommitmentWindow, FighterConfig } from './config';

export type { FighterState } from './state';

/**
 * Commitment Window frame data (Story 2.2). Exported because the Baseline Bots
 * of Story 2.3 and the replay renderer of Epic 4 both have to read a phase out
 * of the two integers state carries, and neither should re-derive the mapping.
 */
export {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_IDLE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
  damageForCode,
  legalActionsFor,
  phaseOf,
  rangeForCode,
  windowFor,
  windowTotalTicks,
} from './frames';
export type { CommittedActionCode, PhaseCode } from './frames';

export { mixSeed, nextRngState } from './prng';
export { canonicalStringify } from './canonical';
export { sha256Hex } from './sha256';
