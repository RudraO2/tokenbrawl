import { ACTIONS, type LoggedAction } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import { createFighterEnvironment } from './environment';
import {
  COMMITTED_ATTACK,
  COMMITTED_NONE,
  PHASE_RECOVERY,
  phaseOf,
  windowTotalTicks,
} from './frames';
import type { FighterState } from './state';

type ActionPair = readonly [LoggedAction | null, LoggedAction | null];

const SEED = 12345;

/** Close enough to trade: separation equals `minSeparation`, well inside `attackRange`. */
const CLOSE_QUARTERS: Partial<FighterConfig> = { startPosition: [460, 500] };

const ATTACK_WINDOW_TICKS = windowTotalTicks(DEFAULT_FIGHTER_CONFIG.attackWindow);
const SPECIAL_WINDOW_TICKS = windowTotalTicks(DEFAULT_FIGHTER_CONFIG.specialWindow);
/** Ticks of an attack's window left once one Decision Point has been simulated. */
const ATTACK_TICKS_AFTER_ONE_STEP = ATTACK_WINDOW_TICKS - DEFAULT_FIGHTER_CONFIG.ticksPerDecision;
/** Largest damage one unblocked `attack` can do: base plus the one-unit jitter. */
const MAX_ATTACK_DAMAGE = DEFAULT_FIGHTER_CONFIG.attackDamage + DEFAULT_FIGHTER_CONFIG.damageJitter;

function stateOf(overrides: Partial<FighterState> = {}): FighterState {
  return {
    tick: 0,
    rngState: 1,
    health: [100, 100],
    position: [460, 500],
    meter: [0, 0],
    commitmentRemaining: [0, 0],
    committedAction: [COMMITTED_NONE, COMMITTED_NONE],
    windowHitLanded: [0, 0],
    ...overrides,
  };
}

/** A fixed, deliberately varied Action script -- every Action, both sides, plus `stand` and a null. */
const SCRIPT: readonly ActionPair[] = [
  ['advance', 'advance'],
  ['attack', 'block'],
  ['retreat', 'attack'],
  ['advance', 'stand'],
  ['attack', 'attack'],
  ['special', 'retreat'],
  [null, 'advance'],
  ['block', 'special'],
  ['stand', null],
  ['attack', 'advance'],
];

function runScript(
  env: ReturnType<typeof createFighterEnvironment>,
  seed: number = SEED,
): FighterState {
  let state = env.reset(seed);
  for (const actions of SCRIPT) {
    state = env.step(state, actions);
  }
  return state;
}

describe('createFighterEnvironment -- adapter surface', () => {
  const env = createFighterEnvironment();

  it('advertises a stable id and version', () => {
    expect(env.id).toBe('fighter-1v1');
    expect(env.version).toBe('1.0.0');
  });

  it('uses the tick cadence from the architecture timing model', () => {
    expect(env.ticksPerDecision).toBe(30);
    expect(env.maxTicks).toBe(1200);
  });

  it('withholds `special` until the Super Meter can pay for it (AC3)', () => {
    // Story 2.1 offered the full frozen ACTIONS list at every Decision Point,
    // which told a model an Action was available that the environment would
    // then refuse. Story 2.2 makes the grammar honest: `special` appears only
    // once it is affordable, and `step()` still rejects it if submitted anyway.
    expect(env.observe(env.reset(SEED), 0).legalActions).not.toContain('special');
    expect(env.observe(env.reset(SEED), 0).legalActions).toStrictEqual(
      ACTIONS.filter((action) => action !== 'special'),
    );

    const armed = stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0] });
    // Exactly at the cost, not merely above it: an off-by-one here would make
    // the Action unreachable at the only meter value a fight reliably hits.
    expect(env.observe(armed, 0).legalActions).toStrictEqual(ACTIONS);
    expect(env.observe(armed, 1).legalActions).not.toContain('special');
  });
});

describe('reset (pure over the seed)', () => {
  const env = createFighterEnvironment();

  it('produces byte-identical state for the same seed', () => {
    expect(env.reset(SEED)).toStrictEqual(env.reset(SEED));
    expect(env.hash(env.reset(SEED))).toBe(env.hash(env.reset(SEED)));
  });

  it('produces different generator state for different seeds', () => {
    expect(env.reset(0).rngState).not.toBe(env.reset(1).rngState);
    expect(env.reset(1).rngState).not.toBe(env.reset(2).rngState);
  });

  it('never leaves the generator in the all-zero state xorshift32 cannot escape', () => {
    for (const seed of [0, 1, -1, 2 ** 31, 999999]) {
      expect(env.reset(seed).rngState).not.toBe(0);
    }
  });

  it('starts both fighters at the configured position, health and meter', () => {
    const state = env.reset(SEED);
    expect(state.tick).toBe(0);
    expect(state.health).toStrictEqual([
      DEFAULT_FIGHTER_CONFIG.initialHealth,
      DEFAULT_FIGHTER_CONFIG.initialHealth,
    ]);
    expect(state.position).toStrictEqual(DEFAULT_FIGHTER_CONFIG.startPosition);
    expect(state.meter).toStrictEqual([0, 0]);
    expect(state.commitmentRemaining).toStrictEqual([0, 0]);
    // No Commitment Window is open at tick 0, and no hit has registered --
    // both new Story 2.2 fields start at their idle values rather than being
    // left undefined, which `hash()` would refuse to serialise.
    expect(state.committedAction).toStrictEqual([COMMITTED_NONE, COMMITTED_NONE]);
    expect(state.windowHitLanded).toStrictEqual([0, 0]);
  });
});

