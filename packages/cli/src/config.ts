import type { ProviderId } from '@tokenbrawl/contracts';
import { validateTournamentConfig } from '../../providers/src/tournament-config';
import type { CliIo } from './io';

/**
 * The run config: a JSON file describing who fights and over which seeds.
 *
 * Two rules shape everything below.
 *
 * **There is no field for an API key, and there will not be one.** A config
 * file gets committed, pasted into an issue and copied between machines; a key
 * belongs in none of those. `apiKeyEnv` names an environment variable, and
 * `secrets.ts` is the only thing that ever reads one (AC3).
 *
 * **Everything is rejected here rather than later.** A config error surfacing
 * after forty Matches have been paid for in free-tier quota is a config error
 * that cost something. So the id pattern, the seed range, the provider set and
 * the tournament rules are all checked before a single Agent is constructed.
 */

/** The frozen schema's `agentIdentity.id`. Copied deliberately: see `assertAgentId`. */
export const AGENT_ID_PATTERN = /^[a-z0-9._:-]{1,96}$/;

export const DEFAULT_OUTPUT_DIR = 'replays';

/** Unsigned 32-bit, per the frozen schema's `seed`. */
const MAX_SEED = 4_294_967_295;

/** A tournament of ten thousand Matches is a typo, not a plan. */
const MAX_SEED_COUNT = 1_000;

export type BotKind = 'random' | 'aggressive' | 'spacing';

const BOT_KINDS: readonly BotKind[] = ['random', 'aggressive', 'spacing'];

/**
 * The providers a CLI tournament may configure.
 *
 * `openrouter` is absent because `validateTournamentConfig` throws on it
 * anyway (50 RPD, reserved for the Metering Probe and BYOK) and `byok` is
 * absent because a BYOK Match is by definition one a visitor runs with their
 * own key in their own tab -- there is no BYOK on this path, and a log
 * claiming otherwise would be unratable for a reason that never happened.
 */
export type CliProviderId = Extract<ProviderId, 'groq' | 'cerebras' | 'google-ai-studio'>;

const CLI_PROVIDERS: readonly CliProviderId[] = ['groq', 'cerebras', 'google-ai-studio'];

export interface BotAgentConfig {
  readonly id: string;
  readonly kind: 'bot';
  readonly bot: BotKind;
}

export interface DeploymentAgentConfig {
  readonly id: string;
  readonly kind: 'deployment';
  readonly provider: CliProviderId;
  readonly model: string;
  /** The *name* of an environment variable, never a key. */
  readonly apiKeyEnv: string;
  /** Whether this Deployment counts toward the leaderboard. Defaults to true. */
  readonly ranked: boolean;
  /** Optional endpoint override. Still checked against the free-tier allowlist (INV-8). */
  readonly endpoint?: string;
}

export type AgentConfig = BotAgentConfig | DeploymentAgentConfig;

export interface RunConfig {
  readonly seedBase: number;
  readonly seedCount: number;
  readonly outputDir: string;
  readonly tokenBankStart?: number;
  readonly agents: readonly AgentConfig[];
}

function fail(message: string): never {
  throw new Error(`Invalid run config: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${where}.${field} must be a non-empty string.`);
  }
  return value;
}

function requireInteger(
  source: Record<string, unknown>,
  field: string,
  where: string,
  min: number,
  max: number,
): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${where}.${field} must be a whole number between ${String(min)} and ${String(max)}.`);
  }
  return value as number;
}

/**
 * The id pattern is restated here rather than imported because the frozen
 * contract expresses it in `command-log.schema.json` (a JSON Schema string)
 * and there is no exported RegExp to reuse. `config.test.ts` asserts this
 * pattern accepts and rejects the same strings the schema does, so the copy
 * cannot drift silently.
 *
 * Checking it *here* is the point: the ledger records that model names
 * routinely violate it (`openai/gpt-oss-120b` carries a `/`), and a config
 * whose ids fail would otherwise sail through every provider call and be
 * rejected by `buildCommandLog` at the very end of a Match already paid for.
 */
function assertAgentId(id: string, where: string): void {
  if (!AGENT_ID_PATTERN.test(id)) {
    fail(
      `${where}.id "${id}" does not match the frozen Agent id pattern ${String(AGENT_ID_PATTERN)}. ` +
        `Lowercase letters, digits, and . _ : - only, up to 96 characters.`,
    );
  }
}

function parseAgent(raw: unknown, index: number): AgentConfig {
  const where = `agents[${String(index)}]`;
  const source = asRecord(raw, where);
  const id = requireString(source, 'id', where);
  assertAgentId(id, where);

  const kind = source['kind'];
  if (kind === 'bot') {
    const bot = requireString(source, 'bot', where);
    if (!BOT_KINDS.includes(bot as BotKind)) {
      fail(`${where}.bot must be one of ${BOT_KINDS.join(', ')}; got "${bot}".`);
    }
    const botConfig: BotAgentConfig = { id, kind: 'bot', bot: bot as BotKind };
    return Object.freeze(botConfig);
  }

  if (kind !== 'deployment') {
    fail(`${where}.kind must be "bot" or "deployment"; got ${JSON.stringify(kind)}.`);
  }

  const provider = requireString(source, 'provider', where);
  if (!CLI_PROVIDERS.includes(provider as CliProviderId)) {
    fail(
      `${where}.provider must be one of ${CLI_PROVIDERS.join(', ')}; got "${provider}". ` +
        `OpenRouter is reserved for the Metering Probe and BYOK, and "byok" describes a Match ` +
        `run in a visitor's own tab, which this is not.`,
    );
  }

  const model = requireString(source, 'model', where);
  const apiKeyEnv = requireString(source, 'apiKeyEnv', where);

  // The one shape the operator is most likely to get wrong, and the one whose
  // consequence is worst: a literal key where a variable name belongs would be
  // committed with the config, pasted into an issue and copied between
  // machines.
  //
  // There is no reliable way to recognise every provider's key format, so this
  // recognises the *variable name* instead, and insists on the one convention
  // every shell and every provider's own documentation uses:
  // SCREAMING_SNAKE_CASE, at most 64 characters. Groq's `gsk_live_...`,
  // Cerebras's `csk-...` and Google's `AIzaSy...` are all rejected by the
  // case rule alone -- a lowercase letter is the thing every real key has and
  // no conventional environment-variable name does.
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(apiKeyEnv)) {
    fail(
      `${where}.apiKeyEnv must be the NAME of an environment variable in SCREAMING_SNAKE_CASE ` +
        `(e.g. "GROQ_API_KEY"), not a key. The CLI reads provider keys from the environment only, ` +
        `and a config file is exactly the wrong place for one.`,
    );
  }

  const ranked = source['ranked'];
  if (ranked !== undefined && typeof ranked !== 'boolean') {
    fail(`${where}.ranked must be a boolean when present.`);
  }

  const endpoint = source['endpoint'];
  if (endpoint !== undefined && (typeof endpoint !== 'string' || endpoint.trim() === '')) {
    fail(`${where}.endpoint must be a non-empty string when present.`);
  }

  const deploymentConfig: DeploymentAgentConfig = {
    id,
    kind: 'deployment',
    provider: provider as CliProviderId,
    model,
    apiKeyEnv,
    ranked: ranked ?? true,
    ...(endpoint === undefined ? {} : { endpoint: endpoint as string }),
  };
  return Object.freeze(deploymentConfig);
}

