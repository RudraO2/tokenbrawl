import {
  ACTIONS,
  ACTIONS_V2,
  assertSchemaVersion,
  assertSchemaVersionV2,
  FALLBACK_ACTION,
  type CommandLog,
  type CommandLogV2,
  type DecisionEntry,
  type DecisionEntryV2,
  type EnvironmentAdapter,
  type LoggedAction,
  type LoggedActionV2,
  type TerminalResult,
} from '@tokenbrawl/contracts';

/**
 * The re-drive half of INV-2 ("replaying a Command Log reproduces the
 * Final-State Hash bit-identically").
 *
 * This module is deliberately the most dependency-starved file in the
 * package: it imports **types** from `@tokenbrawl/contracts` plus the single
 * value `assertSchemaVersion`, and nothing else. Not `./command-log`, which
 * would pull in Ajv, whose `ajv/dist/2020` specifier is extensionless and
 * therefore unresolvable by a plain `node --experimental-strip-types` child
 * process -- verified empirically. The cross-process half of the determinism
 * gate (100 replays in 100 separate OS processes, which is what catches
 * global-state leakage that same-process testing hides) depends on this file
 * staying loadable by a bare Node child. Adding an import here is a
 * load-bearing decision, not a convenience.
 *
 * It is also I/O-free (AD-1: the core is pure). Reading a Command Log off
 * disk lives in `src/testing/` harness code and in the tests that drive it.
 */

/**
 * The narrowest shape `assertSchemaVersion` can be handed. Not exported:
 * callers pass a `CommandLog` or a raw `JSON.parse` result, and the
 * parameter is typed `unknown` precisely so neither needs a cast at the call
 * site.
 */
type VersionedCandidate = { readonly schemaVersion?: unknown };

export interface ReplayResult {
  /** `env.hash(state)` of the state the replay actually arrived at. */
  readonly finalStateHash: string;
  /** The `TerminalResult` the replay actually arrived at, recomputed -- never copied from the log. */
  readonly result: TerminalResult;
  /** Ticks the replay advanced before reaching a terminal state. */
  readonly ticksReplayed: number;
  /** Whether `finalStateHash` equals the log's recorded `finalStateHash`. */
  readonly matchesRecordedHash: boolean;
  /**
   * Whether the recomputed `result` agrees with the log's recorded `result`.
   *
   * Separate from `matchesRecordedHash` because the Final-State Hash covers
   * canonical simulation state, not the `result` block -- so a log can carry a
   * truthful hash and a forged outcome, and `result` is the field a
   * leaderboard actually reads.
   */
  readonly matchesRecordedResult: boolean;
  /**
   * Human-readable notes about entries the log contained that the
   * environment's own actionability disagreed with, and vice versa. Empty for
   * a faithful log. Reported rather than thrown so that a tampered log still
   * yields a hash (which is what proves the gate can fail) instead of
   * crashing before the hash is computed.
   */
  readonly divergences: readonly string[];
}

/**
 * Every value the schema's `decision.action` enum admits, derived from the
 * frozen contract rather than re-listed here -- a second hand-written copy of
 * the enum is exactly how a replayer and a writer drift apart.
 */
const LOGGED_ACTIONS: ReadonlySet<string> = new Set<string>([...ACTIONS, FALLBACK_ACTION]);

/** The v2 sibling of `LOGGED_ACTIONS`: the six v2 Actions plus the Fallback Action. */
const LOGGED_ACTIONS_V2: ReadonlySet<string> = new Set<string>([...ACTIONS_V2, FALLBACK_ACTION]);

/** The frozen schema's bound on `seed` (`{type: integer, minimum: 0, maximum: 4294967295}`). */
const MAX_UINT32 = 0xffff_ffff;

/** The frozen schema's `$defs.sha256` pattern, which `finalStateHash` `$ref`s. */
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Ceiling on how many divergences are reported individually.
 *
 * One note per unconsumed entry is unbounded in the log's own size, and
 * `replay-child.ts` joins the whole list onto stderr. `spawnSync` caps a
 * child's captured stderr at 1 MiB by default and reports the overflow as
 * `error: ENOBUFS` with `status`/`stdout`/`stderr` all null -- which the
 * parent's spawn-failure path attributes to EAGAIN/EMFILE, the flake mode of
 * 100 rapid spawns. So an uncapped list turns *successfully detected tampering*
 * into what reads as infrastructure noise. The count is preserved in a
 * trailing summary, so nothing is silently lost.
 */
