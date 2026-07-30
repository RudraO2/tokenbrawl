import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {
  assertSchemaVersion,
  SCHEMA_VERSION,
  type AgentIdentity,
  type CommandLog,
  type DecisionEntry,
} from '@tokenbrawl/contracts';
import commandLogSchema from '../../../docs/contracts/command-log.schema.json';
import { canonicalSha256 } from './canonical-hash';
import type { MatchResult } from './match-runner';

/**
 * One Ajv instance/compiled validator, module-scoped and reused across every
 * call -- compiling a JSON Schema is not free, and this module's schema
 * never changes at runtime (it is frozen, per this story's standing rule).
 *
 * `Ajv2020`, not the default `Ajv` export: the schema's `$schema` is
 * `https://json-schema.org/draft/2020-12/schema`, and Ajv's default export
 * only understands draft-07. Using the wrong entry point would silently
 * mis-validate `if`/`then`/`$defs` instead of failing loud, which would make
 * the Parse-Failure conditional validate incorrectly rather than error out.
 */
// `strictRequired: false`, not a blanket `strict: false`: Ajv's strict mode
// additionally lints for a `required` referencing a property declared in
// the parent schema's `properties` rather than the local `if`/`then` block
// -- exactly the composition pattern the frozen schema's Parse-Failure
// conditional legitimately uses. Disabling only `strictRequired` keeps every
// other strict-mode protection (banned keywords, type-narrowing checks,
// etc.) intact instead of turning strict mode off wholesale.
const ajv = new Ajv2020({ allErrors: true, strictRequired: false });
// `deployment.endpoint`'s `format: "uri"` is otherwise an unrecognised
// keyword to Ajv's core (format plugins are opt-in) and strict mode treats
// an unrecognised format as a compile-time error, not a silent skip.
addFormats(ajv);
const validate = ajv.compile(commandLogSchema);

export type ComputeMatchIdParams = {
  readonly environmentId: string;
  readonly seed: number;
  readonly configHash: string;
  readonly agentIds: readonly [string, string];
};

/**
 * SHA-256 over the canonical serialisation of every parameter that can
 * affect simulation outcome. Routes through `canonicalSha256` (AD-8) rather
 * than hashing directly, so this and `computeMatchId` can never diverge on
 * key order or float handling.
 */
export function computeConfigHash(config: unknown): string {
  return canonicalSha256(config);
}

/**
 * Derived deterministically from (environment, seed, configHash, agent ids)
 * so the same Match always produces the same id. The 64-char lowercase hex
 * digest a SHA-256 always produces already satisfies the schema's `matchId`
 * pattern (`^[a-z0-9-]{8,64}$`), so no further encoding is needed.
 */
export function computeMatchId(params: ComputeMatchIdParams): string {
  return canonicalSha256({
    environmentId: params.environmentId,
    seed: params.seed,
    configHash: params.configHash,
    agentIds: params.agentIds,
  });
}

export interface BuildCommandLogParams {
  readonly environment: { readonly id: string; readonly version: string };
  readonly seed: number;
  readonly configHash: string;
  readonly agents: readonly [AgentIdentity, AgentIdentity];
  readonly tokenBankStart?: number;
  readonly reasoningSidecar?: string | null;
}

/**
 * Omits every optional key whose source value is `undefined` rather than
 * assigning it -- Ajv's `additionalProperties: false` treats an
 * explicitly-`undefined`-valued key as present and fails the document, so
 * `{ tokensSpent: x ?? undefined }` would still break validation even though
 * `x` was genuinely absent. `null` is a legitimate value for `reasoning` and
 * `rawResponse` (the schema types them `["string","null"]`) and is kept.
 */
function toDecisionEntry(
  entry: MatchResult['decisions'][number],
): DecisionEntry | null {
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
 * Builds a schema-conformant `CommandLog` from a `MatchResult` (Story 1.2's
 * output) plus the metadata a Match needs to be identified and replayed.
 * Self-validates before returning: AC1 treats "write" and "validate" as one
 * atomic step, so this function must never hand a caller a log that would
 * fail its own schema.
 */
export function buildCommandLog(matchResult: MatchResult, params: BuildCommandLogParams): CommandLog {
  const matchId = computeMatchId({
    environmentId: params.environment.id,
    seed: params.seed,
    configHash: params.configHash,
    agentIds: [params.agents[0].id, params.agents[1].id],
  });

  const decisions = matchResult.decisions
    .map((entry) => toDecisionEntry(entry))
    .filter((entry): entry is DecisionEntry => entry !== null);

  const candidate: CommandLog = {
    schemaVersion: SCHEMA_VERSION,
    matchId,
    environment: params.environment,
    seed: params.seed,
    configHash: params.configHash,
    ...(params.tokenBankStart !== undefined ? { tokenBankStart: params.tokenBankStart } : {}),
    agents: params.agents,
    decisions,
    result: matchResult.result,
    finalStateHash: matchResult.finalStateHash,
    ...(params.reasoningSidecar !== undefined ? { reasoningSidecar: params.reasoningSidecar } : {}),
  };

  return validateCommandLog(candidate);
}

/**
 * Validates and returns an untrusted candidate as a `CommandLog`.
 * `schemaVersion` is checked via the frozen `assertSchemaVersion` BEFORE Ajv
 * ever runs, so an unknown version is always a hard fail with zero partial
 * parsing -- never a document that got read halfway through before its
 * version turned out to be unsupported.
 */
export function validateCommandLog(candidate: unknown): CommandLog {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(`validateCommandLog: expected an object, got ${typeof candidate}`);
  }

  assertSchemaVersion(candidate as { schemaVersion?: unknown });

  if (!validate(candidate)) {
    throw new Error(`validateCommandLog: schema validation failed: ${ajv.errorsText(validate.errors)}`);
  }

  return candidate as unknown as CommandLog;
}
