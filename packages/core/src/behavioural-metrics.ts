/**
 * Story 7-3: how a Deployment spent its thinking, not only whether it won.
 *
 * Four numbers per Agent -- tokens per Match, reasoning-token share,
 * parse-failure rate, bank-exhaustion rate -- read off the committed Command
 * Logs. Every input already exists in the frozen schema; nothing here needed a
 * contract change.
 *
 * ## `null` is the type of "not reported"
 *
 * This is the whole reason the module exists rather than being four reductions
 * inside the report builder. INV-5 turns on one distinction: a provider that
 * never reported reasoning tokens is a different fact from a provider that
 * reported zero of them, and collapsing the two is how an unmetered Deployment
 * ends up looking frugal. The frozen contract already carries the distinction
 * (`reasoningTokens` absent or `null` is silence; `0` is a report), and
 * `match-runner.ts` writes it through unchanged, so it survives to disk. It
 * survives to the reader here by being `number | null` all the way to the
 * renderer, which prints the words rather than a digit.
 *
 * A Baseline Bot is three-quarters not-reported by construction: it consumes
 * nothing, so `match-runner.ts` omits all four banking fields rather than
 * writing zeroes, and "cannot consume" stays distinguishable from "consumed
 * nothing". The parse-failure rate is the metric a silent provider cannot
 * suppress -- a Decision Point either yielded a legal Action or it did not,
 * which is observable without the provider's cooperation -- so it is `null`
 * only when the corpus recorded no Decision Point for that Agent at all.
 *
 * ## Integer arithmetic only
 *
 * Every rate is integer basis points (10000 = 1.0000), for the reason
 * `statistics.ts` sets out at length: `scripts/audit-invariants.sh` bans a
 * floating-point literal anywhere under `packages/core`, and a published number
 * that reproduces bit-for-bit on every machine is the only kind worth
 * committing. Means are floored, never rounded.
 */

import type { CommandLog, DecisionEntry } from '@tokenbrawl/contracts';
import { BASIS_POINTS_SCALE } from './statistics';

export interface AgentBehaviour {
  readonly agent: string;
  readonly kind: 'deployment' | 'bot';
  /** Matches in this corpus the Agent played. */
  readonly matches: number;
  /** Decision Points it was polled at, across those Matches. */
  readonly decisions: number;

  /** Completion tokens reported, summed. `null` when none ever were. */
  readonly tokensSpent: number | null;
  /** Denominator of `tokensPerMatch`: Matches with at least one reported usage. */
  readonly matchesReportingUsage: number;
  /** `floor(tokensSpent / matchesReportingUsage)`, or `null` when not reported. */
  readonly tokensPerMatch: number | null;

  /** Reasoning tokens reported, summed. `null` when none ever were. */
  readonly reasoningTokens: number | null;
  /**
   * Reasoning tokens as a share of the completion tokens reported *alongside
   * them* -- only Decisions that reported both are in either half, so the share
   * can never exceed 1 through a mismatched denominator. `null` is
   * not-reported, and is never to be rendered as zero (INV-5).
   */
  readonly reasoningShareBasisPoints: number | null;

  /** Every Decision Point that took the Fallback Action, whatever the cause. */
  readonly parseFailures: number;
  /** The subset whose raw response is a recognisable provider rate-limit refusal. */
  readonly rateLimited: number;
  /** The rest: text the Action grammar could not read. */
  readonly grammarFailures: number;
  /**
   * `null` only when no Decision Point was observed at all -- never merely
   * because a provider stayed silent. Whether a Decision parsed is observable
   * without the provider's cooperation, so a Deployment that was polled has a
   * rate whatever its adapter reported; a corpus that recorded no Decisions has
   * measured nothing, and saying so beats printing a zero.
   */
  readonly parseFailureRateBasisPoints: number | null;
  readonly grammarFailureRateBasisPoints: number | null;
  readonly rateLimitedRateBasisPoints: number | null;

  /** Matches in which any Decision carried Token Bank state. */
  readonly matchesReportingBank: number;
  /** Of those, the ones in which the bank reached zero. */
  readonly bankExhaustedMatches: number;
  /** `null` when no Match reported bank state at all -- a Bot, or an unmetered corpus. */
  readonly bankExhaustionRateBasisPoints: number | null;
}