const MAX_REPORTED_DIVERGENCES = 100;

function decisionKey(tick: number, agentIndex: 0 | 1): string {
  return `${tick}:${agentIndex}`;
}

/**
 * Whether the recomputed `TerminalResult` agrees with the one the log recorded.
 *
 * Compared field by field rather than by `JSON.stringify`: the recomputed
 * result is built by the adapter and the recorded one comes out of `JSON.parse`,
 * so key order is not a property either side controls and a stringify
 * comparison would report a false contradiction between two identical results.
 *
 * A malformed or absent `result` returns `false` rather than throwing. Unlike
 * `decisions`, this block is never fed back into the simulation, so it cannot
 * corrupt a replay -- it can only fail to describe one.
 */
function recordedResultMatches(recomputed: TerminalResult, recorded: unknown): boolean {
  if (typeof recorded !== 'object' || recorded === null) {
    return false;
  }

  const { outcome, endTick, endReason, healthRemaining } = recorded as Record<string, unknown>;

  return (
    outcome === recomputed.outcome &&
    endTick === recomputed.endTick &&
    endReason === recomputed.endReason &&
    Array.isArray(healthRemaining) &&
    healthRemaining.length === recomputed.healthRemaining.length &&
    healthRemaining.every((value, index) => value === recomputed.healthRemaining[index])
  );
}

/**
 * Validates one decision entry's shape before it can reach `env.step`.
 *
 * `replayCommandLog` takes `unknown` and runs no JSON Schema validation (Ajv
 * cannot be imported here -- see the module docblock), so it is the only thing
 * standing between a tampered log and the simulation. An unrecognised Action
 * is a *malformed* log, not a divergence: `damageFor()` in the mock adapter
 * falls through to zero damage for anything it does not recognise, so a
 * forged `"nuke"` would otherwise be silently downgraded to a no-op and
 * replay would return a plausible hash with no complaint.
 */
function assertDecisionEntry(entry: unknown, index: number): asserts entry is DecisionEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`Malformed Command Log: decision entry ${index} is not an object.`);
  }

  const { tick, agentIndex, action } = entry as Record<string, unknown>;

  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0) {
    throw new Error(`Malformed Command Log: decision entry ${index} has a non-integer tick (${String(tick)}).`);
  }

  if (agentIndex !== 0 && agentIndex !== 1) {
    throw new Error(`Malformed Command Log: decision entry ${index} has agentIndex ${String(agentIndex)}, which is neither 0 nor 1.`);
  }

  if (typeof action !== 'string' || !LOGGED_ACTIONS.has(action)) {
    throw new Error(
      `Malformed Command Log: decision entry ${index} (tick ${tick}, agentIndex ${agentIndex}) has unknown action "${String(action)}".`,
    );
  }
}

/**
 * Indexes the log's decisions by `(tick, agentIndex)`.
 *
 * A duplicate key throws rather than being reported as a divergence: two
 * entries for the same Agent at the same Decision Point is a *structurally
 * malformed* log, not a log that merely disagrees with the environment.
 * Silently keeping the first (or the last) would make the replayed hash
 * depend on an arbitrary tie-break rule that nothing else in the system
 * shares.
 *
 * Canonical ordering is enforced here for the same reason. The frozen schema
 * states it outright ("Ordered by tick ascending, then by agentIndex
 * ascending"), but JSON Schema cannot express array ordering, so Ajv does not
 * check it and `validateCommandLog` never will. Keying by `(tick, agentIndex)`
 * makes the replay itself order-blind, which means that without this check a
 * shuffled `decisions` array -- a document that violates the one cross-boundary
 * format in the system -- replays to the recorded hash and is pronounced
 * faithful. This is the only place on the replay path where the property is
 * checkable at all.
 */
