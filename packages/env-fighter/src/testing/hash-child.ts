/**
 * Cross-process half of Story 2.1's determinism test plan.
 *
 * Spawned by `cross-process.test.ts` as a bare Node process, this replays a
 * Match from `(seed, ordered Actions)` and prints the Final-State Hash and
 * nothing else. The point is what an in-process loop structurally cannot
 * check: a module-level generator, a lazily-initialised cache, or any other
 * cross-Match state leak produces identical hashes when two Matches run in
 * one process and divergent ones when they run in fresh processes.
 *
 * Test support, never bundled: this file lives under `src/testing/`, which
 * both `scripts/audit-invariants.sh` and `source-discipline.test.ts` exclude
 * from the AD-4 shipped-file set. `source-discipline.test.ts` separately
 * asserts that no shipped file imports from this directory.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings \
 *        --import <file:// URL of core's register-contracts.mjs> \
 *        hash-child.ts <seed> <script>
 *
 * where `<script>` is Decision Points separated by `,` and the two Agents'
 * Actions separated by `:`, with `-` meaning "submitted nothing".
 */
import type { LoggedActionV2 } from '@tokenbrawl/contracts';
import { createFighterEnvironment } from '../environment';

function parseAction(token: string): LoggedActionV2 | null {
  return token === '-' ? null : (token as LoggedActionV2);
}

const seed = Number(process.argv[2]);
const script = process.argv[3] ?? '';

if (!Number.isSafeInteger(seed)) {
  throw new Error(`hash-child: seed must be a safe integer, received: ${process.argv[2]}`);
}

const env = createFighterEnvironment();
let state = env.reset(seed);

for (const decisionPoint of script.split(',')) {
  const [first, second] = decisionPoint.split(':');
  state = env.step(state, [parseAction(first), parseAction(second)]);
}

process.stdout.write(env.hash(state));
