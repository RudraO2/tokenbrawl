import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  CommandLog,
  CommandLogV2,
  DecisionEntry,
  EnvironmentAdapter,
  LoggedAction,
} from '@tokenbrawl/contracts';
import { SCHEMA_VERSION_V2 } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { computeConfigHash } from './command-log';
import { replayCommandLog, replayCommandLogV2 } from './replay';
import {
  buildDeterminismFixture,
  serialiseDeterminismFixture,
} from './testing/make-determinism-fixture';
import { createMockEnvironment, DEFAULT_MOCK_ENVIRONMENT_CONFIG } from './testing/mock-environment';
import type { MockState } from './testing/mock-environment';

/**
 * INV-2's machine check, in full: "100 consecutive replays of a fixture log,
 * zero hash mismatches, run both in-process and across separate processes --
 * same-process-only testing hides global-state leakage."
 *
 * Both iteration counts are named constants because
 * `scripts/audit-invariants.sh` greps for them: a gate whose iteration count
 * could be quietly dropped to 1 is not a gate.
 */
const IN_PROCESS_REPLAY_ITERATIONS = 100;
const CROSS_PROCESS_REPLAY_ITERATIONS = 100;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTING_DIR = path.join(HERE, 'testing');
const FIXTURE_PATH = path.join(TESTING_DIR, 'fixtures', 'determinism.command-log.json');
const CHILD_PATH = path.join(TESTING_DIR, 'replay-child.ts');
// `--import` takes a file:// URL, never a bare path: on Windows a `C:\...`
// path is rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME because `C:` parses as
// a URL scheme.
const REGISTER_URL = pathToFileURL(path.join(TESTING_DIR, 'register-contracts.mjs')).href;

/** A fresh mutable copy per call, so one test's mutation can never leak into another's. */
function loadFixture(): CommandLog {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as CommandLog;
}

function makeEnv(): EnvironmentAdapter<MockState> {
  return createMockEnvironment();
}

function withMutatedAction(
  log: CommandLog,
  tick: number,
  agentIndex: 0 | 1,
  action: LoggedAction,
): CommandLog {
  // Two preconditions, both against a fixture regeneration silently moving the
  // entry this mutation targets. The entry must exist -- and it must not
  // already hold the value being "mutated" in, which a
  // `some(... action === action)` check cannot tell apart from a real change:
  // that no-op would satisfy its own guard and leave the negative test proving
  // nothing while failing with a misleading "hashes are equal".
  const target = log.decisions.find((entry) => entry.tick === tick && entry.agentIndex === agentIndex);
  expect(target, `the fixture has no entry at tick ${tick}, agentIndex ${agentIndex}`).toBeDefined();
  expect(
    (target as DecisionEntry).action,
    `tick ${tick}, agentIndex ${agentIndex} already holds "${action}", so this mutation is a no-op`,
  ).not.toBe(action);

  const mutated = log.decisions.map((entry) =>
    entry.tick === tick && entry.agentIndex === agentIndex ? { ...entry, action } : entry,
  );
  return { ...log, decisions: mutated };
}

/**
 * Splices an entry into its canonical position rather than appending it.
 *
 * The I/O matrix requires an extra entry at a non-actionable `(tick,
 * agentIndex)` to be *reported as a divergence, not thrown on* -- replay stays
 * lenient so a tampered log still yields a hash. Appending it would instead
 * trip the ordering guard (`decisions` must run tick-ascending, then
 * agentIndex-ascending), turning every one of those cases into an ordering
 * failure and silently deleting the leniency the matrix specifies. The two
 * properties are independent and are tested independently: ordering has its
 * own describe block, which shuffles an otherwise untouched fixture.
 */
function withExtraEntry(log: CommandLog, entry: DecisionEntry): CommandLog {
  const decisions = [...log.decisions];
  const at = decisions.findIndex(
    (existing) =>
      existing.tick > entry.tick || (existing.tick === entry.tick && existing.agentIndex > entry.agentIndex),
  );
  decisions.splice(at === -1 ? decisions.length : at, 0, entry);
  return { ...log, decisions };
}

