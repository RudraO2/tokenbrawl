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
 *        hash-child.ts <seed> <script> [zones]
 *
 * where `<script>` is Decision Points separated by `,` and the two Agents'
 * Actions separated by `:`, with `-` meaning "submitted nothing". `[zones]`
 * (Story 8.3) is optional and, when present, follows the same shape -- one
 * `high`/`low`/`-` pair per Decision Point, `-` meaning "no Zone submitted" --
 * threaded into `step()`'s companion `zones` parameter alongside `actions`.
 * Omitted entirely (rather than passed as empty) when a caller has no Zones
 * to vary, so the pre-Story-8.3 two-argument call sites this script also
 * still serves need no change.
 */
import type { LoggedActionV2 } from '@tokenbrawl/contracts';
import { createFighterEnvironment } from '../environment';
import type { Zone } from '../frames';

function parseAction(token: string): LoggedActionV2 | null {
  return token === '-' ? null : (token as LoggedActionV2);
}

function parseZone(token: string | undefined): Zone | null {
  return token === 'high' || token === 'low' ? token : null;
}

const seed = Number(process.argv[2]);
const script = process.argv[3] ?? '';
const zonesArg = process.argv[4];

if (!Number.isSafeInteger(seed)) {
  throw new Error(`hash-child: seed must be a safe integer, received: ${process.argv[2]}`);
}

const zonePoints = zonesArg ? zonesArg.split(',') : [];

const env = createFighterEnvironment();
let state = env.reset(seed);

const decisionPoints = script.split(',');
for (let index = 0; index < decisionPoints.length; index += 1) {
  const [first, second] = decisionPoints[index].split(':');
  const zonePoint = zonePoints[index];
  const zones: readonly [Zone | null, Zone | null] | undefined = zonePoint
    ? (zonePoint.split(':').map(parseZone) as [Zone | null, Zone | null])
    : undefined;
  state = env.step(state, [parseAction(first), parseAction(second)], zones);
}

process.stdout.write(env.hash(state));
