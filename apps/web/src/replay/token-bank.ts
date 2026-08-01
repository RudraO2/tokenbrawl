import { BASIS_POINTS_FULL } from './film';

/**
 * Story 4.4: reading the Token Bank out of a Command Log.
 *
 * The story's design goal is stated in the user story itself -- "a visitor with
 * no context works out on their own that the fighter is running out of
 * thinking" -- and it turns on the meter being a *level* a viewer watches
 * drain, not a number that appears and disappears.
 *
 * Three facts about the data shape everything here.
 *
 * **The bank changes only when the Agent is polled.** A fighter inside a
 * Commitment Window is never asked for an Action, so no `DecisionEntry` exists
 * at that tick and `bankRemaining` is unchanged rather than absent. Reading the
 * level therefore walks back to this Agent's most recent poll, the same shape
 * as `resolveDecision` in `decision-point.ts` and for the same reason. Drawing
 * nothing at an unpolled position would make the meter flicker in and out for
 * a large share of the Match.
 *
 * **A Baseline Bot has no bank at all**, which is not the same fact as a bank
 * at zero (AC3). `runMatch` writes `bankRemaining` only for a metered call, and
 * the frozen contract says so: the field is "absent for a Baseline Bot (it
 * consumes nothing)". So `tracked` is false for such an Agent and it gets no
 * meter -- a bot displaying a full Token Bank would be a lie about the thing
 * the benchmark measures.
 *
 * **The level is read, never re-derived.** Subtracting `tokensSpent` as
 * playback advances would look equivalent and is not: Story 3.5's prompt
 * caching bills `tokensSpent - cachedTokens`, and a Metering Probe result
 * (`tokensSpent: null`) debits nothing at all. The log records what the engine
 * actually charged, and that is the only number the HUD may show.
 *
 * **INV-3.** A level, never a rate. Nothing here divides by a duration, and
 * two Matches with identical `bankRemaining` sequences produce identical HUDs
 * however long either Deployment took to think.
 */

export interface BankReading {
  /** `bankRemaining` exactly as the log recorded it. */
  readonly remaining: number;
  readonly start: number;
  /**
   * 0..10000. Integer basis points, `Math.floor`-derived.
   *
   * The same convention as `RenderFrame.progressBasisPoints`: the player keeps
   * every ratio an integer and lets the renderer be the only place a float
   * appears, and then only as a pixel.
   */
  readonly filledBasisPoints: number;
  /** The moment the benchmark turns on: Reflex Mode from here. */
  readonly exhausted: boolean;
}

export interface BankReadout {
  /** False for an Agent that records no `bankRemaining` anywhere -- a Baseline Bot. */
  readonly tracked: (agentIndex: 0 | 1) => boolean;
  /**
   * The level at this playback position.
   *
   * `null` only when the Agent has no Token Bank at all. Never null merely
   * because it was not polled here.
   */
  readonly at: (decisionPoint: number, agentIndex: 0 | 1) => BankReading | null;
}

interface BankBearingLog {
  readonly tokenBankStart?: number;
  readonly decisions: readonly {
    readonly tick: number;
    readonly agentIndex: 0 | 1;
    readonly bankRemaining?: number;
  }[];
}

export function createBankReadout(log: BankBearingLog, ticksPerDecision: number): BankReadout {
  if (!Number.isSafeInteger(ticksPerDecision) || ticksPerDecision <= 0) {
    throw new Error(
      `createBankReadout: ticksPerDecision must be a positive safe integer, got ${String(ticksPerDecision)}.`,
    );
  }

  const levels: Map<number, number>[] = [new Map(), new Map()];
  let highest = 0;

  for (const entry of log.decisions) {
    const level = entry.bankRemaining;
    // A non-integer or negative level is a malformed document rather than an
    // untracked Agent; skipping it keeps one bad entry from deciding that a
    // whole Deployment has no bank.
    if (level === undefined || !Number.isSafeInteger(level) || level < 0) {
      continue;
    }
    levels[entry.agentIndex].set(entry.tick, level);
    highest = Math.max(highest, level);
  }

  // `tokenBankStart` is optional in the frozen schema, so a log that omits it
  // still has to produce a meter with a sane full mark. The highest level ever
  // recorded is the honest fallback: the bank only ever decreases, so the first
  // reading is the closest thing to a starting budget the document contains.
  const start = Number.isSafeInteger(log.tokenBankStart) ? (log.tokenBankStart as number) : highest;

  const reading = (remaining: number): BankReading =>
    Object.freeze({
      remaining,
      start,
      // A start of zero would divide by zero and paint the bar at NaN width,
      // which the canvas silently draws as nothing at all.
      filledBasisPoints:
        start <= 0
          ? 0
          : Math.min(BASIS_POINTS_FULL, Math.floor((Math.max(0, remaining) * BASIS_POINTS_FULL) / start)),
      exhausted: remaining <= 0,
    });

  return Object.freeze({
    tracked: (agentIndex: 0 | 1): boolean => levels[agentIndex].size > 0,

    at: (decisionPoint: number, agentIndex: 0 | 1): BankReading | null => {
      const recorded = levels[agentIndex];
      if (recorded.size === 0) {
        return null;
      }
      if (!Number.isSafeInteger(decisionPoint) || decisionPoint < 0) {
        return reading(start);
      }

      for (let candidate = decisionPoint; candidate >= 0; candidate -= 1) {
        const level = recorded.get(candidate * ticksPerDecision);
        if (level !== undefined) {
          return reading(level);
        }
      }

      // Before this Agent's first poll it has spent nothing, so the bank is
      // full. Showing an empty meter there would announce Reflex Mode at the
      // top of every Match.
      return reading(start);
    },
  });
}