describe('determinism (AC1, AC4, AC5 -- INV-2)', () => {
  it('produces identical Final-State Hashes when stepped twice from the same seed', () => {
    const env = createFighterEnvironment();
    expect(env.hash(runScript(env))).toBe(env.hash(runScript(env)));
  });

  it('produces identical hashes across two independently constructed adapters', () => {
    expect(createFighterEnvironment().hash(runScript(createFighterEnvironment()))).toBe(
      createFighterEnvironment().hash(runScript(createFighterEnvironment())),
    );
  });

  it('keeps two concurrent Matches from sharing a generator', () => {
    // AC5: if any PRNG lived at module scope, interleaving two Matches would
    // pull each other's draws and both would diverge from their solo runs.
    const solo = createFighterEnvironment();
    const expected = solo.hash(runScript(solo));

    const envA = createFighterEnvironment();
    const envB = createFighterEnvironment();
    let stateA = envA.reset(SEED);
    let stateB = envB.reset(SEED);
    for (const actions of SCRIPT) {
      stateA = envA.step(stateA, actions);
      stateB = envB.step(stateB, actions);
    }

    expect(envA.hash(stateA)).toBe(expected);
    expect(envB.hash(stateB)).toBe(expected);
  });

  it('keeps two interleaved Matches on different seeds independent', () => {
    const solo = createFighterEnvironment();
    const expectedOther = solo.hash(runScript(solo, SEED + 1));

    const envA = createFighterEnvironment();
    const envB = createFighterEnvironment();
    let stateA = envA.reset(SEED);
    let stateB = envB.reset(SEED + 1);
    for (const actions of SCRIPT) {
      stateA = envA.step(stateA, actions);
      stateB = envB.step(stateB, actions);
    }

    expect(envB.hash(stateB)).toBe(expectedOther);
    expect(envA.hash(stateA)).not.toBe(envB.hash(stateB));
  });

  it('produces different hashes for different Action streams (the gate is not vacuous)', () => {
    const env = createFighterEnvironment();
    let diverged = env.reset(SEED);
    for (const [, second] of SCRIPT) {
      diverged = env.step(diverged, ['attack', second]);
    }
    expect(env.hash(diverged)).not.toBe(env.hash(runScript(env)));
  });

  it('is unchanged when the process is stalled mid-Match (AC4)', async () => {
    const env = createFighterEnvironment();
    const straightThrough = env.hash(runScript(env));

    let state = env.reset(SEED);
    for (const actions of SCRIPT) {
      // Many awaited turns between Decision Points: a real stall, expressed
      // without a timer API (INV-1 bans those outright).
      for (let turn = 0; turn < 25; turn += 1) {
        await Promise.resolve();
      }
      state = env.step(state, actions);
    }

    expect(env.hash(state)).toBe(straightThrough);
  });

  it('never mutates the state handed to it', () => {
    const env = createFighterEnvironment();
    const before = env.reset(SEED);
    const snapshot = JSON.parse(JSON.stringify(before)) as FighterState;

    env.step(before, ['attack', 'advance']);
    env.observe(before, 0);
    env.isActionable(before, 1);
    env.terminal(before);
    env.hash(before);

    expect(before).toStrictEqual(snapshot);
  });

  it('re-steps an old state to the same result (replayability, not accumulation)', () => {
    const env = createFighterEnvironment();
    const start = env.reset(SEED);
    expect(env.hash(env.step(start, ['attack', 'block']))).toBe(
      env.hash(env.step(start, ['attack', 'block'])),
    );
  });
});

