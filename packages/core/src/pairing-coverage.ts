/**
 * Story 7.1 AC3: a pairing that has not been played enough is *provisional*,
 * shown as such, and not rated.
 *
 * The companion to `rating-eligibility.ts`, and deliberately not part of it.
 * That module judges one Match by its own contents -- a BYOK log is unratable
 * no matter what else exists. Whether a *pairing* has been played enough is a
 * property of a whole corpus and cannot be answered from one log, so it is its
 * own module with its own shape. Story 7.2's rating computation imports both;
 * neither subsumes the other.
 *
 * Free of Node built-ins and of the schema validator, for the same reason
 * `rating-eligibility.ts` is: `apps/web` must be able to import it, and
 * `command-log.ts` reaches `node:crypto` and Ajv, which Vite cannot bundle for
 * a browser. The rule reads two fields off already-validated logs.
 */

/**
 * 15 seeds played from both sides. The story's AC states the floor as "30
 * Matches (15 seeds x 2 sides)", so both halves of that sentence are checked
 * -- see `insufficient-mirrored-seeds` below for why the count alone is not
 * enough.
 */
export const MINIMUM_MIRRORED_SEEDS_PER_PAIRING = 15;
export const MINIMUM_MATCHES_PER_PAIRING = 30;

/**
 * Why a pairing is provisional.
 *
 * `insufficient-matches` is the AC's literal rule. `insufficient-mirrored-seeds`
 * is the AC's own parenthetical made enforceable: 30 Matches with the same
 * Agent on side 0 every time satisfies the count and defeats the entire point
 * of the story, because a side advantage in the Environment would still be
 * indistinguishable from a skill difference. Neither implies the other in both
 * directions -- 15 mirrored seeds guarantees 30 Matches, but 40 Matches can
 * contain as few as zero mirrored seeds -- so both are reported.
 */
export type PairingExclusion = 'insufficient-matches' | 'insufficient-mirrored-seeds';

/** The fields this rule reads. A planned Match or a Command Log satisfies it. */
export interface CoverageMatch {
  readonly seed: number;
  /** Side 0 first. Array index 0 is P1; there is no "sides swapped" flag (AD-12). */
  readonly agentIds: readonly [string, string];
}

export interface PairingCoverage {
  /**
   * The two Agent ids, sorted. Both orientations of one pairing land in this
   * single row -- `{a, b}` and `{b, a}` are one pairing played from two sides,
   * never two pairings.
   */
  readonly pairing: readonly [string, string];
  readonly matches: number;
  /** Matches with `pairing[0]` on side 0, then those with `pairing[1]` on side 0. */
  readonly matchesBySide: readonly [number, number];
  readonly seeds: number;
  /** Seeds played from both sides. */
  readonly mirroredSeeds: number;
  readonly provisional: boolean;
  readonly exclusions: readonly PairingExclusion[];
  /**
   * Present exactly when provisional. Displayable text: a leaderboard can say
   * why a row is missing rather than leaving a silent gap, which is the same
   * standard `ratingEligibility` holds itself to.
   */
  readonly reason: string | null;
}

interface Accumulator {
  readonly pairing: readonly [string, string];
  matchesOnSide0: number;
  matchesOnSide1: number;
  /** Seed -> which of `pairing`'s two members has been seen on side 0. */
  readonly sidesBySeed: Map<number, Set<0 | 1>>;
}

/** `localeCompare`, matching `skill-gate.ts`'s tie-break, so ordering is a function of the input. */
function sortedPairing(agentIds: readonly [string, string]): readonly [string, string] {
  return agentIds[0].localeCompare(agentIds[1]) <= 0
    ? [agentIds[0], agentIds[1]]
    : [agentIds[1], agentIds[0]];
}

function assertMatch(match: CoverageMatch, index: number): void {
  if (!Number.isSafeInteger(match.seed)) {
    throw new Error(
      `summarisePairingCoverage: match ${String(index)} has a non-integer seed: ${String(match.seed)}`,
    );
  }
  if (match.agentIds[0] === match.agentIds[1]) {
    throw new Error(
      `summarisePairingCoverage: match ${String(index)} pairs "${match.agentIds[0]}" with itself, which has no sides to compare`,
    );
  }
}