/**
 * The error codes a provider uses to say "you are over your quota".
 *
 * Read off the bodies this repo has actually recorded: Groq and Cerebras send
 * OpenAI-shaped `error.code: "rate_limit_exceeded"`, Google sends
 * `error.status: "RESOURCE_EXHAUSTED"`, and an HTTP status echoed into the body
 * is `429`. `packages/providers/src/rate-limit-recognition.test.ts` runs each
 * adapter's own recorded refusal through the recogniser below, so a provider
 * vocabulary this list does not know about fails there rather than silently
 * inflating a grammar-failure rate here.
 */
const RATE_LIMIT_CODES: readonly string[] = [
  'rate_limit_exceeded',
  'resource_exhausted',
  'too_many_requests',
  'rate_limit',
  '429',
];

function codeOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

/**
 * Whether this raw response is a provider rate-limit refusal rather than model
 * text the Action grammar could not read.
 *
 * A rate-limited Decision Point is indistinguishable from a grammar Parse
 * Failure in a Command Log -- `DecisionEntry` is frozen and carries no
 * discriminator, so `runMatch` records a 429 exactly as it records unparseable
 * prose. Story 3.2 kept the provider's body verbatim in `rawResponse` precisely
 * so the fact would survive to disk; this reads it back.
 *
 * Deliberately structural and deliberately narrow. It parses the body as JSON
 * and consults `error.code`, `error.type` and `error.status` only -- it never
 * scans prose, because a model that writes "rate limit" in its reasoning would
 * otherwise have a real grammar failure reclassified as somebody else's fault,
 * and that is the direction of error that flatters a Deployment.
 *
 * It is a recogniser over a frozen field, not a re-derivation of
 * `packages/providers`' rate-limit logic: AD-1 runs one way and `packages/core`
 * may not import an adapter.
 */
export function isRateLimitedResponse(rawResponse: string | null | undefined): boolean {
  if (typeof rawResponse !== 'string' || rawResponse.length === 0) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    // Model text is not JSON, and a 429 body that is not JSON has nothing
    // structural left to read. Either way this is not a recognisable refusal.
    return false;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return false;
  }
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const fields = error as Record<string, unknown>;
  for (const key of ['code', 'type', 'status'] as const) {
    const code = codeOf(fields[key]);
    if (code !== null && RATE_LIMIT_CODES.includes(code)) {
      return true;
    }
  }
  return false;
}

/**
 * A reported token count has to be a non-negative safe integer before it can be
 * summed. The canonical hasher makes that a rule about simulation state; here it
 * is a rule about a published number, and the reason is the same -- a float or a
 * negative that reached this sum would produce an arithmetic result nobody could
 * reproduce or interpret.
 */
function assertCount(value: number, field: string, matchId: string, agentId: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `computeBehaviouralMetrics: Match "${matchId}" reports ${field} ${String(value)} for "${agentId}", which is not a non-negative integer.`,
    );
  }
}

/** `numerator / denominator` as integer basis points, floored. `0` on an empty denominator. */
function rateBasisPoints(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Math.floor((numerator * BASIS_POINTS_SCALE) / denominator);
}

interface Accumulator {
  readonly agent: string;
  kind: 'deployment' | 'bot';
  matches: number;
  decisions: number;
  tokensSpent: number;
  reportedUsage: number;
  matchesReportingUsage: number;
  reasoningTokens: number;
  /** Tokens reported by the same Decisions that reported reasoning tokens. */
  reasoningDenominator: number;
  reportedReasoning: number;
  parseFailures: number;
  rateLimited: number;
  matchesReportingBank: number;
  bankExhaustedMatches: number;
}

function accumulator(agent: string, kind: 'deployment' | 'bot'): Accumulator {
  return {
    agent,
    kind,
    matches: 0,
    decisions: 0,
    tokensSpent: 0,
    reportedUsage: 0,
    matchesReportingUsage: 0,
    reasoningTokens: 0,
    reasoningDenominator: 0,
    reportedReasoning: 0,
    parseFailures: 0,
    rateLimited: 0,
    matchesReportingBank: 0,
    bankExhaustedMatches: 0,
  };
}

/**
 * Whether this entry reached the bottom of the Token Bank.
 *
 * Two signals, and both are wanted. `reflexMode` is the bank's state when the
 * Agent was *polled* -- true means it entered this Decision Point with nothing
 * left. `bankRemaining` is the state after the debit -- zero means this
 * Decision Point is the one that emptied it. Reading only the first would miss
 * the Match that exhausted its bank on the very last Decision Point; reading
 * only the second would miss nothing today but would start to the moment a
 * Match's final call reports no usage.
 */
function exhausted(entry: DecisionEntry): boolean {
  return entry.reflexMode === true || entry.bankRemaining === 0;
}

