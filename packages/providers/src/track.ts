import type { AgentIdentity, DeploymentIdentity, MeteringProbeResult } from '@tokenbrawl/contracts';
import type { MeteringProbeOutcome } from './metering-probe';

/**
 * Story 3.4: what a Metering Probe classification then forces.
 *
 * `metering-probe.ts` answers "what does this Deployment report?". This file
 * answers "so where may it appear?", which is the half INV-5 actually cares
 * about: a Deployment that cannot be metered honestly is Reflex-Track only,
 * and the exclusion appears in published results -- never silently compared.
 *
 * The two rules that make that stick are both here and both deliberately
 * one-way:
 *
 * 1. Anything but `reports-reasoning` is `'reflex'`, and so is `undefined`.
 *    An unprobed Deployment is exactly what INV-5 forbids on the leaderboard,
 *    and defaulting the missing case to `'main'` is how an invariant is lost
 *    to an omission rather than to a decision.
 * 2. An entry already marked `'reflex'` is never promoted, whatever the probe
 *    says. Demotion is one-way; a passing probe is not a licence to override
 *    a track someone set on purpose.
 */

export type LeaderboardTrack = 'main' | 'reflex';

/** The one classification that reaches the main leaderboard. Every other value, and no value at all, is Reflex Track. */
export function trackFor(result: MeteringProbeResult | undefined): LeaderboardTrack {
  return result === 'reports-reasoning' ? 'main' : 'reflex';
}

/**
 * Why a given entry is not rankable, in the words a published result will
 * carry.
 *
 * `explicitlyReflex` is a separate argument rather than folded into `result`
 * because the two are genuinely different facts: an entry marked Reflex Track
 * by configuration *was* probed and may well have passed, and reporting it as
 * "never probed" would be a false statement in published output -- which is
 * the failure mode AC4 exists to prevent, only inverted.
 */
function reasonFor(result: MeteringProbeResult | undefined, explicitlyReflex: boolean): string {
  if (result === undefined) {
    return 'never probed -- INV-5 requires a Metering Probe result before a Deployment may be ranked';
  }
  if (result === 'no-usage-reported') {
    return 'the provider reported no usage at all, so the Token Bank cannot be debited honestly';
  }
  if (result === 'reports-completion-only') {
    return 'the provider reported completion tokens but no separate deliberation count under structured output, so any tokens spent deliberating would be spent for free';
  }
  return explicitlyReflex
    ? 'configured as Reflex Track, so a passing Metering Probe does not promote it'
    : 'not classified as reports-reasoning';
}

/** A frozen copy of `identity` carrying the probe result. The input is never mutated. */
export function withMeteringProbe(
  identity: DeploymentIdentity,
  result: MeteringProbeResult,
): DeploymentIdentity {
  return Object.freeze({ ...identity, meteringProbe: result });
}

/** The probe outcome as the `DeploymentIdentity` a Command Log will carry (INV-6: provider and endpoint included). */
export function deploymentIdentityFrom(outcome: MeteringProbeOutcome): DeploymentIdentity {
  return Object.freeze({
    provider: outcome.provider,
    endpoint: outcome.endpoint,
    model: outcome.model,
    meteringProbe: outcome.result,
  });
}

/**
 * Records a probe result against an Agent, setting both the classification and
 * the track it forces.
 *
 * A `kind: 'bot'` entry is returned untouched: a Baseline Bot consumes no
 * tokens and has no Deployment identity to record a probe against, so writing
 * one would be a fiction. An entry that is already `'reflex'` stays there.
 */
export function applyMeteringProbe(agent: AgentIdentity, result: MeteringProbeResult): AgentIdentity {
  if (agent.kind !== 'deployment' || agent.deployment === undefined) {
    return agent;
  }
  const track = agent.track === 'reflex' ? 'reflex' : trackFor(result);
  return Object.freeze({
    ...agent,
    deployment: withMeteringProbe(agent.deployment, result),
    track,
  });
}

export interface MeteringExclusion {
  readonly id: string;
  /** `undefined` when the Deployment was never probed at all -- itself an exclusion reason. */
  readonly result: MeteringProbeResult | undefined;
  readonly reason: string;
}

export interface TrackPartition {
  readonly mainLeaderboard: readonly AgentIdentity[];
  readonly reflexTrack: readonly AgentIdentity[];
  /** One per Reflex-Track entry, always. AC4: silent omission is a defect. */
  readonly exclusions: readonly MeteringExclusion[];
}

/**
 * Splits a result set into the main leaderboard, the Reflex Track, and the
 * exclusions that explain the difference.
 *
 * The function is total by construction and its totality is asserted in the
 * tests: `mainLeaderboard.length + reflexTrack.length === entries.length`, and
 * `exclusions.length === reflexTrack.length`. An entry that fell out of both
 * lists, or a Reflex-Track entry with no stated reason, is the silent omission
 * AC4 calls a defect -- so neither is expressible here.
 *
 * Baseline Bots go to the main leaderboard with no exclusion. They consume
 * nothing, so there is no metering to be dishonest about, and holding the
 * calibration ladder off the board it calibrates would be perverse.
 */
export function partitionByTrack(entries: readonly AgentIdentity[]): TrackPartition {
  const mainLeaderboard: AgentIdentity[] = [];
  const reflexTrack: AgentIdentity[] = [];
  const exclusions: MeteringExclusion[] = [];

  for (const entry of entries) {
    if (entry.kind === 'bot') {
      mainLeaderboard.push(entry);
      continue;
    }

    const result = entry.deployment?.meteringProbe;
    const explicitlyReflex = entry.track === 'reflex';
    const track = explicitlyReflex ? 'reflex' : trackFor(result);

    if (track === 'main') {
      mainLeaderboard.push(entry);
      continue;
    }

    reflexTrack.push(entry);
    exclusions.push(
      Object.freeze({
        id: entry.id,
        result,
        reason: reasonFor(result, explicitlyReflex),
      }),
    );
  }

  return Object.freeze({
    mainLeaderboard: Object.freeze(mainLeaderboard),
    reflexTrack: Object.freeze(reflexTrack),
    exclusions: Object.freeze(exclusions),
  });
}

/**
 * The exclusions as publishable lines. A results page that prints these has
 * satisfied AC4; one that prints only the main leaderboard has not, and the
 * absence is what makes a hidden exclusion hard to notice.
 */
export function formatMeteringExclusions(
  exclusions: readonly MeteringExclusion[],
): readonly string[] {
  return Object.freeze(
    exclusions.map(
      (exclusion) =>
        `${exclusion.id}: Reflex Track only (Metering Probe: ${exclusion.result ?? 'not run'}) -- ${exclusion.reason}`,
    ),
  );
}