export function parseRunConfig(text: string): RunConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }

  const source = asRecord(parsed, 'the config');

  const seedBase = requireInteger(source, 'seedBase', 'the config', 0, MAX_SEED);
  const seedCount = requireInteger(source, 'seedCount', 'the config', 1, MAX_SEED_COUNT);
  // A seed range that runs off the top of the frozen schema's unsigned 32-bit
  // `seed` would produce Matches that cannot be logged -- caught here rather
  // than by the last Match of a long run.
  if (seedBase + seedCount - 1 > MAX_SEED) {
    fail(
      `seedBase ${String(seedBase)} plus seedCount ${String(seedCount)} runs past the ` +
        `maximum seed ${String(MAX_SEED)}.`,
    );
  }

  const outputDirRaw = source['outputDir'];
  if (outputDirRaw !== undefined && (typeof outputDirRaw !== 'string' || outputDirRaw.trim() === '')) {
    fail(`outputDir must be a non-empty string when present.`);
  }
  const outputDir = (outputDirRaw as string | undefined) ?? DEFAULT_OUTPUT_DIR;

  const tokenBankStartRaw = source['tokenBankStart'];
  const tokenBankStart =
    tokenBankStartRaw === undefined
      ? undefined
      : requireInteger(source, 'tokenBankStart', 'the config', 1, Number.MAX_SAFE_INTEGER);

  const agentsRaw = source['agents'];
  if (!Array.isArray(agentsRaw)) {
    fail('agents must be an array.');
  }
  if (agentsRaw.length < 2) {
    fail(`agents must contain at least 2 entries; got ${String(agentsRaw.length)}. A Match has two sides.`);
  }

  const agents = agentsRaw.map((raw, index) => parseAgent(raw, index));

  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) {
      // Two Agents sharing an id would make `computeMatchId` collide across
      // genuinely different pairings, and the resume logic would then skip
      // Matches that had never run.
      fail(`two agents share the id "${agent.id}". Agent ids must be unique.`);
    }
    seen.add(agent.id);
  }

  // AC2/AC4 of Story 3.3, finally with a caller. Throws on an OpenRouter
  // Deployment; returns warnings for two ranked Deployments on one provider,
  // which `main.ts` prints to stderr rather than swallowing.
  validateTournamentConfig(
    agents
      .filter((agent): agent is DeploymentAgentConfig => agent.kind === 'deployment')
      .map((agent) => ({ id: agent.id, provider: agent.provider, ranked: agent.ranked })),
  );

  const runConfig: RunConfig = {
    seedBase,
    seedCount,
    outputDir,
    ...(tokenBankStart === undefined ? {} : { tokenBankStart }),
    agents: Object.freeze(agents),
  };
  return Object.freeze(runConfig);
}

export async function loadRunConfig(io: CliIo, path: string): Promise<RunConfig> {
  const text = await io.readFile(path);
  return parseRunConfig(text);
}

/** Warnings from `validateTournamentConfig`, re-derived so `main.ts` can print them. */
export function tournamentWarnings(config: RunConfig): readonly string[] {
  return validateTournamentConfig(
    config.agents
      .filter((agent): agent is DeploymentAgentConfig => agent.kind === 'deployment')
      .map((agent) => ({ id: agent.id, provider: agent.provider, ranked: agent.ranked })),
  ).warnings;
}

export function agentConfigById(config: RunConfig, id: string): AgentConfig {
  const found = config.agents.find((agent) => agent.id === id);
  if (found === undefined) {
    throw new Error(
      `No agent "${id}" in the config. Declared agents: ${config.agents.map((agent) => agent.id).join(', ')}.`,
    );
  }
  return found;
}