/** Whether this entry carries Token Bank state at all (a Deployment's does; a Bot's does not). */
function reportsBank(entry: DecisionEntry): boolean {
  return entry.bankRemaining !== undefined || entry.reflexMode !== undefined;
}

/**
 * The all-`null` record for an Agent that appears on the leaderboard but in no
 * log this corpus carries -- a Baseline Bot ladder rated from Match outcomes
 * alone, for instance. Every count is zero and every reported quantity is
 * `null`: nothing was measured, which is a statement, not a zero.
 */
export function unreportedBehaviour(agent: string, kind: 'deployment' | 'bot'): AgentBehaviour {
  return Object.freeze({
    agent,
    kind,
    matches: 0,
    decisions: 0,
    tokensSpent: null,
    matchesReportingUsage: 0,
    tokensPerMatch: null,
    reasoningTokens: null,
    reasoningShareBasisPoints: null,
    parseFailures: 0,
    rateLimited: 0,
    grammarFailures: 0,
    parseFailureRateBasisPoints: null,
    grammarFailureRateBasisPoints: null,
    rateLimitedRateBasisPoints: null,
    matchesReportingBank: 0,
    bankExhaustedMatches: 0,
    bankExhaustionRateBasisPoints: null,
  });
}

/**
 * One `AgentBehaviour` per Agent appearing in `logs`, sorted by Agent id.
 *
 * Code-unit ordering rather than `localeCompare`, for the reason
 * `pairing-coverage.ts` gives: a committed artefact whose row order depended on
 * the runner's ICU collation data would diff against itself between machines.
 *
 * The caller decides which logs are in scope. `packages/cli/src/leaderboard.ts`
 * passes only the Matches that were actually rated, so every behavioural number
 * describes the same Matches as the rating printed beside it -- and a BYOK
 * Match, already excluded from the rating (AD-11), is excluded from these too.
 */
