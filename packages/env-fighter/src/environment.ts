import {
  FALLBACK_ACTION,
  type EnvironmentAdapter,
  type LoggedAction,
  type Observation,
  type TerminalResult,
} from '@tokenbrawl/contracts';
import { canonicalStringify } from './canonical';
import { assertIntegerConfig, DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  damageForCode,
  legalActionsFor,
  phaseOf,
  rangeForCode,
  windowTotalTicks,
} from './frames';
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

/** Movement intent for the Decision Point, as a sign applied to "towards the opponent". */
const MOVE_NONE = 0;
const MOVE_ADVANCE = 1;
const MOVE_RETREAT = -1;

function opponentOf(agentIndex: 0 | 1): 0 | 1 {
  return agentIndex === 0 ? 1 : 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Apply the legality rule an Agent is told about through `legalActions`.
 *
 * `special` below its Super Meter cost is an *illegal* Action, not a silent
 * no-op: the Fallback Action is substituted, exactly as it is for a Parse
 * Failure. That keeps the two failure modes consistent -- an Agent that
 * ignores the grammar it was given is never rewarded with `block`'s safety or
 * with a repeat of its previous Action.
 */
function legaliseAction(
  config: FighterConfig,
  submitted: LoggedAction,
  meter: number,
): LoggedAction {
  if (submitted === 'special' && meter < config.specialMeterCost) {
    return FALLBACK_ACTION;
  }
  return submitted;
}

export function createFighterEnvironment(
  overrides: Partial<FighterConfig> = {},
): EnvironmentAdapter<FighterState> {
  const config: FighterConfig = { ...DEFAULT_FIGHTER_CONFIG, ...overrides };
  assertIntegerConfig(config);

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
        committedAction: [COMMITTED_NONE, COMMITTED_NONE],
        windowHitLanded: [0, 0],
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
        //
        // The opponent's Commitment Window is surfaced because whiff punishing
        // is only playable if it is visible: an Agent that cannot see that the
        // opponent is stuck in recovery cannot choose to punish it. Its own
        // window is not reported -- an Agent is only ever polled when it has
        // none open, so the value would be `0` at every Decision Point.
        state: canonicalStringify({
          opponentCommitmentRemaining: state.commitmentRemaining[opponentIndex],
          opponentHealth: state.health[opponentIndex],
          opponentMeter: state.meter[opponentIndex],
          opponentPhase: phaseOf(
            config,
            state.committedAction[opponentIndex],
            state.commitmentRemaining[opponentIndex],
          ),
          selfHealth: state.health[agentIndex],
          selfMeter: state.meter[agentIndex],
          separation: Math.abs(self - opponent),
          spaceBehind: facingRight ? self - config.arenaMin : config.arenaMax - self,
          tick: state.tick,
        }),
        legalActions: legalActionsFor(config, state.meter[agentIndex]),
        tick: state.tick,
      };
    },

    /**
     * One Decision Point, resolved tick by tick.
     *
     * Story 2.1 applied a whole Decision Point as one lump, which made an
     * `attack` free: it could not be spaced out of, and its attacker was never
     * exposed afterwards. Here the submitted Actions are *committed* first, and
     * then `ticksPerDecision` ticks are simulated. Within each tick, both
     * fighters' movement is computed from one pre-tick snapshot and applied
     * together, and both fighters' active-phase attacks are judged against the
     * resulting positions and applied together. That is what makes simultaneity
     * structural at tick granularity -- strictly stronger than resolving it
     * once per Decision Point -- and it is why `state` is only ever read.
     *
     * A fighter inside a Commitment Window does not move, does not block, and
     * is not polled, so its recovery is punishable. Movement and windows are
     * mutually exclusive by construction: a movement intent is only recorded
     * for a fighter that was actionable this boundary, and neither `advance`
     * nor `retreat` opens a Commitment Window at all.
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

      const position: [number, number] = [state.position[0], state.position[1]];
      const health: [number, number] = [state.health[0], state.health[1]];
      const meter: [number, number] = [state.meter[0], state.meter[1]];
      const committed: [number, number] = [state.committedAction[0], state.committedAction[1]];
      const remaining: [number, number] = [
        state.commitmentRemaining[0],
        state.commitmentRemaining[1],
      ];
      const hitLanded: [number, number] = [state.windowHitLanded[0], state.windowHitLanded[1]];
      const moveIntent: [number, number] = [MOVE_NONE, MOVE_NONE];
      /** `block` is a stance held for this Decision Point's ticks only -- it never survives into the next. */
      const blocking: [boolean, boolean] = [false, false];

      // --- Commit pass: what each Agent chose at this boundary ---------------
      for (const agentIndex of AGENT_INDICES) {
        const submitted = actions[agentIndex];
        // `null` is "was not polled". A non-null Action from a fighter that is
        // mid-window is ignored rather than trusted: the Harness never sends
        // one, and honouring it would let a caller cancel a Commitment Window.
        if (submitted === null || remaining[agentIndex] > 0) {
          continue;
        }

        const action = legaliseAction(config, submitted, meter[agentIndex]);

        if (action === 'advance') {
          moveIntent[agentIndex] = MOVE_ADVANCE;
        } else if (action === 'retreat') {
          moveIntent[agentIndex] = MOVE_RETREAT;
        } else if (action === 'block') {
          blocking[agentIndex] = true;
        } else if (action === 'attack' || action === 'special') {
          const code = action === 'attack' ? COMMITTED_ATTACK : COMMITTED_SPECIAL;
          const window = action === 'attack' ? config.attackWindow : config.specialWindow;
          committed[agentIndex] = code;
          remaining[agentIndex] = windowTotalTicks(window);
          hitLanded[agentIndex] = 0;
          if (action === 'special') {
            // Spent at commit, not on connection: a whiffed `special` costs its
            // meter, which is what makes throwing one a real decision.
            meter[agentIndex] -= config.specialMeterCost;
          }
        }
        // `stand` -- the Fallback Action, and what a rejected `special` becomes
        // -- is inert by construction: no intent, no stance, nothing committed.
      }

      // --- Tick loop --------------------------------------------------------
      for (let tick = 0; tick < config.ticksPerDecision; tick += 1) {
        // A KO freezes the rest of the Decision Point: no posthumous movement,
        // hit, or window progress. `state.tick` still advances by the full
        // cadence below, because `runMatch` advances its own tick counter
        // independently and the two must never disagree.
        if (health[0] <= 0 || health[1] <= 0) {
          break;
        }

        // Movement. Both deltas come from the same pre-tick positions, so
        // neither fighter's step can be a reaction to the other's.
        const separationBefore = Math.abs(position[0] - position[1]);
        const closers =
          (moveIntent[0] === MOVE_ADVANCE ? 1 : 0) + (moveIntent[1] === MOVE_ADVANCE ? 1 : 0);
        const closingRoom = Math.max(0, separationBefore - config.minSeparation);
        // Two fighters closing at once split the room, floor-halved for each,
        // so neither gets the odd unit -- an asymmetric push-apart would be a
        // side advantage baked into the physics. A *lone* closer gets the whole
        // room, so it can actually reach `minSeparation`; Story 2.1 halved
        // unconditionally, which made a solo advance asymptotic and is why its
        // Harness KO case needed a hand-picked start position.
        const closingCap = closers === 2 ? closingRoom >> 1 : closingRoom;
        const moved: [number, number] = [position[0], position[1]];

        for (const agentIndex of AGENT_INDICES) {
          if (moveIntent[agentIndex] === MOVE_NONE) {
            continue;
          }
          const towards = position[agentIndex] <= position[opponentOf(agentIndex)] ? 1 : -1;
          const distance =
            moveIntent[agentIndex] === MOVE_ADVANCE
              ? Math.min(config.moveUnitsPerTick, closingCap)
              : config.moveUnitsPerTick;
          moved[agentIndex] = clamp(
            position[agentIndex] + moveIntent[agentIndex] * towards * distance,
            config.arenaMin,
            config.arenaMax,
          );
        }
        position[0] = moved[0];
        position[1] = moved[1];

        // Hit resolution. Every active-phase Action is judged against the same
        // post-movement separation and the same pre-tick blocking stances, and
        // the results are applied together after both have been decided.
        const separation = Math.abs(position[0] - position[1]);
        const damageTaken: [number, number] = [0, 0];
        const meterGained: [number, number] = [0, 0];

        for (const agentIndex of AGENT_INDICES) {
          if (hitLanded[agentIndex] === 1) {
            continue;
          }
          const code = committed[agentIndex];
          if (phaseOf(config, code, remaining[agentIndex]) !== PHASE_ACTIVE) {
            continue;
          }
          if (separation > rangeForCode(config, code)) {
            continue;
          }

          const opponentIndex = opponentOf(agentIndex);
          const reduction = blocking[opponentIndex] ? config.blockDamageReduction : 0;
          damageTaken[opponentIndex] += Math.max(
            0,
            damageForCode(config, code) + jitter[agentIndex] - reduction,
          );
          meterGained[agentIndex] += config.meterOnHitLanded;
          meterGained[opponentIndex] += config.meterOnHitTaken;
          // Only this fighter's own flag: one hit per Commitment Window, and
          // setting it cannot influence the other fighter's resolution above.
          hitLanded[agentIndex] = 1;
        }

        for (const agentIndex of AGENT_INDICES) {
          health[agentIndex] = Math.max(0, health[agentIndex] - damageTaken[agentIndex]);
          meter[agentIndex] = clamp(
            meter[agentIndex] + meterGained[agentIndex],
            0,
            config.maxMeter,
          );
        }

        // Window countdown: exactly one tick, so a Match can never stall and
        // `terminal()`'s timeout branch always stays reachable.
        for (const agentIndex of AGENT_INDICES) {
          if (remaining[agentIndex] <= 0) {
            continue;
          }
          remaining[agentIndex] -= 1;
          if (remaining[agentIndex] === 0) {
            committed[agentIndex] = COMMITTED_NONE;
            hitLanded[agentIndex] = 0;
          }
        }
      }

      return {
        tick: state.tick + config.ticksPerDecision,
        rngState,
        health: [health[0], health[1]],
        position: [position[0], position[1]],
        meter: [meter[0], meter[1]],
        commitmentRemaining: [remaining[0], remaining[1]],
        committedAction: [committed[0], committed[1]],
        windowHitLanded: [hitLanded[0], hitLanded[1]],
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
