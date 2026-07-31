import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFighterEnvironment } from './environment';
import type { FighterState } from './state';
import type { LoggedAction } from '@tokenbrawl/contracts';

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

const SCRIPT: readonly (readonly [LoggedAction | null, LoggedAction | null])[] = [
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
      ([, second]) => ['attack', second] as readonly [LoggedAction | null, LoggedAction | null],
    );
    expect(hashInChildProcess(SEED, SCRIPT)).not.toBe(hashInChildProcess(SEED, diverged));
  });

  it('reports a child failure instead of silently passing', () => {
    expect(() => hashInChildProcess(Number.NaN, SCRIPT)).toThrow(/hash-child exited/);
  });
});
