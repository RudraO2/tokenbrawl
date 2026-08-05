import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFighterEnvironment } from './environment';
import type { FighterState } from './state';
import type { LoggedActionV2 } from '@tokenbrawl/contracts';

/**
 * "Cross-process reproducibility" from Story 2.1's test plan, and the half of
 * INV-2 that an in-process loop cannot provide: same-process-only testing
 * hides global-state leakage, because a module-level generator initialised
 * once is *shared* by every in-process Match and therefore stays consistent
 * with itself.
 *
 * Each iteration is a fresh `node` process with a fresh module graph. If any
 * simulation state escaped `FighterState` -- a module-level PRNG, a memoised
 * table keyed on the last Match, a lazily-seeded cache -- the first Match in
 * a virgin process would disagree with the Nth Match in a long-lived one.
 */

const CROSS_PROCESS_HASH_ITERATIONS = 25;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(HERE, 'testing', 'hash-child.ts');
// Reuses packages/core's contracts resolution hooks rather than duplicating
// them: `docs/contracts/` has no package.json and is not linked into
// node_modules, so a bare `node` child dies on the `@tokenbrawl/contracts`
// specifier before it imports anything. The hooks resolve that URL relative
// to their own location, so it does not matter who spawns them. This is a
// test file, so the packages/core reference is outside AD-4's shipped scope.
const REGISTER_CONTRACTS = resolve(
  HERE,
  '..',
  '..',
  'core',
  'src',
  'testing',
  'register-contracts.mjs',
);

const SEED = 12345;

/**
 * Both fighters close to trading range first, then trade.
 *
 * Story 2.1's version of this script opened at the default 320-unit separation
 * and never got inside `attackRange`, so every `attack` in it whiffed and the
 * hash it pinned never depended on damage, Super Meter, or a Commitment Window
 * that had connected. Story 2.2 put four new integers per Match into the state
 * (`committedAction` and `windowHitLanded`) and made hit resolution
 * tick-sensitive; a cross-process gate that cannot reach those paths is not
 * covering the parts of the engine most likely to leak process-local state.
 *
 * The leading advances also let meter accrue past `specialMeterCost`, so the
 * `special` further down is a legal Action rather than one rejected for being
 * unaffordable -- both branches of AC3 are then exercised across processes.
 *
 * Story 8.2 adds a `jump` for each side (34 Ticks each, so each spans two
 * Decision Points against the 30-Tick cadence): this is what makes
 * `verticalPosition`/`airState` -- and the gravity arithmetic driving them --
 * part of what this cross-process gate actually covers, rather than sitting
 * outside it the way a jump-free script would leave them.
 */
const SCRIPT: readonly (readonly [LoggedActionV2 | null, LoggedActionV2 | null])[] = [
  ['advance', 'advance'],
  ['advance', 'advance'],
  ['advance', 'advance'],
  ['attack', 'block'],
  [null, 'attack'],
  ['attack', 'attack'],
  ['retreat', 'attack'],
  ['advance', 'stand'],
  ['jump', 'attack'],
  [null, 'jump'],
  ['attack', 'attack'],
  ['special', 'retreat'],
  [null, 'advance'],
  ['block', 'special'],
  ['stand', null],
  ['attack', 'advance'],
];

function encodeScript(script: typeof SCRIPT): string {
  return script.map(([first, second]) => `${first ?? '-'}:${second ?? '-'}`).join(',');
}

function hashInChildProcess(seed: number, script: typeof SCRIPT): string {
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      '--import',
      pathToFileURL(REGISTER_CONTRACTS).href,
      CHILD_SCRIPT,
      String(seed),
      encodeScript(script),
    ],
    { encoding: 'utf8' },
  );

  if (child.status !== 0) {
    throw new Error(
      `hash-child exited ${String(child.status)}: ${child.stderr || child.stdout || '(no output)'}`,
    );
  }
  return child.stdout.trim();
}

function hashInProcess(seed: number, script: typeof SCRIPT): string {
  const env = createFighterEnvironment();
  let state: FighterState = env.reset(seed);
  for (const actions of script) {
    state = env.step(state, actions);
  }
  return env.hash(state);
}

describe('cross-process determinism (INV-2)', () => {
  it('agrees with a freshly spawned process on the Final-State Hash', () => {
    expect(hashInChildProcess(SEED, SCRIPT)).toBe(hashInProcess(SEED, SCRIPT));
  });

  it(`produces one hash across ${CROSS_PROCESS_HASH_ITERATIONS} separate processes`, () => {
    const observed = new Set<string>();
    for (let iteration = 0; iteration < CROSS_PROCESS_HASH_ITERATIONS; iteration += 1) {
      observed.add(hashInChildProcess(SEED, SCRIPT));
    }
    expect(observed.size).toBe(1);
    expect([...observed]).toStrictEqual([hashInProcess(SEED, SCRIPT)]);
  }, 120000);

  it('still separates different seeds when each runs in its own process', () => {
    // Without this the case above would pass just as happily against a child
    // that ignored its arguments and printed a constant.
    expect(hashInChildProcess(SEED, SCRIPT)).not.toBe(hashInChildProcess(SEED + 1, SCRIPT));
  });

  it('still separates different Action streams across processes', () => {
    const diverged = SCRIPT.map(
      ([, second]) => ['attack', second] as readonly [LoggedActionV2 | null, LoggedActionV2 | null],
    );
    expect(hashInChildProcess(SEED, SCRIPT)).not.toBe(hashInChildProcess(SEED, diverged));
  });

  it('reports a child failure instead of silently passing', () => {
    expect(() => hashInChildProcess(Number.NaN, SCRIPT)).toThrow(/hash-child exited/);
  });
});
