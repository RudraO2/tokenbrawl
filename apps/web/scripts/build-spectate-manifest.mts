import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandLogV2 } from '@tokenbrawl/contracts';
import { computeConfigHash } from '../../../packages/core/src/command-log';
import { validateCommandLogV2 } from '../../../packages/core/src/command-log-v2';
import { runMatch, type MatchResult } from '../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import {
  createAggressiveBot,
  createRandomBot,
  createSpacingBot,
} from '../../../packages/env-fighter/src/bots';
import { buildArcadeCommandLog } from '../src/arcade/log';
import { PLAYBACK_FPS, FRAMES_PER_DECISION, buildReplayFilm } from '../src/replay/film';
import { DEFAULT_JUICE_TUNING, arenaFor, buildJuiceTrack } from '../src/render/juice';

/**
 * Story 9.3 / Story 12.11: generates the Spectate stream's manifest and its
 * Command Logs.
 *
 * Every entry is a Baseline-Bot-vs-Baseline-Bot Match -- no provider key, no
 * network, deterministic (AD-17, AC "no on-demand computation"). This mirrors
 * `build-hero.mts`'s shape and `apps/web/src/testing/demo-log.ts`'s reasoning
 * for why this must run in Node rather than the browser.
 *
 * ## Story 12.11: v2, and a seed search rather than a balance change
 *
 * The v1 corpus this replaced showed the Ultimate exactly once across seven
 * logs, held every fight to `schemaVersion 1.0.0`, and ended six of seven in
 * timeout. All three are corpus problems, and all three are fixed *here*, in
 * this committed generator, without touching a single simulation file:
 *
 *  1. **v2.** Each log is built through `buildArcadeCommandLog` -- the same v2
 *     writer the arcade already uses -- and validated against
 *     `command-log.v2.schema.json` (`validateCommandLogV2`) before it is
 *     written. `configHash` is `computeConfigHash(DEFAULT_FIGHTER_CONFIG)`,
 *     byte-identical to the v1 corpus's, because the config is untouched: this
 *     is a schema move, not a balance change, so no existing gate re-opens.
 *
 *  2. **Ultimates and KOs by *selection*, never by tuning.** Only the random
 *     bot ever reaches for `special` (the aggressive and spacing bots choose
 *     from a fixed vocabulary that never includes it), so every pairing below
 *     carries at least one random bot, and each spec's seed is *searched* --
 *     the first seed whose Match satisfies the spec's `require` predicate is
 *     taken. `DEFAULT_FIGHTER_CONFIG` is not so much as read for a threshold;
 *     the die simply landing on `special` when the meter is full is what puts
 *     the Ultimate on screen. The criteria are written down here (see
 *     `CORPUS_SPECS`), so the corpus is reproducible rather than a set of lucky
 *     files: run this script twice and it writes byte-identical output.
 *
 *  3. **`frameCount` is the juice *track's* length**, unchanged from Story 11.6
 *     -- more Ultimates means more cinematic freeze, so this drifts further than
 *     it did, and recording the film's length instead would land a mid-loop
 *     visitor at the wrong proportion through a Match (`offsetForNow`).
 *
 * The v2-action gap (jump, zones, juggles) is a *simulation* gap and is NOT
 * touched here -- it is recorded as deferred work naming `legalActionsFor`. See
 * the story file's "What this story does, and what it must refuse to do".
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs apps/web/scripts/build-spectate-manifest.mts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'replays');

type BotKind = 'aggressive' | 'spacing' | 'random';

/**
 * What a Match has to contain to be selected for a spec.
 *
 *  - `ko`: ends in a KO *and* contains at least one Ultimate.
 *  - `special`: contains at least one Ultimate (any ending).
 *
 * Three specs require `ko` and three require `special`, which is what makes the
 * corpus end at least half in KO (AC) and carry an Ultimate in every entry --
 * both by construction, both reproducible, neither by moving a number.
 */
type Requirement = 'ko' | 'special';

