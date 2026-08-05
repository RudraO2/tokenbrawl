import {
  FALLBACK_ACTION,
  type EnvironmentAdapter,
  type LoggedActionV2,
  type Observation,
  type TerminalResult,
} from '@tokenbrawl/contracts';
import { canonicalStringify } from './canonical';
import { assertIntegerConfig, DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import {
  COMMITTED_ATTACK,
  COMMITTED_HITSTUN,
  COMMITTED_JUMP,
  COMMITTED_NONE,
  COMMITTED_SPECIAL,
  PHASE_ACTIVE,
  PHASE_IDLE,
  PHASE_RECOVERY,
  PHASE_STARTUP,
  ZONE_NONE,
  damageForCode,
  juggleChainTicksElapsed,
  juggleDamageFor,
  juggleHitstunFor,
  jumpFallStepPerTick,
  jumpRiseStepPerTick,
  legalActionsFor,
  phaseOf,
  rangeForCode,
  windowTotalTicks,
  zoneCodeFor,
  type Zone,
} from './frames';
import { mixSeed, nextRngState } from './prng';
import { sha256Hex } from './sha256';
import type { FighterState } from './state';

const AGENT_INDICES: readonly (0 | 1)[] = [0, 1];

/**
 * `EnvironmentAdapter<FighterState>` with `step()`'s Story 8.3 companion
 * `zones` parameter made visible to this package's own callers.
 *
 * `docs/contracts/index.ts`'s `EnvironmentAdapter.step()` signature is frozen
 * at exactly `(state, actions)` -- that is the interface every Environment
 * Adapter, and every caller that only knows about adapters in general (the
 * Harness, `match-runner.ts`), is entitled to rely on, and this story does
 * not touch it. But a caller that holds a value typed as the *narrower*
 * `EnvironmentAdapter<FighterState>` cannot pass a third argument at all --
 * TypeScript checks a call against the declared arity, not against whatever
 * the underlying object happens to accept at runtime -- so this package's own
 * tests (and any future in-package caller that needs to supply a Zone) need
 * a type that says the third argument exists. An extra *optional* parameter
 * on an overriding method is a valid subtype of the base method, so this
 * interface is still assignable anywhere an `EnvironmentAdapter<FighterState>`
 * is expected -- nothing outside this package needs to know it exists.
 */
export interface FighterEnvironmentAdapter extends EnvironmentAdapter<FighterState> {
  step(
    state: FighterState,
    actions: readonly [LoggedActionV2 | null, LoggedActionV2 | null],
    zones?: readonly [Zone | null, Zone | null],
  ): FighterState;
}

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
  submitted: LoggedActionV2,
  meter: number,
): LoggedActionV2 {
  if (submitted === 'special' && meter < config.specialMeterCost) {
    return FALLBACK_ACTION;
  }
  return submitted;
}

