import { ACTIONS, type LoggedAction } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIGHTER_CONFIG, type FighterConfig } from './config';
import { createFighterEnvironment } from './environment';
import type { FighterState } from './state';

type ActionPair = readonly [LoggedAction | null, LoggedAction | null];

const SEED = 12345;

/** Close enough to trade: separation equals `minSeparation`, well inside `attackRange`. */
const CLOSE_QUARTERS: Partial<FighterConfig> = { startPosition: [460, 500] };

function stateOf(overrides: Partial<FighterState> = {}): FighterState {
  return {
    tick: 0,
    rngState: 1,
    health: [100, 100],
    position: [460, 500],
    meter: [0, 0],
    commitmentRemaining: [0, 0],
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

  it('offers every Action as legal in this story', () => {
    // Story 2.2 makes `special` illegal below its meter cost; here the grammar
    // is the full frozen ACTIONS list at every Decision Point.
    expect(env.observe(env.reset(SEED), 0).legalActions).toStrictEqual(ACTIONS);
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

  it('is inert when the Super Meter cannot pay for it', () => {
    const start = stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost - 1, 0] });
    const after = env.step(start, ['special', 'stand']);

    expect(after.health).toStrictEqual(start.health);
    expect(after.meter[0]).toBe(start.meter[0]);
    expect(after.commitmentRemaining[0]).toBe(0);
  });

  it('spends meter, deals its damage and commits the attacker when affordable', () => {
    const start = stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0] });
    const after = env.step(start, ['special', 'stand']);

    expect(after.health[1]).toBeLessThanOrEqual(
      start.health[1] - DEFAULT_FIGHTER_CONFIG.specialDamage,
    );
    expect(after.meter[0]).toBe(DEFAULT_FIGHTER_CONFIG.meterOnHitLanded);
    expect(after.commitmentRemaining[0]).toBe(DEFAULT_FIGHTER_CONFIG.specialCommitmentTicks);
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
    expect(after.commitmentRemaining[0]).toBe(DEFAULT_FIGHTER_CONFIG.specialCommitmentTicks);
  });

  it('stops polling the committed Agent until the window elapses', () => {
    let state = env.step(stateOf({ meter: [DEFAULT_FIGHTER_CONFIG.specialMeterCost, 0] }), [
      'special',
      'stand',
    ]);
    expect(env.isActionable(state, 0)).toBe(false);
    expect(env.isActionable(state, 1)).toBe(true);

    state = env.step(state, [null, 'stand']);
    expect(env.isActionable(state, 0)).toBe(false);

    state = env.step(state, [null, 'stand']);
    expect(env.isActionable(state, 0)).toBe(true);
    expect(state.commitmentRemaining[0]).toBe(0);
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