function indexDecisions(decisions: unknown): Map<string, DecisionEntry> {
  if (!Array.isArray(decisions)) {
    throw new Error(
      `Malformed Command Log: decisions must be an array, got ${decisions === null ? 'null' : typeof decisions}.`,
    );
  }

  const byKey = new Map<string, DecisionEntry>();
  let previous: DecisionEntry | undefined;

  for (const [index, candidate] of decisions.entries()) {
    assertDecisionEntry(candidate, index);
    const entry: DecisionEntry = candidate;
    const key = decisionKey(entry.tick, entry.agentIndex);
    if (byKey.has(key)) {
      throw new Error(
        `Malformed Command Log: duplicate decision entry for tick ${entry.tick}, agentIndex ${entry.agentIndex}.`,
      );
    }
    if (
      previous !== undefined &&
      (entry.tick < previous.tick ||
        (entry.tick === previous.tick && entry.agentIndex <= previous.agentIndex))
    ) {
      throw new Error(
        `Malformed Command Log: decision entry ${index} (tick ${entry.tick}, agentIndex ${entry.agentIndex}) ` +
          `does not follow entry ${index - 1} (tick ${previous.tick}, agentIndex ${previous.agentIndex}); ` +
          'the schema requires decisions ordered by tick ascending, then agentIndex ascending.',
      );
    }
    byKey.set(key, entry);
    previous = entry;
  }

  return byKey;
}

/**
 * Re-drives `env` from `log.seed` using only the Actions the log persisted,
 * and returns the recomputed Final-State Hash.
 *
 * The loop mirrors `runMatch`'s Decision-Point structure exactly -- ask
 * `env.isActionable` for both Agents against the *pre-step* state, assemble
 * one `[LoggedAction | null, LoggedAction | null]` pair, call `env.step`
 * once, advance by `env.ticksPerDecision`, re-test `env.terminal` -- with the
 * Agent poll replaced by a lookup of the log's entry for that
 * `(tick, agentIndex)`. An **absent** entry for an Agent the environment
 * reports as non-actionable maps to `null`, never to a substituted default
 * Action: `buildCommandLog` deliberately omits entries for Agents inside a
 * Commitment Window (they were never polled), so absence is the normal,
 * expected encoding of "did not act" rather than missing data.
 *
 * `configHash` is deliberately *not* verified here. A `CommandLog` carries
 * the hash but never the config itself, so replay cannot reconstruct the
 * adapter from the log alone -- the adapter is supplied by the caller.
 * Replay checks the identity it can check (`env.id`/`env.version`) and
 * leaves the config check to the caller; `computeConfigHash` lives in
 * `./command-log`, and importing it would drag Ajv into the child process.
 */
