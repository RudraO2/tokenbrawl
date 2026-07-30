import { createHash } from 'node:crypto';
import { ACTIONS, type EnvironmentAdapter, type LoggedAction, type Observation, type TerminalResult } from '@tokenbrawl/contracts';

/**
 * Trivial deterministic `EnvironmentAdapter` used as a fixture for the
 * match-runner and later Command Log / replay stories. It exists to prove
 * the Harness is environment-agnostic, not to model a real fighter -- see
 * `packages/env-fighter` (out of scope for this story) for that.
 *
 * Integer-only state, a seeded PRNG threaded through state (never a module
 * global), and a canonical sorted-key SHA-256 `hash()`, per INV-1/INV-2.
 */
export interface MockState {
  readonly tick: number;
  readonly rngState: number;
  readonly health: readonly [number, number];
  /** Ticks remaining before this Agent is actionable again; >0 means "inside a Commitment Window". */
  readonly commitmentRemaining: readonly [number, number];
}

export interface MockEnvironmentConfig {
  readonly ticksPerDecision: number;
  readonly maxTicks: number;
  readonly initialHealth: number;
  /** Ticks an Agent is locked out for after choosing `special`. */
  readonly commitmentTicksAfterSpecial: number;
  readonly attackDamage: number;
  readonly specialDamage: number;
}

export const DEFAULT_MOCK_ENVIRONMENT_CONFIG: MockEnvironmentConfig = {
  ticksPerDecision: 1,
  maxTicks: 20,
  initialHealth: 30,
  commitmentTicksAfterSpecial: 2,
  attackDamage: 5,
  specialDamage: 9,
};

/** xorshift32: integer-only, deterministic, no unseeded randomness -- threaded entirely through `MockState.rngState`. */
function nextRngState(state: number): number {
  let x = state | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x | 0;
}

function damageFor(action: LoggedAction, config: MockEnvironmentConfig): number {
  switch (action) {
    case 'attack':
      return config.attackDamage;
    case 'special':
      return config.specialDamage;
    default:
      return 0;
  }
}

/** Canonical, sorted-key, integer-only serialisation -- the machine expression of INV-2's hash requirement. */
function canonicalize(state: MockState): string {
  return JSON.stringify({
    commitmentRemaining: [state.commitmentRemaining[0], state.commitmentRemaining[1]],
    health: [state.health[0], state.health[1]],
    rngState: state.rngState,
    tick: state.tick,
  });
}

export function createMockEnvironment(
  overrides: Partial<MockEnvironmentConfig> = {},
): EnvironmentAdapter<MockState> {
  const config: MockEnvironmentConfig = { ...DEFAULT_MOCK_ENVIRONMENT_CONFIG, ...overrides };

  return {
    id: 'mock-environment',
    version: '1.0.0',
    ticksPerDecision: config.ticksPerDecision,
    maxTicks: config.maxTicks,

    reset(seed: number): MockState {
      // Mix the seed before feeding it to xorshift32, which never leaves an
      // all-zero state: a bare `(seed | 0) || 1` fallback would make seed 0
      // and seed 1 produce byte-identical RNG streams. Math.imul mixing
      // means only a hash collision (astronomically unlikely for the small
      // integer seeds Matches actually use) could still collide.
      let rngState = Math.imul(seed | 0, 0x9e3779b9) | 0;
      if (rngState === 0) {
        rngState = 0x6d2b79f5;
      }
      return {
        tick: 0,
        rngState,
        health: [config.initialHealth, config.initialHealth],
        commitmentRemaining: [0, 0],
      };
    },

    isActionable(state: MockState, agentIndex: 0 | 1): boolean {
      return state.commitmentRemaining[agentIndex] <= 0;
    },

    observe(state: MockState, agentIndex: 0 | 1): Observation {
      const opponentIndex = agentIndex === 0 ? 1 : 0;
      return {
        state: JSON.stringify({
          opponentHealth: state.health[opponentIndex],
          selfHealth: state.health[agentIndex],
          tick: state.tick,
        }),
        legalActions: ACTIONS,
        tick: state.tick,
      };
    },

    step(state: MockState, actions: readonly [LoggedAction | null, LoggedAction | null]): MockState {
      const rngState = nextRngState(state.rngState);
      const modifier = Math.abs(rngState) % 2;

      const nextCommitment: [number, number] = [
        Math.max(0, state.commitmentRemaining[0] - config.ticksPerDecision),
        Math.max(0, state.commitmentRemaining[1] - config.ticksPerDecision),
      ];
      const nextHealth: [number, number] = [state.health[0], state.health[1]];

      for (const agentIndex of [0, 1] as const) {
        const action = actions[agentIndex];
        if (action === null) {
          continue;
        }

        const opponentIndex = agentIndex === 0 ? 1 : 0;
        const damage = damageFor(action, config);
        if (damage > 0) {
          nextHealth[opponentIndex] = Math.max(0, nextHealth[opponentIndex] - damage - modifier);
        }
        if (action === 'special') {
          nextCommitment[agentIndex] = config.commitmentTicksAfterSpecial;
        }
      }

      return {
        tick: state.tick + config.ticksPerDecision,
        rngState,
        health: nextHealth,
        commitmentRemaining: nextCommitment,
      };
    },

    terminal(state: MockState): TerminalResult | null {
      const [p1Health, p2Health] = state.health;
      const healthRemaining: readonly [number, number] = [p1Health, p2Health];

      if (p1Health <= 0 || p2Health <= 0) {
        const outcome = p1Health <= 0 && p2Health <= 0 ? 'draw' : p1Health <= 0 ? 'p2' : 'p1';
        return { outcome, endTick: state.tick, endReason: 'ko', healthRemaining };
      }

      if (state.tick >= config.maxTicks) {
        const outcome = p1Health === p2Health ? 'draw' : p1Health > p2Health ? 'p1' : 'p2';
        return { outcome, endTick: state.tick, endReason: 'timeout', healthRemaining };
      }

      return null;
    },

    hash(state: MockState): string {
      return createHash('sha256').update(canonicalize(state)).digest('hex');
    },
  };
}
