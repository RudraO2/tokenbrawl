import { readFileSync } from 'node:fs';
import { replayCommandLog } from '../replay';
import { createMockEnvironment } from './mock-environment';

/**
 * One replay, one OS process -- the cross-process half of the INV-2
 * determinism gate.
 *
 * INV-2's machine check demands replays "run both in-process and across
 * separate processes", because same-process-only testing hides global-state
 * leakage: a module-level counter, a lazily-memoised value, or an ordering
 * effect that only differs on a cold module graph all survive an in-process
 * loop untouched. That is why this file replays exactly once and exits
 * rather than looping internally -- a loop here would re-test the
 * in-process property in a more expensive way and prove nothing new.
 *
 * Usage (see `register-contracts.mjs` for why the hooks are needed):
 *
 *   node --experimental-strip-types --no-warnings \
 *        --import <file:// URL of register-contracts.mjs> \
 *        replay-child.ts <path-to-command-log.json>
 *
 * Contract with the parent: stdout carries the recomputed Final-State Hash
 * and nothing else, so the parent can compare it verbatim. Diagnostics and
 * Node's own type-stripping warnings go to stderr.
 *
 * Exit codes: 0 clean, 1 threw, 2 replayed but the log disagreed with the
 * environment's own actionability, 3 the log contradicts its own replay. The
 * two non-zero replay codes exist because a hash alone is a weak contract at a
 * process boundary, in two separate ways:
 *
 * - Exit 2: a log with forged entries that happen not to move the hash (an
 *   Action attributed to an Agent that was inside a Commitment Window, say)
 *   would otherwise be indistinguishable from a faithful one.
 * - Exit 3: a log whose own recorded `finalStateHash` or `result` is a lie
 *   would otherwise replay "clean" -- the child prints the honest recomputed
 *   hash and says nothing about the fact that it disagrees with the document
 *   it just replayed. `replayCommandLog` computes both verdicts; discarding
 *   them is what makes a replayer a hash printer.
 */

const EXIT_DIVERGED = 2;
const EXIT_CONTRADICTS_LOG = 3;

function main(): void {
  const logPath = process.argv[2];

  if (logPath === undefined) {
    throw new Error('replay-child: expected a Command Log path as argv[2].');
  }

  const parsed: unknown = JSON.parse(readFileSync(logPath, 'utf-8'));

  // Built from DEFAULT_MOCK_ENVIRONMENT_CONFIG, matching the adapter the
  // fixture was recorded against. `replayCommandLog` verifies the recorded
  // environment id/version against this adapter and throws on a mismatch, so
  // a fixture from some other environment fails loudly here rather than
  // printing a meaningless hash.
  const env = createMockEnvironment();
  const replayed = replayCommandLog(parsed, env);

  process.stdout.write(`${replayed.finalStateHash}\n`);

  if (replayed.divergences.length > 0) {
    process.stderr.write(`replay-child: the log diverged from the environment:\n${replayed.divergences.join('\n')}\n`);
    process.exitCode = EXIT_DIVERGED;
  }

  // Checked after divergence so the stronger signal wins the exit code: a log
  // that contradicts its own recorded outcome is a worse finding than one that
  // merely carries an entry the environment would not have polled.
  const contradictions: string[] = [];
  if (!replayed.matchesRecordedHash) {
    contradictions.push('the recomputed Final-State Hash is not the hash this log records');
  }
  if (!replayed.matchesRecordedResult) {
    contradictions.push(`the recomputed result ${JSON.stringify(replayed.result)} is not the result this log records`);
  }

  if (contradictions.length > 0) {
    process.stderr.write(`replay-child: the log contradicts its own replay:\n${contradictions.join('\n')}\n`);
    process.exitCode = EXIT_CONTRADICTS_LOG;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  // `process.exitCode`, never `process.exit(1)`: the parent reads this child
  // over a pipe, where Node's stdio writes are asynchronous and `process.exit`
  // does not flush them -- it can truncate the stack trace that is the child's
  // only diagnostic channel. Falling off the end of the module exits with this
  // code and flushes first.
  process.exitCode = 1;
}
