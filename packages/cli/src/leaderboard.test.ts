import type { AgentIdentity, CommandLog } from '@tokenbrawl/contracts';
import { describe, expect, it } from 'vitest';
import { generateLeaderboard, loadCorpus, tracksFor } from './leaderboard';
import { EXIT_OK, main } from './main';
import { createMemoryIo, type MemoryIo } from './testing/memory-io';

/**
 * Story 7-2, the generation half.
 *
 * The rating arithmetic is `packages/core`'s subject. What is tested here is
 * everything between the committed logs and the published files: which logs are
 * read, how the main/Reflex classification is obtained (`partitionByTrack`,
 * never re-derived), what happens to a log this build cannot rate, and that
 * both artefacts land where the tournament workflow will commit them.
 *
 * The corpus is played for real by the `tournament` command over Baseline Bots
 * -- 15 seeds x 3 pairings x 2 sides = 90 Matches, no provider key, about a
 * second. A hand-built corpus would have let the two halves of this story agree
 * with each other while disagreeing with what the runner actually writes.
 */

const SEED_COUNT = 15;

const RUN_CONFIG = JSON.stringify({
  seedBase: 4101,
  seedCount: SEED_COUNT,
  outputDir: 'replays',
  agents: [
    { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
    { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
    { id: 'bot:random', kind: 'bot', bot: 'random' },
  ],
});

async function playedCorpus(): Promise<MemoryIo> {
  const io = createMemoryIo({ files: { 'run.json': RUN_CONFIG } });
  expect(await main(['tournament', '--config', 'run.json'], io)).toBe(EXIT_OK);
  return io;
}

function logPaths(io: MemoryIo): string[] {
  return [...io.files.keys()].filter((path) => path.endsWith('.command-log.json')).sort();
}

function readLog(io: MemoryIo, path: string): CommandLog {
  return JSON.parse(io.files.get(path) ?? '') as CommandLog;
}

/**
 * A template log rewritten onto a new pairing, over `SEED_COUNT` seeds from both
 * sides, so the synthetic pairing clears the same coverage floor a real one has
 * to. Everything the rating pipeline reads -- agents, seed, outcome -- is set
 * here; everything else is inherited so the document still validates.
 */
function clonePairing(
  io: MemoryIo,
  template: CommandLog,
  first: AgentIdentity,
  second: AgentIdentity,
  seedBase: number,
): void {
  for (let offset = 0; offset < SEED_COUNT; offset += 1) {
    const seed = seedBase + offset;
    for (const flipped of [false, true]) {
      const agents: readonly [AgentIdentity, AgentIdentity] = flipped
        ? [second, first]
        : [first, second];
      // The frozen schema's `matchId` is `^[a-z0-9-]{8,64}$` -- narrower than
      // an Agent id, which may carry `:` and `.`. A synthetic log that does not
      // validate is a synthetic log the generator silently never reads, so the
      // id is built to the pattern rather than assumed into it.
      const slug = (id: string): string => id.replace(/[^a-z0-9-]/g, '-');
      const matchId = `${slug(first.id)}-${slug(second.id)}-${String(seed)}-${flipped ? 'b' : 'a'}`;
      const log: CommandLog = { ...template, matchId, seed, agents, decisions: [] };
      io.files.set(`replays/${matchId}.command-log.json`, JSON.stringify(log));
    }
  }
}

function deployment(id: string, probe?: 'reports-reasoning' | 'reports-completion-only'): AgentIdentity {
  return {
    id,
    kind: 'deployment',
    deployment: {
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: id,
      ...(probe === undefined ? {} : { meteringProbe: probe }),
    },
  };
}

describe('loadCorpus', () => {
  it('reads every committed Command Log and nothing else', async () => {
    const io = await playedCorpus();
    io.files.set('replays/notes.txt', 'not a log');
    io.files.set('replays/demo.reasoning.json', '{}');

    const corpus = await loadCorpus(io, 'replays');
    expect(corpus.matches).toHaveLength(SEED_COUNT * 3 * 2);
    expect(corpus.identities).toHaveLength(corpus.matches.length * 2);
    expect(corpus.unreadable).toHaveLength(0);
    expect(corpus.staleConfig).toHaveLength(0);
  });

  it('skips a file that is not a valid Command Log rather than failing the run', async () => {
    const io = await playedCorpus();
    io.files.set('replays/truncated.command-log.json', '{"schemaVersion":"1.0.0","matchId":');
    io.files.set('replays/wrong-version.command-log.json', JSON.stringify({ schemaVersion: '2.0.0' }));

    const corpus = await loadCorpus(io, 'replays');
    // A segment killed mid-write leaves exactly this behind. One unreadable
    // file must never stop a board from being published.
    expect(corpus.unreadable).toStrictEqual([
      'truncated.command-log.json',
      'wrong-version.command-log.json',
    ]);
    expect(corpus.matches).toHaveLength(SEED_COUNT * 3 * 2);
  });

  it('excludes a log played under a different frame-data config hash (AD-8)', async () => {
    const io = await playedCorpus();
    const [path] = logPaths(io);
    const stale: CommandLog = { ...readLog(io, path), configHash: 'a'.repeat(64) };
    io.files.set('replays/stale.command-log.json', JSON.stringify(stale));

    const corpus = await loadCorpus(io, 'replays');
    expect(corpus.staleConfig).toStrictEqual(['stale.command-log.json']);
    expect(corpus.matches).toHaveLength(SEED_COUNT * 3 * 2);
  });

  it('is an empty corpus, not an error, when the directory does not exist', async () => {
    const io = createMemoryIo({ files: { 'run.json': RUN_CONFIG } });
    const corpus = await loadCorpus(io, 'replays');
    expect(corpus.matches).toHaveLength(0);
  });

  it('excludes a log played by a different Environment version', async () => {
    const io = await playedCorpus();
    const [path] = logPaths(io);
    const older: CommandLog = {
      ...readLog(io, path),
      environment: { id: 'fighter-1v1', version: '0.9.0' },
    };
    io.files.set('replays/older-engine.command-log.json', JSON.stringify(older));

    // `configHash` covers the frame data, not the engine that reads it.
    const corpus = await loadCorpus(io, 'replays');
    expect(corpus.staleConfig).toStrictEqual(['older-engine.command-log.json']);
  });
});

describe('tracksFor', () => {
  it('asks partitionByTrack, so an unprobed Deployment is Reflex Track (INV-5)', () => {
    const tracks = tracksFor([
      { id: 'bot:spacing', kind: 'bot' },
      deployment('groq:unprobed'),
      deployment('groq:probed', 'reports-reasoning'),
      deployment('groq:failed', 'reports-completion-only'),
    ]);
    expect(tracks.get('bot:spacing')).toBe('main');
    expect(tracks.get('groq:unprobed')).toBe('reflex');
    expect(tracks.get('groq:probed')).toBe('main');
    expect(tracks.get('groq:failed')).toBe('reflex');
  });

  it('takes the most restrictive classification an Agent appears under', () => {
    // "It was probed on some nights" is not something a leaderboard can act on,
    // and the direction of the tie-break is the one INV-5 can survive.
    const tracks = tracksFor([
      deployment('groq:sometimes', 'reports-reasoning'),
      deployment('groq:sometimes'),
    ]);
    expect(tracks.get('groq:sometimes')).toBe('reflex');
  });
});

describe('generateLeaderboard', () => {
  it('rates a fully played bot corpus and writes both artefacts', async () => {
    const io = await playedCorpus();
    const result = await generateLeaderboard(io, 'replays');

    expect(result.written).toStrictEqual([
      'docs/reports/leaderboard.json',
      'docs/reports/leaderboard.md',
    ]);
    expect(result.report.ratedMatches).toBe(SEED_COUNT * 3 * 2);
    expect(result.report.mainLeaderboard.map((row) => row.agent)).toStrictEqual([
      'bot:spacing',
      'bot:aggressive',
      'bot:random',
    ]);
    for (const row of result.report.mainLeaderboard) {
      expect(row.ciLowerBasisPoints).toBeLessThanOrEqual(row.ratingBasisPoints);
      expect(row.ciUpperBasisPoints).toBeGreaterThanOrEqual(row.ratingBasisPoints);
    }

    const markdown = io.files.get('docs/reports/leaderboard.md') ?? '';
    expect(markdown).toContain('| Agent | Kind | Matches | Opponents | Rating | CI |');
    expect(markdown).toContain('| bot:spacing | bot |');

    const json = JSON.parse(io.files.get('docs/reports/leaderboard.json') ?? '');
    expect(json).toStrictEqual(JSON.parse(JSON.stringify(result.report)));
  });

  it('reproduces byte for byte from the same corpus (AC5)', async () => {
    const io = await playedCorpus();
    await generateLeaderboard(io, 'replays');
    const first = io.files.get('docs/reports/leaderboard.json');
    await generateLeaderboard(io, 'replays');
    expect(io.files.get('docs/reports/leaderboard.json')).toBe(first);
  });

  it('puts an unprobed Deployment on the Reflex Track and never on the main board (AC3)', async () => {
    const io = await playedCorpus();
    const template = readLog(io, logPaths(io)[0]);
    clonePairing(io, template, deployment('groq:unprobed'), { id: 'bot:spacing', kind: 'bot' }, 9000);

    const result = await generateLeaderboard(io, 'replays');
    expect(result.report.mainLeaderboard.map((row) => row.agent)).not.toContain('groq:unprobed');
    expect(result.report.reflexTrack.map((row) => row.agent)).toStrictEqual(['groq:unprobed']);

    const markdown = io.files.get('docs/reports/leaderboard.md') ?? '';
    const mainSection = markdown.slice(
      markdown.indexOf('## Main leaderboard'),
      markdown.indexOf('## Reflex Track'),
    );
    expect(mainSection).not.toContain('groq:unprobed');
  });

  it('promotes a Deployment whose Metering Probe reported reasoning (INV-5)', async () => {
    const io = await playedCorpus();
    const template = readLog(io, logPaths(io)[0]);
    clonePairing(
      io,
      template,
      deployment('groq:probed', 'reports-reasoning'),
      { id: 'bot:spacing', kind: 'bot' },
      9000,
    );

    const result = await generateLeaderboard(io, 'replays');
    expect(result.report.mainLeaderboard.map((row) => row.agent)).toContain('groq:probed');
  });

  it('excludes a BYOK Match entirely (AC4)', async () => {
    const io = await playedCorpus();
    const template = readLog(io, logPaths(io)[0]);
    const visitor: AgentIdentity = {
      id: 'byok:visitor-model',
      kind: 'deployment',
      deployment: {
        provider: 'byok',
        endpoint: 'https://example.invalid/v1/chat/completions',
        model: 'visitor-model',
      },
    };
    clonePairing(io, template, visitor, { id: 'bot:spacing', kind: 'bot' }, 9000);

    const result = await generateLeaderboard(io, 'replays');
    expect(result.report.ratedMatches).toBe(SEED_COUNT * 3 * 2);
    expect(result.report.exclusionTotals).toStrictEqual([
      { exclusion: 'byok', matches: SEED_COUNT * 2 },
    ]);
    expect(
      [...result.report.mainLeaderboard, ...result.report.reflexTrack].map((row) => row.agent),
    ).not.toContain('byok:visitor-model');
    expect(result.report.unrated.map((row) => row.agent)).toStrictEqual(['byok:visitor-model']);
  });

  it('refuses to overwrite a published board with an empty one', async () => {
    // The failure this closes is silent and total: a mistyped --out, or a
    // workflow running from the wrong directory, reads no logs, publishes a
    // blank table over the real ratings, and the next step commits it.
    const io = await playedCorpus();
    await generateLeaderboard(io, 'replays');

    await expect(generateLeaderboard(io, 'somewhere-else')).rejects.toThrow(
      /Refusing to overwrite a published leaderboard with an empty one/,
    );
    // The published board is untouched.
    expect(io.files.get('docs/reports/leaderboard.md')).toContain('| bot:spacing | bot |');
  });

  it('publishes an empty board on a first run, when there is nothing to overwrite', async () => {
    const io = createMemoryIo({ files: { 'run.json': RUN_CONFIG } });
    const result = await generateLeaderboard(io, 'replays');
    expect(result.report.matches).toBe(0);
    expect(io.files.has('docs/reports/leaderboard.md')).toBe(true);
  });

  it('publishes an empty board rather than nothing when no pairing is covered', async () => {
    const io = createMemoryIo({
      files: { 'run.json': JSON.stringify({ ...JSON.parse(RUN_CONFIG), seedCount: 2 }) },
    });
    expect(await main(['tournament', '--config', 'run.json'], io)).toBe(EXIT_OK);

    const result = await generateLeaderboard(io, 'replays');
    expect(result.report.ratedMatches).toBe(0);
    expect(result.report.mainLeaderboard).toHaveLength(0);
    const markdown = io.files.get('docs/reports/leaderboard.md') ?? '';
    expect(markdown).toContain('_No rated entry on the main leaderboard.');
    expect(markdown).toContain('provisional (');
  });
});

describe('the leaderboard command', () => {
  it('writes the board and reports what it did', async () => {
    const io = await playedCorpus();
    expect(await main(['leaderboard', '--config', 'run.json'], io)).toBe(EXIT_OK);

    expect(io.files.has('docs/reports/leaderboard.json')).toBe(true);
    expect(io.stdout.join('\n')).toContain('90 Matches read, 90 rated, 0 excluded');
    expect(io.stdout.join('\n')).toContain('wrote docs/reports/leaderboard.md');
  });

  it('needs no API key, so it can run after a segment that failed on a missing one', async () => {
    const config = JSON.stringify({
      ...JSON.parse(RUN_CONFIG),
      agents: [
        ...JSON.parse(RUN_CONFIG).agents,
        {
          id: 'groq-some-model',
          kind: 'deployment',
          provider: 'groq',
          model: 'llama-3.3-70b-versatile',
          apiKeyEnv: 'GROQ_API_KEY',
        },
      ],
    });
    const io = createMemoryIo({ files: { 'run.json': config }, env: {} });

    // The same config through `tournament` fails at second zero on the unset
    // key; `leaderboard` reads files and must not.
    expect(await main(['leaderboard', '--config', 'run.json'], io)).toBe(EXIT_OK);
    expect(io.stderr.join('\n')).not.toContain('GROQ_API_KEY');
  });

  it('warns when the report directory is not the one the workflow commits', async () => {
    const io = await playedCorpus();
    expect(await main(['leaderboard', '--config', 'run.json', '--reports', 'scratch'], io)).toBe(
      EXIT_OK,
    );
    expect(io.files.has('scratch/leaderboard.json')).toBe(true);
    expect(io.stderr.join('\n')).toContain('is outside docs/reports');
  });

  it('warns about an unreadable log without failing', async () => {
    const io = await playedCorpus();
    io.files.set('replays/truncated.command-log.json', '{');
    expect(await main(['leaderboard', '--config', 'run.json'], io)).toBe(EXIT_OK);
    expect(io.stderr.join('\n')).toContain('truncated.command-log.json is not a readable');
  });

  it('rejects an unknown option and an empty --reports', async () => {
    const io = await playedCorpus();
    expect(await main(['leaderboard', '--config', 'run.json', '--seed', '1'], io)).not.toBe(EXIT_OK);
    expect(await main(['leaderboard', '--config', 'run.json', '--reports', ' '], io)).not.toBe(
      EXIT_OK,
    );
  });
});
