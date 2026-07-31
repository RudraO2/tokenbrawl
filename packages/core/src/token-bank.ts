import type { Prompt } from '@tokenbrawl/contracts';

/**
 * Story 1.5: the Token Bank (INV-4's positive half). Pure, integer-only,
 * per-Match accounting for one Agent's completion-token budget. `runMatch`
 * threads one `TokenBank` per Agent through the Decision-Point loop; nothing
 * here does I/O or reads a config value on its own.
 */

export const DEFAULT_TOKEN_BANK_START = 25_000;

/** `max_tokens` a Deployment call MUST be capped at once its bank is empty. One definition, shared by every provider adapter. */
export const REFLEX_MAX_TOKENS = 8;

export interface TokenBank {
  readonly remaining: number;
}

/**
 * Constructs a fresh bank. Throws on a negative or non-integer start rather
 * than clamping or truncating -- a bad config value is a caller bug, and
 * `runMatch` must fail before polling any Agent, not silently start one at
 * the wrong budget.
 */
export function createTokenBank(start: number = DEFAULT_TOKEN_BANK_START): TokenBank {
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new Error(`createTokenBank: tokenBankStart must be a non-negative integer, got ${start}`);
  }
  return { remaining: start };
}

/**
 * Debits `tokensSpent` from `bank`, clamped at 0 (the schema pins
 * `bankRemaining`'s `minimum: 0`; overdraft never goes negative).
 *
 * `tokensSpent === null` means the provider reported no usage at all -- a
 * Metering Probe result, not a free call -- so the bank is returned
 * untouched. Coercing `null` to `0` here would silently hand an unmetered
 * Deployment an infinite budget while the log still looked correct.
 *
 * `cachedTokens` (Story 3.5, AC4/AC5) is excluded from the debit when the
 * provider reported it: only `tokensSpent - cachedTokens` is billed. `null`
 * (the default) means the provider reported no cache signal at all, and the
 * debit stays conservative -- the full `tokensSpent` is charged, including
 * whatever was actually served from cache -- rather than guessing a hit rate
 * that was never reported.
 */
export function debitTokenBank(
  bank: TokenBank,
  tokensSpent: number | null,
  agentId: string,
  cachedTokens: number | null = null,
): TokenBank {
  if (tokensSpent === null) {
    return bank;
  }

  if (!Number.isSafeInteger(tokensSpent) || tokensSpent < 0) {
    throw new Error(`debitTokenBank: Agent "${agentId}" reported an invalid tokensSpent: ${tokensSpent}`);
  }

  let billable = tokensSpent;
  if (cachedTokens !== null) {
    if (!Number.isSafeInteger(cachedTokens) || cachedTokens < 0 || cachedTokens > tokensSpent) {
      throw new Error(`debitTokenBank: Agent "${agentId}" reported an invalid cachedTokens: ${cachedTokens}`);
    }
    billable = tokensSpent - cachedTokens;
  }

  return { remaining: Math.max(0, bank.remaining - billable) };
}

/**
 * The `max_tokens` a request body should carry for this Prompt, per INV-4's
 * positive half: `8` once Reflex Mode has engaged, and no cap otherwise
 * (`undefined` -- never send a `reasoning_effort`/`thinking_budget`
 * substitute in the non-reflex case either). Every provider adapter in E3
 * routes through this instead of re-deriving `8` on its own.
 */
export function maxTokensFor(prompt: Prompt): number | undefined {
  return prompt.reflexMode ? REFLEX_MAX_TOKENS : undefined;
}