describe('integer-only state (AC2)', () => {
  it('holds only safe integers after a long mixed Match', () => {
    const env = createFighterEnvironment();
    let state = env.reset(SEED);
    for (let round = 0; round < 40; round += 1) {
      state = env.step(state, SCRIPT[round % SCRIPT.length]);
    }

    const numbers: number[] = [];
    for (const value of Object.values(state)) {
      if (Array.isArray(value)) {
        numbers.push(...(value as number[]));
      } else {
        numbers.push(value as number);
      }
    }
    expect(numbers.length).toBeGreaterThan(0);
    for (const value of numbers) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it('refuses to hash a state that somehow holds a float', () => {
    const env = createFighterEnvironment();
    const corrupted = stateOf({ health: [100 / 3, 100] });
    expect(() => env.hash(corrupted)).toThrow(/non-integer/);
  });
});

describe('hash (the Final-State Hash)', () => {
  const env = createFighterEnvironment();

  it('is a 64-character lowercase hex digest', () => {
    expect(env.hash(env.reset(SEED))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is insensitive to key declaration order', () => {
    const forwards = stateOf();
    const backwards: FighterState = {
      windowHitLanded: forwards.windowHitLanded,
      committedAction: forwards.committedAction,
      commitmentRemaining: forwards.commitmentRemaining,
      meter: forwards.meter,
      position: forwards.position,
      health: forwards.health,
      rngState: forwards.rngState,
      tick: forwards.tick,
    };
    expect(env.hash(backwards)).toBe(env.hash(forwards));
  });

  it('changes when any single field changes', () => {
    // Guards the canonicaliser against silently omitting a field -- the exact
    // rot a hand-listed key list invites as FighterState grows in Story 2.2.
    const base = stateOf();
    const baseline = env.hash(base);
    const mutations: readonly FighterState[] = [
      { ...base, tick: base.tick + 30 },
      { ...base, rngState: base.rngState + 1 },
      { ...base, health: [base.health[0] - 1, base.health[1]] },
      { ...base, health: [base.health[0], base.health[1] - 1] },
      { ...base, position: [base.position[0] + 1, base.position[1]] },
      { ...base, position: [base.position[0], base.position[1] + 1] },
      { ...base, meter: [base.meter[0] + 1, base.meter[1]] },
      { ...base, meter: [base.meter[0], base.meter[1] + 1] },
      { ...base, commitmentRemaining: [base.commitmentRemaining[0] + 1, base.commitmentRemaining[1]] },
      { ...base, commitmentRemaining: [base.commitmentRemaining[0], base.commitmentRemaining[1] + 1] },
      { ...base, committedAction: [COMMITTED_ATTACK, base.committedAction[1]] },
      { ...base, committedAction: [base.committedAction[0], COMMITTED_ATTACK] },
      { ...base, windowHitLanded: [1, base.windowHitLanded[1]] },
      { ...base, windowHitLanded: [base.windowHitLanded[0], 1] },
    ];
    expect(mutations).toHaveLength(Object.keys(base).length * 2 - 2);
    for (const mutated of mutations) {
      expect(env.hash(mutated)).not.toBe(baseline);
    }
  });
});

describe('movement', () => {
  it('closes distance on advance without ever breaching minSeparation', () => {
    const env = createFighterEnvironment();
    let state = env.reset(SEED);
    const startSeparation = Math.abs(state.position[0] - state.position[1]);

    for (let round = 0; round < 20; round += 1) {
      state = env.step(state, ['advance', 'advance']);
      const separation = Math.abs(state.position[0] - state.position[1]);
      expect(separation).toBeGreaterThanOrEqual(DEFAULT_FIGHTER_CONFIG.minSeparation);
    }
    expect(Math.abs(state.position[0] - state.position[1])).toBeLessThan(startSeparation);
    expect(state.position[0]).toBeLessThan(state.position[1]);
  });

  it('opens distance on retreat and clamps at the arena wall', () => {
    const env = createFighterEnvironment();
    let state = env.reset(SEED);
    for (let round = 0; round < 20; round += 1) {
      state = env.step(state, ['retreat', 'retreat']);
    }
    expect(state.position[0]).toBe(DEFAULT_FIGHTER_CONFIG.arenaMin);
    expect(state.position[1]).toBe(DEFAULT_FIGHTER_CONFIG.arenaMax);
  });

  it('keeps both fighters inside the arena under every Action', () => {
    const env = createFighterEnvironment();
    let state = env.reset(SEED);
    for (let round = 0; round < 40; round += 1) {
      state = env.step(state, SCRIPT[round % SCRIPT.length]);
      for (const position of state.position) {
        expect(position).toBeGreaterThanOrEqual(DEFAULT_FIGHTER_CONFIG.arenaMin);
        expect(position).toBeLessThanOrEqual(DEFAULT_FIGHTER_CONFIG.arenaMax);
      }
    }
  });

  it('caps both advancing fighters identically, giving neither side the odd unit', () => {
    const env = createFighterEnvironment();
    const start = env.reset(SEED);
    const moved = env.step(start, ['advance', 'advance']);
    expect(moved.position[0] - start.position[0]).toBe(start.position[1] - moved.position[1]);
  });
});

describe('attacks, blocking and simultaneity', () => {
  const env = createFighterEnvironment(CLOSE_QUARTERS);

  it('damages the opponent when the attack is in range', () => {
    const after = env.step(env.reset(SEED), ['attack', 'stand']);
    expect(after.health[1]).toBeLessThan(DEFAULT_FIGHTER_CONFIG.initialHealth);
    expect(after.health[0]).toBe(DEFAULT_FIGHTER_CONFIG.initialHealth);
  });

  it('does nothing when the attack is out of range', () => {
    const far = createFighterEnvironment();
    const after = far.step(far.reset(SEED), ['attack', 'attack']);
    expect(after.health).toStrictEqual([
      DEFAULT_FIGHTER_CONFIG.initialHealth,
      DEFAULT_FIGHTER_CONFIG.initialHealth,
    ]);
  });

  it('reduces damage when the defender blocked at the same Decision Point', () => {
    const start = env.reset(SEED);
    const unblocked = env.step(start, ['attack', 'stand']);
    const blocked = env.step(start, ['attack', 'block']);
    expect(DEFAULT_FIGHTER_CONFIG.initialHealth - blocked.health[1]).toBe(
      DEFAULT_FIGHTER_CONFIG.initialHealth -
        unblocked.health[1] -
        DEFAULT_FIGHTER_CONFIG.blockDamageReduction,
    );
  });

  it('never lets damage push health below zero', () => {
    const after = env.step(stateOf({ health: [1, 1] }), ['attack', 'attack']);
    expect(after.health).toStrictEqual([0, 0]);
  });

  it('resolves both Actions from the same pre-step snapshot (AC: simultaneity)', () => {
    // Each side's health loss must depend only on what the *other* side did.
    const start = env.reset(SEED);
    const both = env.step(start, ['attack', 'attack']);
    const onlyP1 = env.step(start, ['attack', 'stand']);
    const onlyP2 = env.step(start, ['stand', 'attack']);

    expect(both.health[1]).toBe(onlyP1.health[1]);
    expect(both.health[0]).toBe(onlyP2.health[0]);
  });

  it('gives each side both jitter values across seeds, so neither bit is stuck', () => {
    // The mirrored-seed suite disables jitter deliberately (disjoint per-side
    // bits are an intended asymmetry that would mask side symmetry), which left
    // the fairness of the bit assignment itself uncovered: a bit wired to a
    // constant, or to a corner of the xorshift32 word that barely varies, would
    // hand one side a permanent damage edge across a whole tournament.
    const seen: readonly Set<number>[] = [new Set<number>(), new Set<number>()];
    for (let seed = 1; seed <= 40; seed += 1) {
      const after = env.step(env.reset(seed), ['attack', 'attack']);
      seen[0].add(DEFAULT_FIGHTER_CONFIG.initialHealth - after.health[1]);
      seen[1].add(DEFAULT_FIGHTER_CONFIG.initialHealth - after.health[0]);
    }
    // Each side must show both the jittered and the unjittered damage value.
    for (const damageValues of seen) {
      expect([...damageValues].sort()).toStrictEqual([
        DEFAULT_FIGHTER_CONFIG.attackDamage,
        MAX_ATTACK_DAMAGE,
      ]);
    }
  });

  it('draws each side’s jitter from a different bit, so the two are not locked together', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const differed = seeds.some((seed) => {
      const after = env.step(env.reset(seed), ['attack', 'attack']);
      return (
        DEFAULT_FIGHTER_CONFIG.initialHealth - after.health[0] !==
        DEFAULT_FIGHTER_CONFIG.initialHealth - after.health[1]
      );
    });
    expect(differed).toBe(true);
  });

  it('treats `stand` (the Fallback Action) and `null` as inert', () => {
    const start = env.reset(SEED);
    const stood = env.step(start, ['stand', 'stand']);
    const nulled = env.step(start, [null, null]);

    expect(stood.health).toStrictEqual(start.health);
    expect(stood.position).toStrictEqual(start.position);
    expect(stood.meter).toStrictEqual(start.meter);
    expect(env.hash(stood)).toBe(env.hash(nulled));
  });

  it('resolves the other Agent normally when one submits null', () => {
    const after = env.step(env.reset(SEED), [null, 'attack']);
    expect(after.health[0]).toBeLessThan(DEFAULT_FIGHTER_CONFIG.initialHealth);
    expect(after.health[1]).toBe(DEFAULT_FIGHTER_CONFIG.initialHealth);
  });

  it('accrues meter for both the attacker and the fighter that was hit', () => {
    const after = env.step(env.reset(SEED), ['attack', 'stand']);
    expect(after.meter[0]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitLanded);
    expect(after.meter[1]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitTaken);
  });

  it('caps meter at the configured maximum', () => {
    const after = env.step(stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.maxMeter, 0] }), [
      'attack',
      'stand',
    ]);
    expect(after.meter[0]).toBe(DEFAULT_FIGHTER_CONFIG.maxMeter);
  });
});