interface CorpusSpec {
  readonly id: string;
  /** First seed the search tries for this spec. Distinct per spec so the six Matches differ. */
  readonly seedBase: number;
  readonly p1: BotKind;
  readonly p2: BotKind;
  readonly require: Requirement;
  /**
   * A pinned seed that is taken as-is rather than searched. Set on `spectate-03`
   * only: five test files (`render/cinematic*.test.ts`, `render/audio*.test.ts`,
   * `spectate/panel.test.ts`) replay `spectate-03.command-log.json` as *the*
   * committed Ultimate fixture and assert on its exact events (the heavy on
   * agent 1, the trade on clock 100, the Ultimate at tick 870, no KO). Keeping
   * its seed and pairing byte-for-byte means the replayed film is identical and
   * those assertions hold -- the log is re-emitted as v2, but the Match inside it
   * does not move. `assertMeets` still confirms it carries an Ultimate.
   */
  readonly fixedSeed?: number;
}

/**
 * The six pairings, each with a random bot so `special` is reachable, and the
 * predicate its searched seed must satisfy. Ordered so the loop below finds a
 * strong KO-with-Ultimate showcase early; the manifest marks exactly one entry
 * `containsUltimate` for the visual gate to select (see `chooseShowcase`).
 */
// Which pairings can actually produce which outcome is a measured fact, not a
// guess (see the story finding). A KO needs one side to reliably land damage
// across a 5000-point bar, and only the aggressive bot does that; an Ultimate
// needs the random bot, which is the only one that ever chooses `special`. So
// **a KO-with-Ultimate exists only where random meets aggressive** -- the other
// random pairings throw Ultimates but time out, and aggressive-vs-aggressive
// KOs but never specials. The three `ko` specs therefore both sides random and
// aggressive; the three `special` specs spread across the pairings that carry an
// Ultimate at all, for a corpus that is not six of the same fight.
const CORPUS_SPECS: readonly CorpusSpec[] = [
  { id: 'spectate-01', seedBase: 93_010, p1: 'random', p2: 'aggressive', require: 'ko' },
  { id: 'spectate-02', seedBase: 93_020, p1: 'aggressive', p2: 'random', require: 'ko' },
  // Pinned: the committed Ultimate fixture five test files replay. Its old v1
  // identity (seed 9303, random vs aggressive, a timeout with one Ultimate at
  // tick 870) is preserved exactly and only re-wrapped as v2.
  { id: 'spectate-03', seedBase: 9_303, p1: 'random', p2: 'aggressive', require: 'special', fixedSeed: 9_303 },
  { id: 'spectate-04', seedBase: 93_040, p1: 'random', p2: 'aggressive', require: 'ko' },
  { id: 'spectate-05', seedBase: 93_050, p1: 'spacing', p2: 'random', require: 'special' },
  { id: 'spectate-06', seedBase: 93_060, p1: 'aggressive', p2: 'random', require: 'special' },
];

/** How many consecutive seeds a spec's search tries before giving up (a loud failure, never a silent skip). */
const SEED_SEARCH_LIMIT = 2_000;

function createBot(kind: BotKind, id: string, seed: number) {
  if (kind === 'aggressive') {
    return createAggressiveBot(id, DEFAULT_FIGHTER_CONFIG);
  }
  if (kind === 'spacing') {
    return createSpacingBot(id, DEFAULT_FIGHTER_CONFIG);
  }
  return createRandomBot(id, seed);
}

interface ManifestEntry {
  readonly id: string;
  readonly commandLogUrl: string;
  readonly schemaVersion: string;
  readonly frameCount: number;
  /** Story 12.11. Set only on the one entry the visual gate selects to prove the Ultimate draws. */
  readonly containsUltimate?: boolean;
}

interface BuiltMatch {
  readonly spec: CorpusSpec;
  readonly seed: number;
  readonly match: MatchResult;
  readonly log: CommandLogV2;
  readonly specialCount: number;
  readonly firstSpecialTick: number;
  readonly isKo: boolean;
  readonly frameCount: number;
}

