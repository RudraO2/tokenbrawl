import type { ProviderId } from '@tokenbrawl/contracts';

/**
 * Story 3.3: tournament-config validation, AC2 and AC4.
 *
 * `docs/ARCHITECTURE.md`'s Provider strategy is "one ranked Deployment per
 * provider, so free-tier quotas stay independent rather than shared" --
 * AC2 asks that a config violating it be caught, not silently accepted, and
 * AC4 asks that OpenRouter (50 RPD, reserved for the Metering Probe and BYOK)
 * never be configured into a tournament at all. Both are config-shape
 * questions the tournament runner (Story 5.2) will call this against; nothing
 * here touches `packages/core` or an Environment Adapter.
 */

/** The tournament's opinion of one configured Deployment -- provider identity and rank status only. */
export interface TournamentDeploymentConfig {
  readonly id: string;
  readonly provider: ProviderId;
  /** Whether this Deployment counts toward the leaderboard. A Reflex-only or probe-only entry does not. */
  readonly ranked: boolean;
}

export interface TournamentConfigValidation {
  /** Non-fatal: quotas would no longer be independent, but the config is still usable. */
  readonly warnings: readonly string[];
}

/** 50 RPD, reserved for the Metering Probe and BYOK -- never enough to run a tournament (AC4). */
const TOURNAMENT_FORBIDDEN_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['openrouter']);

/**
 * AC4 first: an OpenRouter Deployment throws outright, regardless of `ranked`.
 * A tournament that runs one call against it is a call it never had the quota
 * for.
 *
 * AC2 next: among the *ranked* Deployments, more than one on the same
 * provider is a warning, not a rejection -- the config is legal (a Reflex
 * Track deployment, or a deliberate shared-quota choice) but the two ranked
 * entries no longer measure independent budgets, and a caller (the tournament
 * runner, a CI report) needs to know that before publishing results.
 */
export function validateTournamentConfig(
  deployments: readonly TournamentDeploymentConfig[],
): TournamentConfigValidation {
  for (const deployment of deployments) {
    if (TOURNAMENT_FORBIDDEN_PROVIDERS.has(deployment.provider)) {
      throw new Error(
        `Deployment "${deployment.id}" configures provider "${deployment.provider}" for a tournament. ` +
          `OpenRouter's free tier is reserved for the Metering Probe and BYOK, not tournament play.`,
      );
    }
  }

  const rankedIdsByProvider = new Map<ProviderId, string[]>();
  for (const deployment of deployments) {
    if (!deployment.ranked) {
      continue;
    }
    const ids = rankedIdsByProvider.get(deployment.provider) ?? [];
    ids.push(deployment.id);
    rankedIdsByProvider.set(deployment.provider, ids);
  }

  const warnings: string[] = [];
  for (const [provider, ids] of rankedIdsByProvider) {
    if (ids.length > 1) {
      warnings.push(
        `Provider "${provider}" has ${ids.length} ranked Deployments (${ids.join(', ')}) -- ` +
          `free-tier quotas would no longer be independent.`,
      );
    }
  }

  return Object.freeze({ warnings: Object.freeze(warnings) });
}
