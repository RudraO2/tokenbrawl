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
  it('is every unordered pair, over every seed, from both sides (7.1 AC1)', () => {
    const planned = planTournament(CONFIG);
    // 3 agents -> 3 pairs, times 3 seeds, times 2 side swaps.
    expect(planned).toHaveLength(18);
    expect(new Set(planned.map((match) => match.matchId)).size).toBe(18);
  });

  it('is seed-major, so an interrupted run has completed whole seeds', () => {
    const seeds = planTournament(CONFIG).map((match) => match.seed);
    expect(seeds).toStrictEqual([
      4101, 4101, 4101, 4101, 4101, 4101, 4102, 4102, 4102, 4102, 4102, 4102, 4103, 4103, 4103,
      4103, 4103, 4103,
    ]);
  });

  it('schedules exactly two Matches per pairing per seed, in opposite array positions (AC1)', () => {
    const bySeedAndPairing = new Map<string, string[][]>();
    for (const match of planTournament(CONFIG)) {
      const key = `${String(match.seed)}|${[...match.agentIds].sort().join('|')}`;
      const orientations = bySeedAndPairing.get(key) ?? [];
      orientations.push([...match.agentIds]);
      bySeedAndPairing.set(key, orientations);
    }

    // 3 pairings x 3 seeds.
    expect(bySeedAndPairing.size).toBe(9);
    for (const orientations of bySeedAndPairing.values()) {
      expect(orientations).toHaveLength(2);
      const [one, other] = orientations;
      expect(other).toStrictEqual([one[1], one[0]]);
    }
  });

  it('gives the two sides of one pairing and seed distinct matchIds (AC1)', () => {
    for (const match of planTournament(CONFIG)) {
      const mirror = planMatch(match.seed, [match.agentIds[1], match.agentIds[0]]);
      expect(mirror.matchId).not.toBe(match.matchId);
      // And the mirror is genuinely in the plan, not merely constructible.
      expect(planTournament(CONFIG).map((entry) => entry.matchId)).toContain(mirror.matchId);
    }
  });

  it('emits the two orientations adjacently, so an interruption cuts between pairs', () => {
    // AD-9 makes plan order decide what a killed segment leaves behind. A
    // one-sided pass followed by a mirroring pass would leave a whole
    // tournament of one-sided data on exactly the interruption the scheduled
    // workflow makes routine.
    const planned = planTournament(CONFIG);
    for (let index = 0; index < planned.length; index += 2) {
      const left = planned[index];
      const right = planned[index + 1];
      expect(right.seed).toBe(left.seed);
      expect(right.agentIds).toStrictEqual([left.agentIds[1], left.agentIds[0]]);
    }
  });

  it('puts the lower-declared agent on side 0 of the first Match of each pair', () => {
    const planned = planTournament(CONFIG);
    expect(planned[0].agentIds).toStrictEqual(['bot:aggressive', 'bot:spacing']);
    expect(planned[1].agentIds).toStrictEqual(['bot:spacing', 'bot:aggressive']);
  });

  it('gives every agent an equal number of Matches on each side (AC1)', () => {
    const onSide0 = new Map<string, number>();
    const onSide1 = new Map<string, number>();
    for (const match of planTournament(CONFIG)) {
      onSide0.set(match.agentIds[0], (onSide0.get(match.agentIds[0]) ?? 0) + 1);
      onSide1.set(match.agentIds[1], (onSide1.get(match.agentIds[1]) ?? 0) + 1);
    }
    for (const agent of CONFIG.agents) {
      expect(onSide0.get(agent.id)).toBe(onSide1.get(agent.id));
    }
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
    expect(await outstandingMatches(planTournament(CONFIG), io, 'replays')).toHaveLength(18);
  });

  it('drops exactly the Matches whose logs are committed, and nothing else', async () => {
    const io = createMemoryIo();
    const planned = planTournament(CONFIG);
    await commit(io, planned[0]);
    await commit(io, planned[4]);

    const outstanding = await outstandingMatches(planned, io, 'replays');
    expect(outstanding).toHaveLength(16);
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
    expect(await outstandingMatches(planTournament(CONFIG), io, 'replays')).toHaveLength(18);
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
