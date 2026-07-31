import {
  ACTIONS,
  type EnvironmentAdapter,
  type LoggedAction,
  type Observation,
  type TerminalResult,
} from '@tokenbrawl/contracts';
import { canonicalStringify } from './canonical';
import { assertIntegerConfig, DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import { mixSeed, nextRngState } from './prng';
import { sha256Hex } from './sha256';
import type { FighterState } from './state';

const AGENT_INDICES: readonly (0 | 1)[] = [0, 1];

/** Bit offsets the two sides draw their damage jitter from -- disjoint, so a
 * threading bug that corrupts one side's outcome cannot hide behind the
 * other's. (The single shared modifier in `mock-environment.ts` is the
 * limitation this avoids.) */
const JITTER_BIT_P1 = 3;
const JITTER_BIT_P2 = 11;

function opponentOf(agentIndex: 0 | 1): 0 | 1 {
  return agentIndex === 0 ? 1 : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function createFighterEnvironment(
  overrides: Partial<FighterConfig> = {},
): EnvironmentAdapter<FighterState> {
  const config: FighterConfig = { ...DEFAULT_FIGHTER_CONFIG, ...overrides };
  assertIntegerConfig(config);

  const moveUnitsPerDecision = config.moveUnitsPerTick * config.ticksPerDecision;

  return {
    id: 'fighter-1v1',
    version: '1.0.0',
    ticksPerDecision: config.ticksPerDecision,
    maxTicks: config.maxTicks,

    reset(seed: number): FighterState {
      return {
        tick: 0,
        rngState: mixSeed(seed),
        health: [config.initialHealth, config.initialHealth],
        position: [config.startPosition[0], config.startPosition[1]],
        meter: [0, 0],
        commitmentRemaining: [0, 0],
      };
    },

    isActionable(state: FighterState, agentIndex: 0 | 1): boolean {
      return state.commitmentRemaining[agentIndex] <= 0;
    },

    observe(state: FighterState, agentIndex: 0 | 1): Observation {
      const opponentIndex = opponentOf(agentIndex);
      const self = state.position[agentIndex];
      const opponent = state.position[opponentIndex];
      const facingRight = self <= opponent;

      return {
        // Side-relative on purpose: an Agent is told what is ahead of it and
        // what is behind it, never an absolute p1/p2 coordinate. Two mirrored
        // seeds therefore produce byte-identical Observations, which is what
        // Story 7.1's side-swap comparison needs in order to mean anything.
        state: canonicalStringify({
          opponentHealth: state.health[opponentIndex],
          opponentMeter: state.meter[opponentIndex],
          selfHealth: state.health[agentIndex],
          selfMeter: state.meter[agentIndex],
          separation: Math.abs(self - opponent),
          spaceBehind: facingRight ? self - config.arenaMin : config.arenaMax - self,
          tick: state.tick,
        }),
        legalActions: ACTIONS,
        tick: state.tick,
      };
    },

    /**
     * One Decision Point. Both Actions resolve against a single immutable
     * pre-step snapshot -- `state` is read, never written, and every effect
     * is accumulated into per-Agent tallies that are applied once at the end.
     * That is what makes simultaneity structural: there is no "first" Agent
     * for either side's Action to have influenced.
     */
    step(
      state: FighterState,
      actions: readonly [LoggedAction | null, LoggedAction | null],
    ): FighterState {
      const rngState = nextRngState(state.rngState);
      const jitter: readonly [number, number] = [
        ((rngState >>> JITTER_BIT_P1) & 1) * config.damageJitter,
        ((rngState >>> JITTER_BIT_P2) & 1) * config.damageJitter,
      ];

      const separation = Math.abs(state.position[0] - state.position[1]);
      // Halved and applied identically to both sides so that two advancing
      // Agents cannot end closer than `minSeparation` and neither side gets
      // the odd unit -- an asymmetric push-apart would be a side advantage
      // baked into the physics.
      const advanceCap = Math.max(0, (separation - config.minSeparation) >> 1);

      const nextPosition: [number, number] = [state.position[0], state.position[1]];
      const damageTaken: [number, number] = [0, 0];
      const meterSpent: [number, number] = [0, 0];
      const meterGained: [number, number] = [0, 0];
      const nextCommitment: [number, number] = [
        Math.max(0, state.commitmentRemaining[0] - config.ticksPerDecision),
        Math.max(0, state.commitmentRemaining[1] - config.ticksPerDecision),
      ];

      for (const agentIndex of AGENT_INDICES) {
        const action = actions[agentIndex];
        if (action === null || action === 'stand') {
          continue;
        }

        const opponentIndex = opponentOf(agentIndex);
        const towardsOpponent = state.position[agentIndex] <= state.position[opponentIndex] ? 1 : -1;

        if (action === 'advance') {
          const distance = Math.min(moveUnitsPerDecision, advanceCap);
          nextPosition[agentIndex] = clamp(
            state.position[agentIndex] + towardsOpponent * distance,
            config.arenaMin,
            config.arenaMax,
          );
          continue;
        }

        if (action === 'retreat') {
          nextPosition[agentIndex] = clamp(
            state.position[agentIndex] - towardsOpponent * moveUnitsPerDecision,
            config.arenaMin,
            config.arenaMax,
          );
          continue;
        }

        // `block` has no effect of its own; it is read below, off the same
        // pre-step `actions` tuple, when the opponent's damage is computed.
        if (action === 'block') {
          continue;
        }

        const affordsSpecial = state.meter[agentIndex] >= config.specialMeterCost;
        // Story 2.2 turns this into an illegal-Action rejection that applies
        // the Fallback Action. Here an unaffordable `special` is simply inert.
        if (action === 'special' && !affordsSpecial) {
          continue;
        }

        const range = action === 'special' ? config.specialRange : config.attackRange;
        const baseDamage = action === 'special' ? config.specialDamage : config.attackDamage;

        if (action === 'special') {
          meterSpent[agentIndex] += config.specialMeterCost;
          nextCommitment[agentIndex] = config.specialCommitmentTicks;
        }

        if (separation > range) {
          continue;
        }

        const blocked = actions[opponentIndex] === 'block';
        const reduction = blocked ? config.blockDamageReduction : 0;
        damageTaken[opponentIndex] += Math.max(0, baseDamage + jitter[agentIndex] - reduction);
        meterGained[agentIndex] += config.meterOnHitLanded;
        meterGained[opponentIndex] += config.meterOnHitTaken;
      }

      return {
        tick: state.tick + config.ticksPerDecision,
        rngState,
        health: [
          Math.max(0, state.health[0] - damageTaken[0]),
          Math.max(0, state.health[1] - damageTaken[1]),
        ],
        position: [nextPosition[0], nextPosition[1]],
        meter: [
          clamp(state.meter[0] - meterSpent[0] + meterGained[0], 0, config.maxMeter),
          clamp(state.meter[1] - meterSpent[1] + meterGained[1], 0, config.maxMeter),
        ],
        commitmentRemaining: [nextCommitment[0], nextCommitment[1]],
      };
    },

    terminal(state: FighterState): TerminalResult | null {
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

    hash(state: FighterState): string {
      return sha256Hex(canonicalStringify(state));
    },
  };
}
