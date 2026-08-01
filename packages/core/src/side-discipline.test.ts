import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCommandLog, validateCommandLog } from './command-log';
import { runMatch } from './match-runner';
import { createMockEnvironment } from './testing/mock-environment';
import { createScriptedAgent } from './testing/mock-agent';

/**
 * Story 7.1 AC2: "given any Command Log, array index 0 is always P1 -- there is
 * no 'sides swapped' flag."
 *
 * AD-12 in its enforceable form. The temptation this guards against is
 * concrete and cheap-looking: one Match plus `sidesSwapped: true` is half the
 * disk and half the Matches of two Matches. It is also how a corpus becomes
 * unreadable -- every consumer would then have to remember to flip, one of them
 * eventually would not, and the failure is silent and looks exactly like a
 * skill difference. So the flag is refused by name, and the positive property
 * (index 0 is the Agent that stood on side 0) is asserted against a real log.
 *
 * The same shape as `scaffold-discipline.test.ts`, deliberately: naming a thing
 * is how it gets built, so the names are banned outright rather than the
 * behaviour being reviewed for.
 *
 * Test files are exempt from the identifier sweep -- this one has to write the
 * banned tokens out in order to search for them, and the repo's other
 * discipline sweeps exempt `*.test.ts` for exactly that reason.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES_ROOT = join(REPO_ROOT, 'packages');
const APPS_ROOT = join(REPO_ROOT, 'apps');

/**
 * Every way of saying "the sides are the other way round" as a value.
 *
 * Precise camel-case identifiers rather than a bare `swapped`: a local named
 * `swapped` holding the *result of a swapped Match* is exactly the right
 * variable in `mirrored-seed.test.ts`, and banning the substring would refuse
 * the correct code along with the incorrect.
 */
const BANNED_SIDE_FLAG_TOKENS: readonly string[] = [
  'sidesSwapped',
  'sideSwapped',
  'swappedSides',
  'swapSides',
  'sidesFlipped',
  'sidesReversed',
  'isMirrorMatch',
  'p1IsFirst',
];

interface ShippedFile {
  readonly path: string;
  readonly source: string;
}

function shippedFiles(directory: string, collected: ShippedFile[] = []): ShippedFile[] {
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') {
      continue;
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      shippedFiles(path, collected);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) {
      continue;
    }
    collected.push({ path, source: readFileSync(path, 'utf8') });
  }
  return collected;
}

function allShippedFiles(): readonly ShippedFile[] {
  const collected: ShippedFile[] = [];
  for (const root of [PACKAGES_ROOT, APPS_ROOT]) {
    for (const workspace of readdirSync(root)) {
      const src = join(root, workspace, 'src');
      try {
        if (!statSync(src).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      shippedFiles(src, collected);
    }
  }
  return collected;
}

describe('no side-swap flag exists anywhere (AC2, AD-12)', () => {
  it('sweeps a non-trivial set of shipped files across packages and apps', () => {
    const files = allShippedFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(({ path }) => path.endsWith('command-log.ts'))).toBe(true);
    expect(files.some(({ path }) => path.endsWith('plan.ts'))).toBe(true);
    expect(files.some(({ path }) => path.includes(join('apps', 'web')))).toBe(true);
  });

  it('declares none of the side-flag identifiers, in code or in prose', () => {
    const offences: string[] = [];
    for (const { path, source } of allShippedFiles()) {
      source.split('\n').forEach((text, index) => {
        for (const token of BANNED_SIDE_FLAG_TOKENS) {
          if (text.includes(token)) {
            offences.push(`${path}:${String(index + 1)}: ${token}`);
          }
        }
      });
    }
    expect(offences).toStrictEqual([]);
  });

  it('keeps the frozen contract and its schema free of any such field', () => {
    const contract = readFileSync(join(REPO_ROOT, 'docs', 'contracts', 'index.ts'), 'utf8');
    const schema = readFileSync(
      join(REPO_ROOT, 'docs', 'contracts', 'command-log.schema.json'),
      'utf8',
    );
    for (const token of BANNED_SIDE_FLAG_TOKENS) {
      expect(contract).not.toContain(token);
      expect(schema).not.toContain(token);
    }
    // And no property name in the schema hints at one under a different spelling.
    const propertyNames = [...schema.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*:\s*\{/g)].map(
      (match) => match[1],
    );
    expect(propertyNames.length).toBeGreaterThan(10);
    expect(propertyNames.filter((name) => /swap|flip|mirror|reversed/i.test(name))).toStrictEqual(
      [],
    );
  });
});

describe('array index 0 is the Agent that stood on side 0 (AC2)', () => {
  const identity = (id: string) =>
    ({ id, kind: 'bot' }) as const;

  /** Long enough that the mock Environment's tick cap ends the Match, not the script. */
  const SIDE_0_SCRIPT = Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0 ? ('advance' as const) : ('attack' as const),
  );
  const SIDE_1_SCRIPT = Array.from({ length: 40 }, (_, index) =>
    index % 2 === 0 ? ('block' as const) : ('retreat' as const),
  );

  async function logFor(
    side0: string,
    side1: string,
  ): Promise<ReturnType<typeof buildCommandLog>> {
    const result = await runMatch(
      createMockEnvironment(),
      [
        createScriptedAgent({ id: side0, script: SIDE_0_SCRIPT }),
        createScriptedAgent({ id: side1, script: SIDE_1_SCRIPT }),
      ],
      4101,
    );
    return buildCommandLog(result, {
      environment: { id: 'mock', version: '1.0.0' },
      seed: 4101,
      configHash: 'c'.repeat(64),
      agents: [identity(side0), identity(side1)],
    });
  }

  it('puts the side-0 Agent at agents[0] in both orientations, with distinct matchIds', async () => {
    const forwards = await logFor('alpha', 'beta');
    const swappedLog = await logFor('beta', 'alpha');

    expect(forwards.agents[0].id).toBe('alpha');
    expect(swappedLog.agents[0].id).toBe('beta');
    expect(forwards.matchId).not.toBe(swappedLog.matchId);

    // Both are whole, valid documents in their own right -- not a base Match
    // plus a flag saying to read it backwards.
    expect(validateCommandLog(JSON.parse(JSON.stringify(forwards))).matchId).toBe(forwards.matchId);
    expect(validateCommandLog(JSON.parse(JSON.stringify(swappedLog))).matchId).toBe(
      swappedLog.matchId,
    );
  });

  it('carries no key anywhere in the document that could mean "read this backwards"', async () => {
    const log = await logFor('beta', 'alpha');
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          walk(nested);
        }
      }
    };
    walk(JSON.parse(JSON.stringify(log)));

    expect(keys.size).toBeGreaterThan(10);
    expect([...keys].filter((key) => /swap|flip|mirror|reversed/i.test(key))).toStrictEqual([]);
  });

  it('records each decision against the array index of the Agent that made it', async () => {
    const log = await logFor('beta', 'alpha');
    expect(log.decisions.length).toBeGreaterThan(0);
    for (const decision of log.decisions) {
      expect([0, 1]).toContain(decision.agentIndex);
    }
    // `beta` was scripted to advance first; it sits at index 0 here, and the
    // log says index 0, with nothing in between to reinterpret.
    expect(log.agents[0].id).toBe('beta');
    expect(log.decisions.find((entry) => entry.agentIndex === 0)?.action).toBe('advance');
  });
});