describe('special and Commitment Windows', () => {
  const env = createFighterEnvironment(CLOSE_QUARTERS);

  it('is rejected as illegal, exactly like the Fallback Action, below its cost (AC3)', () => {
    // Story 2.1 made an unaffordable `special` a silent no-op. Story 2.2
    // rejects it: the Fallback Action is substituted, which is inert. The
    // observable difference from a no-op is that the substitution is stated
    // rather than incidental -- so the strongest assertion available is that
    // the resulting state is *bit-identical* to having submitted nothing.
    const start = stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost - 1, 0] });
    const rejected = env.step(start, ['special', 'stand']);
    const submittedNothing = env.step(start, [null, 'stand']);

    expect(env.hash(rejected)).toBe(env.hash(submittedNothing));
    expect(rejected.health).toStrictEqual(start.health);
    expect(rejected.meter[0]).toBe(start.meter[0]);
    expect(rejected.commitmentRemaining[0]).toBe(0);
    expect(rejected.committedAction[0]).toBe(COMMITTED_NONE);
    // And the Agent was told so: withholding it and refusing it are two halves
    // of one rule, not alternatives.
    expect(env.observe(start, 0).legalActions).not.toContain('special');
  });

  it('spends meter, deals its damage and commits the attacker when affordable', () => {
    const start = stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0] });
    const after = env.step(start, ['special', 'stand']);

    expect(after.health[1]).toBeLessThanOrEqual(
      start.health[1] - DEFAULT_FIGHTER_CONFIG.specialDamage,
    );
    expect(after.meter[0]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitLanded);
    // A 60-Tick window against a 30-Tick cadence: one Decision Point of it has
    // been simulated, so half of it is still to come. Story 2.1 asserted the
    // whole 60 here because it decremented the countdown once per step rather
    // than once per Tick.
    expect(after.commitmentRemaining[0]).toBe(
      SPECIAL_WINDOW_TICKS - DEFAULT_FIGHTER_CONFIG.ticksPerDecision,
    );
  });

  it('commits and spends even on a whiff, which is what makes it punishable', () => {
    const far = createFighterEnvironment();
    const start = stateOf({
      meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0],
      position: DEFAULT_FIGHTER_CONFIG.startPosition,
    });
    const after = far.step(start, ['special', 'stand']);

    expect(after.health[1]).toBe(start.health[1]);
    expect(after.meter[0]).toBe(0);
    expect(after.commitmentRemaining[0]).toBe(
      SPECIAL_WINDOW_TICKS - DEFAULT_FIGHTER_CONFIG.ticksPerDecision,
    );
  });

  it('stops polling the committed Agent for exactly the window it opened', () => {
    // Two Decision Points of lockout for a 60-Tick window, not three. Story
    // 2.1 assigned the countdown *after* decrementing it, so the window still
    // read a full 60 at the end of the step that opened it and a fighter paid
    // 90 Ticks for a 60-Tick Action. Counting down inside the step that opens
    // the window is what makes `commitmentRemaining` mean what it says.
    let state = env.step(stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0] }), [
      'special',
      'stand',
    ]);
    expect(state.commitmentRemaining[0]).toBe(
      SPECIAL_WINDOW_TICKS - DEFAULT_FIGHTER_CONFIG.ticksPerDecision,
    );
    expect(env.isActionable(state, 0)).toBe(false);
    expect(env.isActionable(state, 1)).toBe(true);

    state = env.step(state, [null, 'stand']);
    expect(env.isActionable(state, 0)).toBe(true);
    expect(state.commitmentRemaining[0]).toBe(0);
    expect(state.committedAction[0]).toBe(COMMITTED_NONE);
  });

  it('decrements the Commitment Window every step, so a Match can never stall', () => {
    let state = stateOf({ commitmentRemaining: [900, 900] });
    for (let round = 0; round < 30; round += 1) {
      const before = state.commitmentRemaining[0];
      state = env.step(state, [null, null]);
      expect(state.commitmentRemaining[0]).toBeLessThan(before);
    }
    expect(state.commitmentRemaining).toStrictEqual([0, 0]);
  });
});

describe('attack Commitment Windows (AC1)', () => {
  const env = createFighterEnvironment(CLOSE_QUARTERS);

  it('locks the attacker out of the next Decision Point, and only the next one', () => {
    // The whole point of the story: Story 2.1's `attack` resolved inside one
    // Decision Point and opened no window at all, so attacking was free and
    // nothing could ever be punished. A 40-Tick window against a 30-Tick
    // cadence costs the attacker exactly one Decision Point.
    const committed = env.step(env.reset(SEED), ['attack', 'stand']);
    expect(committed.committedAction[0]).toBe(COMMITTED_ATTACK);
    expect(committed.commitmentRemaining[0]).toBe(ATTACK_TICKS_AFTER_ONE_STEP);
    expect(env.isActionable(committed, 0)).toBe(false);
    expect(env.isActionable(committed, 1)).toBe(true);

    const released = env.step(committed, [null, 'stand']);
    expect(env.isActionable(released, 0)).toBe(true);
    expect(released.commitmentRemaining[0]).toBe(0);
    // The window is fully cleared, not merely counted out: a stale action code
    // or hit flag left behind would change the Final-State Hash of an
    // otherwise idle fighter.
    expect(released.committedAction[0]).toBe(COMMITTED_NONE);
    expect(released.windowHitLanded[0]).toBe(0);
  });

  it('spends its startup and active phases inside the Decision Point that opened it', () => {
    // Both phases are shorter than the cadence, so by the next boundary the
    // attacker is necessarily in recovery -- which is what makes the punish
    // window in the case below reachable at all.
    const committed = env.step(env.reset(SEED), ['attack', 'stand']);
    expect(
      phaseOf(DEFAULT_FIGHTER_CONFIG, committed.committedAction[0], committed.commitmentRemaining[0]),
    ).toBe(PHASE_RECOVERY);
    expect(
      DEFAULT_FIGHTER_CONFIG.attackWindow.startup + DEFAULT_FIGHTER_CONFIG.attackWindow.active,
    ).toBeLessThan(DEFAULT_FIGHTER_CONFIG.ticksPerDecision);
  });

  it('connects once per window even though its active phase spans several Ticks', () => {
    const after = env.step(env.reset(SEED), ['attack', 'stand']);
    const taken = DEFAULT_FIGHTER_CONFIG.initialHealth - after.health[1];

    expect(DEFAULT_FIGHTER_CONFIG.attackWindow.active).toBeGreaterThan(1);
    expect(taken).toBeGreaterThanOrEqual(DEFAULT_FIGHTER_CONFIG.attackDamage);
    // One hit's worth, not one per active Tick: without the `windowHitLanded`
    // flag this would be `active` hits deep and a fight would end in one step.
    expect(taken).toBeLessThanOrEqual(MAX_ATTACK_DAMAGE);
    expect(after.windowHitLanded[0]).toBe(1);
  });

  it('is not shortened by connecting, so recovery is a property of the frame data', () => {
    const connected = env.step(env.reset(SEED), ['attack', 'stand']);
    const whiffed = createFighterEnvironment().step(
      createFighterEnvironment().reset(SEED),
      ['attack', 'stand'],
    );

    expect(connected.health[1]).toBeLessThan(DEFAULT_FIGHTER_CONFIG.initialHealth);
    expect(whiffed.health[1]).toBe(DEFAULT_FIGHTER_CONFIG.initialHealth);
    expect(connected.commitmentRemaining[0]).toBe(whiffed.commitmentRemaining[0]);
  });

  it('whiffs when the opponent walks out of range before the active phase (AC2)', () => {
    // Timing, not distance at the boundary: both fighters start exactly at
    // `attackRange`, so the attack is in range when it is committed. The
    // retreating opponent covers `moveUnitsPerTick` per Tick and is out of the
    // band by the time the active phase arrives. Story 2.1 read separation once
    // per Decision Point and so could not express this at all.
    const spaced = createFighterEnvironment({
      startPosition: [
        DEFAULT_FIGHTER_CONFIG.startPosition[0],
        DEFAULT_FIGHTER_CONFIG.startPosition[0] + DEFAULT_FIGHTER_CONFIG.attackRange,
      ],
    });
    const start = spaced.reset(SEED);
    const escaped = spaced.step(start, ['attack', 'retreat']);
    const stood = spaced.step(start, ['attack', 'block']);

    expect(
      DEFAULT_FIGHTER_CONFIG.attackWindow.startup * DEFAULT_FIGHTER_CONFIG.moveUnitsPerTick,
    ).toBeGreaterThan(0);
    expect(escaped.health[1]).toBe(DEFAULT_FIGHTER_CONFIG.initialHealth);
    // The control: standing still in the same band is hit, so the whiff above
    // is caused by the movement and not by the band being wrong.
    expect(stood.health[1]).toBeLessThan(DEFAULT_FIGHTER_CONFIG.initialHealth);
  });

  it('ignores an Action submitted for a fighter that is mid-window', () => {
    // The Harness sends `null` for a committed Agent, but honouring a non-null
    // Action here would let any caller cancel a Commitment Window -- and with
    // it every guarantee the punish window rests on.
    const midWindow = stateOf({
      committedAction: [COMMITTED_ATTACK, COMMITTED_NONE],
      commitmentRemaining: [ATTACK_TICKS_AFTER_ONE_STEP, 0],
      windowHitLanded: [1, 0],
    });
    const after = env.step(midWindow, ['advance', 'stand']);

    expect(after.position).toStrictEqual(midWindow.position);
    expect(after.committedAction[0]).toBe(COMMITTED_NONE);
    expect(after.commitmentRemaining[0]).toBe(0);
  });
});

