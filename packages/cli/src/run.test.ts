import { describe, expect, it } from 'vitest';
import { buildCommandLog, computeConfigHash, validateCommandLog } from '../../core/src/command-log';
import { runMatch } from '../../core/src/match-runner';
import { replayCommandLog } from '../../core/src/replay';
import { createAggressiveBot, createSpacingBot } from '../../env-fighter/src/bots';
import { DEFAULT_FIGHTER_CONFIG } from '../../env-fighter/src/config';
import { createFighterEnvironment } from '../../env-fighter/src/environment';
import { buildReplayFilm } from '../../../apps/web/src/replay/film';
import { createReasoningSource } from '../../../apps/web/src/replay/sidecar';
import type { HttpFetch, HttpRequest } from '../../providers/src/http';
import { parseRunConfig, type RunConfig } from './config';
import { joinPath, logFileName, planMatch, planTournament } from './plan';
import { createQuotaTracker } from './quota';
import { runOneMatch, runPlannedMatches, serialiseCommandLog } from './run';
import { guardSecrets } from './secrets';
import { createMemoryIo } from './testing/memory-io';

const SEED = 4101;

const BOT_CONFIG: RunConfig = parseRunConfig(
  JSON.stringify({
    seedBase: SEED,
    seedCount: 2,
    outputDir: 'replays',
    agents: [
      { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
      { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
    ],
  }),
);

/**
 * The same Match, built with no CLI in sight: core's Harness, core's builder,
 * the shipped Environment Adapter. This is the "programmatically-produced"
 * half of AC1's byte-identity claim, and it is written the way
 * `apps/web/src/testing/demo-log.ts` writes it -- deliberately, because that
 * is the other existing producer and the three must agree.
 */
async function buildReferenceLog(seed: number) {
  const env = createFighterEnvironment();
  const p1 = createAggressiveBot('bot:aggressive');
  const p2 = createSpacingBot('bot:spacing');
  const match = await runMatch(env, [p1, p2], seed);

  return buildCommandLog(match, {
    environment: { id: env.id, version: env.version },
    seed,
    configHash: computeConfigHash(DEFAULT_FIGHTER_CONFIG),
    agents: [
      { id: p1.id, kind: 'bot' },
      { id: p2.id, kind: 'bot' },
    ],
  });
}

describe('AC1: the same Harness and the same Command Log schema as CI', () => {
  it('produces a log byte-identical to a programmatically-produced one for the same seed', async () => {
    const io = createMemoryIo();
    const summary = await runPlannedMatches(
      [planMatch(SEED, ['bot:aggressive', 'bot:spacing'])],
      BOT_CONFIG,
      { io },
    );

    const written = io.files.get(summary.written[0]);
    const reference = await buildReferenceLog(SEED);

    // The document, field for field. Not "looks similar": `toStrictEqual`
    // fails on an extra key, a missing key, and an `undefined` where a key
    // should be absent -- all three of which are how a forked serialiser
    // diverges first.
    expect(JSON.parse(written ?? '')).toStrictEqual(reference);
    // And the bytes, which is what the acceptance criterion actually says.
    expect(written).toBe(serialiseCommandLog(reference));
  });

  it('is stable across runs -- the same seed twice is the same bytes', async () => {
    const first = createMemoryIo();
    const second = createMemoryIo();
    const plan = [planMatch(SEED, ['bot:aggressive', 'bot:spacing'])];

    const a = await runPlannedMatches(plan, BOT_CONFIG, { io: first });
    const b = await runPlannedMatches(plan, BOT_CONFIG, { io: second });

    expect(first.files.get(a.written[0])).toBe(second.files.get(b.written[0]));
  });

  it('writes a document that passes the frozen schema validator', async () => {
    const io = createMemoryIo();
    const summary = await runPlannedMatches([planMatch(SEED, ['bot:aggressive', 'bot:spacing'])], BOT_CONFIG, {
      io,
    });
    expect(() => validateCommandLog(JSON.parse(io.files.get(summary.written[0]) ?? ''))).not.toThrow();
  });

  it('names the file after the matchId the plan derived', async () => {
    const io = createMemoryIo();
    const match = planMatch(SEED, ['bot:aggressive', 'bot:spacing']);
    const summary = await runPlannedMatches([match], BOT_CONFIG, { io });
    expect(summary.written[0]).toBe(joinPath('replays', logFileName(match.matchId)));
  });

  it('serialises as two-space JSON with a trailing newline', async () => {
    const io = createMemoryIo();
    const summary = await runPlannedMatches([planMatch(SEED, ['bot:aggressive', 'bot:spacing'])], BOT_CONFIG, {
      io,
    });
    const written = io.files.get(summary.written[0]) ?? '';
    expect(written.endsWith('}\n')).toBe(true);
    expect(written).toContain('\n  "schemaVersion"');
  });
});

describe('AC2: the player loads CLI output without conversion', () => {
  it('replays to the recorded final-state hash', async () => {
    const io = createMemoryIo();
    const summary = await runPlannedMatches([planMatch(SEED, ['bot:aggressive', 'bot:spacing'])], BOT_CONFIG, {
      io,
    });

    const verdict = replayCommandLog(JSON.parse(io.files.get(summary.written[0]) ?? ''), createFighterEnvironment());
    expect(verdict.matchesRecordedHash).toBe(true);
    expect(verdict.divergences).toStrictEqual([]);
  });

  it('builds a film through the player’s own loader, with no transformation step', async () => {
    const io = createMemoryIo();
    const summary = await runPlannedMatches([planMatch(SEED, ['bot:aggressive', 'bot:spacing'])], BOT_CONFIG, {
      io,
    });

    // The literal bytes off disk, parsed and handed to the function the page
    // calls. Anything the player needed that the CLI did not write shows up
    // here as a throw rather than as a bug report.
    const film = buildReplayFilm(JSON.parse(io.files.get(summary.written[0]) ?? ''), createFighterEnvironment());
    expect(film.matchesRecordedHash).toBe(true);
    expect(film.frames.length).toBeGreaterThan(0);
  });

  it('carries its reasoning inline, so the page fetches no sidecar for it', async () => {
    const io = createMemoryIo();
    const summary = await runPlannedMatches([planMatch(SEED, ['bot:aggressive', 'bot:spacing'])], BOT_CONFIG, {
      io,
    });

    const log = JSON.parse(io.files.get(summary.written[0]) ?? '') as Record<string, unknown>;
    expect(log['reasoningSidecar']).toBeUndefined();

    const source = createReasoningSource(
      log as unknown as Parameters<typeof createReasoningSource>[0],
    );
    expect(source.status()).toBe('inline');
  });
});

describe('runOneMatch', () => {
  it('refuses a Match whose produced matchId disagrees with the plan', async () => {
    const io = createMemoryIo();
    // A plan built for a pairing the config declares, but with the sides the
    // other way round: the runner plays what the plan says and would produce
    // a different id from the one the plan asked for only if the two derived
    // it differently -- so instead, feed it a plan whose id was tampered with.
    const match = planMatch(SEED, ['bot:aggressive', 'bot:spacing']);
    const tampered = { ...match, matchId: 'f'.repeat(64) };

    await expect(runOneMatch(tampered, BOT_CONFIG, { io })).rejects.toThrow(/resume would never converge/);
  });

  it('honours tokenBankStart from the config', async () => {
    const io = createMemoryIo();
    const config = parseRunConfig(
      JSON.stringify({
        seedBase: SEED,
        seedCount: 1,
        agents: [
          { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
          { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
        ],
        tokenBankStart: 1234,
      }),
    );
    const log = await runOneMatch(planMatch(SEED, ['bot:aggressive', 'bot:spacing']), config, { io });
    // Bot-only Match: the schema's rule is that `tokenBankStart` is absent
    // when banking is disabled, and two Baseline Bots consume nothing.
    expect(log.tokenBankStart).toBeUndefined();
  });
});

describe('runPlannedMatches', () => {
  it('reports what it ran, what was skipped, and what was planned', async () => {
    const io = createMemoryIo();
    const planned = planTournament(BOT_CONFIG);
    const summary = await runPlannedMatches(planned.slice(0, 1), BOT_CONFIG, { io }, 1);

    expect(summary).toStrictEqual({
      planned: 2,
      skipped: 1,
      completed: 1,
      written: [joinPath('replays', logFileName(planned[0].matchId))],
      parked: [],
    });
  });

  it('writes each log as its Match completes, which is what makes resume work', async () => {
    const io = createMemoryIo();
    const planned = planTournament(BOT_CONFIG);
    const seen: number[] = [];
    const observing = {
      ...io,
      writeFile: async (path: string, contents: string) => {
        await io.writeFile(path, contents);
        seen.push(io.files.size);
      },
    };

    await runPlannedMatches(planned, BOT_CONFIG, { io: observing });
    // 1, 2, 3, 4 -- not 0, 0, 0, 0 then a batch at the end.
    expect(seen).toStrictEqual([1, 2, 3, 4]);
  });

  it('does nothing at all, not even creating a directory, for an empty plan', async () => {
    const io = createMemoryIo();
    let ensured = 0;
    const counting = { ...io, ensureDir: () => { ensured += 1; return Promise.resolve(); } };

    const summary = await runPlannedMatches([], BOT_CONFIG, { io: counting }, 2);
    expect(summary.completed).toBe(0);
    expect(ensured).toBe(0);
  });

  it('prints one result line per Match', async () => {
    const io = createMemoryIo();
    await runPlannedMatches(planTournament(BOT_CONFIG), BOT_CONFIG, { io });
    // One pairing x 2 seeds x 2 side swaps (Story 7.1).
    expect(io.stdout).toHaveLength(4);
    expect(io.stdout[0]).toContain('bot:aggressive vs bot:spacing');
  });
});

// ---------------------------------------------------------------------------
// AC3, on the path that can actually leak: a Deployment with a real key.
// ---------------------------------------------------------------------------

const KEY = 'gsk_live_0123456789abcdef';
const GROQ_MODEL = 'llama-3.1-8b-instant';

function groqResponse(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-1',
    model: GROQ_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 500, completion_tokens: 7, total_tokens: 507 },
  });
}

/**
 * A transport that echoes the request -- headers included -- back in the
 * response body.
 *
 * That is not a realistic provider, and that is the point: it is the *worst*
 * realistic provider, the one whose error bodies quote the Authorization
 * header back at you. If a key can reach a Command Log at all, it reaches it
 * through a body like this one.
 */
function echoingFetch(action: string): HttpFetch {
  return (url: string, request: HttpRequest) =>
    Promise.resolve({
      status: 200,
      headers: { get: () => null },
      text: () =>
        Promise.resolve(
          groqResponse(`${action}\n<!-- upstream echoed: ${JSON.stringify(request.headers)} ${url} -->`),
        ),
    });
}

const DEPLOYMENT_CONFIG: RunConfig = parseRunConfig(
  JSON.stringify({
    seedBase: SEED,
    seedCount: 1,
    outputDir: 'replays',
    agents: [
      { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
      {
        id: 'groq:llama-3.1-8b-instant',
        kind: 'deployment',
        provider: 'groq',
        model: GROQ_MODEL,
        apiKeyEnv: 'GROQ_API_KEY',
      },
    ],
    tokenBankStart: 4000,
  }),
);

describe('AC3: a key never reaches disk', () => {
  it('runs a Deployment Match and records the endpoint, model and provider', async () => {
    const io = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    const log = await runOneMatch(planMatch(SEED, ['bot:spacing', 'groq:llama-3.1-8b-instant']), DEPLOYMENT_CONFIG, {
      io,
      fetch: echoingFetch('ACTION: attack'),
    });

    expect(log.agents[1].deployment).toStrictEqual({
      provider: 'groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: GROQ_MODEL,
    });
    expect(log.tokenBankStart).toBe(4000);
  });

  it('refuses to write the log when a provider echoed the key into it', async () => {
    const raw = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    const io = guardSecrets(raw, [KEY]);

    // The Match itself is fine -- it is the *writing* that must not happen.
    await expect(
      runPlannedMatches([planMatch(SEED, ['bot:spacing', 'groq:llama-3.1-8b-instant'])], DEPLOYMENT_CONFIG, {
        io,
        fetch: echoingFetch('ACTION: attack'),
      }),
    ).rejects.toThrow(/contains a provider API key/);

    expect(raw.files.size).toBe(0);
  });

  it('writes the log when nothing echoed the key back', async () => {
    const raw = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    const io = guardSecrets(raw, [KEY]);
    const quietFetch: HttpFetch = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(groqResponse('ACTION: attack')),
      });

    const summary = await runPlannedMatches(
      [planMatch(SEED, ['bot:spacing', 'groq:llama-3.1-8b-instant'])],
      DEPLOYMENT_CONFIG,
      { io, fetch: quietFetch },
    );

    expect(summary.completed).toBe(1);
    const written = raw.files.get(summary.written[0]) ?? '';
    expect(written).not.toContain(KEY);
    expect(written).not.toContain('GROQ_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// Story 5.2, AC3 & AC4: parking a Deployment that has hit its daily quota,
// and continuing the tournament with everything else.
// ---------------------------------------------------------------------------

/** Groq's configured `maxBackoffMs` (`free-tier.config.json`). Past this, one call's bounded wait cannot have cleared the limit. */
const MAX_BACKOFF_MS = 120_000;

function rateLimitedFetch(retryAfterSeconds: number): HttpFetch {
  return () =>
    Promise.resolve({
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? String(retryAfterSeconds) : null) },
      text: () =>
        Promise.resolve(
          JSON.stringify({ error: { type: 'requests', message: 'Rate limit reached for requests per day (RPD)' } }),
        ),
    });
}

/** Three agents so a tournament has both a parked-Deployment pairing and an unrelated bot-vs-bot one. */
const THREE_AGENT_CONFIG: RunConfig = parseRunConfig(
  JSON.stringify({
    seedBase: SEED,
    seedCount: 1,
    outputDir: 'replays',
    agents: [
      { id: 'bot:spacing', kind: 'bot', bot: 'spacing' },
      { id: 'bot:aggressive', kind: 'bot', bot: 'aggressive' },
      {
        id: 'groq:llama-3.1-8b-instant',
        kind: 'deployment',
        provider: 'groq',
        model: GROQ_MODEL,
        apiKeyEnv: 'GROQ_API_KEY',
      },
    ],
  }),
);

describe('AC3/AC4: parking a Deployment past its daily quota', () => {
  it('parks the Deployment and skips its remaining Matches, but keeps running everything else', async () => {
    const io = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    const quota = createQuotaTracker();
    // 3 agents, 1 seed, both sides (Story 7.1) -> (spacing,aggressive),
    // (aggressive,spacing), (spacing,groq), (groq,spacing), (aggressive,groq),
    // (groq,aggressive) in that plan order. The third Match is the first
    // against groq, and it is the one that parks it.
    const planned = planTournament(THREE_AGENT_CONFIG);

    const summary = await runPlannedMatches(planned, THREE_AGENT_CONFIG, {
      io,
      fetch: rateLimitedFetch(9999), // 9,999,000ms, past MAX_BACKOFF_MS
      sleep: async () => {},
      quota,
    });

    expect(summary.parked).toStrictEqual(['groq:llama-3.1-8b-instant']);
    // Both bot-vs-bot orientations ran; the first groq Match ran (and parked
    // it mid-flight); every later groq Match was skipped entirely.
    expect(summary.completed).toBe(3);
    expect(summary.written).toHaveLength(3);
    expect(quota.isParked('groq:llama-3.1-8b-instant')).toBe(true);

    expect(io.stderr.join('\n')).toContain('parked:');
  });

  it('does not park on a rate limit short enough for one call to have already waited out', async () => {
    const io = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    const quota = createQuotaTracker();
    const planned = planTournament(THREE_AGENT_CONFIG);

    const summary = await runPlannedMatches(planned, THREE_AGENT_CONFIG, {
      io,
      fetch: rateLimitedFetch(5), // 5,000ms, well under MAX_BACKOFF_MS
      sleep: async () => {},
      quota,
    });

    expect(summary.parked).toStrictEqual([]);
    // All six Matches ran; none were skipped for parking.
    expect(summary.completed).toBe(6);
  });

  it('carries no quota state between two trackers -- a fresh run rediscovers it, never assumes it', async () => {
    const io = createMemoryIo({ env: { GROQ_API_KEY: KEY } });
    const first = createQuotaTracker();
    await runPlannedMatches(planTournament(THREE_AGENT_CONFIG), THREE_AGENT_CONFIG, {
      io,
      fetch: rateLimitedFetch(9999),
      sleep: async () => {},
      quota: first,
    });
    expect(first.isParked('groq:llama-3.1-8b-instant')).toBe(true);

    // A brand new tracker -- standing in for a brand new process -- has no
    // memory of the park. Nothing on disk records it either (AD-9): quota
    // state is not the resumable state, committed logs are.
    const second = createQuotaTracker();
    expect(second.isParked('groq:llama-3.1-8b-instant')).toBe(false);
  });
});