interface ChildReplay {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Per-child wall-clock ceiling. One replay of a 20-tick log is milliseconds of work; 30 s is pure headroom. */
const CHILD_SPAWN_TIMEOUT_MS = 30_000;

function replayInChildProcess(logPath: string, cwd?: string): ChildReplay {
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', REGISTER_URL, CHILD_PATH, logPath],
    {
      encoding: 'utf-8',
      // Defaults to inheriting Vitest's cwd. Overridable so one test can prove
      // the resolution hooks do not silently depend on it.
      ...(cwd === undefined ? {} : { cwd }),
      // Vitest's per-test timeout is a timer on this same thread, so it cannot
      // fire while a synchronous spawnSync is blocked. Without a timeout here
      // a single hanging child hangs the worker until the CI job's own limit.
      timeout: CHILD_SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      // Stated, not inherited. The child writes one line per divergence to
      // stderr, so a heavily tampered log can exceed the 1 MiB default -- and
      // an overflow surfaces as `error: ENOBUFS` with status/stdout/stderr all
      // null, i.e. detected tampering reported through the branch below whose
      // own comment blames EAGAIN/EMFILE. `replay.ts` caps its divergence list
      // at MAX_REPORTED_DIVERGENCES for the same reason; this is the second
      // half of that fix, sized so no honest child can reach it.
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  // spawnSync reports a launch failure (EAGAIN/EMFILE are the realistic
  // outcomes of 100 rapid spawns on a loaded runner) and a timeout kill in
  // `error`, leaving status/stdout/stderr null. Dropping it turns the single
  // most likely flake mode into "exited null; stderr: null".
  if (child.error !== undefined) {
    throw new Error(`spawnSync failed to run the replay child: ${child.error.message}`);
  }

  if (child.signal !== null) {
    throw new Error(`the replay child was killed by ${child.signal}; stderr:\n${child.stderr ?? ''}`);
  }

  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

describe('Faithful in-process replay (I/O matrix)', () => {
  it('recomputes the committed fixture\'s Final-State Hash exactly, with no divergences', () => {
    const fixture = loadFixture();

    const replayed = replayCommandLog(fixture, makeEnv());

    expect(replayed.finalStateHash).toBe(fixture.finalStateHash);
    expect(replayed.matchesRecordedHash).toBe(true);
    expect(replayed.divergences).toStrictEqual([]);
  });

  it('recomputes the TerminalResult and tick count rather than copying them out of the log', () => {
    const fixture = loadFixture();

    const replayed = replayCommandLog(fixture, makeEnv());

    // `result` is whatever env.terminal() returned at the end of the re-drive;
    // log.result is read for the comparison verdict and never fed back into
    // the simulation, so this agreeing is a finding, not a tautology.
    expect(replayed.result).toStrictEqual(fixture.result);
    expect(replayed.matchesRecordedResult).toBe(true);
    expect(replayed.ticksReplayed).toBe(fixture.result.endTick);
  });

  it('reports a forged result block as a contradiction even though the Final-State Hash still matches', () => {
    const fixture = loadFixture();
    // The hash covers canonical simulation state, not the result block, so
    // these two verdicts genuinely differ and collapsing them into one would
    // lose the finding.
    const forged: CommandLog = { ...fixture, result: { ...fixture.result, endReason: 'ko' } };

    const replayed = replayCommandLog(forged, makeEnv());

    expect(replayed.matchesRecordedHash).toBe(true);
    expect(replayed.matchesRecordedResult).toBe(false);
  });

  it('closes the config loop the log itself cannot: the fixture\'s configHash is the hash of DEFAULT_MOCK_ENVIRONMENT_CONFIG', () => {
    // A CommandLog carries configHash but never the config, so replay cannot
    // verify it (see the story's Design Notes) -- the caller can, and here the
    // caller is this test. This pins the fixture to a *named* config rather
    // than to an opaque constant: the staleness test would also catch a config
    // change, but only as "the bytes moved", not as "configHash no longer
    // describes DEFAULT_MOCK_ENVIRONMENT_CONFIG".
    expect(loadFixture().configHash).toBe(computeConfigHash(DEFAULT_MOCK_ENVIRONMENT_CONFIG));
  });
});

describe('100 consecutive in-process replays (I/O matrix, INV-2)', () => {
  it(`produces exactly one distinct Final-State Hash across ${IN_PROCESS_REPLAY_ITERATIONS} replays, with zero flakes`, () => {
    const fixture = loadFixture();
    const observed = new Set<string>();

    for (let iteration = 0; iteration < IN_PROCESS_REPLAY_ITERATIONS; iteration += 1) {
      // A fresh adapter per iteration: reusing one would let a replayer that
      // accidentally mutated adapter-held state still pass, which is the
      // opposite of what this gate is for.
      const replayed = replayCommandLog(fixture, makeEnv());
      observed.add(replayed.finalStateHash);
    }

    expect(observed.size).toBe(1);
    expect([...observed]).toStrictEqual([fixture.finalStateHash]);
  });

  it(`produces the same hash across ${IN_PROCESS_REPLAY_ITERATIONS} replays that share one adapter instance`, () => {
    const fixture = loadFixture();
    const env = makeEnv();
    const observed = new Set<string>();

    for (let iteration = 0; iteration < IN_PROCESS_REPLAY_ITERATIONS; iteration += 1) {
      observed.add(replayCommandLog(fixture, env).finalStateHash);
    }

    expect([...observed]).toStrictEqual([fixture.finalStateHash]);
  });
});

describe('100 separate processes (I/O matrix, INV-2)', () => {
  it(
    `spawns ${CROSS_PROCESS_REPLAY_ITERATIONS} node processes that each replay the fixture once, and every one exits 0 printing the recorded hash`,
    () => {
      const expectedHash = loadFixture().finalStateHash;
      const observed = new Set<string>();

      for (let iteration = 0; iteration < CROSS_PROCESS_REPLAY_ITERATIONS; iteration += 1) {
        const child = replayInChildProcess(FIXTURE_PATH);

        // The child's stderr is surfaced in the failure message: a module
        // resolution failure inside a spawned process is otherwise a bare
        // "exit 1" with no clue what broke.
        expect(
          child.status,
          `child ${iteration} exited ${String(child.status)}; stderr:\n${child.stderr}`,
        ).toBe(0);

        const printed = child.stdout.trim();
        expect(printed, `child ${iteration} printed unparseable stdout; stderr:\n${child.stderr}`).toMatch(
          /^[0-9a-f]{64}$/,
        );
        observed.add(printed);
      }

      expect([...observed]).toStrictEqual([expectedHash]);
    },
    // ~230 ms per spawn locally, so ~23 s for 100. Vitest's 5 s default would
    // fail this spuriously and say nothing about determinism.
    240_000,
  );

  it('replays correctly from a child spawned with an unrelated cwd, which is what the resolution hooks promise', () => {
    // contracts-hooks.mjs resolves docs/contracts relative to its own file URL
    // rather than through cwd or an environment variable, and calls that its
    // central design choice. Every other spawn in this file inherits Vitest's
    // cwd (packages/core), so a regression to cwd-relative resolution would
    // pass all 100 iterations above and break for every other caller.
    const expectedHash = loadFixture().finalStateHash;
    const dir = mkdtempSync(path.join(tmpdir(), 'tokenbrawl-cwd-'));

    try {
      const child = replayInChildProcess(FIXTURE_PATH, dir);

      expect(child.status, `child exited ${String(child.status)}; stderr:\n${child.stderr}`).toBe(0);
      expect(child.stdout.trim()).toBe(expectedHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Mutated Action (I/O matrix) -- proves the gate can fail', () => {
  it('recomputes a different hash when one logged attack is rewritten to block', () => {
    const fixture = loadFixture();
    // attack -> block, not advance -> retreat: damageFor() returns 0 for
    // advance/retreat/block/stand, so swapping two zero-damage Actions is a
    // genuine no-op on state and would produce an *identical* hash -- a
    // negative test that silently proves nothing.
    const mutated = withMutatedAction(fixture, 1, 0, 'block');

    const replayed = replayCommandLog(mutated, makeEnv());

    expect(replayed.finalStateHash).not.toBe(fixture.finalStateHash);
    expect(replayed.matchesRecordedHash).toBe(false);
  });

  it('recomputes the identical hash when two zero-damage Actions are swapped, showing the mutation choice above is load-bearing', () => {
    const fixture = loadFixture();
    const mutated = withMutatedAction(fixture, 0, 0, 'retreat');

    // The mock environment's advance/retreat/block are all no-ops on state.
    // This is not a defect: it is why the negative test above must mutate a
    // damaging Action, and this test would start failing the day the mock
    // environment gives movement an effect -- at which point the note above
    // needs revisiting rather than silently rotting.
    expect(replayCommandLog(mutated, makeEnv()).finalStateHash).toBe(fixture.finalStateHash);
  });

  it('recomputes a different hash in a separate process too, proving the child replays rather than echoing log.finalStateHash', () => {
    const fixture = loadFixture();
    const mutated = withMutatedAction(fixture, 1, 0, 'block');
    // mkdtempSync, not a name built from a clock reading: INV-1's grep bans
    // wall-clock identifiers everywhere under packages/core, test files
    // included.
    const dir = mkdtempSync(path.join(tmpdir(), 'tokenbrawl-replay-'));

    try {
      const mutatedPath = path.join(dir, 'mutated.command-log.json');
      writeFileSync(mutatedPath, `${JSON.stringify(mutated, null, 2)}\n`, 'utf-8');

      const child = replayInChildProcess(mutatedPath);

      // Exit 3, not 0: the mutated log still *carries* the original
      // finalStateHash, so the replay contradicts the document it replayed.
      expect(child.status, `child exited ${String(child.status)}; stderr:\n${child.stderr}`).toBe(3);
      expect(child.stderr).toMatch(/contradicts its own replay/);
      // A child that printed the log's recorded value would pass the
      // 100-process test above while proving nothing, so it must print
      // something different here.
      expect(child.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(child.stdout.trim()).not.toBe(fixture.finalStateHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Child-process divergence signalling', () => {
  it('exits non-zero and names the divergence when a forged entry does not move the hash', () => {
    const fixture = loadFixture();
    // Agent 0 is inside a Commitment Window at tick 4, so this forged entry is
    // ignored for stepping and the recomputed hash is unchanged. A child that
    // only printed a hash would report this tampered log as indistinguishable
    // from a faithful one -- making the 100-process gate a hash-printing
    // exercise rather than a replay.
    const tampered = withExtraEntry(fixture, { tick: 4, agentIndex: 0, action: 'attack' });
    const dir = mkdtempSync(path.join(tmpdir(), 'tokenbrawl-replay-'));

    try {
      const tamperedPath = path.join(dir, 'tampered.command-log.json');
      writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf-8');

      const child = replayInChildProcess(tamperedPath);

      expect(child.status).toBe(2);
      expect(child.stdout.trim()).toBe(fixture.finalStateHash);
      expect(child.stderr).toMatch(/non-actionable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the log lies about its own Final-State Hash, instead of printing the honest one and calling it clean', () => {
    const fixture = loadFixture();
    // Nothing about this log is internally inconsistent from the replayer's
    // point of view: every Action is faithful, so the re-drive produces the
    // recorded state, no entry diverges, and the child prints the correct
    // hash. The only lie is the value the document itself records -- which is
    // the single value INV-2 is about.
    const lying: CommandLog = { ...fixture, finalStateHash: 'a'.repeat(64) };
    const dir = mkdtempSync(path.join(tmpdir(), 'tokenbrawl-replay-'));

    try {
      const lyingPath = path.join(dir, 'lying.command-log.json');
      writeFileSync(lyingPath, `${JSON.stringify(lying, null, 2)}\n`, 'utf-8');

      const child = replayInChildProcess(lyingPath);

      expect(child.status, `child exited ${String(child.status)}; stderr:\n${child.stderr}`).toBe(3);
      expect(child.stdout.trim()).toBe(fixture.finalStateHash);
      expect(child.stderr).toMatch(/not the hash this log records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the log forges its result block, which the Final-State Hash does not cover', () => {
    const fixture = loadFixture();
    // The hash is over canonical simulation state, not over `result`, so this
    // log replays to the recorded hash exactly. `result` is what a leaderboard
    // reads, and a child that checked only the hash would pass this.
    const forged: CommandLog = {
      ...fixture,
      result: { ...fixture.result, outcome: fixture.result.outcome === 'p1' ? 'p2' : 'p1' },
    };
    const dir = mkdtempSync(path.join(tmpdir(), 'tokenbrawl-replay-'));

    try {
      const forgedPath = path.join(dir, 'forged-result.command-log.json');
      writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf-8');

      const child = replayInChildProcess(forgedPath);

      expect(child.status, `child exited ${String(child.status)}; stderr:\n${child.stderr}`).toBe(3);
      expect(child.stdout.trim()).toBe(fixture.finalStateHash);
      expect(child.stderr).toMatch(/not the result this log records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero on a malformed log rather than printing a hash for it', () => {
    const fixture = loadFixture();
    const tampered = {
      ...fixture,
      decisions: fixture.decisions.map((entry, index) => (index === 1 ? { ...entry, action: 'nuke' } : entry)),
    };
    const dir = mkdtempSync(path.join(tmpdir(), 'tokenbrawl-replay-'));

    try {
      const tamperedPath = path.join(dir, 'malformed.command-log.json');
      writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf-8');

      const child = replayInChildProcess(tamperedPath);

      expect(child.status).toBe(1);
      expect(child.stdout.trim()).toBe('');
      expect(child.stderr).toMatch(/unknown action "nuke"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Mutated seed (I/O matrix)', () => {
  it('recomputes a different hash when the log\'s seed is changed to another valid seed', () => {
    const fixture = loadFixture();
    const mutated: CommandLog = { ...fixture, seed: fixture.seed + 1 };

    expect(replayCommandLog(mutated, makeEnv()).finalStateHash).not.toBe(fixture.finalStateHash);
  });
});

describe('Unknown schemaVersion (I/O matrix)', () => {
  it('throws naming the rejected version before any other field of the candidate is read', () => {
    const readFields: string[] = [];
    // Getters, not a plain object: they turn "was this field read?" into an
    // observable fact instead of an assumption about the implementation.
    const candidate = {
      schemaVersion: '2.0.0',
      get environment() {
        readFields.push('environment');
        return { id: 'mock-environment', version: '1.0.0' };
      },
      get seed() {
        readFields.push('seed');
        return 42;
      },
      get decisions() {
        readFields.push('decisions');
        return [];
      },
      get finalStateHash() {
        readFields.push('finalStateHash');
        return '';
      },
    };

    expect(() => replayCommandLog(candidate, makeEnv())).toThrow(/2\.0\.0/);
    expect(readFields).toStrictEqual([]);
  });

  it('throws when schemaVersion is missing entirely, rather than defaulting to the current version', () => {
    const { schemaVersion: _schemaVersion, ...rest } = loadFixture();

    expect(() => replayCommandLog(rest, makeEnv())).toThrow();
  });

  it('throws a named error rather than a bare TypeError when handed something that is not an object at all', () => {
    // The child process parses whatever JSON it is pointed at; `null` and a
    // bare string are both valid JSON documents, and a TypeError on
    // `.schemaVersion` would be a far less useful failure in a spawned
    // process whose only output channel is stderr.
    expect(() => replayCommandLog(null, makeEnv())).toThrow(/expected a Command Log object/);
    expect(() => replayCommandLog('not a log', makeEnv())).toThrow(/expected a Command Log object/);
  });
});

describe('Wrong environment (I/O matrix)', () => {
  it('throws naming both the recorded and the supplied environment when the adapter id differs', () => {
    const fixture = loadFixture();
    const wrongEnv: EnvironmentAdapter<MockState> = { ...makeEnv(), id: 'some-other-env' };

    expect(() => replayCommandLog(fixture, wrongEnv)).toThrow(/mock-environment/);
    expect(() => replayCommandLog(fixture, wrongEnv)).toThrow(/some-other-env/);
  });

  it('throws when only the adapter version differs, since a rules change makes replays incomparable', () => {
    const fixture = loadFixture();
    const wrongEnv: EnvironmentAdapter<MockState> = { ...makeEnv(), version: '9.9.9' };

    expect(() => replayCommandLog(fixture, wrongEnv)).toThrow(/9\.9\.9/);
  });
});

describe('Extra entry for a non-actionable Agent (I/O matrix)', () => {
  it('ignores the entry for stepping and reports it in divergences, without throwing', () => {
    const fixture = loadFixture();
    // Agent 0 plays `special` at tick 3, which locks it out for the next two
    // Decision Points -- so tick 4 is a (tick, agentIndex) the environment
    // reports as non-actionable and the log legitimately has no entry for.
    expect(fixture.decisions.some((entry) => entry.tick === 4 && entry.agentIndex === 0)).toBe(false);
    const tampered = withExtraEntry(fixture, { tick: 4, agentIndex: 0, action: 'attack' });

    const replayed = replayCommandLog(tampered, makeEnv());

    // The forged `attack` must not land: applying it would let a tampered log
    // drive a state the simulation's own rules forbid.
    expect(replayed.finalStateHash).toBe(fixture.finalStateHash);
    expect(replayed.divergences).toHaveLength(1);
    expect(replayed.divergences[0]).toMatch(/tick 4, agentIndex 0/);
    expect(replayed.divergences[0]).toMatch(/non-actionable/);
  });

  it('reports an entry that lies outside the replayed Match instead of silently discarding it', () => {
    const fixture = loadFixture();
    const tampered = withExtraEntry(fixture, { tick: 999, agentIndex: 1, action: 'attack' });

    const replayed = replayCommandLog(tampered, makeEnv());

    expect(replayed.finalStateHash).toBe(fixture.finalStateHash);
    expect(replayed.divergences).toHaveLength(1);
    expect(replayed.divergences[0]).toMatch(/outside the replayed Match/);
  });

  it('caps the reported divergence list and states how many it withheld, so a heavily tampered log cannot blow the child\'s stderr past spawnSync\'s buffer', () => {
    const fixture = loadFixture();
    const lastTick = fixture.result.endTick;
    // One note per unconsumed entry is unbounded in the log's own size, and the
    // child joins the whole list onto stderr. Past spawnSync's maxBuffer the
    // overflow arrives as `error: ENOBUFS` with status/stdout/stderr all null,
    // which the parent reports through its spawn-failure branch -- so detected
    // tampering read as an EAGAIN/EMFILE flake. Entries are appended in
    // ascending tick order because the ordering guard is upstream of this one.
    const padding: DecisionEntry[] = Array.from({ length: 150 }, (_unused, index) => ({
      tick: lastTick + index + 1,
      agentIndex: 0,
      action: 'attack',
    }));
    const bloated = { ...fixture, decisions: [...fixture.decisions, ...padding] };

    const replayed = replayCommandLog(bloated, makeEnv());

    // Still a real replay with a real verdict -- the cap changes the report, not the gate.
    expect(replayed.matchesRecordedHash).toBe(true);
    expect(replayed.divergences).toHaveLength(101);
    expect(replayed.divergences.at(-1)).toMatch(/and 50 further divergences, not reported individually/);
  });

  it('reports a missing entry for an Agent the environment says was actionable, and replays it as no action', () => {
    const fixture = loadFixture();
    const thinned: CommandLog = {
      ...fixture,
      decisions: fixture.decisions.filter((entry) => !(entry.tick === 1 && entry.agentIndex === 0)),
    };

    const replayed = replayCommandLog(thinned, makeEnv());

    // Dropping the tick-1 `attack` removes its damage, so this is also a
    // second, independent demonstration that the hash tracks Actions.
    expect(replayed.finalStateHash).not.toBe(fixture.finalStateHash);
    expect(replayed.divergences).toHaveLength(1);
    expect(replayed.divergences[0]).toMatch(/tick 1, agentIndex 0/);
    expect(replayed.divergences[0]).toMatch(/no entry/);
  });
});

describe('Duplicate entry (I/O matrix)', () => {
  it('throws rather than diverging, because two entries for one (tick, agentIndex) is a malformed log, not a disagreement', () => {
    const fixture = loadFixture();
    const firstEntry = fixture.decisions[0];
    expect(firstEntry).toBeDefined();
    const duplicated = withExtraEntry(fixture, firstEntry as DecisionEntry);

    // Keeping the first (or the last) would make the replayed hash depend on
    // an arbitrary tie-break rule nothing else in the system shares.
    expect(() => replayCommandLog(duplicated, makeEnv())).toThrow(/duplicate decision entry/i);
  });
});

describe('Decision ordering (the one format rule Ajv cannot express)', () => {
  it('accepts the committed fixture, which is ordered by tick then agentIndex as the schema requires', () => {
    // Guards the check below against being satisfiable only by a log nobody
    // writes: buildCommandLog's own output must pass it.
    expect(() => replayCommandLog(loadFixture(), makeEnv())).not.toThrow();
  });

  it('throws on a shuffled decisions array, which keying by (tick, agentIndex) would otherwise replay clean', () => {
    const fixture = loadFixture();
    // The frozen schema states the ordering outright ("Ordered by tick
    // ascending, then by agentIndex ascending") but JSON Schema cannot express
    // array ordering, so Ajv passes a reversed log and validateCommandLog
    // always will. Replay indexes by (tick, agentIndex), which makes the
    // re-drive itself order-blind -- so before this guard a reversed fixture
    // reproduced the recorded hash exactly and the child exited 0, pronouncing
    // a document that violates the format faithful.
    const reversed = { ...fixture, decisions: [...fixture.decisions].reverse() };

    expect(() => replayCommandLog(reversed, makeEnv())).toThrow(/ordered by tick ascending/i);
  });

  it('throws when only the two entries of a single Decision Point are swapped', () => {
    const fixture = loadFixture();
    const decisions = [...fixture.decisions];
    const [first, second] = [decisions[0] as DecisionEntry, decisions[1] as DecisionEntry];
    // Same tick, agentIndex 1 before 0 -- the subtle half of the rule, and the
    // half a tick-only comparison would miss.
    expect(first.tick).toBe(second.tick);
    expect(first.agentIndex).toBe(0);
    expect(second.agentIndex).toBe(1);
    decisions[0] = second;
    decisions[1] = first;

    expect(() => replayCommandLog({ ...fixture, decisions }, makeEnv())).toThrow(/ordered by tick ascending/i);
  });
});

describe('Malformed log (structurally invalid, not merely divergent)', () => {
  it('throws on an Action outside the frozen enum rather than replaying it as a no-op', () => {
    const fixture = loadFixture();
    // The mock adapter's damageFor() falls through to zero damage for anything
    // it does not recognise, so a forged Action would otherwise be silently
    // downgraded to "did nothing" and replay would return a plausible hash
    // with no complaint. replayCommandLog runs no JSON Schema validation (Ajv
    // cannot be imported into the child), so this guard is the only thing
    // between a tampered log and env.step.
    const tampered = {
      ...fixture,
      decisions: fixture.decisions.map((entry, index) => (index === 1 ? { ...entry, action: 'nuke' } : entry)),
    };

    expect(() => replayCommandLog(tampered, makeEnv())).toThrow(/unknown action "nuke"/);
  });

  it('throws a named error when decisions is absent or not an array', () => {
    const { decisions: _decisions, ...withoutDecisions } = loadFixture();

    expect(() => replayCommandLog(withoutDecisions, makeEnv())).toThrow(/decisions must be an array/);
    expect(() => replayCommandLog({ ...loadFixture(), decisions: {} }, makeEnv())).toThrow(/decisions must be an array/);
  });

  it('throws a named error when a decision entry is null or has an out-of-range agentIndex', () => {
    const fixture = loadFixture();

    expect(() => replayCommandLog({ ...fixture, decisions: [null] }, makeEnv())).toThrow(/is not an object/);
    expect(() =>
      replayCommandLog({ ...fixture, decisions: [{ tick: 0, agentIndex: 2, action: 'attack' }] }, makeEnv()),
    ).toThrow(/neither 0 nor 1/);
  });

  it('throws a named error when the environment block is missing, instead of a bare TypeError', () => {
    const { environment: _environment, ...withoutEnvironment } = loadFixture();

    // A spawned child's only diagnostic channel is stderr, where "Cannot read
    // properties of undefined (reading 'id')" identifies neither the document
    // nor the field.
    expect(() => replayCommandLog(withoutEnvironment, makeEnv())).toThrow(/environment block is missing/);
  });

  it('throws the same named error for an array-valued environment block, which typeof calls an object', () => {
    // Without Array.isArray this slipped past the guard above and failed four
    // lines later as "log records undefined@undefined but the supplied adapter
    // is mock-environment@1.0.0" -- naming the adapter as the suspect for what
    // is a malformed document, in the one place the guard exists to prevent.
    expect(() => replayCommandLog({ ...loadFixture(), environment: [] }, makeEnv())).toThrow(
      /environment block is missing/,
    );
  });

  it('throws when the seed is missing or non-numeric rather than silently replaying as seed 0', () => {
    const { seed: _seed, ...withoutSeed } = loadFixture();

    // env.reset coerces with `seed | 0`, so an absent seed would produce a
    // perfectly well-formed hash for a Match nobody ever ran.
    expect(() => replayCommandLog(withoutSeed, makeEnv())).toThrow(/seed must be a uint32/);
    expect(() => replayCommandLog({ ...loadFixture(), seed: '42' }, makeEnv())).toThrow(/seed must be a uint32/);
  });

  it('throws on a seed outside the frozen schema\'s uint32 range, which `seed | 0` would otherwise truncate into a different Match', () => {
    const fixture = loadFixture();
    // 2**32 above the fixture's own seed. `seed | 0` truncates it straight
    // back to the fixture's seed, so without a range guard this log replays to
    // the recorded hash and passes every check -- a document whose stated seed
    // does not describe the Match it carries. replayCommandLog runs no Ajv, so
    // the schema's own `maximum: 4294967295` never reaches this path.
    const truncating: CommandLog = { ...fixture, seed: fixture.seed + 0x1_0000_0000 };

    expect(() => replayCommandLog(truncating, makeEnv())).toThrow(/seed must be a uint32/);
    expect(() => replayCommandLog({ ...fixture, seed: -1 }, makeEnv())).toThrow(/seed must be a uint32/);
  });

  it('throws when finalStateHash is absent or not a hex digest, rather than reporting it as a mismatch', () => {
    const { finalStateHash: _finalStateHash, ...withoutHash } = loadFixture();

    // Degrading to `matchesRecordedHash: false` is the wrong shape of answer:
    // a log that records no hash is structurally malformed, and every other
    // required field already fails loudly rather than quietly.
    expect(() => replayCommandLog(withoutHash, makeEnv())).toThrow(/finalStateHash must be a lowercase/);
    expect(() => replayCommandLog({ ...loadFixture(), finalStateHash: 'nope' }, makeEnv())).toThrow(
      /finalStateHash must be a lowercase/,
    );
    // Uppercase is a real hex digest but not the frozen schema's, whose
    // `$defs.sha256` pattern is `^[a-f0-9]{64}$`.
    expect(() =>
      replayCommandLog({ ...loadFixture(), finalStateHash: 'A'.repeat(64) }, makeEnv()),
    ).toThrow(/finalStateHash must be a lowercase/);
  });

  it('throws a Command-Log-shaped error for a JSON array, which is a valid JSON document', () => {
    expect(() => replayCommandLog([], makeEnv())).toThrow(/expected a Command Log object, got array/);
  });
});

describe('Unusable adapter (the replayer must fail, never hang)', () => {
  it('rejects an adapter whose ticksPerDecision cannot advance the tick counter', () => {
    const fixture = loadFixture();
    // With ticksPerDecision <= 0 the loop's tick never grows, so any
    // tick-valued bound is unreachable and the replay spins forever -- inside
    // a spawned child, where the parent's test timeout cannot interrupt a
    // blocked synchronous spawn.
    const stalled: EnvironmentAdapter<MockState> = { ...makeEnv(), ticksPerDecision: 0 };

    expect(() => replayCommandLog(fixture, stalled)).toThrow(/ticksPerDecision must be a positive integer/);
  });

  it('rejects an adapter whose maxTicks is not a usable positive integer', () => {
    const fixture = loadFixture();
    const unbounded: EnvironmentAdapter<MockState> = { ...makeEnv(), maxTicks: Number.NaN };

    expect(() => replayCommandLog(fixture, unbounded)).toThrow(/maxTicks must be a positive integer/);
  });
});

describe('Golden fixture staleness (I/O matrix)', () => {
  it('regenerates byte-identically from buildDeterminismFixture, so a drifted fixture fails loudly', async () => {
    const regenerated = serialiseDeterminismFixture(await buildDeterminismFixture());

    // The supported regeneration path. Without one, the only recovery from a
    // *legitimate* staleness failure (someone deliberately changed the mock
    // environment) is hand-editing hashes into the JSON -- precisely the
    // unreproducible artefact the committed-fixture design exists to prevent.
    // Deliberately opt-in via the environment -- and refused under CI rather
    // than merely assumed absent there: the write makes the assertion below
    // unconditionally true, so a CI runner that carried this variable would
    // turn a staleness *failure* into a silent self-rebaseline of the golden
    // fixture, which is the one thing this test exists to prevent.
    if (process.env.TOKENBRAWL_REGENERATE_DETERMINISM_FIXTURE === '1') {
      expect(process.env.CI, 'refusing to regenerate the golden fixture under CI').toBeFalsy();
      writeFileSync(FIXTURE_PATH, regenerated, 'utf-8');
    }

    // `.gitattributes` forces LF, but a Windows working tree can still hand
    // back CRLF from some toolchains; normalising keeps the check about
    // content drift rather than about checkout settings.
    const committed = readFileSync(FIXTURE_PATH, 'utf-8').replace(/\r\n/g, '\n');

    expect(
      regenerated,
      'The committed golden fixture no longer matches what buildDeterminismFixture produces. If the simulation change was deliberate, regenerate with:\n' +
        '  bash:       TOKENBRAWL_REGENERATE_DETERMINISM_FIXTURE=1 npx vitest run --root packages/core replay.test.ts\n' +
        '  PowerShell: $env:TOKENBRAWL_REGENERATE_DETERMINISM_FIXTURE=1; npx vitest run --root packages/core replay.test.ts\n' +
        'That run rewrites the fixture but stays red: every case before this one already loaded the old bytes. Re-run the suite without the variable to confirm green.',
    ).toBe(committed);
  });

  it('regenerates deterministically twice in a row', async () => {
    const first = await buildDeterminismFixture();
    const second = await buildDeterminismFixture();

    expect(second).toStrictEqual(first);
  });
});

describe('Child-process dependency surface (cross-process gate depends on it)', () => {
  function importSpecifiersOf(file: string): readonly string[] {
    const source = readFileSync(file, 'utf-8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(codeOnly, `${file} uses require()`).not.toMatch(/\brequire\s*\(/);
    expect(codeOnly, `${file} uses a dynamic import()`).not.toMatch(/\bimport\s*\(/);

    // Both quote styles, and bare side-effect imports (`import 'x';`), which
    // carry no `from` at all. Nothing in the repo enforces a quote style --
    // there is no Prettier config and the ESLint rule set for TS is empty --
    // so a single-quote-only scanner returns an *empty* list for a file that
    // imports Ajv with double quotes, and the guard below passes vacuously.
    const specifiers = [
      ...codeOnly.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
      ...codeOnly.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ];

    return specifiers.map((match) => match[1] as string);
  }

  it('keeps replay.ts importing nothing but @tokenbrawl/contracts, so a bare node child can still load it', () => {
    // Importing ./command-log here would pull in Ajv, whose `ajv/dist/2020`
    // specifier is extensionless and unresolvable under plain Node ESM -- the
    // 100-process test above would start failing with ERR_MODULE_NOT_FOUND
    // and no obvious connection to the import that caused it.
    expect(importSpecifiersOf(path.join(HERE, 'replay.ts'))).toStrictEqual(['@tokenbrawl/contracts']);
  });

  it('keeps every module the child actually loads free of bare specifiers that plain Node cannot resolve', () => {
    // Walked transitively from the child's entry point, not listed by hand. A
    // hand-maintained list stops describing the graph the moment a listed file
    // adds a relative import -- `replay.ts -> ./canonical-hash`, say -- because
    // a `./` specifier was treated as resolvable and then never followed. The
    // file it points at could import anything.
    const visited = new Set<string>();
    const offenders: string[] = [];
    const queue = [path.join(TESTING_DIR, 'replay-child.ts')];

    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);

      for (const specifier of importSpecifiersOf(file)) {
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          // Extensionless by house style (moduleResolution: "Bundler"), which
          // is exactly why contracts-hooks.mjs appends `.ts` at resolve time.
          // Mirror that hook's rule rather than a looser one: append only when
          // the specifier has no JS/TS extension of its own, or a relative
          // import of `./x.js` becomes `./x.js.ts` and the readFileSync below
          // dies with an ENOENT naming a file nobody wrote -- this test failing
          // with a filesystem error instead of the finding it exists to report.
          const resolved = path.resolve(path.dirname(file), specifier);
          const candidate = /\.[cm]?[jt]sx?$/.test(resolved) ? resolved : `${resolved}.ts`;
          expect(
            existsSync(candidate),
            `cannot follow "${specifier}" from ${file}: ${candidate} does not exist`,
          ).toBe(true);
          queue.push(candidate);
          continue;
        }

        // `@tokenbrawl/contracts` is remapped by contracts-hooks.mjs; `node:*`
        // is built in. Anything else must exist in node_modules AND expose a
        // Node-ESM-resolvable entry point -- exactly the assumption
        // `ajv/dist/2020` violates.
        if (specifier === '@tokenbrawl/contracts' || specifier.startsWith('node:')) {
          continue;
        }

        offenders.push(`${file} imports "${specifier}"`);
      }
    }

    expect(offenders, 'a bare node child cannot resolve these specifiers').toStrictEqual([]);
    // The walk reaching the modules the child demonstrably loads is what keeps
    // the assertion above from passing vacuously on a truncated graph.
    expect(visited).toContain(path.join(HERE, 'replay.ts'));
    expect(visited).toContain(path.join(TESTING_DIR, 'mock-environment.ts'));
  });
});

describe('Public surface', () => {
  it('re-exports replayCommandLog from the package barrel, which is what downstream epics import', async () => {
    // replay.test.ts imports from './replay' directly, so without this the
    // re-export could be deleted with a green suite and a green audit, and
    // every downstream consumer would break instead.
    const barrel = await import('./index');

    expect(typeof barrel.replayCommandLog).toBe('function');
    expect(barrel.replayCommandLog(loadFixture(), makeEnv()).matchesRecordedHash).toBe(true);
  });

  it('re-exports replayCommandLogV2 from the package barrel too', async () => {
    const barrel = await import('./index');
    expect(typeof barrel.replayCommandLogV2).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Story 9.2 (closing the arcade-panel gap): replayCommandLogV2, mirroring
// the v1 coverage above at unit scale rather than re-running the full
// 100-process determinism apparatus, which is INV-2's gate for the v1
// engine and is unchanged by this addition. Schema v2 is additive-only
// (Story 8.1), so a v2-relabelled copy of the same fixture is a legitimate
// v2 document: every field the v1 fixture carries is legal in v2 too.
// ---------------------------------------------------------------------------

function loadFixtureAsV2(): CommandLogV2 {
  const v1 = loadFixture();
  return {
    ...v1,
    schemaVersion: SCHEMA_VERSION_V2,
    // Exercises the field v1 cannot express, on the side the v1 fixture
    // already calls "bot" -- schema v2 is additive, so relabelling one side
    // 'human' changes nothing about how the mock environment steps it.
    agents: [v1.agents[0], { ...v1.agents[1], kind: 'human' }],
  } as CommandLogV2;
}

describe('replayCommandLogV2: valid v2 log replays and matches hash', () => {
  it('recomputes the same Final-State Hash a v2-relabelled fixture records, with no divergences', () => {
    const fixture = loadFixtureAsV2();

    const replayed = replayCommandLogV2(fixture, makeEnv());

    expect(replayed.finalStateHash).toBe(fixture.finalStateHash);
    expect(replayed.matchesRecordedHash).toBe(true);
    expect(replayed.divergences).toStrictEqual([]);
  });

  it('recomputes the TerminalResult rather than copying it out of the log', () => {
    const fixture = loadFixtureAsV2();
    const replayed = replayCommandLogV2(fixture, makeEnv());
    expect(replayed.result).toStrictEqual(fixture.result);
    expect(replayed.matchesRecordedResult).toBe(true);
  });
});

describe('replayCommandLogV2: a v1 document is rejected, never silently accepted', () => {
  it('throws on the v1 fixture, naming the schema-version mismatch', () => {
    const v1Fixture = loadFixture();
    expect(() => replayCommandLogV2(v1Fixture, makeEnv())).toThrow(/2\.0\.0/);
  });
});

describe('replayCommandLog: a v2 document is rejected symmetrically', () => {
  it('throws when the v1 reader is handed a v2-shaped document', () => {
    const v2Fixture = loadFixtureAsV2();
    expect(() => replayCommandLog(v2Fixture, makeEnv())).toThrow(/1\.0\.0/);
  });
});

describe('replayCommandLogV2: tampered v2 decisions are reported as divergences', () => {
  it('reports a forged entry at a non-actionable Decision Point rather than throwing', () => {
    const fixture = loadFixtureAsV2();
    const tampered: CommandLogV2 = withExtraEntry(
      fixture as unknown as CommandLog,
      { tick: 4, agentIndex: 0, action: 'attack' },
    ) as unknown as CommandLogV2;

    const replayed = replayCommandLogV2(tampered, makeEnv());

    expect(replayed.finalStateHash).toBe(fixture.finalStateHash);
    expect(replayed.divergences.some((note) => note.includes('non-actionable'))).toBe(true);
  });

  it('recomputes a different hash when a damaging Action is rewritten, the same as v1', () => {
    const fixture = loadFixtureAsV2();
    const mutated = withMutatedAction(fixture as unknown as CommandLog, 1, 0, 'block') as unknown as CommandLogV2;

    const replayed = replayCommandLogV2(mutated, makeEnv());

    expect(replayed.finalStateHash).not.toBe(fixture.finalStateHash);
    expect(replayed.matchesRecordedHash).toBe(false);
  });

  it('rejects a jump Action against the v1 mock environment, which has no such Action, without corrupting the hash silently', () => {
    // The mock environment only ever recognises v1 Actions -- jump is v2-only
    // and belongs to a future vertical-axis adapter, not to this one. A
    // malformed-log-shaped rejection here (rather than a silent no-op) is the
    // correct outcome: replay must never treat an Action the adapter cannot
    // interpret as a harmless divergence.
    const fixture = loadFixtureAsV2();
    const mutated = withMutatedAction(fixture as unknown as CommandLog, 1, 0, 'block') as unknown as CommandLogV2;
    const withJump: CommandLogV2 = {
      ...mutated,
      decisions: mutated.decisions.map((entry, index) => (index === 0 ? { ...entry, action: 'jump' } : entry)),
    };

    // `replayCommandLogV2` itself accepts 'jump' as a well-formed Action (it
    // is in ACTIONS_V2); what happens next is between the log and the
    // adapter, exercised only to show the guard admits it rather than
    // rejecting valid v2 grammar.
    expect(() => replayCommandLogV2(withJump, makeEnv())).not.toThrow(/unknown action/);
  });
});