export function computeBehaviouralMetrics(
  logs: readonly CommandLog[],
): readonly AgentBehaviour[] {
  const accumulators = new Map<string, Accumulator>();

  // One Match, one contribution, for the reason `computeLeaderboard` refuses a
  // duplicate `matchId`: AD-8 derives that id from (environment, seed,
  // configHash, agent ids), so two documents carrying one is the same Match
  // twice. Here it would double a token total and halve a Match-denominated
  // rate. The two functions are called together today, but this one is exported
  // on its own, and a guard that lives only in the caller is a guard the next
  // caller does not get.
  const identifiers = new Set<string>();
  for (const log of logs) {
    if (identifiers.has(log.matchId)) {
      throw new Error(
        `computeBehaviouralMetrics: matchId "${log.matchId}" appears twice. One Match may contribute to a metric once.`,
      );
    }
    identifiers.add(log.matchId);
  }

  for (const log of logs) {
    // Per-Match state, so "how many Matches exhausted the bank" is a count of
    // Matches rather than of Decision Points.
    const usageInMatch = new Set<string>();
    const bankInMatch = new Set<string>();
    const exhaustedInMatch = new Set<string>();

    if (log.agents[0].id === log.agents[1].id) {
      throw new Error(
        `computeBehaviouralMetrics: Match "${log.matchId}" pairs "${log.agents[0].id}" with itself, so its Decisions belong to no distinguishable Agent.`,
      );
    }

    for (const identity of log.agents) {
      const existing = accumulators.get(identity.id);
      if (existing !== undefined && existing.kind !== identity.kind) {
        throw new Error(
          `computeBehaviouralMetrics: "${identity.id}" appears as both a ${existing.kind} and a ${identity.kind}. One id is one entrant (INV-6).`,
        );
      }
      const entry = existing ?? accumulator(identity.id, identity.kind);
      accumulators.set(identity.id, entry);
      entry.matches += 1;
    }

    for (const decision of log.decisions) {
      const identity = log.agents[decision.agentIndex];
      if (identity === undefined) {
        throw new Error(
          `computeBehaviouralMetrics: Match "${log.matchId}" has a decision for agentIndex ${String(decision.agentIndex)}, which names no Agent.`,
        );
      }
      const entry = accumulators.get(identity.id);
      if (entry === undefined) {
        throw new Error(
          `computeBehaviouralMetrics: no accumulator for "${identity.id}", which cannot happen`,
        );
      }

      entry.decisions += 1;

      // `undefined` (field never written) and `null` (provider reported no
      // usage) are the same statement -- nothing was reported -- and neither
      // may become a zero. `0` is a report and counts as one.
      const tokens = decision.tokensSpent;
      if (typeof tokens === 'number') {
        assertCount(tokens, 'tokensSpent', log.matchId, identity.id);
        entry.tokensSpent += tokens;
        entry.reportedUsage += 1;
        usageInMatch.add(identity.id);
      }

      const reasoning = decision.reasoningTokens;
      if (typeof reasoning === 'number') {
        assertCount(reasoning, 'reasoningTokens', log.matchId, identity.id);
        // The frozen contract says `tokensSpent` is "completion tokens actually
        // consumed, **including** reasoning tokens where the provider reports
        // them", so a reasoning count above it is a broken adapter, not a
        // surprising model. Refused loudly rather than published as a share
        // above 1, which a reader would have no way to interpret.
        if (typeof tokens === 'number' && reasoning > tokens) {
          throw new Error(
            `computeBehaviouralMetrics: Match "${log.matchId}" reports ${String(reasoning)} reasoning tokens for "${identity.id}" out of ${String(tokens)} completion tokens, which cannot be a share.`,
          );
        }
        entry.reasoningTokens += reasoning;
        entry.reportedReasoning += 1;
        // Only tokens reported by the *same* Decision, so the share has a
        // denominator its numerator actually came out of.
        if (typeof tokens === 'number') {
          entry.reasoningDenominator += tokens;
        }
      }

      if (decision.parseFailure === true) {
        entry.parseFailures += 1;
        if (isRateLimitedResponse(decision.rawResponse)) {
          entry.rateLimited += 1;
        }
      }

      if (reportsBank(decision)) {
        bankInMatch.add(identity.id);
        if (exhausted(decision)) {
          exhaustedInMatch.add(identity.id);
        }
      }
    }

    for (const id of usageInMatch) {
      const entry = accumulators.get(id);
      if (entry !== undefined) {
        entry.matchesReportingUsage += 1;
      }
    }
    for (const id of bankInMatch) {
      const entry = accumulators.get(id);
      if (entry !== undefined) {
        entry.matchesReportingBank += 1;
      }
    }
    for (const id of exhaustedInMatch) {
      const entry = accumulators.get(id);
      if (entry !== undefined) {
        entry.bankExhaustedMatches += 1;
      }
    }
  }

  return Object.freeze(
    [...accumulators.values()]
      .sort((left, right) => (left.agent === right.agent ? 0 : left.agent < right.agent ? -1 : 1))
      .map((entry) => {
        const grammarFailures = entry.parseFailures - entry.rateLimited;
        return Object.freeze({
          agent: entry.agent,
          kind: entry.kind,
          matches: entry.matches,
          decisions: entry.decisions,
          tokensSpent: entry.reportedUsage === 0 ? null : entry.tokensSpent,
          matchesReportingUsage: entry.matchesReportingUsage,
          tokensPerMatch:
            entry.matchesReportingUsage === 0
              ? null
              : Math.floor(entry.tokensSpent / entry.matchesReportingUsage),
          reasoningTokens: entry.reportedReasoning === 0 ? null : entry.reasoningTokens,
          // Not-reported covers both silences: a provider that never reported
          // reasoning tokens, and one that reported them beside no completion
          // count at all. A share with no denominator is not a zero share, and
          // rendering it as one is exactly what INV-5 forbids.
          reasoningShareBasisPoints:
            entry.reportedReasoning === 0 || entry.reasoningDenominator === 0
              ? null
              : rateBasisPoints(entry.reasoningTokens, entry.reasoningDenominator),
          parseFailures: entry.parseFailures,
          rateLimited: entry.rateLimited,
          grammarFailures,
          parseFailureRateBasisPoints:
            entry.decisions === 0 ? null : rateBasisPoints(entry.parseFailures, entry.decisions),
          grammarFailureRateBasisPoints:
            entry.decisions === 0 ? null : rateBasisPoints(grammarFailures, entry.decisions),
          rateLimitedRateBasisPoints:
            entry.decisions === 0 ? null : rateBasisPoints(entry.rateLimited, entry.decisions),
          matchesReportingBank: entry.matchesReportingBank,
          bankExhaustedMatches: entry.bankExhaustedMatches,
          bankExhaustionRateBasisPoints:
            entry.matchesReportingBank === 0
              ? null
              : rateBasisPoints(entry.bankExhaustedMatches, entry.matchesReportingBank),
        });
      }),
  ) as readonly AgentBehaviour[];
}
