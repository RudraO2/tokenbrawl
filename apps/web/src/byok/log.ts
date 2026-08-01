import {
  SCHEMA_VERSION,
  type AgentIdentity,
  type CommandLog,
  type DecisionEntry,
} from '@tokenbrawl/contracts';
import { canonicalStringify } from '../../../../packages/env-fighter/src/canonical';
import { sha256Hex } from '../../../../packages/env-fighter/src/sha256';
import type { MatchResult } from '../../../../packages/core/src/match-runner';

/**
 * Story 4.6: a Command Log, built in the tab.
 *
 * `packages/core`'s `buildCommandLog` cannot be used here and the constraint is
 * old news -- Story 4.2 hit it, 4.5 restated it, and `source-discipline.test.ts`
 * gates it: `command-log.ts` reaches `node:crypto` through `canonical-hash.ts`
 * and pulls in Ajv, Vite externalises `node:crypto`, and the page dies on load
 * with the entire suite still green.
 *
 * The way out is not a third canonicaliser. `packages/env-fighter` already
 * carries a pure-TypeScript `sha256Hex` and a `canonicalStringify` that mirrors
 * core's discipline exactly, *because AD-4 forced that package to run in a
 * browser unmodified* -- the same requirement, met once, two epics earlier. So
 * this module composes those two into the same two hashes core computes, and
 * `log.test.ts` asserts the values agree with `computeMatchId` and
 * `computeConfigHash` rather than merely looking plausible. If they ever
 * diverge, a BYOK log and a CI log of the same Match would carry different
 * `matchId`s, which is the kind of drift that is invisible until two datasets
 * are joined.
 *
 * Schema validation is deliberately *not* done here: Ajv is the other half of
 * what cannot be bundled. `log.test.ts` runs the real `validateCommandLog` over
 * a log this function produced, so AC4's "valid Command Log" is asserted
 * against the frozen schema in CI, where the validator can run.
 */

export interface ByokMatchIdParams {
  readonly environmentId: string;
  readonly seed: number;
  readonly configHash: string;
  readonly agentIds: readonly [string, string];
}

/** SHA-256 over the canonical serialisation of every parameter that can affect outcome. */
export function byokConfigHash(config: unknown): string {
  return sha256Hex(canonicalStringify(config));
}

/**
 * The same derivation `computeMatchId` performs: same field names, same key
 * order (sorted by the canonicaliser, never written by hand), same digest. The
 * 64-char lowercase hex satisfies the schema's `^[a-z0-9-]{8,64}$` with no
 * further encoding.
 */
export function byokMatchId(params: ByokMatchIdParams): string {
  return byokConfigHash({
    environmentId: params.environmentId,
    seed: params.seed,
    configHash: params.configHash,
    agentIds: params.agentIds,
  });
}

export interface ByokLogParams {
  readonly environment: { readonly id: string; readonly version: string };
  readonly seed: number;
  readonly configHash: string;
  readonly agents: readonly [AgentIdentity, AgentIdentity];
  readonly tokenBankStart?: number;
}

/**
 * One `MatchResult` entry as a schema-conformant `DecisionEntry`, or `null` for
 * a Decision Point at which this Agent was inside a Commitment Window and was
 * never polled.
 *
 * Every optional key whose value is `undefined` is *omitted* rather than
 * assigned. Ajv's `additionalProperties: false` counts an explicitly-undefined
 * key as present and fails the document, so `{ tokensSpent: x ?? undefined }`
 * would produce a log that fails its own schema. `null` is kept where the
 * schema types it -- `tokensSpent: null` is a Metering Probe result and
 * collapsing it to `0` would break INV-5 (Story 1.3 made the same choice, for
 * the same reason).
 *
 * `cachedTokens` is dropped: it rides on the in-memory `MatchResult` so
 * `runMatch` can debit the Token Bank conservatively (Story 3.5), and the
 * frozen schema has no field for it.
 */
function toDecisionEntry(entry: MatchResult['decisions'][number]): DecisionEntry | null {
  if (entry.action == null) {
    return null;
  }

  return {
    tick: entry.tick,
    agentIndex: entry.agentIndex,
    action: entry.action,
    ...(entry.tokensSpent !== undefined ? { tokensSpent: entry.tokensSpent } : {}),
    ...(entry.reasoningTokens !== undefined ? { reasoningTokens: entry.reasoningTokens } : {}),
    ...(entry.bankRemaining !== undefined ? { bankRemaining: entry.bankRemaining } : {}),
    ...(entry.reflexMode !== undefined ? { reflexMode: entry.reflexMode } : {}),
    ...(entry.parseFailure !== undefined ? { parseFailure: entry.parseFailure } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.rawResponse !== undefined ? { rawResponse: entry.rawResponse } : {}),
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    ...(entry.endpoint !== undefined ? { endpoint: entry.endpoint } : {}),
  };
}

/**
 * Assembles the log.
 *
 * The reasoning stays inline on the decision entries rather than being split
 * into a sidecar (AD-10). A sidecar exists so a *fetched* log can start a fight
 * before the text arrives; this log was produced in the tab and its reasoning is
 * already in memory, so a split would mean writing a second document that has
 * nowhere to be written to. `createReasoningSource` reads inline reasoning
 * natively -- that is its `'inline'` status.
 */
export function buildByokCommandLog(match: MatchResult, params: ByokLogParams): CommandLog {
  const decisions = match.decisions
    .map((entry) => toDecisionEntry(entry))
    .filter((entry): entry is DecisionEntry => entry !== null);

  const tokenBankStart = params.tokenBankStart ?? match.tokenBankStart;
  const hasDeployment = params.agents.some((agent) => agent.kind === 'deployment');

  return {
    schemaVersion: SCHEMA_VERSION,
    matchId: byokMatchId({
      environmentId: params.environment.id,
      seed: params.seed,
      configHash: params.configHash,
      agentIds: [params.agents[0].id, params.agents[1].id],
    }),
    environment: params.environment,
    seed: params.seed,
    configHash: params.configHash,
    ...(hasDeployment && tokenBankStart !== undefined ? { tokenBankStart } : {}),
    agents: params.agents,
    decisions,
    result: match.result,
    finalStateHash: match.finalStateHash,
  };
}
