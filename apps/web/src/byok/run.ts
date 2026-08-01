import type { AgentIdentity, CommandLog } from '@tokenbrawl/contracts';
import { createDeployment } from '../../../../packages/core/src/deployment';
import { runMatch } from '../../../../packages/core/src/match-runner';
import { DEFAULT_TOKEN_BANK_START } from '../../../../packages/core/src/token-bank';
import { DEFAULT_FIGHTER_CONFIG } from '../../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../../packages/env-fighter/src/environment';
import type { FreeTierConfig } from '../../../../packages/providers/src/free-tier';
import type { HttpFetch } from '../../../../packages/providers/src/http';
import { byokEndpoint, byokProvider } from './catalogue';
import { createByokClient } from './client';
import { buildByokCommandLog, byokConfigHash } from './log';

/**
 * Story 4.6: one Match, played out in the visitor's own tab.
 *
 * This is AD-4's claim cashed in -- "the same engine that ran in CI runs in the
 * tab" -- and it is a small function because everything it composes was built
 * for exactly this. `runMatch` is the blocking Harness loop from Story 1.2,
 * `createDeployment` is Story 3.1's Agent, and the Environment Adapter has been
 * browser-clean since Story 2.1 because `audit-invariants.sh` would not let it
 * be otherwise.
 *
 * There is no server anywhere on this path and there cannot be one (INV-8). The
 * key goes from an input to a `ProviderClient` closure to a request header, and
 * the only URL it is ever sent to is the one `free-tier.config.json` allowlists
 * for the selection the visitor made (AC1).
 *
 * **Failure is total, never partial (AC3).** Any `ByokKeyError` rejects
 * `runMatch`, this function propagates it, and the log is never built. That is
 * not a guard -- there is simply no code path from a failed call to a
 * `CommandLog`, and there is nothing to clean up because nothing was written.
 */

/** Unsigned 32-bit, per the frozen schema's `seed`. */
const MAX_SEED = 4_294_967_295;

export interface ByokFighterConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface ByokRunConfig {
  readonly fighters: readonly [ByokFighterConfig, ByokFighterConfig];
  readonly seed: number;
  /** Injectable transport, so a whole Match runs in a test with no network. */
  readonly fetch?: HttpFetch;
  readonly freeTier?: FreeTierConfig;
  /**
   * Called after each completed provider call, with the running count.
   *
   * Deliberately a count of *calls*, not a duration, a percentage or an
   * estimate: a visitor watching their own Match already knows how long it is
   * taking, and nothing here is recorded, but a countdown or a spinner whose
   * behaviour varied with the model would be the UI hinting at think time,
   * which INV-3 forbids and which nothing on this page may do.
   */
  readonly onCall?: (calls: number) => void;
}

/**
 * The Agent id for one side.
 *
 * Side-prefixed because two fighters may legitimately be the same model on the
 * same provider -- "gemini-2.5-flash against itself" is one of the more
 * interesting things a visitor can run -- and two Agents sharing an id would
 * make the reasoning panel unreadable and the log ambiguous about which side a
 * name refers to. Lowercase with `:` and `-` only, per the schema's id pattern.
 */
export function byokAgentId(agentIndex: 0 | 1, model: string): string {
  return `p${String(agentIndex + 1)}:byok:${model.toLowerCase()}`;
}

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new Error(`Seed must be a whole number between 0 and ${String(MAX_SEED)}.`);
  }
}

/**
 * Runs the Match and returns its Command Log.
 *
 * Both clients are constructed before either is called, so a CLI-only provider,
 * a model that is not on the free-tier allowlist, or a blank key fails *before*
 * a single request exists (AC5's "rather than failing at request time"). The
 * one thing worse than a wasted request is a wasted request on one key while
 * the other was never going to work.
 */
export async function runByokMatch(config: ByokRunConfig): Promise<CommandLog> {
  assertSeed(config.seed);

  const env = createFighterEnvironment();
  const calls = { count: 0 };
  const countCall = (): void => {
    calls.count += 1;
    config.onCall?.(calls.count);
  };

  const agents = [0, 1].map((index) => {
    const agentIndex = index as 0 | 1;
    const fighter = config.fighters[agentIndex];
    return createDeployment({
      id: byokAgentId(agentIndex, fighter.model),
      client: createByokClient({
        agentIndex,
        provider: fighter.provider,
        model: fighter.model,
        apiKey: fighter.apiKey,
        fetch: config.fetch,
        freeTier: config.freeTier,
        onCall: countCall,
      }),
    });
  });

  const identities = [0, 1].map((index): AgentIdentity => {
    const agentIndex = index as 0 | 1;
    const fighter = config.fighters[agentIndex];
    // `byokProvider` has already refused a CLI-only id inside `createByokClient`
    // above; this call is what turns the selection into the label and endpoint
    // the log records.
    byokProvider(fighter.provider, config.freeTier);
    return {
      id: byokAgentId(agentIndex, fighter.model),
      kind: 'deployment',
      deployment: {
        // AC4/AD-11. The upstream endpoint and model stay verbatim beside it:
        // the log still records what actually served every call (INV-6), and
        // `byok` is the fact that makes the Match unratable rather than a claim
        // about where it ran.
        provider: 'byok',
        endpoint: byokEndpoint(fighter.provider, fighter.model, config.freeTier),
        model: fighter.model,
      },
    };
  });

  const match = await runMatch(env, [agents[0], agents[1]], config.seed, {
    tokenBankStart: DEFAULT_TOKEN_BANK_START,
  });

  return buildByokCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed: config.seed,
    // The same hash a CI Match of this configuration would carry: same config
    // object, same canonicalisation, same digest. Two logs of one configuration
    // that disagreed here would be uncomparable for no reason.
    configHash: byokConfigHash(DEFAULT_FIGHTER_CONFIG),
    agents: [identities[0], identities[1]],
    tokenBankStart: DEFAULT_TOKEN_BANK_START,
  });
}
