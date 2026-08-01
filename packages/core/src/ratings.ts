/**
 * Story 7-2: ratings, with a bootstrapped confidence interval on every one of
 * them.
 *
 * Every rule this file applies was written by an earlier story as a predicate
 * with no consumer. This is the consumer:
 *
 *   - `ratingEligibility` (4.6)          -- a BYOK Match is never rated (AD-11).
 *   - `summarisePairingCoverage` (7.1)   -- a pairing under 30 Matches, or under
 *                                           15 seeds played from both sides, is
 *                                           provisional and not rated.
 *   - `bootstrapMeanInterval` (2.4)      -- the interval itself, seeded (AD-5).
 *
 * None of them is re-derived here. The one rule this file does *not* own is the
 * main/Reflex split: `partitionByTrack` lives in `packages/providers` and AD-1
 * forbids `packages/core` importing it, so the track arrives as a map the
 * caller built by calling that function. An Agent with no entry in it is an
 * error rather than a default -- INV-5 is lost to an omission far more easily
 * than to a decision, and "unprobed silently became main" is exactly the
 * omission.
 *
 * ## What a rating is here
 *
 * The Agent's mean score over its rated Matches, in integer basis points, with
 * a percentile bootstrap interval -- not Elo and not TrueSkill. The
 * architecture spine defers that choice to this epic; the reasoning for taking
 * neither is in `spec-7-2-ratings-with-confidence-intervals.md` (D1) and is
 * threefold: a complete mirrored round-robin (7.1) makes a mean score
 * sufficient; a logistic expectation cannot be computed in a package that bans
 * floating point (INV-2); and a sequential update rule would make a published
 * number depend on the order logs happen to be listed in, which AD-9 leaves
 * undefined by design.
 *
 * The price of that choice is that a mean score is only comparable across rows
 * when the opponent sets are. So every row carries its per-opponent breakdown
 * rather than only a single number, and the renderer prints the opponent count
 * beside the rating.
 *
 * ## Tracks separate rows, not Matches
 *
 * A Match is rated once and contributes to both its Agents. The Reflex Track
 * appears as its own table (INV-5) but its Matches against Baseline Bots still
 * count: the bots are the calibration ladder, and discarding every
 * Deployment-vs-Bot Match as "cross-track" would throw away the entire corpus
 * -- today, every Deployment is Reflex Track, because a CLI log carries no
 * Metering Probe result and `trackFor(undefined)` is `reflex`.
 */

import type { AgentIdentity } from '@tokenbrawl/contracts';
import {
  isPairingRatable,
  summarisePairingCoverage,
  type CoverageMatch,
  type PairingCoverage,
  type PairingExclusion,
} from './pairing-coverage';
import { ratingEligibility, type RatingExclusion } from './rating-eligibility';
import { side0Score } from './side-advantage';
import {
  DEFAULT_CONFIDENCE_BASIS_POINTS,
  WIN_BASIS_POINTS,
  bootstrapMeanInterval,
  deriveSeed,
  meanBasisPoints,
  type BootstrapInterval,
} from './statistics';

/**
 * Structurally identical to `packages/providers`'s `LeaderboardTrack`, and
 * deliberately a second declaration rather than an import: AD-1 runs one way,
 * and core may not depend on a provider package. `ratings.typecheck.test.ts`
 * asserts the two remain mutually assignable, so the duplication cannot drift
 * into two different vocabularies.
 */
export type RatingTrack = 'main' | 'reflex';

/** Why a Match did not contribute to any rating. Both unions come from their owning module. */
export type MatchExclusionReason = RatingExclusion | PairingExclusion;

export interface LeaderboardMatch {
  readonly matchId: string;
  readonly seed: number;
  /** Side 0 first. Array index 0 is P1; there is no "sides swapped" flag (AD-12). */
  readonly agents: readonly [AgentIdentity, AgentIdentity];
  readonly outcome: 'p1' | 'p2' | 'draw';
}

export interface OpponentRecord {
  readonly opponent: string;
  readonly matches: number;
  /** This Agent's mean score against that opponent, in basis points. */
  readonly scoreBasisPoints: number;
}

export interface RatingRow {
  readonly agent: string;
  readonly kind: 'deployment' | 'bot';
  readonly track: RatingTrack;
  readonly matches: number;
  /** Sorted by opponent id. The schedule this rating was earned against, in full. */
  readonly opponents: readonly OpponentRecord[];
  readonly ratingBasisPoints: number;
  /**
   * Never optional, and that is the machine form of AC1's second sentence: a
   * row that could be published without an interval would have to be a
   * different type, which no function in this repo produces.
   */
  readonly interval: BootstrapInterval;
}

