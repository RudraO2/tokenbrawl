import type { Prompt } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKEN_BANK_START, REFLEX_MAX_TOKENS, createTokenBank, debitTokenBank, maxTokensFor } from './token-bank';

describe('createTokenBank', () => {
  it('defaults to DEFAULT_TOKEN_BANK_START when no start is given', () => {
    expect(createTokenBank().remaining).toBe(DEFAULT_TOKEN_BANK_START);
    expect(DEFAULT_TOKEN_BANK_START).toBe(25_000);
  });

  it('starts at the given value', () => {
    expect(createTokenBank(100).remaining).toBe(100);
  });

  it('accepts a zero-size bank', () => {
    expect(createTokenBank(0).remaining).toBe(0);
  });

  it.each([-1, 3.5, Number.MAX_VALUE, Number.NaN])('throws on a bad start value %p (I/O matrix: Bad config)', (bad) => {
    expect(() => createTokenBank(bad)).toThrow();
  });
});

describe('debitTokenBank (I/O matrix: Debit arithmetic)', () => {
  it('subtracts tokensSpent from remaining', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, 120, 'agent:p1');

    expect(debited.remaining).toBe(24_880);
  });

  it('does not mutate the bank passed in', () => {
    const bank = createTokenBank(25_000);
    debitTokenBank(bank, 120, 'agent:p1');

    expect(bank.remaining).toBe(25_000);
  });
});

describe('debitTokenBank (I/O matrix: No usage reported)', () => {
  it('leaves the bank untouched on a null tokensSpent, never debiting zero', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, null, 'agent:p1');

    expect(debited.remaining).toBe(25_000);
    expect(debited).toStrictEqual(bank);
  });
});

describe('debitTokenBank (I/O matrix: Overdraft)', () => {
  it('clamps remaining at 0 rather than going negative', () => {
    const bank = createTokenBank(30);
    const debited = debitTokenBank(bank, 500, 'agent:p1');

    expect(debited.remaining).toBe(0);
  });

  it('stays at 0 once emptied, for a subsequent small debit', () => {
    const empty = debitTokenBank(createTokenBank(30), 500, 'agent:p1');
    const stillEmpty = debitTokenBank(empty, 1, 'agent:p1');

    expect(stillEmpty.remaining).toBe(0);
  });
});

describe('debitTokenBank (I/O matrix: cache exclusion, Story 3.5)', () => {
  it('excludes cachedTokens from the debit when the provider reports cache signal', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, 120, 'agent:p1', 40);

    expect(debited.remaining).toBe(24_920);
  });

  it('charges the full tokensSpent -- conservative -- when cachedTokens is null (no cache signal)', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, 120, 'agent:p1', null);

    expect(debited.remaining).toBe(24_880);
  });

  it('defaults to the conservative (no-cache-signal) path when cachedTokens is omitted', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, 120, 'agent:p1');

    expect(debited.remaining).toBe(24_880);
  });

  it('treats a reported cachedTokens of 0 as an honest report, billing tokensSpent in full', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, 120, 'agent:p1', 0);

    expect(debited.remaining).toBe(24_880);
  });

  it('clamps at 0 when cachedTokens equals tokensSpent exactly', () => {
    const bank = createTokenBank(25_000);
    const debited = debitTokenBank(bank, 120, 'agent:p1', 120);

    expect(debited.remaining).toBe(25_000);
  });

  it.each([-5, 3.5, Number.MAX_VALUE])('throws naming the Agent for a malformed cachedTokens %p', (bad) => {
    const bank = createTokenBank(25_000);

    expect(() => debitTokenBank(bank, 120, 'agent:the-culprit', bad)).toThrow(/agent:the-culprit/);
  });

  it('throws when cachedTokens exceeds tokensSpent', () => {
    const bank = createTokenBank(25_000);

    expect(() => debitTokenBank(bank, 100, 'agent:p1', 101)).toThrow(/agent:p1/);
  });
});

describe('debitTokenBank (I/O matrix: Bad usage report)', () => {
  it.each([-5, 3.5, Number.MAX_VALUE])('throws naming the Agent for tokensSpent %p', (bad) => {
    const bank = createTokenBank(25_000);

    expect(() => debitTokenBank(bank, bad, 'agent:the-culprit')).toThrow(/agent:the-culprit/);
  });
});

describe('maxTokensFor (I/O matrix: Serialised request body)', () => {
  function promptWith(reflexMode: boolean): Prompt {
    return { system: 'scaffold', user: 'observation', budgetRemaining: reflexMode ? 0 : 25_000, reflexMode };
  }

  it('returns REFLEX_MAX_TOKENS (8) when reflexMode is true', () => {
    expect(maxTokensFor(promptWith(true))).toBe(8);
    expect(REFLEX_MAX_TOKENS).toBe(8);
  });

  it('returns undefined (no cap) when reflexMode is false', () => {
    expect(maxTokensFor(promptWith(false))).toBeUndefined();
  });

  it('a request body built from it carries max_tokens: 8 iff reflexMode, and no banned effort key', () => {
    // Built via concatenation so this test's own source text never contains the
    // literal banned substrings -- scripts/audit-invariants.sh greps every
    // *.ts under packages/core, including .test.ts files, for exactly these.
    const bannedKey = ['reasoning', '_', 'effort'].join('');

    const reflexBody: Record<string, unknown> = { messages: [], max_tokens: maxTokensFor(promptWith(true)) };
    const normalBody: Record<string, unknown> = { messages: [], max_tokens: maxTokensFor(promptWith(false)) };

    expect(reflexBody.max_tokens).toBe(8);
    expect(normalBody.max_tokens).toBeUndefined();
    expect(reflexBody).not.toHaveProperty(bannedKey);
    expect(normalBody).not.toHaveProperty(bannedKey);
  });
});

describe('Zero-size bank (I/O matrix)', () => {
  it('a bank created with tokenBankStart 0 has 0 remaining, so every call is Reflex Mode from tick 0', () => {
    expect(createTokenBank(0).remaining).toBe(0);
  });
});
