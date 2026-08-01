import type { Agent, AgentIdentity } from '@tokenbrawl/contracts';
import { createDeployment } from '../../core/src/deployment';
import type { ProviderClient } from '../../core/src/deployment';
import { DEFAULT_FIGHTER_CONFIG } from '../../env-fighter/src/config';
import {
  createAggressiveBot,
  createRandomBot,
  createSpacingBot,
} from '../../env-fighter/src/bots';
import { createCerebrasClient } from '../../providers/src/cerebras';
import type { FreeTierConfig } from '../../providers/src/free-tier';
import { createGoogleClient } from '../../providers/src/google';
import { createGroqClient } from '../../providers/src/groq';
import type { HttpFetch, Sleep } from '../../providers/src/http';
import type { RateLimitSignal } from '../../providers/src/rate-limit';
import type { AgentConfig, BotAgentConfig, DeploymentAgentConfig, RunConfig } from './config';
import type { CliIo } from './io';
import { resolveApiKey } from './secrets';

/**
 * Config entries to Agents.
 *
 * Deliberately the only file in this package that knows a provider exists.
 * Every client factory it calls already validates its own endpoint against the
 * free-tier allowlist at construction (INV-8), so a Deployment that could not
 * legally be configured fails here rather than on its first request.
 *
 * Deep relative specifiers into the other packages are this repo's established
 * convention: no package declares `main`/`exports`, so the bare
 * `@tokenbrawl/core` specifier does not resolve at runtime. Already in the
 * deferred-work ledger against Story 1.1.
 */

export interface BuiltAgent {
  readonly agent: Agent;
  readonly identity: AgentIdentity;
}

export interface AgentDeps {
  readonly io: CliIo;
  /** Injectable transport, so a whole Deployment Match runs in a test with no network. */
  readonly fetch?: HttpFetch;
  readonly sleep?: Sleep;
  readonly freeTier?: FreeTierConfig;
  /**
   * Where a provider's rate-limit signal goes.
   *
   * Story 5.1 forwards it to stderr and does nothing else with it. Consuming
   * it -- pacing, parking a Deployment that has hit a daily quota, backing off
   * across Matches rather than within one -- is Story 5.2's whole subject, and
   * AD-9 puts that state in the runner rather than in an adapter. The sink is
   * wired now so 5.2 inherits a seam instead of an omission.
   */
  readonly onRateLimit?: (signal: RateLimitSignal) => void;
}

/**
 * A fresh Agent per Match, never a shared one.
 *
 * The random bot carries a generator in its closure, so reusing an instance
 * across Matches would make Match `n` depend on Match `n-1` and a tournament
 * would stop being a function of its seeds. Its seed is derived from the Match
 * seed and the side it is playing, exactly as `skill-ladder.ts` does it, so
 * two random bots in one Match are genuinely different streams rather than the
 * same one played twice.
 */
function createBot(config: BotAgentConfig, seed: number, agentIndex: 0 | 1): Agent {
  if (config.bot === 'random') {
    return createRandomBot(config.id, Math.imul(seed, 31) + agentIndex);
  }
  if (config.bot === 'aggressive') {
    return createAggressiveBot(config.id, DEFAULT_FIGHTER_CONFIG);
  }
  return createSpacingBot(config.id, DEFAULT_FIGHTER_CONFIG);
}

function createClient(config: DeploymentAgentConfig, apiKey: string, deps: AgentDeps): ProviderClient {
  const shared = {
    apiKey,
    model: config.model,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.freeTier === undefined ? {} : { freeTier: deps.freeTier }),
    ...(deps.onRateLimit === undefined ? {} : { onRateLimit: deps.onRateLimit }),
  };

  if (config.provider === 'groq') {
    return createGroqClient(shared);
  }
  if (config.provider === 'cerebras') {
    return createCerebrasClient(shared);
  }
  return createGoogleClient(shared);
}

export function buildAgent(
  config: AgentConfig,
  seed: number,
  agentIndex: 0 | 1,
  deps: AgentDeps,
): BuiltAgent {
  if (config.kind === 'bot') {
    return {
      agent: createBot(config, seed, agentIndex),
      // A Baseline Bot carries no `deployment` block and no `track`: it
      // consumes nothing, so there is no provider, no endpoint and no
      // Metering Probe result to record.
      identity: { id: config.id, kind: 'bot' },
    };
  }

  const apiKey = resolveApiKey(deps.io.env, config.apiKeyEnv, config.id);
  const client = createClient(config, apiKey, deps);

  return {
    agent: createDeployment({ id: config.id, client }),
    identity: {
      id: config.id,
      kind: 'deployment',
      deployment: {
        // Taken from the *client*, not from the config: the log then records
        // the endpoint that actually served every call, including the one the
        // free-tier allowlist chose when the config named none (INV-6).
        provider: client.provider,
        endpoint: client.endpoint,
        model: client.model,
      },
    },
  };
}

/**
 * Every API key this config will resolve, for `guardSecrets`.
 *
 * Resolved once, up front, before any Match runs -- so a missing key is a
 * message at second zero rather than after the first pairing has already
 * burned quota, and so the redaction guard is armed before there is anything
 * to redact. A key is never stored anywhere but this array and the closure of
 * the client that uses it.
 */
export function secretsFor(config: RunConfig, io: CliIo): readonly string[] {
  const secrets: string[] = [];
  for (const agent of config.agents) {
    if (agent.kind !== 'deployment') {
      continue;
    }
    const key = resolveApiKey(io.env, agent.apiKeyEnv, agent.id);
    if (!secrets.includes(key)) {
      secrets.push(key);
    }
  }
  return secrets;
}
