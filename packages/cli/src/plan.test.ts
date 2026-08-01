import { describe, expect, it } from 'vitest';
import { computeConfigHash, computeMatchId } from '../../core/src/command-log';
import { DEFAULT_FIGHTER_CONFIG } from '../../env-fighter/src/config';
import { createFighterEnvironment } from '../../env-fighter/src/environment';
import { parseRunConfig } from './config';
import {
  CLI_ENVIRONMENT_ID,
  CLI_ENVIRONMENT_VERSION,
  cliConfigHash,
  joinPath,
  logFileName,
  outstandingMatches,
  planMatch,
  planTournament,
  type PlannedMatch,
} from './plan';
import { runOneMatch, serialiseCommandLog } from './run';
import { createMemoryIo } from './testing/memory-io';

const CONFIG = parseRunConfig(
  JSON.stringify({
    seedBase: 4101,
    seedCount: 3,
    outputDir: 'replays',
    agents: [
      { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
      { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
      { id: 'bot:random', kind: 'bot', bot: 'random' },
    ],
  }),
);

describe('the plan is a pure function of the config (AD-8)', () => {
  it('derives matchId exactly as packages/core does', () => {
    const planned = planMatch(4101, ['bot:aggressive', 'bot:spacing']);
    expect(planned.matchId).toBe(
      computeMatchId({
        environmentId: CLI_ENVIRONMENT_ID,
        seed: 4101,
        configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
        agentIds: ['bot:aggressive', 'bot:spacing'],
      }),
    );
  });

  it('agrees with the live environment adapter about its own identity', () => {
    const env = createFighterEnvironment();
    expect(CLI_ENVIRONMENT_ID).toBe(env.id);
    expect(CLI_ENVIRONMENT_VERSION).toBe(env.version);
  });

  it('uses the same config hash a CI or browser Match of this configuration carries', () => {
    expect(cliConfigHash()).toBe(computeConfigHash(DEFAULT_FIGHTER_CONFIG));
  });

  it('produces the identical plan when called twice', () => {
    expect(planTournament(CONFIG)).toStrictEqual(planTournament(CONFIG));
  });

  it('gives every side ordering its own matchId', () => {
    expect(planMatch(4101, ['a', 'b']).matchId).not.toBe(planMatch(4101, ['b', 'a']).matchId);
  });

  it('gives every seed its own matchId', () => {
    expect(planMatch(4101, ['a', 'b']).matchId).not.toBe(planMatch(4102, ['a', 'b']).matchId);
  });
});

describe('planTournament', () => {
  it('is every unordered pair, over every seed', () => {
    const planned = planTournament(CONFIG);
    // 3 agents -> 3 pairs, times 3 seeds.
    expect(planned).toHaveLength(9);
    expect(new Set(planned.map((match) => match.matchId)).size).toBe(9);
  });

  it('is seed-major, so an interrupted run has completed whole seeds', () => {
    const seeds = planTournament(CONFIG).map((match) => match.seed);
    expect(seeds).toStrictEqual([4101, 4101, 4101, 4102, 4102, 4102, 4103, 4103, 4103]);
  });

  it('puts the lower-declared agent on side 0 (a known bias; Story 7.1 owns side swaps)', () => {
    const first = planTournament(CONFIG)[0];
    expect(first.agentIds).toStrictEqual(['bot:aggressive', 'bot:spacing']);
  });

  it('never pairs an agent with itself', () => {
    for (const match of planTournament(CONFIG)) {
      expect(match.agentIds[0]).not.toBe(match.agentIds[1]);
    }
  });
});

describe('joinPath and logFileName', () => {
  it('names a log after its matchId', () => {
    expect(logFileName('abc')).toBe('abc.command-log.json');
  });

  it('joins with forward slashes and tolerates a trailing separator', () => {
    expect(joinPath('replays', 'a.json')).toBe('replays/a.json');
    expect(joinPath('replays/', 'a.json')).toBe('replays/a.json');
    expect(joinPath('', 'a.json')).toBe('a.json');
  });
});

/** A real, committed log for one planned Match -- built through the real runner. */
async function commit(io: ReturnType<typeof createMemoryIo>, match: PlannedMatch): Promise<string> {
  const log = await runOneMatch(match, CONFIG, { io });
  const path = joinPath(CONFIG.outputDir, logFileName(log.matchId));
  await io.writeFile(path, serialiseCommandLog(log));
  return path;
}

describe('outstandingMatches (AC4, AD-9: the committed logs ARE the state)', () => {
  it('is the whole plan when nothing has been committed', async () => {
    const io = createMemoryIo();
    expect(await outstandingMatches(planTournament(CONFIG), io, 'replays')).toHaveLength(9);
  });

  it('drops exactly the Matches whose logs are committed, and nothing else', async () => {
    const io = createMemoryIo();
    const planned = planTournament(CONFIG);
    await commit(io, planned[0]);
    await commit(io, planned[4]);

    const outstanding = await outstandingMatches(planned, io, 'replays');
    expect(outstanding).toHaveLength(7);
    expect(outstanding.map((match) => match.matchId)).not.toContain(planned[0].matchId);
    expect(outstanding.map((match) => match.matchId)).not.toContain(planned[4].matchId);
  });

  it('preserves plan order in what is left', async () => {
    const io = createMemoryIo();
    const planned = planTournament(CONFIG);
    await commit(io, planned[3]);

    const outstanding = await outstandingMatches(planned, io, 'replays');
    expect(outstanding.map((match) => match.matchId)).toStrictEqual(
      planned.filter((_, index) => index !== 3).map((match) => match.matchId),
    );
  });

  it('treats a truncated log as outstanding -- the mid-write kill AC4 is about', async () => {
    const io = createMemoryIo();
    const planned = planTournament(CONFIG);
    const path = await commit(io, planned[0]);

    const whole = io.files.get(path) ?? '';
    io.files.set(path, whole.slice(0, Math.floor(whole.length / 2)));

    const outstanding = await outstandingMatches(planned, io, 'replays');
    expect(outstanding.map((match) => match.matchId)).toContain(planned[0].matchId);
  });

  it('treats a schema-invalid log as outstanding', async () => {
    const io = createMemoryIo();
    const planned = planTournament(CONFIG);
    const path = await commit(io, planned[0]);

    const log = JSON.parse(io.files.get(path) ?? '{}') as Record<string, unknown>;
    delete log['finalStateHash'];
    io.files.set(path, JSON.stringify(log));

    const outstanding = await outstandingMatches(planned, io, 'replays');
    expect(outstanding.map((match) => match.matchId)).toContain(planned[0].matchId);
  });

  it('treats a log whose matchId disagrees with its filename as outstanding', async () => {
    const io = createMemoryIo();
    const planned = planTournament(CONFIG);
    const path = await commit(io, planned[0]);

    // Same valid document, filed under a different Match's name. A resume that
    // trusted the directory listing would skip a Match nothing ever played.
    io.files.set(joinPath('replays', logFileName(planned[1].matchId)), io.files.get(path) ?? '');

    const outstanding = await outstandingMatches(planned, io, 'replays');
    expect(outstanding.map((match) => match.matchId)).toContain(planned[1].matchId);
  });

  it('ignores unrelated files in the output directory', async () => {
    const io = createMemoryIo({ files: { 'replays/README.md': 'notes', 'replays/demo.command-log.json': '{}' } });
    expect(await outstandingMatches(planTournament(CONFIG), io, 'replays')).toHaveLength(9);
  });

  it('reads no file at all when the directory listing has nothing matching', async () => {
    const io = createMemoryIo();
    let reads = 0;
    const counting = {
      ...io,
      readFile: (path: string) => {
        reads += 1;
        return io.readFile(path);
      },
    };
    await outstandingMatches(planTournament(CONFIG), counting, 'replays');
    expect(reads).toBe(0);
  });
});
