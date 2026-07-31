import type { CommandLog, DecisionEntry } from '@tokenbrawl/contracts';
import {
  REASONING_SIDECAR_VERSION,
  type ReasoningEntry,
  type ReasoningSidecar,
} from '../replay/sidecar';

/**
 * Story 4.2: the writer half of the reasoning sidecar.
 *
 * **Node-only, and under `src/testing/` for that reason.** Nothing shipped to
 * the browser needs to *produce* a sidecar -- the page only reads one -- and a
 * splitter in the bundle would be dead code that a later story mistakes for a
 * supported browser-side capability. The real producer is the tournament
 * runner (Story 5.2); this is the same operation applied to the committed demo
 * replay, so the page exercises the sidecar path against a real Match rather
 * than only against a fixture.
 *
 * The split is what AC3 is about. `reasoning` is the largest field a
 * Deployment log carries and it is the field a visitor needs last, so it comes
 * out of the document that playback blocks on and goes into one that playback
 * never waits for (AD-10).
 */

/** Path recorded in the log's `reasoningSidecar`, relative to the log itself. */
export const DEMO_SIDECAR_PATH = 'demo.reasoning.json';

/**
 * Moves reasoning out of a Command Log into a sidecar.
 *
 * `rawResponse` travels with it, with one exception that is not negotiable: an
 * entry whose `parseFailure` is true keeps its `rawResponse` inline, because
 * `command-log.schema.json`'s `allOf` requires the field to be present on such
 * an entry. A parse failure whose evidence had been moved to a sheddable file
 * would be a failure nobody could audit, which is exactly what Story 1.6's
 * "never retried, always recorded" discipline exists to prevent. The record is
 * duplicated rather than moved for those entries: the sidecar still carries it
 * so the reader has one uniform shape.
 */
export function splitReasoning(log: CommandLog): {
  readonly log: CommandLog;
  readonly sidecar: ReasoningSidecar;
} {
  const entries: ReasoningEntry[] = log.decisions.map((decision) => ({
    tick: decision.tick,
    agentIndex: decision.agentIndex,
    reasoning: decision.reasoning ?? null,
    rawResponse: decision.rawResponse ?? null,
    reflexMode: decision.reflexMode === true,
    parseFailure: decision.parseFailure === true,
  }));

  const stripped: DecisionEntry[] = log.decisions.map((decision) => {
    const { reasoning: _reasoning, rawResponse, ...rest } = decision;
    return decision.parseFailure === true
      ? { ...rest, rawResponse: rawResponse ?? null }
      : rest;
  });

  return {
    log: { ...log, decisions: stripped, reasoningSidecar: DEMO_SIDECAR_PATH },
    sidecar: {
      schemaVersion: REASONING_SIDECAR_VERSION,
      matchId: log.matchId,
      entries,
    },
  };
}