/** Reads a Match into the numbers the search and the showcase choice need. */
function summarise(spec: CorpusSpec, seed: number, match: MatchResult): BuiltMatch {
  const env = createFighterEnvironment();
  const configHash = computeConfigHash(DEFAULT_FIGHTER_CONFIG);
  const p1Id = `bot:${spec.p1}:1`;
  const p2Id = `bot:${spec.p2}:2`;

  const log = buildArcadeCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed,
    configHash,
    agents: [
      { id: p1Id, kind: 'bot' },
      { id: p2Id, kind: 'bot' },
    ],
  });
  // Fail loud at generation time if a log does not conform to the frozen v2
  // schema -- the corpus is the artefact, and an invalid one must never reach
  // disk (the arcade writer does not self-validate; here we do).
  validateCommandLogV2(log);

  const specials = log.decisions.filter((decision) => decision.action === 'special');
  const specialCount = specials.length;
  const firstSpecialTick = specialCount === 0 ? Number.MAX_SAFE_INTEGER : specials[0].tick;
  const isKo = log.result.endReason === 'ko';

  const film = buildReplayFilm(log, env);
  /**
   * Story 11.6. The **track's** length, not the film's. See the story file:
   * `frameCount` is what `spectate/manifest.ts`'s `offsetForNow` walks, and a
   * juice track is the film's length plus every hitstop hold plus every
   * Ultimate cinematic freeze. Every argument matches `spectate/walk.ts`'s call
   * exactly so the manifest and playback agree.
   */
  const track = buildJuiceTrack(
    film.frames,
    DEFAULT_JUICE_TUNING,
    arenaFor(DEFAULT_FIGHTER_CONFIG),
    false,
    DEFAULT_FIGHTER_CONFIG,
  );

  return { spec, seed, match, log, specialCount, firstSpecialTick, isKo, frameCount: track.frameCount };
}

function meets(built: BuiltMatch): boolean {
  if (built.specialCount < 1) {
    return false;
  }
  return built.spec.require === 'special' || built.isKo;
}

async function playSeed(spec: CorpusSpec, seed: number): Promise<BuiltMatch> {
  const env = createFighterEnvironment();
  const p1Id = `bot:${spec.p1}:1`;
  const p2Id = `bot:${spec.p2}:2`;
  const p1 = createBot(spec.p1, p1Id, Math.imul(seed, 31));
  const p2 = createBot(spec.p2, p2Id, Math.imul(seed, 37) + 1);
  const match = await runMatch(env, [p1, p2], seed);
  return summarise(spec, seed, match);
}

/**
 * Seeds already claimed by an earlier spec. Two specs share a pairing (three are
 * random-vs-aggressive), their 2000-wide search windows overlap, and the manifest
 * keys on `id` rather than content -- so without this guard a second search could
 * silently land on the first's seed and emit two byte-identical fights under two
 * ids. A claimed seed is skipped.
 */
const usedSeeds = new Set<number>();

async function searchSpec(
  spec: CorpusSpec,
  extra: (built: BuiltMatch) => boolean = () => true,
): Promise<BuiltMatch> {
  if (spec.fixedSeed !== undefined) {
    const built = await playSeed(spec, spec.fixedSeed);
    if (built.specialCount < 1) {
      throw new Error(
        `build-spectate-manifest: pinned seed ${spec.fixedSeed} for ${spec.id} no longer contains an Ultimate; its fixture assumption has drifted.`,
      );
    }
    usedSeeds.add(spec.fixedSeed);
    return built;
  }

  for (let offset = 0; offset < SEED_SEARCH_LIMIT; offset += 1) {
    const seed = spec.seedBase + offset;
    if (usedSeeds.has(seed)) {
      continue;
    }
    const built = await playSeed(spec, seed);
    if (meets(built) && extra(built)) {
      usedSeeds.add(seed);
      return built;
    }
  }
  throw new Error(
    `build-spectate-manifest: no seed in [${spec.seedBase}, ${spec.seedBase + SEED_SEARCH_LIMIT}) satisfied ${spec.id} (require ${spec.require}, plus the corpus constraint). Widen the range or the pairing.`,
  );
}

/**
 * The one entry the manifest marks `containsUltimate` for the visual gate.
 *
 * Prefer a KO Match (a fight that ends decisively reads best), then the earliest
 * Ultimate (so the gate reaches the cinematic soon after it presses play rather
 * than sampling a whole Match for it), then the most Ultimates. Deterministic in
 * the built set, so the marked entry is stable across regenerations.
 */