export function replayCommandLog<TState>(
  candidate: unknown,
  env: EnvironmentAdapter<TState>,
): ReplayResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(
      `replayCommandLog: expected a Command Log object, got ${
        candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate
      }`,
    );
  }

  // Before ANY other field is read. An unrecognised schemaVersion must be a
  // hard fail with zero partial parsing -- a half-read log from an evolved
  // schema is how a leaderboard quietly becomes wrong.
  const versioned = candidate as VersionedCandidate;
  assertSchemaVersion(versioned);
  const log: CommandLog = versioned;

  // Named guards, not an implicit TypeError from reaching into an absent
  // field. This function's failures are read as a stack trace on a spawned
  // child's stderr, where "Cannot read properties of undefined (reading 'id')"
  // says nothing about which document was malformed or how.
  const environment = (log as { environment?: unknown }).environment;
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    // `Array.isArray` for the same reason the top-level guard above has it:
    // `typeof [] === 'object'`, so an array-valued environment block otherwise
    // sails past this guard and fails four lines later as
    // "log records undefined@undefined", which is precisely the uninformative
    // message this guard exists to replace.
    throw new Error('Malformed Command Log: the environment block is missing or is not an object.');
  }

  if (!Number.isSafeInteger(log.seed) || log.seed < 0 || log.seed > MAX_UINT32) {
    // `env.reset` coerces with `seed | 0`, so a missing or non-numeric seed
    // would silently replay as seed 0 and return a perfectly plausible hash.
    // The range matters for the same reason and is not cosmetic: `seed | 0`
    // truncates, so 42 + 2**32 is a safe integer that replays as 42 -- a log
    // whose seed contradicts its own contents, passing the gate clean. The
    // frozen schema pins seed to a uint32, and replay runs no Ajv by design
    // (see the module docblock), so this guard is the only place that bound
    // exists on the replay path.
    throw new Error(`Malformed Command Log: seed must be a uint32, got ${String(log.seed)}.`);
  }

  if (typeof log.finalStateHash !== 'string' || !SHA256_HEX.test(log.finalStateHash)) {
    // The one field the whole gate is about. Left unguarded it degrades to
    // `matchesRecordedHash: false`, which any consumer that merely prints the
    // recomputed hash -- the spawned child, before it learned to check --
    // reports as a successful replay of a log that records no hash at all.
    throw new Error(
      `Malformed Command Log: finalStateHash must be a lowercase 64-character hex digest, got ${String(log.finalStateHash)}.`,
    );
  }

  if (env.id !== log.environment.id || env.version !== log.environment.version) {
    // Replaying a log through the wrong adapter would produce a
    // well-formed-looking hash that means nothing. Fail honestly instead.
    throw new Error(
      `Environment mismatch: log records ${log.environment.id}@${log.environment.version} ` +
        `but the supplied adapter is ${env.id}@${env.version}.`,
    );
  }

  const byKey = indexDecisions(log.decisions);
  const consumed = new Set<string>();
  const divergences: string[] = [];
  let suppressedDivergences = 0;

  const reportDivergence = (note: string): void => {
    if (divergences.length < MAX_REPORTED_DIVERGENCES) {
      divergences.push(note);
      return;
    }
    suppressedDivergences += 1;
  };

  // The loop advances by `env.ticksPerDecision`, so a non-positive pacing
  // value means `tick` never grows and no tick-valued bound can ever fire.
  // Budget Decision Points instead, and reject an adapter whose own pacing
  // makes termination unprovable -- a replayer that hangs inside a spawned
  // child is strictly worse than one that fails, because the parent's test
  // timeout cannot interrupt a blocked synchronous spawn.
  if (!Number.isSafeInteger(env.ticksPerDecision) || env.ticksPerDecision <= 0) {
    throw new Error(`Unusable adapter: ticksPerDecision must be a positive integer, got ${String(env.ticksPerDecision)}.`);
  }
  if (!Number.isSafeInteger(env.maxTicks) || env.maxTicks <= 0) {
    throw new Error(`Unusable adapter: maxTicks must be a positive integer, got ${String(env.maxTicks)}.`);
  }
  const decisionPointBudget = Math.ceil(env.maxTicks / env.ticksPerDecision) + 1;

  let state = env.reset(log.seed);
  let tick = 0;
  let decisionPoints = 0;
  let terminalResult = env.terminal(state);

  while (terminalResult === null) {
    decisionPoints += 1;
    if (decisionPoints > decisionPointBudget) {
      // Unreachable for a well-behaved adapter (`terminal` must fire by
      // `maxTicks`), but this is the last line of defence against a hang.
      throw new Error(
        `Replay exceeded its Decision-Point budget (${decisionPointBudget}) at tick ${tick} without reaching a terminal state.`,
      );
    }

    const actionsForStep: [LoggedAction | null, LoggedAction | null] = [null, null];

    for (const agentIndex of [0, 1] as const) {
      const key = decisionKey(tick, agentIndex);
      const entry = byKey.get(key);

      if (!env.isActionable(state, agentIndex)) {
        if (entry !== undefined) {
          // The log claims this Agent acted, but this environment says it was
          // inside a Commitment Window and was never polled. Ignore the entry
          // for stepping (applying it would let a tampered log drive a state
          // the simulation's own rules forbid) and report it.
          consumed.add(key);
          reportDivergence(
            `tick ${tick}, agentIndex ${agentIndex}: log records action "${entry.action}" but the environment reports the Agent as non-actionable; entry ignored.`,
          );
        }
        continue;
      }

      if (entry === undefined) {
        reportDivergence(
          `tick ${tick}, agentIndex ${agentIndex}: the environment reports the Agent as actionable but the log has no entry; replayed as no action.`,
        );
        continue;
      }

      consumed.add(key);
      actionsForStep[agentIndex] = entry.action;
    }

    state = env.step(state, actionsForStep);
    tick += env.ticksPerDecision;
    terminalResult = env.terminal(state);
  }

  for (const [key, entry] of byKey) {
    if (!consumed.has(key)) {
      reportDivergence(
        `tick ${entry.tick}, agentIndex ${entry.agentIndex}: log entry lies outside the replayed Match (action "${entry.action}"); entry ignored.`,
      );
    }
  }

  if (suppressedDivergences > 0) {
    divergences.push(
      `... and ${suppressedDivergences} further divergences, not reported individually (capped at ${MAX_REPORTED_DIVERGENCES}).`,
    );
  }

  const finalStateHash = env.hash(state);

  return {
    finalStateHash,
    result: terminalResult,
    ticksReplayed: tick,
    matchesRecordedHash: finalStateHash === log.finalStateHash,
    matchesRecordedResult: recordedResultMatches(terminalResult, (log as { result?: unknown }).result),
    divergences,
  };
}

