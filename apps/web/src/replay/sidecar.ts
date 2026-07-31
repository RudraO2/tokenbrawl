/**
 * Story 4.2: the reasoning sidecar, and the four states a reader can be in.
 *
 * `command-log.schema.json` already carries `reasoningSidecar` -- "relative
 * path to a sidecar holding reasoning text, when reasoning has been
 * externalised to keep this document small. When present, decision entries
 * omit 'reasoning' and the sidecar is fetched lazily. Playback MUST NOT block
 * on it." The frozen contract names the mechanism and states the rule; it does
 * not specify the sidecar's own shape, so that is defined here, in the only
 * package that reads one.
 *
 * ## Why a state machine rather than an optional value
 *
 * AD-10 makes reasoning sheddable, which means a reader must distinguish four
 * situations that an `undefined` collapses into one:
 *
 * - `inline`      -- the log carries its own reasoning. Nothing to fetch.
 * - `loading`     -- the log names a sidecar and it has not arrived yet.
 * - `ready`       -- the sidecar arrived and was accepted.
 * - `unavailable` -- it will not arrive, and we know why.
 *
 * AC4 is precisely the difference between the second and the fourth: a visitor
 * who hovers before the sidecar lands must see a loading state, never an error
 * and never a blank. Collapsing those two is how a slow network gets reported
 * to a viewer as a missing model response.
 *
 * ## INV-3
 *
 * Nothing here times anything. The `loading` state is a state, not a duration:
 * no elapsed value is computed, none is displayed, and there is no progress
 * affordance whose behaviour could vary with how long a Deployment thought.
 * `source-discipline.test.ts` sweeps this file along with the rest of
 * `apps/web/src` for every wall-clock and latency token.
 */

/**
 * Exact-match, for the same reason `assertSchemaVersion` is (AD-3): a partial
 * read of an evolved document is how a viewer is shown reasoning that belongs
 * to a field that has since changed meaning.
 */
export const REASONING_SIDECAR_VERSION = '1.0.0';

export interface ReasoningEntry {
  readonly tick: number;
  readonly agentIndex: 0 | 1;
  /** `null` when the Agent reported none -- a Baseline Bot, or a provider that returned no text. */
  readonly reasoning: string | null;
  /** Verbatim provider response. Required on the entry itself when `parseFailure` is true. */
  readonly rawResponse: string | null;
  readonly reflexMode: boolean;
  readonly parseFailure: boolean;
}

export interface ReasoningSidecar {
  readonly schemaVersion: typeof REASONING_SIDECAR_VERSION;
  /**
   * The Command Log this sidecar belongs to.
   *
   * Load-bearing rather than decorative: a sidecar from another Match would
   * attribute one Deployment's deliberation to another, which is a worse
   * outcome than showing nothing at all. `validateReasoningSidecar` refuses it.
   */
  readonly matchId: string;
  readonly entries: readonly ReasoningEntry[];
}

export type ReasoningStatus = 'inline' | 'loading' | 'ready' | 'unavailable';

export interface ReasoningLookup {
  readonly status: ReasoningStatus;
  /** Whether a record exists for this exact `(tick, agentIndex)`. */
  readonly found: boolean;
  readonly reasoning: string | null;
  readonly rawResponse: string | null;
  readonly reflexMode: boolean;
  readonly parseFailure: boolean;
}

export interface ReasoningSource {
  readonly status: () => ReasoningStatus;
  /** Why the sidecar will not arrive, when the status is `unavailable`. */
  readonly reason: () => string | null;
  readonly adopt: (sidecar: ReasoningSidecar) => void;
  readonly markUnavailable: (reason: string) => void;
  readonly at: (tick: number, agentIndex: 0 | 1) => ReasoningLookup;
}

/** The decision fields a reasoning lookup needs. A structural subset of `DecisionEntry`. */
interface ReasoningBearingEntry {
  readonly tick: number;
  readonly agentIndex: 0 | 1;
  readonly reasoning?: string | null;
  readonly rawResponse?: string | null;
  readonly reflexMode?: boolean;
  readonly parseFailure?: boolean;
}

interface ReasoningBearingLog {
  readonly reasoningSidecar?: string | null;
  readonly decisions: readonly ReasoningBearingEntry[];
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/** `(tick, agentIndex)` is the Decision Point identity everywhere in this repo. */
function keyOf(tick: number, agentIndex: number): string {
  return `${String(tick)}:${String(agentIndex)}`;
}

function assertEntry(candidate: unknown, index: number): ReasoningEntry {
  if (!isObject(candidate)) {
    throw new Error(`validateReasoningSidecar: entry ${String(index)} is not an object.`);
  }

  const { tick, agentIndex, reasoning, rawResponse, reflexMode, parseFailure } = candidate;

  if (!Number.isSafeInteger(tick) || (tick as number) < 0) {
    throw new Error(
      `validateReasoningSidecar: entry ${String(index)} has a non-integer tick (${String(tick)}).`,
    );
  }
  if (agentIndex !== 0 && agentIndex !== 1) {
    throw new Error(
      `validateReasoningSidecar: entry ${String(index)} has agentIndex ${String(agentIndex)}, expected 0 or 1.`,
    );
  }
  for (const [name, value] of [
    ['reasoning', reasoning],
    ['rawResponse', rawResponse],
  ] as const) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(
        `validateReasoningSidecar: entry ${String(index)} field ${name} must be a string or null.`,
      );
    }
  }
  for (const [name, value] of [
    ['reflexMode', reflexMode],
    ['parseFailure', parseFailure],
  ] as const) {
    if (typeof value !== 'boolean') {
      throw new Error(
        `validateReasoningSidecar: entry ${String(index)} field ${name} must be a boolean.`,
      );
    }
  }

  return Object.freeze({
    tick: tick as number,
    agentIndex,
    reasoning: reasoning as string | null,
    rawResponse: rawResponse as string | null,
    reflexMode: reflexMode as boolean,
    parseFailure: parseFailure as boolean,
  });
}

