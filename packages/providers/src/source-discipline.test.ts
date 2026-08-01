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
      // Two named exemptions, both *per-unit conversion factors* rather than
      // provider quotas -- the distinction this rule is actually about is
      // "a number a provider's plan decides", and neither of these is one.
      //
      //   MS_PER_*        a duration unit conversion (Story 3.2)
      //   *TOKENS_PER_CALL  how many tokens one Match call costs, which is a
      //                     property of this game's prompt, not of anyone's
      //                     free tier. Story 4.7 divides quotas *by* it to
      //                     work out whether a model can finish a Match at
      //                     all; putting it in free-tier.config.json would
      //                     file game data under provider data.
      //
      // Exempted by what they are, not by which file they are in: a bare
      // `1000` anywhere else still fails this.
      text.includes('MS_PER') || text.includes('TOKENS_PER_CALL')
        ? ''
        : text.replace(/_/g, ''),
    );
    expect(offences).toStrictEqual([]);
  });

  it('keeps the allowlist-free BYOK client out of the package surface (INV-8, Story 4.7)', () => {
    // The in-suite half of the exemption `scripts/audit-invariants.sh` grants
    // `byok-direct.ts`. Every other discipline rule in this repo is checked
    // twice, and this is the one whose failure mode is a tournament silently
    // acquiring the ability to call a paid endpoint.
    //
    // Not exporting it is what makes the file unreachable: `packages/providers`
    // is consumed through its index everywhere except `apps/web/src/byok/`,
    // which reaches in by relative path.
    const index = shippedFiles().find((file) => file.name === 'index.ts');
    expect(index).toBeDefined();
    expect(index?.source).not.toMatch(/from\s+'\.\/byok-direct'/);

    // And the factory it holds must still validate what it was given, even
    // though what it validates is not the allowlist.
    const direct = shippedFiles().find((file) => file.name === 'byok-direct.ts');
    expect(direct).toBeDefined();
    expect(direct?.source).toContain('assertVisitorSuppliedEndpoint');
    expect(direct?.source).toContain("protocol !== 'https:'");
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
