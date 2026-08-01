import { describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE, USAGE, main, parseArgs } from './main';
import { createMemoryIo, type MemoryIo } from './testing/memory-io';
import { REDACTED } from './secrets';
import type { HttpFetch } from '../../providers/src/http';

const RUN_CONFIG = JSON.stringify({
  seedBase: 4101,
  seedCount: 3,
  outputDir: 'replays',
  agents: [
    { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
    { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
    { id: 'bot:random', kind: 'bot', bot: 'random' },
  ],
});

function io(files: Record<string, string> = {}, env: Record<string, string> = {}): MemoryIo {
  return createMemoryIo({ files: { 'run.json': RUN_CONFIG, ...files }, env });
}

function logsIn(memory: MemoryIo): string[] {
  return [...memory.files.keys()].filter((path) => path.endsWith('.command-log.json'));
}

describe('parseArgs', () => {
  it('reads a command and its --flag value pairs', () => {
    expect(parseArgs(['match', '--config', 'run.json', '--seed', '7'])).toStrictEqual({
      command: 'match',
      options: { config: 'run.json', seed: '7' },
    });
  });

  it('rejects an option with no value', () => {
    expect(() => parseArgs(['match', '--config'])).toThrow(/needs a value/);
  });

  it('rejects an option whose value looks like another option', () => {
    expect(() => parseArgs(['match', '--config', '--seed', '7'])).toThrow(/--config needs a value/);
  });

  it('rejects a repeated option rather than silently taking one', () => {
    expect(() => parseArgs(['match', '--seed', '1', '--seed', '2'])).toThrow(/given twice/);
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseArgs(['match', 'run.json'])).toThrow(/Unexpected argument/);
  });

  it('rejects an option before the command', () => {
    expect(() => parseArgs(['--config', 'run.json'])).toThrow(/Expected a command/);
  });

  it('rejects an empty argv', () => {
    expect(() => parseArgs([])).toThrow(/No command given/);
  });

  it('treats --help and -h as the help command, not as an option before a command', () => {
    // The leading-dash rule used to reject these, which made `main`'s own
    // `--help` branch unreachable -- and `--help` is what people type.
    for (const token of ['help', '--help', '-h']) {
      expect(parseArgs([token])).toStrictEqual({ command: 'help', options: {} });
    }
  });

  it('tolerates whitespace around the two ids in --agents', () => {
    expect(parseArgs(['match', '--agents', 'a, b']).options['agents']).toBe('a, b');
  });
});

describe('main: usage and errors', () => {
  it('prints usage and exits 2 with no arguments', async () => {
    const memory = io();
    expect(await main([], memory)).toBe(EXIT_USAGE);
    expect(memory.stderr.join('\n')).toContain(USAGE);
  });

  it('prints usage and exits 0 for help', async () => {
    const memory = io();
    expect(await main(['help'], memory)).toBe(EXIT_OK);
    expect(memory.stdout.join('\n')).toContain(USAGE);
  });

  it('exits 2 for an unknown command', async () => {
    const memory = io();
    expect(await main(['fight', '--config', 'run.json'], memory)).toBe(EXIT_USAGE);
    expect(memory.stderr[0]).toContain('Unknown command "fight"');
  });

  it('exits 2 for an option that command does not take', async () => {
    const memory = io();
    expect(await main(['tournament', '--config', 'run.json', '--seed', '1'], memory)).toBe(EXIT_USAGE);
    expect(memory.stderr[0]).toContain('Unknown option --seed');
  });

  it('exits 1 for a config file that is not there, and writes nothing', async () => {
    const memory = createMemoryIo();
    expect(await main(['tournament', '--config', 'missing.json'], memory)).toBe(1);
    expect(memory.files.size).toBe(0);
  });

  it('exits 1 for an invalid config', async () => {
    const memory = createMemoryIo({ files: { 'bad.json': '{"seedBase": -1}' } });
    expect(await main(['tournament', '--config', 'bad.json'], memory)).toBe(1);
    expect(memory.stderr[0]).toContain('Invalid run config');
  });

  it('exits 2 when --agents names the same id twice', async () => {
    const memory = io();
    const code = await main(
      ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:spacing,bot:spacing'],
      memory,
    );
    expect(code).toBe(EXIT_USAGE);
    expect(memory.stderr[0]).toContain('on both sides');
  });

  it('prints usage and exits 0 for --help and -h', async () => {
    for (const token of ['--help', '-h']) {
      const memory = io();
      expect(await main([token], memory)).toBe(EXIT_OK);
      expect(memory.stdout.join('\n')).toContain(USAGE);
    }
  });

  it('exits 2 when --config is missing', async () => {
    const memory = io();
    expect(await main(['tournament'], memory)).toBe(EXIT_USAGE);
    expect(memory.stderr[0]).toContain('--config is required');
  });

  it('exits 2 for a seed past the frozen schema maximum, before playing the Match', async () => {
    const memory = io();
    const code = await main(
      ['match', '--config', 'run.json', '--seed', '5000000000', '--agents', 'bot:aggressive,bot:spacing'],
      memory,
    );
    expect(code).toBe(EXIT_USAGE);
    expect(memory.stderr[0]).toContain('between 0 and 4294967295');
    // The point of checking early: nothing ran and nothing was written.
    expect(logsIn(memory)).toHaveLength(0);
  });

  it('exits 2 for an empty --out rather than scattering logs across the working directory', async () => {
    const memory = io();
    const code = await main(
      ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:aggressive,bot:spacing', '--out', '  '],
      memory,
    );
    expect(code).toBe(EXIT_USAGE);
    expect(logsIn(memory)).toHaveLength(0);
  });

  it('exits 1 when --agents names an id the config does not declare', async () => {
    const memory = io();
    const code = await main(
      ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:spacing,bot:ghost'],
      memory,
    );
    expect(code).toBe(1);
    expect(memory.stderr[0]).toContain('No agent "bot:ghost"');
  });
});

describe('main: match', () => {
  it('runs one Match and writes one log', async () => {
    const memory = io();
    const code = await main(
      ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:aggressive,bot:spacing'],
      memory,
    );

    expect(code).toBe(EXIT_OK);
    expect(logsIn(memory)).toHaveLength(1);
    expect(logsIn(memory)[0].startsWith('replays/')).toBe(true);
  });

  it('honours --out over the config’s outputDir', async () => {
    const memory = io();
    await main(
      ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:aggressive,bot:spacing', '--out', 'elsewhere'],
      memory,
    );
    expect(logsIn(memory)[0].startsWith('elsewhere/')).toBe(true);
  });

  it('re-invoked after its log was committed, runs nothing', async () => {
    const memory = io();
    const argv = ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:aggressive,bot:spacing'];

    await main(argv, memory);
    const first = new Map(memory.files);
    memory.stdout.length = 0;

    expect(await main(argv, memory)).toBe(EXIT_OK);
    expect(memory.files).toStrictEqual(first);
    expect(memory.stdout.join('\n')).toContain('0 run, 1 already committed');
  });
});

describe('AC4: an interrupted tournament, rerun, completes only what is outstanding', () => {
  it('runs the whole plan on a clean directory', async () => {
    const memory = io();
    expect(await main(['tournament', '--config', 'run.json'], memory)).toBe(EXIT_OK);
    // 3 agents -> 3 pairs, times 3 seeds.
    expect(logsIn(memory)).toHaveLength(9);
    expect(memory.stdout.at(-1)).toContain('9 run, 0 already committed, 9 planned');
  });

  it('completes exactly the outstanding Matches after an interruption', async () => {
    const memory = io();

    // The interruption: a runner that dies after four Matches. Nothing else
    // about the process is simulated -- it is the *files it left behind* that
    // the next invocation reads, which is the whole of AD-9.
    const killed = {
      ...memory,
      writeFile: async (path: string, contents: string) => {
        if (logsIn(memory).length >= 4) {
          throw new Error('killed');
        }
        await memory.writeFile(path, contents);
      },
    };
    await main(['tournament', '--config', 'run.json'], killed);
    expect(logsIn(memory)).toHaveLength(4);

    const survived = new Map(logsIn(memory).map((path) => [path, memory.files.get(path)]));
    memory.stdout.length = 0;

    expect(await main(['tournament', '--config', 'run.json'], memory)).toBe(EXIT_OK);
    expect(logsIn(memory)).toHaveLength(9);
    expect(memory.stdout.at(-1)).toContain('5 run, 4 already committed, 9 planned');

    // The four that survived were not re-run: byte-identical, not merely present.
    for (const [path, contents] of survived) {
      expect(memory.files.get(path)).toBe(contents);
    }
  });

  it('runs nothing at all on a third invocation', async () => {
    const memory = io();
    await main(['tournament', '--config', 'run.json'], memory);
    await main(['tournament', '--config', 'run.json'], memory);
    memory.stdout.length = 0;

    expect(await main(['tournament', '--config', 'run.json'], memory)).toBe(EXIT_OK);
    expect(memory.stdout.at(-1)).toContain('0 run, 9 already committed');
  });

  it('re-runs a Match whose committed log was truncated mid-write', async () => {
    const memory = io();
    await main(['tournament', '--config', 'run.json'], memory);

    const victim = logsIn(memory)[2];
    const whole = memory.files.get(victim) ?? '';
    memory.files.set(victim, whole.slice(0, 200));
    memory.stdout.length = 0;

    expect(await main(['tournament', '--config', 'run.json'], memory)).toBe(EXIT_OK);
    expect(memory.stdout.at(-1)).toContain('1 run, 8 already committed');
    expect(memory.files.get(victim)).toBe(whole);
  });

  it('derives resume from the committed logs alone -- no state file is ever written', async () => {
    const memory = io();
    await main(['tournament', '--config', 'run.json'], memory);

    // Every file this run produced is a Command Log. INV-8 and AD-9: there is
    // no queue, no manifest, no lock file, no database.
    const produced = [...memory.files.keys()].filter((path) => path !== 'run.json');
    expect(produced).toHaveLength(9);
    expect(produced.every((path) => path.startsWith('replays/') && path.endsWith('.command-log.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 end to end, through the real entry point.
// ---------------------------------------------------------------------------

const KEY = 'gsk_live_0123456789abcdef';

const DEPLOYMENT_CONFIG = JSON.stringify({
  seedBase: 4101,
  seedCount: 1,
  outputDir: 'replays',
  agents: [
    { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
    {
      id: 'groq:llama-3.1-8b-instant',
      kind: 'deployment',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      apiKeyEnv: 'GROQ_API_KEY',
    },
  ],
});

const quietFetch: HttpFetch = () =>
  Promise.resolve({
    status: 200,
    headers: { get: () => null },
    text: () =>
      Promise.resolve(
        JSON.stringify({
          id: 'chatcmpl-1',
          model: 'llama-3.1-8b-instant',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ACTION: attack' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 500, completion_tokens: 7, total_tokens: 507 },
        }),
      ),
  });

describe('AC3 through main', () => {
  it('refuses to start when a Deployment’s key is not in the environment, before any request', async () => {
    const memory = createMemoryIo({ files: { 'run.json': DEPLOYMENT_CONFIG } });
    let requests = 0;
    const counting: HttpFetch = (url, request) => {
      requests += 1;
      return quietFetch(url, request);
    };

    expect(await main(['tournament', '--config', 'run.json'], memory, { fetch: counting })).toBe(1);
    expect(requests).toBe(0);
    expect(memory.stderr[0]).toContain('GROQ_API_KEY');
    expect(memory.files.size).toBe(1);
  });

  it('runs with the key from the environment and writes a log that does not contain it', async () => {
    const memory = createMemoryIo({
      files: { 'run.json': DEPLOYMENT_CONFIG },
      env: { GROQ_API_KEY: KEY },
    });

    expect(await main(['tournament', '--config', 'run.json'], memory, { fetch: quietFetch })).toBe(EXIT_OK);

    const written = logsIn(memory);
    expect(written).toHaveLength(1);
    for (const contents of memory.files.values()) {
      expect(contents).not.toContain(KEY);
    }
  });

  it('refuses to write a log the provider echoed the key into, through main itself', async () => {
    // The guard lives in `main`, one wrapper away from every call site, and
    // this is the test that pins it there: `run.test.ts` proves `guardSecrets`
    // works, but only this proves `main` actually applies it to what it writes.
    const memory = createMemoryIo({
      files: { 'run.json': DEPLOYMENT_CONFIG },
      env: { GROQ_API_KEY: KEY },
    });
    const echoing: HttpFetch = (url, request) =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () =>
          Promise.resolve(
            JSON.stringify({
              id: 'chatcmpl-1',
              model: 'llama-3.1-8b-instant',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: `ACTION: attack\n<!-- echoed ${JSON.stringify(request.headers)} ${url} -->`,
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 500, completion_tokens: 7, total_tokens: 507 },
            }),
          ),
      });

    expect(await main(['tournament', '--config', 'run.json'], memory, { fetch: echoing })).toBe(1);
    expect(logsIn(memory)).toHaveLength(0);
    expect(memory.stderr.join('\n')).toContain('contains a provider API key');
  });

  it('resolves every Deployment’s key before the first Match, not on first use', async () => {
    // The roster's only Deployment appears in the *last* pairing. With lazy
    // resolution the two bot-vs-bot Matches ahead of it would run to
    // completion first, and a tournament against a real provider would have
    // burned quota before saying the key was missing.
    const memory = createMemoryIo({
      files: {
        'run.json': JSON.stringify({
          seedBase: 4101,
          seedCount: 1,
          outputDir: 'replays',
          agents: [
            { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
            { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
            { id: 'bot:random', kind: 'bot', bot: 'random' },
            {
              id: 'groq:llama-3.1-8b-instant',
              kind: 'deployment',
              provider: 'groq',
              model: 'llama-3.1-8b-instant',
              apiKeyEnv: 'GROQ_API_KEY',
            },
          ],
        }),
      },
    });

    expect(await main(['tournament', '--config', 'run.json'], memory, { fetch: quietFetch })).toBe(1);
    expect(logsIn(memory)).toHaveLength(0);
    expect(memory.stderr[0]).toContain('GROQ_API_KEY');
  });

  it('redacts a key that reached an error message', async () => {
    const memory = createMemoryIo({
      files: { 'run.json': DEPLOYMENT_CONFIG },
      env: { GROQ_API_KEY: KEY },
    });
    // A 500 aborts the Match, and this provider quotes the request back --
    // the failure path is the one an operator actually pastes into an issue.
    const leaky: HttpFetch = (url, request) =>
      Promise.resolve({
        status: 500,
        headers: { get: () => null },
        text: () => Promise.resolve(`upstream error for ${JSON.stringify(request.headers)}`),
      });

    expect(await main(['tournament', '--config', 'run.json'], memory, { fetch: leaky })).toBe(1);
    const stderr = memory.stderr.join('\n');
    expect(stderr).not.toContain(KEY);
    expect(stderr).toContain(REDACTED);
    expect(logsIn(memory)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Story 5.2, AC1: kill-and-resume at several points, not just one.
// ---------------------------------------------------------------------------

describe('AC1 (Story 5.2): kill-and-resume at several points', () => {
  it('converges to the full plan across three separate interruptions', async () => {
    const memory = io();

    function killedAtTotalOf(count: number): MemoryIo {
      return {
        ...memory,
        writeFile: async (path: string, contents: string) => {
          if (logsIn(memory).length >= count) {
            throw new Error('killed');
          }
          await memory.writeFile(path, contents);
        },
      };
    }

    await main(['tournament', '--config', 'run.json'], killedAtTotalOf(2));
    expect(logsIn(memory)).toHaveLength(2);

    await main(['tournament', '--config', 'run.json'], killedAtTotalOf(5));
    expect(logsIn(memory)).toHaveLength(5);

    await main(['tournament', '--config', 'run.json'], killedAtTotalOf(7));
    expect(logsIn(memory)).toHaveLength(7);

    // What survived every interruption must still be exactly what it was --
    // not merely present, byte-identical -- before the final, uninterrupted
    // invocation completes the rest.
    const survived = new Map(logsIn(memory).map((path) => [path, memory.files.get(path)]));

    expect(await main(['tournament', '--config', 'run.json'], memory)).toBe(EXIT_OK);
    expect(logsIn(memory)).toHaveLength(9);
    expect(memory.stdout.at(-1)).toContain('2 run, 7 already committed, 9 planned');

    for (const [path, contents] of survived) {
      expect(memory.files.get(path)).toBe(contents);
    }
  });
});

// ---------------------------------------------------------------------------
// Story 5.2, AC3: parking a Deployment past its daily quota, through the real
// entry point -- the run keeps going and exits cleanly rather than failing.
// ---------------------------------------------------------------------------

const THREE_AGENT_DEPLOYMENT_CONFIG = JSON.stringify({
  seedBase: 4101,
  seedCount: 1,
  outputDir: 'replays',
  agents: [
    { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
    { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
    {
      id: 'groq:llama-3.1-8b-instant',
      kind: 'deployment',
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      apiKeyEnv: 'GROQ_API_KEY',
    },
  ],
});

const rateLimitedFetch: HttpFetch = () =>
  Promise.resolve({
    status: 429,
    headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '9999' : null) },
    text: () =>
      Promise.resolve(
        JSON.stringify({ error: { type: 'requests', message: 'Rate limit reached for requests per day (RPD)' } }),
      ),
  });

describe('AC3 (Story 5.2): parking a Deployment past its daily quota', () => {
  it('parks the Deployment, skips its remaining Matches, exits 0, and reports it', async () => {
    const memory = createMemoryIo({
      files: { 'run.json': THREE_AGENT_DEPLOYMENT_CONFIG },
      env: { GROQ_API_KEY: KEY },
    });

    const code = await main(['tournament', '--config', 'run.json'], memory, {
      fetch: rateLimitedFetch,
      sleep: async () => {},
    });

    expect(code).toBe(EXIT_OK);
    // bot-vs-bot, plus the one groq pairing that ran (and parked mid-flight);
    // the second groq pairing was skipped, never attempted.
    expect(logsIn(memory)).toHaveLength(2);
    expect(memory.stdout.at(-1)).toContain('parked');
    expect(memory.stderr.join('\n')).toContain('parked:');
    for (const contents of memory.files.values()) {
      expect(contents).not.toContain(KEY);
    }
  });

  it('a later invocation does not remember the park -- it is not the resumable state', async () => {
    const memory = createMemoryIo({
      files: { 'run.json': THREE_AGENT_DEPLOYMENT_CONFIG },
      env: { GROQ_API_KEY: KEY },
    });

    await main(['tournament', '--config', 'run.json'], memory, {
      fetch: rateLimitedFetch,
      sleep: async () => {},
    });
    expect(logsIn(memory)).toHaveLength(2);
    memory.stdout.length = 0;

    // A second invocation, quota no longer exhausted (a quiet provider this
    // time): the still-outstanding groq pairing runs to completion. Nothing
    // about the previous park survived to bias this decision -- there is
    // nothing it could have survived *in*.
    const code = await main(['tournament', '--config', 'run.json'], memory, { fetch: quietFetch });
    expect(code).toBe(EXIT_OK);
    expect(logsIn(memory)).toHaveLength(3);
    expect(memory.stdout.at(-1)).toContain('1 run, 2 already committed, 3 planned');
  });
});

describe('Story 5.3, AC1/AC4: --dry-run rehearses the schedule without spending quota', () => {
  it('parses as a valueless flag and does not swallow the next option', () => {
    // The whole risk of teaching the parser a boolean flag: a flag that still
    // consumed a token would eat `--config` and then fail on a missing one.
    expect(parseArgs(['tournament', '--dry-run', '--config', 'run.json'])).toStrictEqual({
      command: 'tournament',
      options: { 'dry-run': 'true', config: 'run.json' },
    });
    expect(parseArgs(['tournament', '--config', 'run.json', '--dry-run'])).toStrictEqual({
      command: 'tournament',
      options: { config: 'run.json', 'dry-run': 'true' },
    });
  });

  it('is still subject to the repeated-option and unknown-option rules', () => {
    expect(() => parseArgs(['tournament', '--dry-run', '--dry-run'])).toThrow(/given twice/);
  });

  it('reports the whole outstanding plan and writes nothing', async () => {
    const memory = io();
    const code = await main(['tournament', '--config', 'run.json', '--dry-run'], memory);

    expect(code).toBe(EXIT_OK);
    // 3 agents round-robin = 3 pairings, over 3 seeds = 9 Matches.
    expect(memory.stdout.filter((line) => line.startsWith('would run'))).toHaveLength(9);
    expect(memory.stdout.at(-1)).toContain('tournament (dry run): 0 run, 0 already committed, 9 planned');
    expect(logsIn(memory)).toStrictEqual([]);
  });

  it('issues no provider call at all', async () => {
    const memory = createMemoryIo({ files: { 'run.json': DEPLOYMENT_CONFIG }, env: { GROQ_API_KEY: KEY } });
    const explode: HttpFetch = () => {
      throw new Error('a dry run must not reach a provider');
    };

    const code = await main(['tournament', '--config', 'run.json', '--dry-run'], memory, { fetch: explode });

    expect(code).toBe(EXIT_OK);
    expect(logsIn(memory)).toStrictEqual([]);
  });

  it('resolves every key first, so a missing secret fails the rehearsal (D2)', async () => {
    // The reason a dry run is worth running in CI at all: a repository whose
    // secret was never added fails here, at second zero, rather than at 03:00
    // the next morning one day of quota later.
    const memory = createMemoryIo({ files: { 'run.json': DEPLOYMENT_CONFIG } });

    const code = await main(['tournament', '--config', 'run.json', '--dry-run'], memory);

    expect(code).not.toBe(EXIT_OK);
    expect(memory.stderr.join('\n')).toContain('GROQ_API_KEY');
  });

  it('sees what previous segments committed, and reports nothing left to run', async () => {
    const memory = io();
    await main(['tournament', '--config', 'run.json'], memory);
    expect(logsIn(memory)).toHaveLength(9);
    memory.stdout.length = 0;

    // This is a segment starting the morning after a segment that finished:
    // the resumable state is the committed logs and nothing else.
    const code = await main(['tournament', '--config', 'run.json', '--dry-run'], memory);

    expect(code).toBe(EXIT_OK);
    expect(memory.stdout.filter((line) => line.startsWith('would run'))).toStrictEqual([]);
    expect(memory.stdout.at(-1)).toContain('tournament (dry run): 0 run, 9 already committed, 9 planned');
  });

  it('rehearses a single match too', async () => {
    const memory = io();
    const code = await main(
      ['match', '--config', 'run.json', '--seed', '4101', '--agents', 'bot:aggressive,bot:spacing', '--dry-run'],
      memory,
    );

    expect(code).toBe(EXIT_OK);
    expect(memory.stdout.filter((line) => line.startsWith('would run'))).toHaveLength(1);
    expect(logsIn(memory)).toStrictEqual([]);
  });
});
