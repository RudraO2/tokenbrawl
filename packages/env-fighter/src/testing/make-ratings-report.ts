/**
 * The committed Baseline Bot rating report (Story 7-2).
 *
 * Two artefacts carry ratings and only one of them can be byte-compared:
 *
 *   - `docs/reports/leaderboard.{json,md}` is written by `tokenbrawl
 *     leaderboard` from the real replay corpus, and CI rewrites it every
 *     tournament segment. A test pinning its bytes would go red on the first
 *     real run.
 *   - `docs/reports/baseline-ratings.{json,md}`, built here, is the Baseline Bot
 *     ladder rated by the very same functions. It needs no provider key,
 *     reproduces exactly from its seeds, and is recomputed and compared on every
 *     `npm test` -- which is what makes "the published numbers reproduce" (AC5)
 *     a gate rather than a claim.
 *
 * Pure builders only; file I/O belongs to `ratings.test.ts`, exactly as
 * `make-skill-gate-report.ts` and `make-side-advantage-report.ts` split. The
 * function that produced the committed bytes has to be the one the test re-runs.
 *
 * Regenerate with:
 *   TOKENBRAWL_WRITE_RATINGS_REPORT=1 npx vitest run --root packages/env-fighter \
 *     src/ratings.test.ts
 */

import type { AgentIdentity } from '@tokenbrawl/contracts';
import type { LeaderboardMatch, RatingTrack } from '../../../core/src/ratings';
import type { LeaderboardReportMeta } from '../../../core/src/ratings-report';
import { DRAW_BASIS_POINTS, WIN_BASIS_POINTS } from '../../../core/src/statistics';
import type { LadderRun } from './skill-ladder';

export const BASELINE_RATINGS_REPORT_PATH = 'docs/reports/baseline-ratings.json';
export const BASELINE_RATINGS_REPORT_MARKDOWN_PATH = 'docs/reports/baseline-ratings.md';

/**
 * Its own resampling seed, not the ladder's and not the side-advantage report's.
 *
 * Reusing another artefact's seed would resample this sample along the identical
 * index sequence, correlating two intervals a reader treats as independent
 * evidence -- the same reasoning `skill-gate.ts` applies per row, applied per
 * report.
 */
export const BASELINE_RATINGS_BOOTSTRAP_SEED = 20260802;
export const BASELINE_RATINGS_BOOTSTRAP_RESAMPLES = 2000;

function botIdentity(id: string): AgentIdentity {
  return { id, kind: 'bot' };
}

/**
 * The ladder's Matches as rating input.
 *
 * `LadderMatch.scoreBasisPoints` is scored from the *stronger*-listed bot's
 * point of view, which is the right frame for a skill gate and the wrong one
 * here: a rating needs to know who stood on which side and who won, with no
 * notion of who was expected to. The outcome is derived from the score rather
 * than recomputed from the Match, so there is one source of truth for who won.
 */
export function ladderLeaderboardMatches(run: LadderRun): readonly LeaderboardMatch[] {
  const matches: LeaderboardMatch[] = [];

  for (const pairing of run.pairings) {
    for (const match of pairing.matches) {
      const strongerOnSide0 = match.strongerAgentIndex === 0;
      const side0Score = strongerOnSide0
        ? match.scoreBasisPoints
        : WIN_BASIS_POINTS - match.scoreBasisPoints;

      matches.push({
        matchId: match.matchId,
        seed: match.seed,
        agents: strongerOnSide0
          ? [botIdentity(pairing.stronger), botIdentity(pairing.weaker)]
          : [botIdentity(pairing.weaker), botIdentity(pairing.stronger)],
        outcome:
          side0Score === DRAW_BASIS_POINTS ? 'draw' : side0Score === WIN_BASIS_POINTS ? 'p1' : 'p2',
      });
    }
  }

  return matches;
}

/**
 * Every ladder entrant is main-track.
 *
 * A Baseline Bot consumes no tokens, so there is no metering to be dishonest
 * about and nothing for a Metering Probe to classify -- `partitionByTrack` says
 * the same thing for the same reason. The map is built here rather than
 * defaulted inside `computeLeaderboard`, because a default is how INV-5 would
 * one day admit an unprobed Deployment by omission.
 */
export function ladderTracks(run: LadderRun): ReadonlyMap<string, RatingTrack> {
  const tracks = new Map<string, RatingTrack>();
  for (const pairing of run.pairings) {
    tracks.set(pairing.stronger, 'main');
    tracks.set(pairing.weaker, 'main');
  }
  return tracks;
}

export function baselineRatingsMeta(run: LadderRun): LeaderboardReportMeta {
  return {
    // The sprint-status key, not the dotted story number: `audit-invariants.sh`
    // reads a digit-dot-digit sequence anywhere under `packages/` as a
    // floating-point literal (INV-2) and does not exempt string contents.
    story: '7-2-ratings-with-confidence-intervals',
    title: 'Baseline Bot ratings',
    generatedBy:
      'TOKENBRAWL_WRITE_RATINGS_REPORT=1 npx vitest run --root packages/env-fighter src/ratings.test.ts',
    corpus: `the Baseline Bot ladder — ${String(run.pairings.length * run.seedCount * 2)} Matches over ${String(run.seedCount)} seeds from seed base ${String(run.seedBase)}, every seed played from both sides (AD-12)`,
    environment: run.environment,
    configHash: run.configHash,
  };
}