describe('whiff punishing (AC2)', () => {
  it('lands full damage on a fighter that is still recovering', () => {
    // The scenario the story exists for. p1 attacks from out of range while p2
    // closes; p1's window outlives the Decision Point, so at the next boundary
    // p1 is not polled, cannot block, and eats a clean hit.
    const env = createFighterEnvironment({ startPosition: [420, 540] });
    const whiffed = env.step(env.reset(SEED), ['attack', 'advance']);

    expect(whiffed.health).toStrictEqual([
      DEFAULT_FIGHTER_CONFIG.initialHealth,
      DEFAULT_FIGHTER_CONFIG.initialHealth,
    ]);
    expect(env.isActionable(whiffed, 0)).toBe(false);
    expect(
      phaseOf(DEFAULT_FIGHTER_CONFIG, whiffed.committedAction[0], whiffed.commitmentRemaining[0]),
    ).toBe(PHASE_RECOVERY);

    const punished = env.step(whiffed, [null, 'attack']);
    const taken = whiffed.health[0] - punished.health[0];
    expect(taken).toBeGreaterThanOrEqual(DEFAULT_FIGHTER_CONFIG.attackDamage);

    // A fighter that *could* block takes strictly less from the same hit, so
    // "cannot block while committed" is doing real work rather than being an
    // unobservable implementation detail.
    const close = createFighterEnvironment(CLOSE_QUARTERS);
    const blocked = close.step(close.reset(SEED), ['block', 'attack']);
    const takenWhileBlocking = DEFAULT_FIGHTER_CONFIG.initialHealth - blocked.health[0];
    expect(takenWhileBlocking).toBeLessThan(taken);
  });

  it('is damageable at every Tick of the recovery phase, not just the first', () => {
    // "Damageable for the full recovery duration" swept offset by offset. Each
    // iteration starts p1 that many Ticks into its window and has p2 attack;
    // p2's own active phase falls a few Ticks later, well inside what remains.
    const env = createFighterEnvironment(CLOSE_QUARTERS);
    const recoveryStart =
      DEFAULT_FIGHTER_CONFIG.attackWindow.startup + DEFAULT_FIGHTER_CONFIG.attackWindow.active;
    const offsets: number[] = [];

    for (let offset = recoveryStart; offset < ATTACK_WINDOW_TICKS; offset += 1) {
      const recovering = stateOf({
        committedAction: [COMMITTED_ATTACK, COMMITTED_NONE],
        commitmentRemaining: [ATTACK_WINDOW_TICKS - offset, 0],
        windowHitLanded: [1, 0],
      });
      const punished = env.step(recovering, [null, 'attack']);
      const taken = DEFAULT_FIGHTER_CONFIG.initialHealth - punished.health[0];
      if (taken < DEFAULT_FIGHTER_CONFIG.attackDamage) {
        offsets.push(offset);
      }
    }

    expect(recoveryStart).toBeLessThan(ATTACK_WINDOW_TICKS);
    expect(offsets).toStrictEqual([]);
  });
});

describe('movement caps where the cap actually binds', () => {
  const MIN_SEPARATION = DEFAULT_FIGHTER_CONFIG.minSeparation;

  /** One Decision Point's displacement for each side, as a `[p1, p2]` pair. */
  type DisplacementPair = readonly [number, number];

  /** Steps both fighters forward, reporting the settled separation and each round's displacement pair. */
  function closeUntilStable(gap: number): {
    separation: number;
    rounds: readonly DisplacementPair[];
  } {
    const env = createFighterEnvironment({
      startPosition: [
        DEFAULT_FIGHTER_CONFIG.startPosition[0],
        DEFAULT_FIGHTER_CONFIG.startPosition[0] + gap,
      ],
    });
    let state = env.reset(SEED);
    const rounds: DisplacementPair[] = [];

    for (let round = 0; round < 40; round += 1) {
      const before = state.position;
      state = env.step(state, ['advance', 'advance']);
      // Displacement *towards the opponent* for each side. Within a round the
      // two must match -- that is the whole claim of the halved cap. Across
      // rounds they legitimately shrink as the room runs out, so the comparison
      // is per-round rather than global.
      rounds.push([state.position[0] - before[0], before[1] - state.position[1]]);
    }
    return { separation: Math.abs(state.position[0] - state.position[1]), rounds };
  }

  it('displaces both closers identically once the room is too small to split evenly', () => {
    // The gap that was missing, and it was a real hole: from the default
    // 320-unit start the cap is ~140 while a Tick moves only 2 units, so
    // `Math.min(moveUnitsPerTick, cap)` never binds and any asymmetry in the cap
    // is invisible. Verified by mutation -- handing p1 the unhalved room passed
    // all 161 tests, including the case named "gives neither side the odd unit".
    // Starting a few units above `minSeparation` is what forces the cap to be
    // the binding term, and a side advantage in the physics is the single most
    // damaging bug this environment could ship (Story 7.1 compares sides).
    const { rounds } = closeUntilStable(MIN_SEPARATION + 3);
    for (const [first, second] of rounds) {
      expect(first).toBe(second);
    }
    // And the cap really was the binding term in at least one round: a round
    // that moved a nonzero distance smaller than a full Tick's worth of movement
    // could only have been limited by the halved room. Without this the case
    // would pass just as well from a start where the cap never applies -- which
    // is precisely how the asymmetry went unnoticed.
    const bound = rounds.filter(
      ([first]) => first > 0 && first < DEFAULT_FIGHTER_CONFIG.moveUnitsPerTick,
    );
    expect(bound.length).toBeGreaterThan(0);
  });

  it('converges to minSeparation from an even gap and one unit short from an odd one', () => {
    // Not a stall to be fixed but an arithmetic consequence of fairness: two
    // mutual closers move the same distance, so separation changes by an even
    // amount and its parity is conserved. An odd gap can therefore only reach
    // `minSeparation + 1`. Pinned so Story 2.4's recalibration cannot quietly
    // land a range band inside that unreachable unit -- and `assertIntegerConfig`
    // now rejects such a band outright.
    expect(closeUntilStable(MIN_SEPARATION + 4).separation).toBe(MIN_SEPARATION);
    expect(closeUntilStable(MIN_SEPARATION + 3).separation).toBe(MIN_SEPARATION + 1);
  });

  it('closes correctly in an arena scaled past the 32-bit range', () => {
    // Regression guard for a cap that was computed with `>> 1`, and so coerced
    // through ToInt32: a closing room crossing 2^32 halved to exactly zero,
    // freezing the distance between the fighters for the rest of the Match, and
    // to a *negative* cap slightly further out, which feeds a backwards step into
    // the position update. `assertIntegerConfig` accepts any safe integer here,
    // so nothing rejected such an arena -- it just quietly stopped working.
    const huge = 5_000_000_000;
    const env = createFighterEnvironment({
      arenaMin: 0,
      arenaMax: huge,
      startPosition: [0, huge],
      moveUnitsPerTick: 100_000_000,
    });
    let state = env.reset(SEED);
    let previous = Math.abs(state.position[0] - state.position[1]);

    for (let round = 0; round < 5; round += 1) {
      state = env.step(state, ['advance', 'advance']);
      const separation = Math.abs(state.position[0] - state.position[1]);
      expect(separation).toBeLessThanOrEqual(previous);
      expect(separation).toBeGreaterThanOrEqual(MIN_SEPARATION);
      expect(state.position.every((value) => Number.isSafeInteger(value))).toBe(true);
      previous = separation;
    }
    expect(previous).toBe(MIN_SEPARATION);
  });

  it('lets a lone closer reach exactly minSeparation', () => {
    // Story 2.1 halved the closing room whether one fighter was advancing or
    // two, so a solo advance approached `minSeparation` asymptotically and
    // never arrived -- which is why its Harness KO case needed a hand-picked
    // start position. The cap is now split only when both sides are closing.
    const env = createFighterEnvironment();
    let state = env.reset(SEED);
    for (let round = 0; round < 20; round += 1) {
      state = env.step(state, ['advance', 'block']);
    }
    expect(Math.abs(state.position[0] - state.position[1])).toBe(
      DEFAULT_FIGHTER_CONFIG.minSeparation,
    );
  });
});

