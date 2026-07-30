/**
 * Latency simulation for mock Agents, without any wall-clock or timer API.
 *
 * INV-1 requires that a Deployment taking 40 seconds and one taking 200ms
 * produce identical Command Logs. `scripts/audit-invariants.sh`'s INV-1
 * check greps every `*.ts` under `packages/core` -- including `.test.ts`
 * files, with no test-file exclusion for this particular check -- for the
 * wall-clock and timer scheduling APIs named in that script's INV-1 pattern.
 * A real timer-based sleep, even one only ever used inside a test, would
 * trip that gate.
 *
 * `yieldMicrotasks` sidesteps this entirely: it recurses through
 * `queueMicrotask` (not matched by the banned-identifier pattern) and
 * resolves in a handful of microtask turns regardless of `cycles` -- in
 * practice, well under a millisecond of real time even for a large
 * `cycles`. It does not simulate real elapsed time; it proves the property
 * the invariant actually cares about, that `runMatch` places no upper bound
 * on how many additional async ticks a `decide()` call takes before
 * resolving.
 */
export function yieldMicrotasks(cycles: number): Promise<void> {
  if (cycles <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      yieldMicrotasks(cycles - 1).then(resolve);
    });
  });
}