/**
 * Validates a fetched sidecar against the log that named it.
 *
 * Version before anything else, then shape, then the binding. The order is the
 * point: a document of an unknown version must be rejected before a single one
 * of its other fields is interpreted (AD-3), because interpreting it is exactly
 * the partial read the rule exists to prevent.
 */
export function validateReasoningSidecar(candidate: unknown, matchId: string): ReasoningSidecar {
  if (!isObject(candidate)) {
    throw new Error('validateReasoningSidecar: the sidecar is not an object.');
  }
  if (candidate.schemaVersion !== REASONING_SIDECAR_VERSION) {
    throw new Error(
      `validateReasoningSidecar: unsupported schemaVersion ${String(candidate.schemaVersion)} (expected ${REASONING_SIDECAR_VERSION}).`,
    );
  }
  if (typeof candidate.matchId !== 'string' || candidate.matchId.length === 0) {
    throw new Error('validateReasoningSidecar: the sidecar carries no matchId.');
  }
  if (candidate.matchId !== matchId) {
    throw new Error(
      `validateReasoningSidecar: this sidecar belongs to Match ${candidate.matchId}, not ${matchId}.`,
    );
  }
  if (!Array.isArray(candidate.entries)) {
    throw new Error('validateReasoningSidecar: entries must be an array.');
  }

  const entries = candidate.entries.map((entry, index) => assertEntry(entry, index));

  const seen = new Set<string>();
  for (const entry of entries) {
    const key = keyOf(entry.tick, entry.agentIndex);
    if (seen.has(key)) {
      // Two records for one Decision Point means one of them is wrong and
      // nothing distinguishes which. Refusing the document is the only honest
      // outcome; picking the first would silently publish a coin flip.
      throw new Error(`validateReasoningSidecar: duplicate entry for Decision Point ${key}.`);
    }
    seen.add(key);
  }

  return Object.freeze({
    schemaVersion: REASONING_SIDECAR_VERSION,
    matchId: candidate.matchId,
    entries: Object.freeze(entries),
  });
}

function lookupFrom(status: ReasoningStatus, entry: ReasoningEntry | undefined): ReasoningLookup {
  if (entry === undefined) {
    return Object.freeze({
      status,
      found: false,
      reasoning: null,
      rawResponse: null,
      reflexMode: false,
      parseFailure: false,
    });
  }
  return Object.freeze({
    status,
    found: true,
    reasoning: entry.reasoning,
    rawResponse: entry.rawResponse,
    reflexMode: entry.reflexMode,
    parseFailure: entry.parseFailure,
  });
}

/**
 * Builds the reader for one log.
 *
 * The initial status is decided by the log alone: a log that carries its own
 * reasoning is `inline` and never fetches anything, and a log that names a
 * sidecar starts `loading` from the moment the film exists -- before the fetch
 * is even issued. That ordering is what makes AC4 reachable: a visitor who
 * hovers in the first hundred milliseconds gets a loading state rather than a
 * source that has not been told what it is yet.
 *
 * An entry present in the log is still readable in the `loading` state. A
 * parse-failure entry keeps its `rawResponse` inline (the frozen schema
 * requires it), so hovering a failure during a slow sidecar fetch shows the
 * failure rather than a placeholder.
 */
export function createReasoningSource(log: ReasoningBearingLog): ReasoningSource {
  const inlineEntries = new Map<string, ReasoningEntry>();
  for (const decision of log.decisions) {
    inlineEntries.set(
      keyOf(decision.tick, decision.agentIndex),
      Object.freeze({
        tick: decision.tick,
        agentIndex: decision.agentIndex,
        reasoning: decision.reasoning ?? null,
        rawResponse: decision.rawResponse ?? null,
        reflexMode: decision.reflexMode === true,
        parseFailure: decision.parseFailure === true,
      }),
    );
  }

  const named = typeof log.reasoningSidecar === 'string' && log.reasoningSidecar.length > 0;

  // Closure state, not a module-level binding: `source-discipline.test.ts`
  // bans the latter, and per-source state is what lets two logs be open at
  // once without one clobbering the other's status.
  const state: {
    status: ReasoningStatus;
    reason: string | null;
    entries: Map<string, ReasoningEntry> | null;
  } = {
    status: named ? 'loading' : 'inline',
    reason: null,
    entries: null,
  };

  return Object.freeze({
    status: () => state.status,
    reason: () => state.reason,

    adopt: (sidecar: ReasoningSidecar): void => {
      const entries = new Map<string, ReasoningEntry>();
      for (const entry of sidecar.entries) {
        entries.set(keyOf(entry.tick, entry.agentIndex), entry);
      }
      state.entries = entries;
      state.status = 'ready';
      state.reason = null;
    },

    markUnavailable: (reason: string): void => {
      // Terminal, and deliberately reachable from `ready` as well as from
      // `loading`: whatever went wrong, a source that stops answering must say
      // so rather than keep serving a half-populated map.
      state.entries = null;
      state.status = 'unavailable';
      state.reason = reason;
    },

    at: (tick: number, agentIndex: 0 | 1): ReasoningLookup => {
      const key = keyOf(tick, agentIndex);
      // The sidecar wins when it has the record; the log's own entry is the
      // fallback in every other state. One lookup, four states, so the panel
      // has a single code path (AD-10).
      const entry = state.entries?.get(key) ?? inlineEntries.get(key);
      return lookupFrom(state.status, entry);
    },
  });
}