export function createFighterEnvironment(
  overrides: Partial<FighterConfig> = {},
): FighterEnvironmentAdapter {
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
        verticalPosition: [0, 0],
        airState: [PHASE_IDLE, PHASE_IDLE],
        committedZone: [ZONE_NONE, ZONE_NONE],
        juggleCount: [0, 0],
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
      actions: readonly [LoggedActionV2 | null, LoggedActionV2 | null],
      // Story 8.3: the Zone `attack`/`special`/`block` carries this Decision
      // Point, alongside `actions` rather than folded into it. `LoggedActionV2`
      // stays the plain Action string `EnvironmentAdapter.step()`'s frozen
      // signature already commits to (`docs/contracts/index.ts`) -- adding a
      // required parameter here would be an *additional* one, which every
      // existing two-argument call site (a caller going through the adapter
      // interface, which declares only `(state, actions)`) still satisfies,
      // since it is optional and a missing entry reads as "no Zone" exactly
      // like an omitted `zones` argument entirely. Ignored for any index whose
      // submitted Action is not `attack`, `special`, or `block`.
      zones?: readonly [Zone | null, Zone | null],
    ): FighterState {
      // Already terminal on entry: the whole Decision Point is frozen. Nothing
      // is committed, no Tick is simulated, and no PRNG draw is consumed --
      // only the cadence advances, because a caller's own tick counter
      // (`runMatch` keeps one) must never drift from the state's.
      //
      // Without this guard the commit pass below still ran on a dead fighter:
      // it would spend Super Meter and open a Commitment Window during a step
      // that simulated zero Ticks. `runMatch` checks `terminal()` before each
      // iteration so it never reaches here, which is exactly why the
      // inconsistency could sit unnoticed until a replay or analysis tool
      // stepped one Decision Point past the end of a Match.
      if (state.health[0] <= 0 || state.health[1] <= 0) {
        return { ...state, tick: state.tick + config.ticksPerDecision };
      }

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
      const verticalPosition: [number, number] = [
        state.verticalPosition[0],
        state.verticalPosition[1],
      ];
      const airState: [number, number] = [state.airState[0], state.airState[1]];
      const committedZone: [number, number] = [state.committedZone[0], state.committedZone[1]];
      /** Story 8.4: consecutive hits landed on each Agent while it has not regained a Decision Point. */
      const juggleCount: [number, number] = [state.juggleCount[0], state.juggleCount[1]];
      const moveIntent: [number, number] = [MOVE_NONE, MOVE_NONE];
      /** `block` is a stance held for this Decision Point's ticks only -- it never survives into the next. */
      const blocking: [boolean, boolean] = [false, false];
      /**
       * The Zone a `block` stance holds, for this Decision Point's ticks only
       * -- exactly as ephemeral as `blocking` itself, and for the same reason:
       * `block` never opens a Commitment Window, so it never needs to survive
       * past this `step()` call the way `committedZone` (for `attack`/
       * `special`) does.
       */
      const blockZone: [number, number] = [ZONE_NONE, ZONE_NONE];

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
          blockZone[agentIndex] = zoneCodeFor(zones?.[agentIndex]);
        } else if (action === 'attack' || action === 'special') {
          const code = action === 'attack' ? COMMITTED_ATTACK : COMMITTED_SPECIAL;
          const window = action === 'attack' ? config.attackWindow : config.specialWindow;
          committed[agentIndex] = code;
          remaining[agentIndex] = windowTotalTicks(window);
          hitLanded[agentIndex] = 0;
          committedZone[agentIndex] = zoneCodeFor(zones?.[agentIndex]);
          if (action === 'special') {
            // Spent at commit, not on connection: a whiffed `special` costs its
            // meter, which is what makes throwing one a real decision.
            meter[agentIndex] -= config.specialMeterCost;
          }
        } else if (action === 'jump') {
          // Story 8.2: opens a Commitment Window exactly like attack/special --
          // no legality gate (unlike `special`, nothing is spent to commit),
          // and no `hitLanded` semantics of its own since a whiffed or landed
          // hit is not a concept jump has (air-attacks are Story 8.4's).
          // Rise/apex/fall progress is driven Tick-by-Tick below, from the same
          // `committed`/`remaining` pair every other window uses.
          committed[agentIndex] = COMMITTED_JUMP;
          remaining[agentIndex] = windowTotalTicks(config.jumpWindow);
          hitLanded[agentIndex] = 0;
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
        //
        // `Math.floor` over a division rather than `>> 1`: a shift coerces
        // through ToInt32, so an arena scaled past 2^31 units -- which
        // `assertIntegerConfig` permits, since it only demands safe integers --
        // would silently yield a cap of zero or a *negative* one. Zero freezes
        // the distance between the fighters for the rest of the Match; negative
        // feeds a backwards step into the position update. Division is exact
        // here for every safe integer and assumes no word size at all.
        //
        // Symmetry has an arithmetic consequence worth naming: two mutual
        // closers each move the same distance, so separation changes by an even
        // amount every Tick and its parity is conserved. A pair that starts an
        // odd distance apart therefore converges on `minSeparation + 1`, never
        // `minSeparation` itself. That is the price of never handing either side
        // the odd unit, and it is harmless as long as no range band sits inside
        // that last unit -- which `assertIntegerConfig` now enforces.
        const closingCap = closers === 2 ? Math.floor(closingRoom / 2) : closingRoom;
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
        // Story 8.4: which committed code each Agent entered *this* Tick with,
        // read once before any hit below can change it. A mutual trade must
        // judge both hits against the same pre-Tick chain state -- reading a
        // just-mutated `committed[opponentIndex]` inside this same loop would
        // let whichever agentIndex resolves first corrupt the other's chain
        // continuation, exactly the failure mode the rest of this function's
        // pre-Tick snapshots (`separationBefore`, `blocking`) already avoid.
        const preHitCommitted: readonly [number, number] = [committed[0], committed[1]];
        /** Deferred juggle/hitstun effects, applied in one pass after both hits are judged. */
        const blockedSuccessfully: [boolean, boolean] = [false, false];
        const attackerLandedThisTick: [boolean, boolean] = [false, false];
        const chainForceEnded: [boolean, boolean] = [false, false];
        const hitstunApplied: [boolean, boolean] = [false, false];
        const hitstunRemaining: [number, number] = [0, 0];
        const nextJuggleCount: [number, number] = [juggleCount[0], juggleCount[1]];

        for (const agentIndex of AGENT_INDICES) {
          if (hitLanded[agentIndex] === 1) {
            continue;
          }
          const code = committed[agentIndex];
          // `jump` has no range band or damage of its own (Story 8.2 is
          // rise-and-land only; air-attacks are Story 8.4's), so it is excluded
          // here rather than letting `rangeForCode`/`damageForCode` throw for a
          // code neither function recognises.
          if (code !== COMMITTED_ATTACK && code !== COMMITTED_SPECIAL) {
            continue;
          }
          if (phaseOf(config, code, remaining[agentIndex]) !== PHASE_ACTIVE) {
            continue;
          }
          if (separation > rangeForCode(config, code)) {
            continue;
          }

          const opponentIndex = opponentOf(agentIndex);
          // Story 8.3: a `block` only prevents damage when its Zone matches
          // the incoming strike's -- wrong-Zone or no block at all reduce to
          // the same full-damage outcome (AC3). `ZONE_NONE === ZONE_NONE`
          // (neither side named a Zone) still matches, which is what keeps a
          // Zone-naive `block` behaving exactly as it did before this story.
          const blockedMatch =
            blocking[opponentIndex] && blockZone[opponentIndex] === committedZone[agentIndex];
          meterGained[agentIndex] += config.meterOnHitLanded;
          meterGained[opponentIndex] += config.meterOnHitTaken;
          // Only this fighter's own flag: one hit per Commitment Window, and
          // setting it cannot influence the other fighter's resolution above.
          hitLanded[agentIndex] = 1;
          attackerLandedThisTick[agentIndex] = true;

          if (blockedMatch) {
            // A successful block ends any juggle chain against its defender
            // (AC3) and never opens hitstun -- Story 8.4 does not scale a
            // blocked hit's chip damage, which stays exactly Story 8.3's rule.
            damageTaken[opponentIndex] += Math.max(
              0,
              damageForCode(config, code) + jitter[agentIndex] - config.blockDamageReduction,
            );
            blockedSuccessfully[opponentIndex] = true;
            continue;
          }

          // Chain continuation: this hit lands on a defender already in
          // hitstun from a prior hit *this same chain* (AC1) only if that was
          // true entering this Tick -- `preHitCommitted`, not `committed`,
          // which the other agentIndex's iteration this same Tick may already
          // have overwritten.
          const juggleForThisHit =
            preHitCommitted[opponentIndex] === COMMITTED_HITSTUN
              ? juggleCount[opponentIndex] + 1
              : 0;
          damageTaken[opponentIndex] += Math.max(
            0,
            juggleDamageFor(config, damageForCode(config, code), juggleForThisHit) +
              jitter[agentIndex],
          );

          // AC4/OQ-7: a hit-count cap and a Tick cap, either of which forcibly
          // ends the chain and returns the defender to actionable immediately,
          // "regardless of further attacker input" -- checked before opening
          // (or re-opening) hitstun rather than after, so the defender is
          // never even briefly locked past either limit.
          const cumulativeTicks = juggleChainTicksElapsed(config, juggleForThisHit + 1);
          const scaledHitstun = juggleHitstunFor(config, juggleForThisHit);
          // A scaled hitstun of `0` (the table's floor) is the same "no window
          // to hold the defender open" outcome as either cap above -- opening
          // `COMMITTED_HITSTUN` with `0` Ticks remaining would leave it
          // uncleared forever, since the window-close branch below only fires
          // on the Tick a positive countdown reaches zero.
          if (
            juggleForThisHit >= config.juggleMaxCount ||
            cumulativeTicks > config.juggleTickCap ||
            scaledHitstun <= 0
          ) {
            chainForceEnded[opponentIndex] = true;
          } else {
            hitstunApplied[opponentIndex] = true;
            hitstunRemaining[opponentIndex] = scaledHitstun;
            nextJuggleCount[opponentIndex] = juggleForThisHit;
          }
        }

        for (const agentIndex of AGENT_INDICES) {
          health[agentIndex] = Math.max(0, health[agentIndex] - damageTaken[agentIndex]);
          meter[agentIndex] = clamp(
            meter[agentIndex] + meterGained[agentIndex],
            0,
            config.maxMeter,
          );
          // Story 8.4: apply this Tick's juggle/hitstun effects in priority
          // order -- being hit this Tick (forced end or a fresh/continued
          // chain) always wins over merely having landed one's own hit or
          // blocked successfully, so a mutual-trade Tick still tracks each
          // side as its own victim state rather than clobbering it with the
          // other role's reset. `hitLanded` is deliberately left untouched
          // here: a `COMMITTED_HITSTUN` code always short-circuits past every
          // `hitLanded`-gated branch in the hit-resolution loop (hitstun is
          // never `COMMITTED_ATTACK`/`COMMITTED_SPECIAL`), so this flag has no
          // reader while hitstun is open. Zeroing it here would instead erase
          // a same-Tick mutual trade's *own* attack having connected -- the
          // window-close branch below already clears it once hitstun ends.
          if (chainForceEnded[agentIndex]) {
            committed[agentIndex] = COMMITTED_NONE;
            remaining[agentIndex] = 0;
            juggleCount[agentIndex] = 0;
          } else if (hitstunApplied[agentIndex]) {
            committed[agentIndex] = COMMITTED_HITSTUN;
            remaining[agentIndex] = hitstunRemaining[agentIndex];
            juggleCount[agentIndex] = nextJuggleCount[agentIndex];
          } else if (attackerLandedThisTick[agentIndex] || blockedSuccessfully[agentIndex]) {
            juggleCount[agentIndex] = 0;
          }
        }

        // Gravity (Story 8.2, AC4). Read against `remaining` before this Tick's
        // countdown below, exactly like the hit resolution above -- the phase a
        // fighter is judged to be in for a given Tick is the one it was in
        // *entering* that Tick. A fixed-point integer step per Tick, never a
        // delta-time multiply: `jumpRiseStepPerTick`/`jumpFallStepPerTick` are
        // themselves pure integer division (AD-5).
        for (const agentIndex of AGENT_INDICES) {
          const code = committed[agentIndex];
          if (code !== COMMITTED_JUMP) {
            // Grounded, or committed to something that is not `jump`: no air
            // state and no vertical motion. `verticalPosition` is left as-is
            // rather than force-zeroed here so a state fed to `step()` cannot
            // be silently "corrected" mid-Match; the window-close branch below
            // is the one place a landing is enforced.
            airState[agentIndex] = PHASE_IDLE;
            continue;
          }

          const phase = phaseOf(config, code, remaining[agentIndex]);
          airState[agentIndex] = phase;
          if (phase === PHASE_STARTUP) {
            verticalPosition[agentIndex] = Math.min(
              config.jumpHeight,
              verticalPosition[agentIndex] + jumpRiseStepPerTick(config),
            );
          } else if (phase === PHASE_ACTIVE) {
            // Apex: held rather than left to drift, so a fighter is exactly at
            // `jumpHeight` for the whole hang time regardless of any rise-phase
            // remainder.
            verticalPosition[agentIndex] = config.jumpHeight;
          } else if (phase === PHASE_RECOVERY) {
            // Floored every Tick (AC6), not only when the window closes: a
            // caller stepping from a hand-built mid-fall state must never see
            // this go negative either.
            verticalPosition[agentIndex] = Math.max(
              0,
              verticalPosition[agentIndex] - jumpFallStepPerTick(config),
            );
          }
        }

        // Window countdown: exactly one tick, so a Match can never stall and
        // `terminal()`'s timeout branch always stays reachable.
        for (const agentIndex of AGENT_INDICES) {
          if (remaining[agentIndex] <= 0) {
            continue;
          }
          remaining[agentIndex] -= 1;
          if (remaining[agentIndex] === 0) {
            const wasJump = committed[agentIndex] === COMMITTED_JUMP;
            // Story 8.4 AC3: a hitstun window that closes without the Agent
            // having been hit again this same Tick is "returns to neutral" --
            // a re-hit this Tick already overwrote `committed`/`remaining`
            // above (to a fresh hitstun window or `COMMITTED_NONE` on a forced
            // end), so this branch only ever sees the untouched, expired one.
            const wasHitstun = committed[agentIndex] === COMMITTED_HITSTUN;
            committed[agentIndex] = COMMITTED_NONE;
            hitLanded[agentIndex] = 0;
            committedZone[agentIndex] = ZONE_NONE;
            if (wasHitstun) {
              juggleCount[agentIndex] = 0;
            }
            if (wasJump) {
              // Land exactly on the floor: a rise/fall Tick count that does not
              // divide `jumpHeight` evenly would otherwise leave a 1-or-2-unit
              // remainder airborne forever (AC6).
              verticalPosition[agentIndex] = 0;
              airState[agentIndex] = PHASE_IDLE;
            }
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
        verticalPosition: [verticalPosition[0], verticalPosition[1]],
        airState: [airState[0], airState[1]],
        committedZone: [committedZone[0], committedZone[1]],
        juggleCount: [juggleCount[0], juggleCount[1]],
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
