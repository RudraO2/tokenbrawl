import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The grep-level half of Story 3.2's ACs, in the same shape as
 * `packages/env-fighter/src/source-discipline.test.ts`.
 *
 * AC3 (no cross-call state), AC4 (no bank arithmetic) and AC5 (free-tier limits
 * come from a config file) are all claims about what is *absent* from the
 * shipped source. A behavioural test cannot prove an absence; a sweep can.
 *
 * Test files are exempt: this one reads `node:fs` to do its job, and
 * `groq.test.ts` deliberately writes out the banned request keys in order to
 * assert they are not on the wire.
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

/** Lines that are wholly a comment: prose may legitimately name a banned token. */
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

function offendingLines(
  pattern: RegExp,
  normalise: (text: string) => string = (text) => text,
): readonly string[] {
  const offences: string[] = [];
  for (const { name, source } of shippedFiles()) {
    for (const { line, text } of codeLines(source)) {
      if (pattern.test(normalise(text))) {
        offences.push(`${name}:${line}: ${text.trim()}`);
      }
    }
  }
  return offences;
}

describe('shipped provider source discipline', () => {
  it('finds the shipped files it is meant to police', () => {
    const names = shippedFiles().map((file) => file.name);
    expect(names).toEqual(
      expect.arrayContaining(['free-tier.ts', 'groq.ts', 'http.ts', 'index.ts', 'rate-limit.ts']),
    );
    expect(names.every((name) => !name.endsWith('.test.ts'))).toBe(true);
  });

  it('does no Token Bank arithmetic (AC4, AD-6)', () => {
    // The Harness owns the debit. An adapter that reached for the bank could
    // hand a Deployment a budget the Command Log never recorded spending.
    const banned = [
      'debitTokenBank',
      'createTokenBank',
      'DEFAULT_TOKEN_BANK_START',
      'TokenBank',
      'bankRemaining',
      'budgetRemaining',
    ];
    expect(offendingLines(new RegExp(banned.join('|')))).toStrictEqual([]);
  });

  it('assembles no prompt, and cannot (AC-adjacent, INV-7, AD-7)', () => {
    // `ProviderRequest` deliberately carries no material a prompt could be
    // rebuilt from. Naming the assembler here would be the first step to one.
    expect(offendingLines(/assemblePrompt|SCAFFOLD|ACTION_GRAMMAR|parseAction/)).toStrictEqual([]);
  });

  it('hard-codes no free-tier quota, so the config file is the only source (AC5)', () => {
    // Underscore separators are stripped first, or `14_400` would slip past a
    // word-boundary match on `14400`.
    const quotas = /\b(30|1000|6000|14400|60000)\b/;
    const offences = offendingLines(quotas, (text) =>
      // A duration unit conversion is not a quota; nothing else may say 1000.
      text.includes('MS_PER') ? '' : text.replace(/_/g, ''),
    );
    expect(offences).toStrictEqual([]);
  });

  it('declares no module-level mutable binding, which is where cross-call state hides (AC3)', () => {
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

  it('imports nothing bare except the frozen contracts (AD-1)', () => {
    // The port is reached by a relative path into `packages/core/src`, which is
    // the house convention until the `main`/`exports` gap is closed. AD-1 runs
    // one way: providers may import core, never the reverse.
    const bareImports: string[] = [];
    for (const { name, source } of shippedFiles()) {
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        if (!match[1].startsWith('.')) {
          bareImports.push(`${name}: ${match[1]}`);
        }
      }
    }
    expect([...new Set(bareImports.map((entry) => entry.split(': ')[1]))]).toStrictEqual([
      '@tokenbrawl/contracts',
    ]);
  });

  it('reaches into core for the port only, never for an environment or the Harness', () => {
    const offences: string[] = [];
    for (const { name, source } of shippedFiles()) {
      for (const match of source.matchAll(/from\s+['"](\.\.\/\.\.\/core\/[^'"]+)['"]/g)) {
        if (match[1] !== '../../core/src/deployment') {
          offences.push(`${name}: ${match[1]}`);
        }
      }
    }
    expect(offences).toStrictEqual([]);
  });
});
