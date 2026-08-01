import type { AgentIdentity } from '@tokenbrawl/contracts';

/**
 * Story 4.6: AD-11's "BYOK Matches never enter the leaderboard", as a
 * predicate rather than as a sentence somebody has to remember.
 *
 * It lives in `packages/core` and not in `apps/web`, even though 4.6 is the
 * story that needs it, because the *consumer* that must not get this wrong is
 * Story 7.2's rating computation. A BYOK Match is run on a key nobody else
 * controls, against a model nobody else can verify was the model claimed, at a
 * quota that shapes how many Decision Points it survived. Rating it would let
 * any visitor move a published number. Two implementations of that rule -- one
 * in the page that produces the log, one in the ranker that consumes it -- is
 * one implementation too many, so there is exactly this one and both import it.
 *
 * Deliberately free of Node built-ins and of the schema validator, so
 * `apps/web` can import it: `command-log.ts` reaches `node:crypto` through
 * `canonical-hash.ts` and pulls in Ajv, which Vite cannot bundle for a browser
 * (see `apps/web/src/source-discipline.test.ts`). The check itself needs
 * neither -- it reads two fields off an already-validated Command Log.
 *
 * The shape it accepts is deliberately narrower than `CommandLog`: everything
 * this rule depends on is in `agents`, and a parameter typed to the whole
 * frozen document would force every caller to have one when a pair of agent
 * identities is all that is being judged.
 */

/** Why a Match is not ratable. One member today; a union so 7.2 can add without changing shape. */
export type RatingExclusion = 'byok';

export interface RatingEligibility {
  readonly eligible: boolean;
  readonly exclusion: RatingExclusion | null;
  /**
   * Present exactly when excluded. Displayable text: the page that produced the
   * Match says this next to it, and a leaderboard generator can say why a row
   * is missing rather than leaving a silent gap.
   */
  readonly reason: string | null;
}

/** The fields this rule reads. A full `CommandLog` satisfies it structurally. */
export interface RatableLog {
  readonly agents: readonly AgentIdentity[];
}

const BYOK_PROVIDER = 'byok';

const BYOK_REASON =
  'Run in a visitor\'s own browser with their own key (provider: "byok"). BYOK Matches are excluded from all rating computation (AD-11).';

/**
 * Whether this Match may contribute to a rating, and why not when it may not.
 *
 * One BYOK Agent is enough to exclude the Match. A Deployment on somebody's
 * personal key fighting a Baseline Bot is exactly as unverifiable as two of
 * them, and "half the Match was auditable" is not a thing a rating can use.
 */
export function ratingEligibility(log: RatableLog): RatingEligibility {
  const byok = log.agents.some((agent) => agent.deployment?.provider === BYOK_PROVIDER);
  return Object.freeze({
    eligible: !byok,
    exclusion: byok ? ('byok' as const) : null,
    reason: byok ? BYOK_REASON : null,
  });
}

export function isRatingEligible(log: RatableLog): boolean {
  return ratingEligibility(log).eligible;
}