describe('meter accrual (AC4)', () => {
  const env = createFighterEnvironment(CLOSE_QUARTERS);

  it('accrues on a blocked hit too -- the hit landed, it was only reduced', () => {
    const after = env.step(env.reset(SEED), ['attack', 'block']);
    expect(DEFAULT_FIGHTER_CONFIG.initialHealth - after.health[1]).toBeLessThan(
      DEFAULT_FIGHTER_CONFIG.attackDamage,
    );
    expect(after.meter[0]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitLanded);
    expect(after.meter[1]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitTaken);
  });

  it('accrues even when the block absorbs the hit entirely', () => {
    // The extreme of the rule above: with a reduction as large as the damage, a
    // connected hit deals literally zero. Meter still accrues, because the hit
    // *landed* -- gating accrual on damage instead would silently turn a perfect
    // block into a meter denial too, and Story 2.4 is free to configure a
    // reduction that large.
    const absorbing = createFighterEnvironment({
      ...CLOSE_QUARTERS,
      blockDamageReduction:
        DEFAULT_FIGHTER_CONFIG.attackDamage + DEFAULT_FIGHTER_CONFIG.damageJitter,
    });
    const after = absorbing.step(absorbing.reset(SEED), ['attack', 'block']);

    expect(after.health[1]).toBe(DEFAULT_FIGHTER_CONFIG.initialHealth);
    expect(after.meter[0]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitLanded);
    expect(after.meter[1]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitTaken);
  });

  it('caps the defender’s meter as well as the attacker’s', () => {
    // Both sides route through one `clamp`, but only the attacker's side was
    // pinned -- and the defender is the side that accrues without choosing to.
    const after = env.step(stateOf({ meter: [0, DEFAULT_FIGHTER_CONFIG.maxMeter] }), [
      'attack',
      'stand',
    ]);
    expect(after.meter[1]).toBe(DEFAULT_FIGHTER_CONFIG.maxMeter);
  });

  it('never accrues for a whiff', () => {
    const far = createFighterEnvironment();
    const after = far.step(far.reset(SEED), ['attack', 'attack']);
    expect(after.meter).toStrictEqual([0, 0]);
  });

  it('never drives the Super Meter below zero when a special is paid for', () => {
    const exact = stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0] });
    const far = createFighterEnvironment({ startPosition: DEFAULT_FIGHTER_CONFIG.startPosition });
    const after = far.step({ ...exact, position: DEFAULT_FIGHTER_CONFIG.startPosition }, [
      'special',
      'stand',
    ]);
    expect(after.meter[0]).toBe(0);
  });
});

describe('simultaneity at Tick granularity (AC5)', () => {
  const env = createFighterEnvironment(CLOSE_QUARTERS);

  it('gives the same result whichever side submits which Action', () => {
    // Swapping the tuple round must mirror the outcome exactly. Jitter is
    // disabled because the two sides deliberately draw it from disjoint PRNG
    // bits, which is an intended asymmetry that would mask this property.
    const fair = createFighterEnvironment({ ...CLOSE_QUARTERS, damageJitter: 0 });
    const start = fair.reset(SEED);
    const forwards = fair.step(start, ['attack', 'block']);
    const backwards = fair.step(start, ['block', 'attack']);

    expect(backwards.health).toStrictEqual([forwards.health[1], forwards.health[0]]);
    expect(backwards.meter).toStrictEqual([forwards.meter[1], forwards.meter[0]]);
    expect(backwards.commitmentRemaining).toStrictEqual([
      forwards.commitmentRemaining[1],
      forwards.commitmentRemaining[0],
    ]);
  });

  it('resolves a mutual trade rather than letting the first hit pre-empt the second', () => {
    // One health each, so a resolution that checked for a KO between the two
    // sides *within* the Tick would leave the second fighter alive on 1. Not
    // `MAX_ATTACK_DAMAGE` health: each side draws its jitter from a different
    // PRNG bit, so at that health one side can survive on a legitimate
    // one-unit-lower roll and the case would be flaky rather than wrong.
    const traded = env.step(stateOf({ health: [1, 1] }), ['attack', 'attack']);
    // Both connect on the same Tick and both are applied: a sequential
    // resolution would have let whichever side was processed first survive.
    expect(traded.health).toStrictEqual([0, 0]);
    expect(traded.windowHitLanded).toStrictEqual([1, 1]);
  });
});

