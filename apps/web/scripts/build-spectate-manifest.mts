import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandLog } from '@tokenbrawl/contracts';
import { buildCommandLog, computeConfigHash } from '../../../packages/core/src/command-log';
import { runMatch } from '../../../packages/core/src/match-runner';
import { DEFAULT_FIGHTER_CONFIG } from '../../../packages/env-fighter/src/config';
import { createFighterEnvironment } from '../../../packages/env-fighter/src/environment';
import {
  createAggressiveBot,
  createRandomBot,
  createSpacingBot,
} from '../../../packages/env-fighter/src/bots';
import { PLAYBACK_FPS, FRAMES_PER_DECISION, buildReplayFilm } from '../src/replay/film';

/**
 * Story 9.3: generates the Spectate stream's manifest and its Command Logs.
 *
 * Every entry is a Baseline-Bot-vs-Baseline-Bot Match -- no provider key, no
 * network, deterministic (AD-17, AC "no on-demand computation"). This mirrors
 * `build-hero.mts`'s shape and `apps/web/src/testing/demo-log.ts`'s reasoning
 * for why this must run in Node rather than the browser: `buildCommandLog`
 * reaches `node:crypto` through `canonical-hash.ts`.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings \
 *        --import ./packages/cli/bin/register.mjs apps/web/scripts/build-spectate-manifest.mts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'replays');

type BotKind = 'aggressive' | 'spacing' | 'random';

interface Pairing {
  readonly id: string;
  readonly seed: number;
  readonly p1: BotKind;
  readonly p2: BotKind;
}

/** Six pairings: every bot kind meets every other, plus one mirror, over distinct seeds. */
const PAIRINGS: readonly Pairing[] = [
  { id: 'spectate-01', seed: 9_301, p1: 'aggressive', p2: 'spacing' },
  { id: 'spectate-02', seed: 9_302, p1: 'spacing', p2: 'aggressive' },
  { id: 'spectate-03', seed: 9_303, p1: 'random', p2: 'aggressive' },
  { id: 'spectate-04', seed: 9_304, p1: 'aggressive', p2: 'random' },
  { id: 'spectate-05', seed: 9_305, p1: 'spacing', p2: 'random' },
  { id: 'spectate-06', seed: 9_306, p1: 'random', p2: 'spacing' },
];

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
}

async function buildOne(pairing: Pairing): Promise<{ readonly log: CommandLog; readonly entry: ManifestEntry }> {
  const env = createFighterEnvironment();
  const p1Id = `bot:${pairing.p1}:1`;
  const p2Id = `bot:${pairing.p2}:2`;
  const p1 = createBot(pairing.p1, p1Id, Math.imul(pairing.seed, 31));
  const p2 = createBot(pairing.p2, p2Id, Math.imul(pairing.seed, 37) + 1);

  const match = await runMatch(env, [p1, p2], pairing.seed);
  const log = buildCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed: pairing.seed,
    configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
    agents: [
      { id: p1Id, kind: 'bot' },
      { id: p2Id, kind: 'bot' },
    ],
  });

  const film = buildReplayFilm(log, env);

  return {
    log,
    entry: {
      id: pairing.id,
      commandLogUrl: `/replays/${pairing.id}.command-log.json`,
      schemaVersion: log.schemaVersion,
      frameCount: film.frames.length,
    },
  };
}

mkdirSync(OUT, { recursive: true });

const entries: ManifestEntry[] = [];
for (const pairing of PAIRINGS) {
  const { log, entry } = await buildOne(pairing);
  writeFileSync(join(OUT, `${pairing.id}.command-log.json`), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  entries.push(entry);
  process.stdout.write(
    `${pairing.id}: seed ${String(pairing.seed)} ${pairing.p1} vs ${pairing.p2} -- ${String(entry.frameCount)} frames\n`,
  );
}

/**
 * Fixed anchor, deliberately a constant rather than `Date.now()` at generation
 * time: two runs of this script must be able to reproduce byte-identical
 * output for the same pairings/seeds, and a wall-clock read here would defeat
 * that. The value only has to be *some* point in the past; `manifest.ts`
 * computes an offset from it, never a duration since it.
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
process.stdout.write(
  `manifest.json: ${String(entries.length)} entries, ${String(totalLoopDurationMs)}ms total loop (${String(FRAMES_PER_DECISION)} frames/decision @ ${String(PLAYBACK_FPS)}fps)\n`,
);