// ---------------------------------------------------------------------------
// Story 9.2 (closing the gap flagged there): the v2 sibling of everything
// above. Schema v2 is additive-only (Story 8.1), so this is a straight
// mirror of `replayCommandLog` -- same structure, same guards, same
// divergence-reporting -- with only the schema-version assertion, the
// action-string allowlist, and the top-level types swapped for their v2
// counterparts. `ReplayResult`, `recordedResultMatches`, `decisionKey`,
// `MAX_REPORTED_DIVERGENCES`, `MAX_UINT32` and `SHA256_HEX` are shared
// unchanged: none of them read a schema-version-specific field.
//
// A v1 document handed to this function fails `assertSchemaVersionV2`
// before any other field is read, exactly as a v2 document handed to
// `replayCommandLog` fails `assertSchemaVersion` -- the two readers can
// never accidentally accept each other's documents.
// ---------------------------------------------------------------------------

/** The v2 sibling of `assertDecisionEntry`, validating against `LOGGED_ACTIONS_V2`. */
function assertDecisionEntryV2(entry: unknown, index: number): asserts entry is DecisionEntryV2 {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`Malformed Command Log: decision entry ${index} is not an object.`);
  }

  const { tick, agentIndex, action } = entry as Record<string, unknown>;

  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0) {
    throw new Error(`Malformed Command Log: decision entry ${index} has a non-integer tick (${String(tick)}).`);
  }

  if (agentIndex !== 0 && agentIndex !== 1) {
    throw new Error(`Malformed Command Log: decision entry ${index} has agentIndex ${String(agentIndex)}, which is neither 0 nor 1.`);
  }

  if (typeof action !== 'string' || !LOGGED_ACTIONS_V2.has(action)) {
    throw new Error(
      `Malformed Command Log: decision entry ${index} (tick ${tick}, agentIndex ${agentIndex}) has unknown action "${String(action)}".`,
    );
  }
}

/** The v2 sibling of `indexDecisions`. Same ordering and duplicate-key rules. */
function indexDecisionsV2(decisions: unknown): Map<string, DecisionEntryV2> {
  if (!Array.isArray(decisions)) {
    throw new Error(
      `Malformed Command Log: decisions must be an array, got ${decisions === null ? 'null' : typeof decisions}.`,
    );
  }

  const byKey = new Map<string, DecisionEntryV2>();
  let previous: DecisionEntryV2 | undefined;

  for (const [index, candidate] of decisions.entries()) {
    assertDecisionEntryV2(candidate, index);
    const entry: DecisionEntryV2 = candidate;
    const key = decisionKey(entry.tick, entry.agentIndex);
    if (byKey.has(key)) {
      throw new Error(
        `Malformed Command Log: duplicate decision entry for tick ${entry.tick}, agentIndex ${entry.agentIndex}.`,
      );
    }
    if (
      previous !== undefined &&
      (entry.tick < previous.tick ||
        (entry.tick === previous.tick && entry.agentIndex <= previous.agentIndex))
    ) {
      throw new Error(
        `Malformed Command Log: decision entry ${index} (tick ${entry.tick}, agentIndex ${entry.agentIndex}) ` +
          `does not follow entry ${index - 1} (tick ${previous.tick}, agentIndex ${previous.agentIndex}); ` +
          'the schema requires decisions ordered by tick ascending, then agentIndex ascending.',
      );
    }
    byKey.set(key, entry);
    previous = entry;
  }

  return byKey;
}

/**
 * The v2 sibling of `replayCommandLog`. See that function's docblock for the
 * reasoning behind every guard here -- this is the same function, replaying
 * a `CommandLogV2` against the same `EnvironmentAdapter` contract.
 */