describe('KO freezes the rest of the Decision Point', () => {
  const env = createFighterEnvironment(CLOSE_QUARTERS);

  it('advances the Tick counter by exactly one cadence and applies nothing further', () => {
    // `runMatch` advances its own tick counter by `ticksPerDecision` per
    // iteration, so a step that returned a partial Tick count would put the
    // Harness's tick and the state's tick permanently out of step -- and every
    // logged Decision Point after it would carry the wrong tick.
    const start = stateOf({ health: [1, DEFAULT_FIGHTER_CONFIG.initialHealth] });
    const after = env.step(start, ['advance', 'attack']);

    expect(after.health[0]).toBe(0);
    expect(after.tick).toBe(start.tick + DEFAULT_FIGHTER_CONFIG.ticksPerDecision);
    expect(env.terminal(after)).toMatchObject({ endReason: 'ko', outcome: 'p2' });
    // p1 was advancing when it died: the freeze means it stops there rather
    // than walking the remaining Ticks of a Decision Point it did not survive.
    expect(Math.abs(after.position[0] - start.position[0])).toBeLessThan(
      DEFAULT_FIGHTER_CONFIG.moveUnitsPerTick * DEFAULT_FIGHTER_CONFIG.ticksPerDecision,
    );
  });

  it('commits nothing at all when the state was already terminal on entry', () => {
    // The commit pass used to run before anything checked for a KO, so stepping
    // a finished Match spent Super Meter and opened a Commitment Window during a
    // step that simulated zero Ticks. `runMatch` calls `terminal()` before each
    // iteration and so never reaches this path -- which is exactly why the
    // inconsistency could survive: only a replay or analysis tool stepping one
    // Decision Point past the end of a Match would ever have seen it.
    const finished = stateOf({
      health: [0, DEFAULT_FIGHTER_CONFIG.initialHealth],
      meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, DEFAULT_FIGHTER_CONFIG.specialMeterCost],
    });
    const after = env.step(finished, ['special', 'attack']);

    expect(after.tick).toBe(finished.tick + DEFAULT_FIGHTER_CONFIG.ticksPerDecision);
    expect(after.meter).toStrictEqual(finished.meter);
    expect(after.commitmentRemaining).toStrictEqual([0, 0]);
    expect(after.committedAction).toStrictEqual([COMMITTED_NONE, COMMITTED_NONE]);
    expect(after.position).toStrictEqual(finished.position);
    expect(after.health).toStrictEqual(finished.health);
    // Not even a PRNG draw is consumed, so a frozen step cannot shift the jitter
    // of anything a caller does afterwards.
    expect(after.rngState).toBe(finished.rngState);
  });
});

describe('terminal', () => {
  const env = createFighterEnvironment();

  it('returns null mid-Match', () => {
    expect(env.terminal(env.reset(SEED))).toBeNull();
  });

  it('reports a KO for p1', () => {
    expect(env.terminal(stateOf({ tick: 90, health: [40, 0] }))).toStrictEqual({
      outcome: 'p1',
      endTick: 90,
      endReason: 'ko',
      healthRemaining: [40, 0],
    });
  });

  it('reports a KO for p2', () => {
    expect(env.terminal(stateOf({ tick: 90, health: [0, 40] }))?.outcome).toBe('p2');
  });

  it('reports a draw when both are knocked out in the same step', () => {
    const traded = createFighterEnvironment(CLOSE_QUARTERS).step(stateOf({ health: [3, 3] }), [
      'attack',
      'attack',
    ]);
    expect(env.terminal(traded)).toStrictEqual({
      outcome: 'draw',
      endTick: traded.tick,
      endReason: 'ko',
      healthRemaining: [0, 0],
    });
  });

  it('reports a timeout at the tick cap, won on remaining health', () => {
    const cap = DEFAULT_FIGHTER_CONFIG.maxTicks;
    expect(env.terminal(stateOf({ tick: cap, health: [50, 20] }))).toStrictEqual({
      outcome: 'p1',
      endTick: cap,
      endReason: 'timeout',
      healthRemaining: [50, 20],
    });
    expect(env.terminal(stateOf({ tick: cap, health: [20, 50] }))?.outcome).toBe('p2');
    expect(env.terminal(stateOf({ tick: cap, health: [50, 50] }))?.outcome).toBe('draw');
  });

  it('prefers the KO reason over the timeout reason when both hold', () => {
    expect(env.terminal(stateOf({ tick: DEFAULT_FIGHTER_CONFIG.maxTicks, health: [10, 0] }))).
      toMatchObject({ endReason: 'ko', outcome: 'p1' });
  });

  it('reaches the tick cap in exactly maxTicks / ticksPerDecision Decision Points', () => {
    let state = env.reset(SEED);
    let decisionPoints = 0;
    while (env.terminal(state) === null) {
      state = env.step(state, ['block', 'block']);
      decisionPoints += 1;
      expect(decisionPoints).toBeLessThanOrEqual(100);
    }
    expect(state.tick).toBe(DEFAULT_FIGHTER_CONFIG.maxTicks);
    expect(decisionPoints).toBe(
      DEFAULT_FIGHTER_CONFIG.maxTicks / DEFAULT_FIGHTER_CONFIG.ticksPerDecision,
    );
    expect(env.terminal(state)?.endReason).toBe('timeout');
  });
});

