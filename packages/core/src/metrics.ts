import type { CommandLog } from '@tokenbrawl/contracts';

/** Parse-failure rate for one Agent over one Match. */
export interface ParseFailureRate {
  readonly agentIndex: 0 | 1;
  readonly agentId: string;
  readonly decisionCount: number;
  readonly parseFailureCount: number;
  /** `parseFailureCount / decisionCount`, or `0` when `decisionCount` is 0 -- never `NaN`. */
  readonly parseFailureRate: number;
}

/**
 * Parse-failure rate per Agent for a completed Match (Story 1.6, AC4). Pure:
 * one pass over `log.decisions`, no I/O. Non-actionable ticks never reach a
 * `CommandLog` (`toDecisionEntry` filters them before this function ever
 * sees the log), so every entry here already represents a real Decision
 * Point this Agent was polled for.
 */
export function computeParseFailureRates(log: CommandLog): readonly [ParseFailureRate, ParseFailureRate] {
  const counts: [{ decisions: number; failures: number }, { decisions: number; failures: number }] = [
    { decisions: 0, failures: 0 },
    { decisions: 0, failures: 0 },
  ];

  for (const entry of log.decisions) {
    const bucket = counts[entry.agentIndex];
    bucket.decisions += 1;
    if (entry.parseFailure === true) {
      bucket.failures += 1;
    }
  }

  const rateFor = (agentIndex: 0 | 1): ParseFailureRate => {
    const { decisions, failures } = counts[agentIndex];
    return {
      agentIndex,
      agentId: log.agents[agentIndex].id,
      decisionCount: decisions,
      parseFailureCount: failures,
      parseFailureRate: decisions === 0 ? 0 : failures / decisions,
    };
  };

  return [rateFor(0), rateFor(1)];
}