export function replayCommandLogV2<TState>(
  candidate: unknown,
  env: EnvironmentAdapter<TState>,
): ReplayResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error(
      `replayCommandLogV2: expected a Command Log object, got ${
        candidate === null ? 'null' : Array.isArray(candidate) ? 'array' : typeof candidate
      }`,
    );
  }

  // Before ANY other field is read, and never the v1 assertion: a v1 document
  // must fail here, not be silently accepted as v2.
  const versioned = candidate as VersionedCandidate;
  assertSchemaVersionV2(versioned);
  const log: CommandLogV2 = versioned;

  const environment = (log as { environment?: unknown }).environment;
  if (typeof environment !== 'object' || environment === null || Array.isArray(environment)) {
    throw new Error('Malformed Command Log: the environment block is missing or is not an object.');
  }

  if (!Number.isSafeInteger(log.seed) || log.seed < 0 || log.seed > MAX_UINT32) {
    throw new Error(`Malformed Command Log: seed must be a uint32, got ${String(log.seed)}.`);
  }

  if (typeof log.finalStateHash !== 'string' || !SHA256_HEX.test(log.finalStateHash)) {
    throw new Error(
      `Malformed Command Log: finalStateHash must be a lowercase 64-character hex digest, got ${String(log.finalStateHash)}.`,
    );
  }

  if (env.id !== log.environment.id || env.version !== log.environment.version) {
    throw new Error(
      `Environment mismatch: log records ${log.environment.id}@${log.environment.version} ` +
        `but the supplied adapter is ${env.id}@${env.version}.`,
    );
  }

  const byKey = indexDecisionsV2(log.decisions);
  const consumed = new Set<string>();
  const divergences: string[] = [];
  let suppressedDivergences = 0;

  const reportDivergence = (note: string): void => {
    if (divergences.length < MAX_REPORTED_DIVERGENCES) {
      divergences.push(note);
      return;
    }
    suppressedDivergences += 1;
  };

  if (!Number.isSafeInteger(env.ticksPerDecision) || env.ticksPerDecision <= 0) {
    throw new Error(`Unusable adapter: ticksPerDecision must be a positive integer, got ${String(env.ticksPerDecision)}.`);
  }
  if (!Number.isSafeInteger(env.maxTicks) || env.maxTicks <= 0) {
    throw new Error(`Unusable adapter: maxTicks must be a positive integer, got ${String(env.maxTicks)}.`);
  }
  const decisionPointBudget = Math.ceil(env.maxTicks / env.ticksPerDecision) + 1;

  let state = env.reset(log.seed);
  let tick = 0;
  let decisionPoints = 0;
  let terminalResult = env.terminal(state);

  while (terminalResult === null) {
    decisionPoints += 1;
    if (decisionPoints > decisionPointBudget) {
      throw new Error(
        `Replay exceeded its Decision-Point budget (${decisionPointBudget}) at tick ${tick} without reaching a terminal state.`,
      );
    }

    // `LoggedActionV2` here, not `LoggedAction` -- the v1 alias `env.step`
    // (the v1 fighter engine) accepts is a strict subset, so any v2 log this
    // engine itself produced (no `'jump'`, no vertical-axis fields) still
    // steps it cleanly. A v2 engine's own adapter would accept the full v2
    // grammar in the same slot.
    const actionsForStep: [LoggedActionV2 | null, LoggedActionV2 | null] = [null, null];

    for (const agentIndex of [0, 1] as const) {
      const key = decisionKey(tick, agentIndex);
      const entry = byKey.get(key);

      if (!env.isActionable(state, agentIndex)) {
        if (entry !== undefined) {
          consumed.add(key);
          reportDivergence(
            `tick ${tick}, agentIndex ${agentIndex}: log records action "${entry.action}" but the environment reports the Agent as non-actionable; entry ignored.`,
          );
        }
        continue;
      }

      if (entry === undefined) {
        reportDivergence(
          `tick ${tick}, agentIndex ${agentIndex}: the environment reports the Agent as actionable but the log has no entry; replayed as no action.`,
        );
        continue;
      }

      consumed.add(key);
      actionsForStep[agentIndex] = entry.action;
    }

    state = env.step(state, actionsForStep as Parameters<typeof env.step>[1]);
    tick += env.ticksPerDecision;
    terminalResult = env.terminal(state);
  }

  for (const [key, entry] of byKey) {
    if (!consumed.has(key)) {
      reportDivergence(
        `tick ${entry.tick}, agentIndex ${entry.agentIndex}: log entry lies outside the replayed Match (action "${entry.action}"); entry ignored.`,
      );
    }
  }

  if (suppressedDivergences > 0) {
    divergences.push(
      `... and ${suppressedDivergences} further divergences, not reported individually (capped at ${MAX_REPORTED_DIVERGENCES}).`,
    );
  }

  const finalStateHash = env.hash(state);

  return {
    finalStateHash,
    result: terminalResult,
    ticksReplayed: tick,
    matchesRecordedHash: finalStateHash === log.finalStateHash,
    matchesRecordedResult: recordedResultMatches(terminalResult, (log as { result?: unknown }).result),
    divergences,
  };
}
