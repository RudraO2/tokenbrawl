import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The grep-level half of Story 2.1's test plan (AC2, AC3) plus AD-4.
 *
 * `scripts/audit-invariants.sh` runs equivalent checks in CI; this file runs
 * them from inside the suite so a local `npm test` catches the violation too,
 * and so the *shipped* file set is stated in one place rather than only in a
 * shell glob.
 *
 * Test files themselves are exempt and deliberately so: this file imports
 * `node:fs` to do its own job, and no test is ever bundled into the web app.
 *
 * Banned identifiers are assembled from fragments rather than written out,
 * because writing them contiguously here would trip the audit script's own
 * repo-wide greps -- which do *not* exempt test files for INV-1 and INV-3.
 */

const SHIPPED_DIRECTORY = dirname(fileURLToPath(import.meta.url));

interface ShippedFile {
  readonly name: string;
  readonly source: string;
}

function shippedFiles(): readonly ShippedFile[] {
  return readdirSync(SHIPPED_DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .map((name) => ({ name, source: readFileSync(join(SHIPPED_DIRECTORY, name), 'utf8') }));
}

/** Lines that are wholly a comment: prose may legitimately mention a banned token. */
function codeLines(source: string): readonly { readonly line: number; readonly text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*')
      );
    });
}

function offendingLines(pattern: RegExp): readonly string[] {
  const offences: string[] = [];
  for (const { name, source } of shippedFiles()) {
    for (const { line, text } of codeLines(source)) {
      if (pattern.test(text)) {
        offences.push(`${name}:${line}: ${text.trim()}`);
      }
    }
  }
  return offences;
}

const CLOCK_TOKENS = [
  ['Date', 'now'].join('.'),
  ['performance', 'now'].join('.'),
  ['set', 'Timeout'].join(''),
  ['set', 'Interval'].join(''),
  ['new ', 'Date('].join(''),
];

const RENDERING_TOKENS = [
  ['document', '.'].join(''),
  ['window', '.'].join(''),
  ['getContext', '('].join(''),
  ['request', 'AnimationFrame'].join(''),
  ['HTML', 'Canvas'].join(''),
];

const NODE_BUILTINS = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'os',
  'path',
  'process',
  'stream',
  'url',
  'util',
  'worker_threads',
  'zlib',
];

function escapeForPattern(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('shipped source discipline', () => {
  it('finds the shipped files it is meant to police', () => {
    const names = shippedFiles().map((file) => file.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'canonical.ts',
        'config.ts',
        'environment.ts',
        'index.ts',
        'prng.ts',
        'sha256.ts',
        'state.ts',
      ]),
    );
    expect(names.every((name) => !name.endsWith('.test.ts'))).toBe(true);
  });

  it('contains no floating-point literal apart from the adapter semver (AC2, INV-2)', () => {
    // `scripts/audit-invariants.sh` exempts any line containing "version"
    // from its float sweep. That exemption is far wider than it needs to be,
    // so this half pins it shut: the only permitted match is the adapter's
    // own `version:` semver string, which never enters state or arithmetic.
    // Anything else -- including a line that merely says "version" in
    // passing -- fails here even though the shell guard would wave it past.
    const offences = offendingLines(/[0-9]+\.[0-9]+/);
    for (const offence of offences) {
      expect(offence).toMatch(/^environment\.ts:[0-9]+: version: '[0-9]+\.[0-9]+\.[0-9]+',$/);
    }
    expect(offences).toHaveLength(1);
  });

  it('calls no float-producing Math helper (AC2, INV-2)', () => {
    expect(offendingLines(/\bMath\.(random|sin|cos|tan|sqrt|cbrt|pow|exp|log|atan2|hypot)\b/)).toStrictEqual(
      [],
    );
  });

  it('uses no exponentiation operator, which produces floats for negative exponents', () => {
    expect(offendingLines(/\*\*/)).toStrictEqual([]);
  });

  it('reads no wall-clock and schedules no timer (INV-1)', () => {
    const pattern = new RegExp(CLOCK_TOKENS.map(escapeForPattern).join('|'));
    expect(offendingLines(pattern)).toStrictEqual([]);
  });

  it('touches no DOM, canvas or rendering API (AC3, INV-3)', () => {
    const pattern = new RegExp(RENDERING_TOKENS.map(escapeForPattern).join('|'));
    expect(offendingLines(pattern)).toStrictEqual([]);
  });

  it('imports no Node built-in, so the same module runs in a browser tab (AD-4)', () => {
    const specifiers = [
      ...NODE_BUILTINS,
      ...NODE_BUILTINS.map((name) => `node:${name}`),
      'node:test',
    ]
      .map(escapeForPattern)
      .join('|');
    const pattern = new RegExp(
      `(?:from|import|require\\()\\s*\\(?\\s*['"](?:${specifiers})['"]`,
    );
    expect(offendingLines(pattern)).toStrictEqual([]);
  });

  it('uses no Node ambient global, which needs no import at all (AD-4)', () => {
    // The hole the import ban alone leaves wide open: `process.env`,
    // `Buffer.from`, `__dirname` and `require(...)` are all reachable with no
    // import statement to grep for, and every one of them breaks a browser
    // bundle exactly as hard as `import 'node:fs'` would.
    expect(
      offendingLines(/(^|[^A-Za-z0-9_$.])(process|Buffer|__dirname|__filename|require)\s*[.(]/),
    ).toStrictEqual([]);
  });

  it('never reaches into src/testing/, which is exempt from the AD-4 sweep', () => {
    // `src/testing/` holds the cross-process determinism child, which must
    // read `process.argv`. Both this file and the audit script exclude that
    // directory -- an exemption that is only safe while no shipped module
    // imports out of it.
    const offences: string[] = [];
    for (const { name, source } of shippedFiles()) {
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (match[1].includes('testing')) {
          offences.push(`${name}: ${match[1]}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });

  it('imports nothing outside this package except the frozen contracts (AD-1, AD-4)', () => {
    const bareImports: string[] = [];
    for (const { name, source } of shippedFiles()) {
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) {
          bareImports.push(`${name}: ${specifier}`);
        }
      }
    }
    // `@tokenbrawl/core` is deliberately absent: its barrel pulls in Ajv and
    // `node:crypto`, which would break AD-4 through the back door.
    expect([...new Set(bareImports.map((entry) => entry.split(': ')[1]))]).toStrictEqual([
      '@tokenbrawl/contracts',
    ]);
  });

  it('declares no module-level mutable binding that a PRNG could hide in (AC5)', () => {
    const offences: string[] = [];
    for (const { name, source } of shippedFiles()) {
      for (const { line, text } of codeLines(source)) {
        if (/^(let|var)\s/.test(text)) {
          offences.push(`${name}:${line}: ${text.trim()}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});