describe('observe', () => {
  const env = createFighterEnvironment();

  it('reports the current Tick, never anything time-derived', () => {
    const state = env.step(env.reset(SEED), ['stand', 'stand']);
    const observation = env.observe(state, 0);
    expect(observation.tick).toBe(state.tick);
    expect(observation.tick).toBe(DEFAULT_FIGHTER_CONFIG.ticksPerDecision);
  });

  it('serialises integers only, with sorted keys', () => {
    const payload = JSON.parse(env.observe(env.reset(SEED), 0).state) as Record<string, unknown>;
    expect(Object.keys(payload)).toStrictEqual([...Object.keys(payload)].sort());
    for (const value of Object.values(payload)) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it('shows each Agent its own side as self', () => {
    const state = stateOf({ health: [80, 30], meter: [10, 40] });
    const first = JSON.parse(env.observe(state, 0).state) as Record<string, number>;
    const second = JSON.parse(env.observe(state, 1).state) as Record<string, number>;

    expect(first.selfHealth).toBe(80);
    expect(first.opponentHealth).toBe(30);
    expect(second.selfHealth).toBe(30);
    expect(second.opponentHealth).toBe(80);
    expect(first.selfMeter).toBe(10);
    expect(second.selfMeter).toBe(40);
  });

  it('is side-relative, so a mirrored state reads identically to both Agents', () => {
    const mirrored = stateOf({ health: [70, 70], meter: [20, 20], position: [400, 560] });
    expect(env.observe(mirrored, 0).state).toBe(env.observe(mirrored, 1).state);
  });

  it('stays side-relative while both fighters are mid-Commitment-Window', () => {
    // The case above only covers an idle state, so the two fields this story
    // added sat outside the mirror-symmetry claim entirely -- and they are the
    // fields most able to leak an absolute side, since each Agent reads them off
    // the *other* index.
    const mirrored = stateOf({
      health: [70, 70],
      meter: [20, 20],
      position: [400, 560],
      committedAction: [COMMITTED_ATTACK, COMMITTED_ATTACK],
      commitmentRemaining: [ATTACK_TICKS_AFTER_ONE_STEP, ATTACK_TICKS_AFTER_ONE_STEP],
      windowHitLanded: [1, 1],
    });
    expect(env.observe(mirrored, 0).state).toBe(env.observe(mirrored, 1).state);

    // And an asymmetric window must still read differently, or the assertion
    // above would also hold for an `observe()` that omitted the fields entirely.
    const lopsided = stateOf({
      health: [70, 70],
      meter: [20, 20],
      position: [400, 560],
      committedAction: [COMMITTED_ATTACK, COMMITTED_NONE],
      commitmentRemaining: [ATTACK_TICKS_AFTER_ONE_STEP, 0],
    });
    expect(env.observe(lopsided, 0).state).not.toBe(env.observe(lopsided, 1).state);
  });

  it('reports the opponent’s Commitment Window, so a punish is playable (AC2)', () => {
    // Whiff punishing is only a decision an Agent can make if it can see the
    // opponent is stuck. Reported as an integer phase code, never a string:
    // every value in the payload has to survive the integers-only canonical
    // serialisation the case above pins.
    const recovering = stateOf({
      committedAction: [COMMITTED_ATTACK, COMMITTED_NONE],
      commitmentRemaining: [ATTACK_TICKS_AFTER_ONE_STEP, 0],
      windowHitLanded: [0, 0],
    });
    const defender = JSON.parse(env.observe(recovering, 1).state) as Record<string, number>;
    const attacker = JSON.parse(env.observe(recovering, 0).state) as Record<string, number>;

    expect(defender.opponentPhase).toBe(PHASE_RECOVERY);
    expect(defender.opponentCommitmentRemaining).toBe(ATTACK_TICKS_AFTER_ONE_STEP);
    // The committed fighter's own window is not reported: it is only ever
    // polled when it has none open, so the value would always be zero.
    expect(attacker.opponentCommitmentRemaining).toBe(0);
    expect(Object.keys(attacker)).not.toContain('selfCommitmentRemaining');
  });

  it('reports separation and the space behind each fighter', () => {
    const state = stateOf({ position: [100, 300] });
    const first = JSON.parse(env.observe(state, 0).state) as Record<string, number>;
    const second = JSON.parse(env.observe(state, 1).state) as Record<string, number>;

    expect(first.separation).toBe(200);
    expect(second.separation).toBe(200);
    expect(first.spaceBehind).toBe(100 - DEFAULT_FIGHTER_CONFIG.arenaMin);
    expect(second.spaceBehind).toBe(DEFAULT_FIGHTER_CONFIG.arenaMax - 300);
  });
});

describe('isActionable', () => {
  const env = createFighterEnvironment();

  it('is true for a fighter with no commitment left and false otherwise', () => {
    const state = stateOf({ commitmentRemaining: [0, 30] });
    expect(env.isActionable(state, 0)).toBe(true);
    expect(env.isActionable(state, 1)).toBe(false);
  });
});

describe('config validation', () => {
  it('rejects a non-integer override before it can reach the hash', () => {
    expect(() => createFighterEnvironment({ initialHealth: 100 / 3 })).toThrow(
      /must be a safe integer/,
    );
  });

  it('rejects a non-integer start position', () => {
    expect(() => createFighterEnvironment({ startPosition: [1 / 3, 640] })).toThrow(
      /startPosition\[0\] must be a safe integer/,
    );
  });

  it('rejects a cadence that would stop the tick counter advancing', () => {
    expect(() => createFighterEnvironment({ ticksPerDecision: 0 })).toThrow(/must be positive/);
    expect(() => createFighterEnvironment({ maxTicks: 0 })).toThrow(/maxTicks must be positive/);
  });

  it('rejects an inverted arena and out-of-arena start positions', () => {
    expect(() => createFighterEnvironment({ arenaMin: 900, arenaMax: 100 })).toThrow(
      /arenaMax must exceed arenaMin/,
    );
    expect(() => createFighterEnvironment({ startPosition: [-10, 640] })).toThrow(
      /must lie within the arena/,
    );
  });

  it('rejects start positions closer than minSeparation', () => {
    expect(() => createFighterEnvironment({ startPosition: [480, 500], minSeparation: 40 })).toThrow(
      /must respect minSeparation/,
    );
  });

  it('rejects a negative value where only a magnitude is meaningful', () => {
    expect(() => createFighterEnvironment({ moveUnitsPerTick: -2 })).toThrow(
      /moveUnitsPerTick must not be negative/,
    );
    expect(() => createFighterEnvironment({ damageJitter: -1 })).toThrow(
      /damageJitter must not be negative/,
    );
    expect(() => createFighterEnvironment({ attackRange: -80 })).toThrow(
      /attackRange must not be negative/,
    );
    expect(() => createFighterEnvironment({ minSeparation: -40 })).toThrow(
      /minSeparation must not be negative/,
    );
  });

  it('rejects a Commitment Window that would commit its fighter for no Decision Point', () => {
    // A window no longer than the cadence unwinds inside the very step that
    // opened it, so the Action is free and the punish mechanic silently vanishes
    // -- while the Match still runs, still hashes, and still produces a
    // leaderboard row. `config.ts` claimed both totals exceed `ticksPerDecision`;
    // nothing enforced it until now.
    expect(() =>
      createFighterEnvironment({ attackWindow: { startup: 0, active: 1, recovery: 29 } }),
    ).toThrow(/attackWindow totals 30 Ticks, which does not exceed ticksPerDecision/);
    expect(() =>
      createFighterEnvironment({ specialWindow: { startup: 2, active: 2, recovery: 6 } }),
    ).toThrow(/specialWindow totals 10 Ticks/);
    // One Tick longer than the cadence is enough, and is accepted.
    expect(() =>
      createFighterEnvironment({ attackWindow: { startup: 1, active: 1, recovery: 29 } }),
    ).not.toThrow();
  });

  it('rejects a range band that minSeparation puts permanently out of reach', () => {
    // Separation is floored at `minSeparation` by the closing cap, so a band at
    // or below it can never connect: the Action opens, commits its fighter, and
    // does nothing forever. Same failure mode as `specialMeterCost > maxMeter`,
    // which was already guarded.
    expect(() => createFighterEnvironment({ attackRange: 10, minSeparation: 40 })).toThrow(
      /attackRange \(10\) must exceed minSeparation \(40\)/,
    );
    expect(() => createFighterEnvironment({ specialRange: 40, minSeparation: 40 })).toThrow(
      /specialRange \(40\) must exceed minSeparation \(40\)/,
    );
  });

  it('rejects a special that the Super Meter could never pay for', () => {
    expect(() => createFighterEnvironment({ specialMeterCost: 101, maxMeter: 100 })).toThrow(
      /making special unusable/,
    );
  });

  it('accepts an integer override and applies it', () => {
    const env = createFighterEnvironment({ initialHealth: 42 });
    expect(env.reset(SEED).health).toStrictEqual([42, 42]);
  });
});