function chooseShowcase(built: readonly BuiltMatch[]): string {
  const ranked = [...built].sort((a, b) => {
    if (a.isKo !== b.isKo) {
      return a.isKo ? -1 : 1;
    }
    if (a.firstSpecialTick !== b.firstSpecialTick) {
      return a.firstSpecialTick - b.firstSpecialTick;
    }
    if (a.specialCount !== b.specialCount) {
      return b.specialCount - a.specialCount;
    }
    return a.spec.id.localeCompare(b.spec.id);
  });
  return ranked[0].spec.id;
}

mkdirSync(OUT, { recursive: true });

/**
 * The loop's total frame count must not be ≡ 1 (mod 3), and the last searched
 * entry is chosen to make that so.
 *
 * `manifest.json`'s `totalLoopDurationMs` is `round(totalFrames / 60 * 1000)`
 * integer milliseconds, and `1000 / 60 = 50 / 3`, so the loop is a *whole*
 * number of milliseconds exactly when `totalFrames ≡ 0 (mod 3)`, and rounds
 * cleanly *down* when `≡ 2`. At `≡ 1` it rounds *up*, which pushes the recorded
 * duration a hair past the true one and lands a visitor arriving at an exact lap
 * boundary on the loop's last frame instead of its first -- a one-frame join
 * error `offsetForNow` cannot avoid from a rounded integer duration, and the one
 * `manifest-artefact.test.ts` asserts against ("lands a visitor where the loop
 * actually is, frame for frame"). The old v1 corpus summed to 3234 (≡ 0) and so
 * never hit it; selecting the last entry's seed to keep the total off `≡ 1` is
 * the same seed-search this story already runs, with one more predicate on it.
 */
const built: BuiltMatch[] = [];
for (let index = 0; index < CORPUS_SPECS.length; index += 1) {
  const spec = CORPUS_SPECS[index];
  const isLast = index === CORPUS_SPECS.length - 1;
  if (!isLast) {
    built.push(await searchSpec(spec));
    continue;
  }
  const sumSoFar = built.reduce((sum, one) => sum + one.frameCount, 0);
  built.push(await searchSpec(spec, (candidate) => (sumSoFar + candidate.frameCount) % 3 !== 1));
}

const showcaseId = chooseShowcase(built);

const entries: ManifestEntry[] = built.map((one) => ({
  id: one.spec.id,
  commandLogUrl: `/replays/${one.spec.id}.command-log.json`,
  schemaVersion: one.log.schemaVersion,
  frameCount: one.frameCount,
  ...(one.spec.id === showcaseId ? { containsUltimate: true } : {}),
}));

for (const one of built) {
  writeFileSync(
    join(OUT, `${one.spec.id}.command-log.json`),
    `${JSON.stringify(one.log, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `${one.spec.id}: seed ${String(one.seed)} ${one.spec.p1} vs ${one.spec.p2} -- ` +
      `${one.isKo ? 'KO' : 'timeout'}, ${String(one.specialCount)} Ultimate(s), ` +
      `${String(one.frameCount)} clock frames${one.spec.id === showcaseId ? ' [showcase]' : ''}\n`,
  );
}

/**
 * Fixed anchor, deliberately a constant rather than `Date.now()` at generation
 * time (INV-3): two runs of this script must reproduce byte-identical output,
 * and a wall-clock read here would defeat that. `manifest.ts` computes an offset
 * from it, never a duration since it.
 */
const LOOP_START_EPOCH_MS = 1_754_000_000_000; // 2025-08-01T00:00:00.000Z, fixed.

const totalFrames = entries.reduce((sum, entry) => sum + entry.frameCount, 0);
const totalLoopDurationMs = Math.round((totalFrames / PLAYBACK_FPS) * 1000);

const manifest = {
  schemaVersion: '1.0.0',
  loopStartEpochMs: LOOP_START_EPOCH_MS,
  totalLoopDurationMs,
  entries,
};

writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const koCount = built.filter((one) => one.isKo).length;
process.stdout.write(
  `manifest.json: ${String(entries.length)} entries, ${String(koCount)} KO, showcase ${showcaseId}, ` +
    `${String(totalLoopDurationMs)}ms total loop (${String(FRAMES_PER_DECISION)} frames/decision @ ${String(PLAYBACK_FPS)}fps)\n`,
);