function describe(coverage: {
  readonly matches: number;
  readonly mirroredSeeds: number;
  readonly exclusions: readonly PairingExclusion[];
}): string | null {
  if (coverage.exclusions.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (coverage.exclusions.includes('insufficient-matches')) {
    parts.push(
      `${String(coverage.matches)} Matches, fewer than the required ${String(MINIMUM_MATCHES_PER_PAIRING)}`,
    );
  }
  if (coverage.exclusions.includes('insufficient-mirrored-seeds')) {
    parts.push(
      `${String(coverage.mirroredSeeds)} seeds played from both sides, fewer than the required ${String(MINIMUM_MIRRORED_SEEDS_PER_PAIRING)}`,
    );
  }
  return `Provisional, not rated: ${parts.join('; ')}.`;
}

/**
 * Every pairing present in `matches`, with the coverage facts that decide
 * whether it may be rated.
 *
 * Rows are sorted by pairing id so the output is a function of the input and
 * never of `Map` insertion order -- the same rule `skill-gate.ts` follows, and
 * for the same reason: a report that reorders itself between runs cannot be
 * diffed.
 *
 * A duplicate `(pairing, seed, orientation)` is counted as the Matches it is.
 * Two logs of one orientation are two Matches by every measure this project
 * has, and `matchId` collision is the thing that would actually be wrong --
 * caught upstream by `outstandingMatches`, not silently absorbed here.
 */
export function summarisePairingCoverage(
  matches: readonly CoverageMatch[],
): readonly PairingCoverage[] {
  const byPairing = new Map<string, Accumulator>();

  matches.forEach((match, index) => {
    assertMatch(match, index);
    const pairing = sortedPairing(match.agentIds);
    const key = `${pairing[0]} ${pairing[1]}`;
    const entry = byPairing.get(key) ?? {
      pairing,
      matchesOnSide0: 0,
      matchesOnSide1: 0,
      sidesBySeed: new Map<number, Set<0 | 1>>(),
    };

    // Which member of the sorted pairing occupied side 0 in this Match.
    const memberOnSide0: 0 | 1 = match.agentIds[0] === pairing[0] ? 0 : 1;
    if (memberOnSide0 === 0) {
      entry.matchesOnSide0 += 1;
    } else {
      entry.matchesOnSide1 += 1;
    }

    const seen = entry.sidesBySeed.get(match.seed) ?? new Set<0 | 1>();
    seen.add(memberOnSide0);
    entry.sidesBySeed.set(match.seed, seen);

    byPairing.set(key, entry);
  });

  return Object.freeze(
    [...byPairing.values()]
      .sort(
        (left, right) =>
          left.pairing[0].localeCompare(right.pairing[0]) ||
          left.pairing[1].localeCompare(right.pairing[1]),
      )
      .map((entry) => {
        const matchCount = entry.matchesOnSide0 + entry.matchesOnSide1;
        let mirroredSeeds = 0;
        for (const sides of entry.sidesBySeed.values()) {
          if (sides.size === 2) {
            mirroredSeeds += 1;
          }
        }

        const exclusions: PairingExclusion[] = [];
        if (matchCount < MINIMUM_MATCHES_PER_PAIRING) {
          exclusions.push('insufficient-matches');
        }
        if (mirroredSeeds < MINIMUM_MIRRORED_SEEDS_PER_PAIRING) {
          exclusions.push('insufficient-mirrored-seeds');
        }

        return Object.freeze({
          pairing: Object.freeze([entry.pairing[0], entry.pairing[1]]) as readonly [string, string],
          matches: matchCount,
          matchesBySide: Object.freeze([entry.matchesOnSide0, entry.matchesOnSide1]) as readonly [
            number,
            number,
          ],
          seeds: entry.sidesBySeed.size,
          mirroredSeeds,
          provisional: exclusions.length > 0,
          exclusions: Object.freeze(exclusions) as readonly PairingExclusion[],
          reason: describe({ matches: matchCount, mirroredSeeds, exclusions }),
        });
      }),
  );
}

/** Whether this pairing may contribute to a rating. The inverse of `provisional`. */
export function isPairingRatable(coverage: PairingCoverage): boolean {
  return !coverage.provisional;
}
