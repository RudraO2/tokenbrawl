import {
  SCHEMA_VERSION_V2,
  type AgentIdentityV2,
  type CommandLogV2,
  type DecisionEntryV2,
} from '@tokenbrawl/contracts';
import { canonicalStringify } from '../../../../packages/env-fighter/src/canonical';
import { sha256Hex } from '../../../../packages/env-fighter/src/sha256';
import type { MatchResult } from '../../../../packages/core/src/match-runner';

/**
 * Story 9.2: a v2 Command Log, built in the tab.
 *
 * A close mirror of `byok/log.ts`'s `buildByokCommandLog` -- same reason
 * `packages/core`'s `buildCommandLog` cannot be used here (it reaches
 * `node:crypto` through `canonical-hash.ts` and pulls in Ajv), same fix
 * (`packages/env-fighter`'s pure-TypeScript `sha256Hex`/`canonicalStringify`,
 * which already has to run in a browser for AD-4). The one real difference is
 * the schema: this module writes `SCHEMA_VERSION_V2`/`AgentIdentityV2`/
 * `DecisionEntryV2`/`CommandLogV2`, because a Match with a `'human'` Agent has
 * nowhere to go in the frozen v1 shape (`AgentIdentity.kind` is
 * `'deployment' | 'bot'` only).
 *
 * Schema validation is deliberately not done here, for the same reason as
 * `byok/log.ts`: Ajv cannot be bundled. `log.test.ts` runs the real
 * `validateCommandLogV2` over a log this function produced.
 */

export interface ArcadeMatchIdParams {
  readonly environmentId: string;
  readonly seed: number;
  readonly configHash: string;
  readonly agentIds: readonly [string, string];
}

/** SHA-256 over the canonical serialisation of every parameter that can affect outcome. */
export function arcadeConfigHash(config: unknown): string {
  return sha256Hex(canonicalStringify(config));
}

/** Same derivation as `computeMatchId`/`byokMatchId`: same field names, same key order. */
export function arcadeMatchId(params: ArcadeMatchIdParams): string {
  return arcadeConfigHash({
    environmentId: params.environmentId,
    seed: params.seed,
    configHash: params.configHash,
    agentIds: params.agentIds,
  });
}

export interface ArcadeLogParams {
  readonly environment: { readonly id: string; readonly version: string };
  readonly seed: number;
  readonly configHash: string;
  readonly agents: readonly [AgentIdentityV2, AgentIdentityV2];
  readonly tokenBankStart?: number;
}

/**
 * One `MatchResult` entry as a schema-conformant `DecisionEntryV2`, or `null`
 * for a Decision Point at which this Agent was inside a Commitment Window and
 * was never polled.
 *
 * Token fields (`tokensSpent`/`reasoningTokens`/`bankRemaining`/`reflexMode`)
 * are written only when the entry's own Agent is `kind: 'deployment'` --
 * never for the human side and never for the Baseline Bot, mirroring
 * `hasDeployment`-style gating elsewhere: neither consumes a Token Bank, so
 * all four stay absent rather than being derived from a zero value.
 */
function toDecisionEntry(
  entry: MatchResult['decisions'][number],
  agents: readonly [AgentIdentityV2, AgentIdentityV2],
): DecisionEntryV2 | null {
  if (entry.action == null) {
    return null;
  }

  // `agentIndex` comes off a `MatchResult` produced by `runMatch`, which
  // should only ever emit 0 or 1 for a two-Agent Match. Bounds-checked here,
  // before it is used to index `agents`, rather than trusting it: an
  // out-of-range index would otherwise silently read `undefined.kind`
  // (P6), throwing an unhelpful TypeError deep inside `.map()` instead of
  // this clear, descriptive one.
  if (entry.agentIndex !== 0 && entry.agentIndex !== 1) {
    throw new Error(
      `toDecisionEntry: agentIndex ${String(entry.agentIndex)} is out of range for a two-Agent Match.`,
    );
  }

  const agentKind = agents[entry.agentIndex].kind;
  const metered = agentKind === 'deployment';

  return {
    tick: entry.tick,
    agentIndex: entry.agentIndex,
    action: entry.action,
    ...(metered && entry.tokensSpent !== undefined ? { tokensSpent: entry.tokensSpent } : {}),
    ...(metered && entry.reasoningTokens !== undefined
      ? { reasoningTokens: entry.reasoningTokens }
      : {}),
    ...(metered && entry.bankRemaining !== undefined ? { bankRemaining: entry.bankRemaining } : {}),
    ...(metered && entry.reflexMode !== undefined ? { reflexMode: entry.reflexMode } : {}),
    ...(entry.parseFailure !== undefined ? { parseFailure: entry.parseFailure } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.rawResponse !== undefined ? { rawResponse: entry.rawResponse } : {}),
    ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
    ...(entry.endpoint !== undefined ? { endpoint: entry.endpoint } : {}),
  };
}

/** Assembles a v2 Command Log for a Human-vs-Baseline-Bot arcade Match. */
export function buildArcadeCommandLog(match: MatchResult, params: ArcadeLogParams): CommandLogV2 {
  const decisions = match.decisions
    .map((entry) => toDecisionEntry(entry, params.agents))
    .filter((entry): entry is DecisionEntryV2 => entry !== null);

  const tokenBankStart = params.tokenBankStart ?? match.tokenBankStart;
  const hasDeployment = params.agents.some((agent) => agent.kind === 'deployment');

  return {
    schemaVersion: SCHEMA_VERSION_V2,
    matchId: arcadeMatchId({
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