export interface MatchExclusion {
  readonly matchId: string;
  readonly agentIds: readonly [string, string];
  readonly exclusions: readonly MatchExclusionReason[];
  /** Displayable. A silent omission is the defect; a stated one is a result. */
  readonly reason: string;
}

export interface UnratedAgent {
  readonly agent: string;
  readonly kind: 'deployment' | 'bot';
  readonly track: RatingTrack;
  readonly reason: string;
}

export interface Leaderboard {
  readonly main: readonly RatingRow[];
  readonly reflex: readonly RatingRow[];
  /** Present in the corpus, rated in no Match. Never dropped in silence. */
  readonly unrated: readonly UnratedAgent[];
  /** Coverage over the BYOK-filtered corpus -- what decided which pairings count. */
  readonly coverage: readonly PairingCoverage[];
  readonly matches: number;
  readonly ratedMatches: number;
  readonly excludedMatches: readonly MatchExclusion[];
  readonly bootstrap: {
    readonly resamples: number;
    readonly seed: number;
    readonly confidenceBasisPoints: number;
  };
}

export interface LeaderboardParams {
  readonly matches: readonly LeaderboardMatch[];
  /**
   * Every Agent id appearing in `matches`, or `computeLeaderboard` throws.
   * Built by the caller from `partitionByTrack` -- the only place the
   * main/Reflex rule is decided (INV-5).
   */
  readonly tracks: ReadonlyMap<string, RatingTrack>;
  readonly resamples: number;
  readonly seed: number;
  readonly confidenceBasisPoints?: number;
}

/**
 * Code-unit ordering, deliberately **not** `localeCompare`, for the reason
 * `pairing-coverage.ts` gives at length: row order decides which bootstrap seed
 * each row is given, so a runner with different ICU collation data would
 * publish different intervals for the same corpus.
 */
function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

interface AgentAccumulator {
  readonly agent: string;
  readonly kind: 'deployment' | 'bot';
  readonly track: RatingTrack;
  readonly scores: number[];
  /** Opponent id -> that opponent's scores from *this* Agent's point of view. */
  readonly byOpponent: Map<string, number[]>;
}

/**
 * The track for this identity, checked against what the log itself claims.
 *
 * Called for **every** occurrence of an Agent, not only the first. Checking
 * once would let a corpus where a Deployment is logged `main` in one Match and
 * `reflex` in another pass silently, on whichever of the two happened to be
 * read first -- and that disagreement is exactly the condition INV-5 cares
 * about.
 */
function trackOf(
  tracks: ReadonlyMap<string, RatingTrack>,
  identity: AgentIdentity,
): RatingTrack {
  const supplied = tracks.get(identity.id);
  if (supplied === undefined) {
    throw new Error(
      `computeLeaderboard: no track supplied for "${identity.id}". Every Agent in the corpus needs one -- build the map with partitionByTrack rather than defaulting (INV-5).`,
    );
  }
  // A log that already carries a track and a map that says otherwise is two
  // answers to one question. Refuse rather than pick: the disagreement is
  // itself the finding, and silently preferring either one would hide a
  // Deployment whose probe result and whose published table no longer agree.
  if (identity.track !== undefined && identity.track !== supplied) {
    throw new Error(
      `computeLeaderboard: "${identity.id}" is logged as track "${identity.track}" but the supplied map says "${supplied}".`,
    );
  }
  return supplied;
}

function assertMatch(match: LeaderboardMatch, index: number): void {
  if (!Number.isSafeInteger(match.seed)) {
    throw new Error(
      `computeLeaderboard: match ${String(index)} has a non-integer seed: ${String(match.seed)}`,
    );
  }
  if (match.agents[0].id === match.agents[1].id) {
    throw new Error(
      `computeLeaderboard: match ${String(index)} pairs "${match.agents[0].id}" with itself, which has no two sides to score`,
    );
  }
}

function pairingKey(left: string, right: string): string {
  return compareIds(left, right) <= 0 ? `${left} ${right}` : `${right} ${left}`;
}

/**
 * Compute the leaderboard: two tables, the coverage that decided them, and one
 * exclusion record per Match that did not make it.
 *
 * Totality is a property of the return value and is asserted by the tests:
 * `ratedMatches + excludedMatches.length === matches.length`. A Match that fell
 * out of both counts would be the silent omission this whole pipeline exists to
 * make impossible.
 *
 * Order of operations is load-bearing. BYOK Matches are removed **before**
 * coverage is computed: a visitor who could push a pairing over the 30-Match
 * floor from their own browser could promote a provisional pairing into the
 * published ratings, which is AD-11 defeated by arithmetic rather than by a
 * missing check.
 */
export function computeLeaderboard(params: LeaderboardParams): Leaderboard {
  const { matches, tracks, resamples, seed } = params;

  matches.forEach(assertMatch);

  // One Match, one row of evidence. A `matchId` is derived from
  // (environment, seed, configHash, agent ids) by one function (AD-8), so two
  // documents carrying the same id are the same Match twice -- and counting it
  // twice both inflates a pairing toward the coverage floor and narrows an
  // interval that has not earned it. The runner cannot produce this (a log's
  // file name *is* its id), which is precisely why nothing downstream would
  // notice a corpus that had it.
  const identifiers = new Set<string>();
  for (const match of matches) {
    if (identifiers.has(match.matchId)) {
      throw new Error(
        `computeLeaderboard: matchId "${match.matchId}" appears twice. One Match may contribute to a rating once.`,
      );
    }
    identifiers.add(match.matchId);
  }

  // --- Pass 0: register every Agent in the corpus, rated or not. -----------
  //
  // Registration is deliberately ahead of every filter below. An Agent that
  // appears only in Matches that are then excluded -- a Deployment somebody ran
  // exclusively through BYOK, a pairing that never reached the coverage floor
  // -- still owes the reader an entry saying so. Registering inside the scoring
  // loop instead would make it vanish from the output entirely, which is the
  // silent omission this whole pipeline is built to make impossible.
  const accumulators = new Map<string, AgentAccumulator>();
  const seen = new Map<string, 'deployment' | 'bot'>();

  const remember = (identity: AgentIdentity): AgentAccumulator => {
    const previous = seen.get(identity.id);
    if (previous !== undefined && previous !== identity.kind) {
      throw new Error(
        `computeLeaderboard: "${identity.id}" appears as both a ${previous} and a ${identity.kind}. One id is one entrant (INV-6).`,
      );
    }
    seen.set(identity.id, identity.kind);

    const track = trackOf(tracks, identity);

    const existing = accumulators.get(identity.id);
    if (existing !== undefined) {
      return existing;
    }
    const created: AgentAccumulator = {
      agent: identity.id,
      kind: identity.kind,
      track,
      scores: [],
      byOpponent: new Map<string, number[]>(),
    };
    accumulators.set(identity.id, created);
    return created;
  };

  for (const match of matches) {
    remember(match.agents[0]);
    remember(match.agents[1]);
  }

  // --- Pass 1: AD-11. A BYOK Match is not a Match for any of this. ---------
  const eligible: LeaderboardMatch[] = [];
  const excluded: MatchExclusion[] = [];

  for (const match of matches) {
    const eligibility = ratingEligibility({ agents: [match.agents[0], match.agents[1]] });
    if (eligibility.eligible) {
      eligible.push(match);
      continue;
    }
    const reason = eligibility.reason ?? '';
    excluded.push(
      Object.freeze({
        matchId: match.matchId,
        agentIds: Object.freeze([match.agents[0].id, match.agents[1].id]) as readonly [
          string,
          string,
        ],
        exclusions: Object.freeze(['byok' as const]) as readonly MatchExclusionReason[],
        reason,
      }),
    );
  }

  // --- Pass 2: 7.1's coverage floor, over what survived AD-11. -------------
  const coverageMatches: readonly CoverageMatch[] = eligible.map((match) => ({
    seed: match.seed,
    agentIds: [match.agents[0].id, match.agents[1].id] as readonly [string, string],
  }));
  const coverage = summarisePairingCoverage(coverageMatches);
  const coverageByPairing = new Map<string, PairingCoverage>(
    coverage.map((row) => [pairingKey(row.pairing[0], row.pairing[1]), row]),
  );

  // --- Pass 3: score every rated Match from both Agents' points of view. ---
  let ratedMatches = 0;

  for (const match of eligible) {
    const first = remember(match.agents[0]);
    const second = remember(match.agents[1]);

    const pairing = coverageByPairing.get(pairingKey(first.agent, second.agent));
    if (pairing === undefined) {
      // Not reachable: `coverage` was computed from these very Matches, so
      // every eligible pairing has a row. Thrown rather than treated as an
      // exclusion, because the alternative is an excluded Match with no stated
      // reason -- the one shape this function promises never to produce.
      throw new Error(
        `computeLeaderboard: no coverage row for "${first.agent}" vs "${second.agent}", which cannot happen`,
      );
    }
    if (!isPairingRatable(pairing)) {
      excluded.push(
        Object.freeze({
          matchId: match.matchId,
          agentIds: Object.freeze([first.agent, second.agent]) as readonly [string, string],
          exclusions: Object.freeze([...pairing.exclusions]) as readonly MatchExclusionReason[],
          reason: pairing.reason ?? '',
        }),
      );
      continue;
    }

    ratedMatches += 1;

    const side0 = side0Score(match.outcome);
    const scores: readonly [number, number] = [side0, WIN_BASIS_POINTS - side0];
    const sides: readonly [AgentAccumulator, AgentAccumulator] = [first, second];

    for (const index of [0, 1] as const) {
      const self = sides[index];
      const opponent = sides[index === 0 ? 1 : 0];
      self.scores.push(scores[index]);
      const against = self.byOpponent.get(opponent.agent) ?? [];
      against.push(scores[index]);
      self.byOpponent.set(opponent.agent, against);
    }
  }

  // --- Pass 4: rows, in a deterministic order, each with its own stream. ---
  const rated = [...accumulators.values()].filter((entry) => entry.scores.length > 0);
  const unrated = [...accumulators.values()]
    .filter((entry) => entry.scores.length === 0)
    .map((entry) =>
      Object.freeze({
        agent: entry.agent,
        kind: entry.kind,
        track: entry.track,
        reason:
          'No rated Match: every Match this Agent played was excluded (BYOK, or a pairing below the coverage floor).',
      }),
    )
    .sort((left, right) => compareIds(left.agent, right.agent));

  // Sorted across *both* tracks before the seeds are handed out, so a row's
  // interval does not change when an unrelated Deployment is demoted to the
  // Reflex Track. The partition happens after, and only moves rows between
  // arrays.
  const ordered = rated
    .map((entry) => ({ entry, mean: meanBasisPoints(entry.scores) }))
    .sort((left, right) => right.mean - left.mean || compareIds(left.entry.agent, right.entry.agent));

  const rows: RatingRow[] = ordered.map((row, index) =>
    Object.freeze({
      agent: row.entry.agent,
      kind: row.entry.kind,
      track: row.entry.track,
      matches: row.entry.scores.length,
      opponents: Object.freeze(
        [...row.entry.byOpponent.entries()]
          .map(([opponent, scores]) =>
            Object.freeze({
              opponent,
              matches: scores.length,
              scoreBasisPoints: meanBasisPoints(scores),
            }),
          )
          .sort((left, right) => compareIds(left.opponent, right.opponent)),
      ) as readonly OpponentRecord[],
      ratingBasisPoints: row.mean,
      interval: bootstrapMeanInterval({
        scoresBasisPoints: row.entry.scores,
        resamples,
        seed: deriveSeed(seed, index),
        confidenceBasisPoints: params.confidenceBasisPoints,
      }),
    }),
  );

  const firstInterval = rows.length > 0 ? rows[0].interval : null;

  return Object.freeze({
    main: Object.freeze(rows.filter((row) => row.track === 'main')) as readonly RatingRow[],
    reflex: Object.freeze(rows.filter((row) => row.track === 'reflex')) as readonly RatingRow[],
    unrated: Object.freeze(unrated) as readonly UnratedAgent[],
    coverage,
    matches: matches.length,
    ratedMatches,
    excludedMatches: Object.freeze(excluded) as readonly MatchExclusion[],
    bootstrap: Object.freeze({
      resamples,
      seed,
      // Read back off a computed interval rather than restated, so the report
      // can never advertise a coverage the intervals were not computed at.
      // With no rows there is no interval to read, and the caller's value --
      // or the statistics module's default -- is reported instead.
      confidenceBasisPoints:
        firstInterval?.confidenceBasisPoints ??
        params.confidenceBasisPoints ??
        DEFAULT_CONFIDENCE_BASIS_POINTS,
    }),
  });
}
